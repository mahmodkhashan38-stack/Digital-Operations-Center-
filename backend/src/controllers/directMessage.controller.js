const mongoose = require('mongoose');
const DirectMessageConversation = require('../models/DirectMessageConversation');
const DirectMessage = require('../models/DirectMessage');
const User = require('../models/User');
const dmAttachmentStorage = require('../services/dmAttachmentStorage');
const { MAX_ATTACHMENTS_PER_MESSAGE } = require('../middleware/chatUpload');
const { createNotification } = require('../services/notification.service');
const { escapeRegExp } = require('../utils/requestQueryBuilder');

// DOC-73 - "Private Direct Messages".
// -----------------------------------------------------------------------
// THE ONE RULE EVERY ENDPOINT ON THIS CONTROLLER SHARES (task spec section
// 9/23/24 - the ticket's own single most-repeated, most-tested
// requirement): a conversation is visible/writable ONLY to its own two
// `participantIds` - never "any Manager in the Organization" (task spec
// section 23: "Manager must NOT automatically be able to read Employee
// conversations" - there is no Manager special case anywhere in this
// file), and never "System Admin" (task spec section 24 - System Admin is
// already structurally excluded before ever reaching this file at all,
// since routes/directMessage.routes.js's own `requireRole('manager',
// 'operator', 'employee')` never includes it - see that file's own
// comment). `loadAuthorizedConversation` below is the ONE function that
// implements this rule; every conversation-scoped endpoint calls it
// first, and none of them re-implements the check inline.
//
// ORGANIZATION ISOLATION (task spec section 5/25) is a SEPARATE, second
// axis, layered underneath the privacy check, not a substitute for it: a
// conversation is also always scoped by `organizationId:
// req.user.organizationId` (never trusted from req.body/req.params), so a
// cross-Organization prober cannot even reach the participant check on a
// conversation from a different Organization - they get the exact same
// generic 404 an intra-Organization non-participant gets, never a
// distinguishing 403 (the same DOC-38 anti-enumeration convention every
// other cross-tenant lookup in this project already uses).
// -----------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_CONTENT_LENGTH = 2000;
const USER_SEARCH_RESULT_LIMIT = 8;
const MAX_USER_SEARCH_QUERY_LENGTH = 100;
const CONVERSATION_LIST_LIMIT = 100;

// Task spec section 8/30 - who may participate in a DM at all: exactly the
// same population Organization Chat/DOC-72 @Mentions already allow, minus
// System Admin (whose organizationId is always null - see this file's own
// top comment). Kept as its own small constant here (not imported from
// utils/chatMentionValidation.js, which is a DOC-72-owned file with its
// own independent lifecycle) so a future change to one feature's allowed
// roles is never silently assumed to apply to the other.
const ALLOWED_DM_ROLES = ['manager', 'operator', 'employee'];

// ---------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------

// Task spec section 12/33 - minimal, already-safe fields only, identical
// shape to chat.controller.js's own `sanitizeMentionCandidate`. Never
// email/bio/isActive/organizationId. `hasProfileImage` (never a full
// profileImageUrl object) is deliberately all the backend ever returns for
// ANOTHER user's avatar here - task spec section 35's own "reuse DOC-71
// Avatar... avoid duplicate avatar logic" is satisfied on the FRONTEND
// side instead: since GET /api/users/:userId/profile-image already allows
// any same-Organization viewer (see userProfileImage.controller.js's own
// `canViewProfileImage`), the frontend can safely build that URL itself
// from `{id, hasProfileImage}` with no extra backend field needed.
function sanitizeUserSummary(user) {
  return {
    id: user._id,
    fullName: user.fullName,
    role: user.role,
    hasProfileImage: !!user.profileImage,
  };
}

// Task spec section 14 - a short, safe, ALREADY-TRUNCATED plain-text
// preview. Never exposes attachment internals (filename/mimeType/
// objectKey/fileId) - an attachment-only message always previews as the
// fixed string "Sent an attachment", regardless of how many attachments or
// what type they are.
const PREVIEW_MAX_LENGTH = 80;
function buildMessagePreview(message) {
  const trimmedContent = typeof message.content === 'string' ? message.content.trim() : '';
  if (trimmedContent.length > 0) {
    return trimmedContent.length > PREVIEW_MAX_LENGTH
      ? `${trimmedContent.slice(0, PREVIEW_MAX_LENGTH)}…`
      : trimmedContent;
  }
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return 'Sent an attachment';
  }
  return null;
}

// Task spec section 26/27/29 - `null` (never opened yet) is treated as
// "the dawn of time", so every message from the other participant counts
// as unread until the very first mark-read call.
const EPOCH = new Date(0);
function resolveUnreadThreshold(conversation, userId) {
  const state = (conversation.readStates || []).find((entry) => String(entry.userId) === String(userId));
  return state && state.lastReadAt ? state.lastReadAt : EPOCH;
}

// DOC-70's own filename-safety helper is reused verbatim here (identical
// header-injection concern, identical fix) rather than importing it from
// chat.controller.js - keeping this controller fully independent of that
// one, the same "each feature owns its own small sanitizers" convention
// requestImageStorage.js/chatAttachmentStorage.js already established at
// the storage layer.
function sanitizeContentDispositionFilename(originalName) {
  const fallback = 'attachment';
  if (typeof originalName !== 'string' || originalName.length === 0) {
    return fallback;
  }
  const stripped = originalName.replace(/[\r\n\0]/g, '').replace(/["\\]/g, '');
  const trimmed = stripped.trim().slice(0, 150);
  return trimmed.length > 0 ? trimmed : fallback;
}

function buildContentDispositionHeader(attachment) {
  const disposition = attachment.mimeType && attachment.mimeType.startsWith('image/') ? 'inline' : 'attachment';
  const safeName = sanitizeContentDispositionFilename(attachment.originalName);
  return `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sanitizeAttachment(conversationId, messageId, attachment) {
  return {
    id: attachment._id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedAt: attachment.uploadedAt,
    url: `/direct-messages/conversations/${conversationId}/messages/${messageId}/attachments/${attachment._id}/content`,
  };
}

// Task spec section 15/34 - never exposes senderId as a raw internal field
// (it is reshaped into `isOwnMessage`, computed relative to the CALLER,
// never the raw id of either participant) - the frontend never needs to
// know the other participant's id from an individual message, only from
// the conversation/header it is already rendering.
function sanitizeMessage(message, currentUserId) {
  return {
    id: message._id,
    conversationId: message.conversationId,
    content: message.content,
    isOwnMessage: String(message.senderId) === String(currentUserId),
    attachments: (message.attachments || []).map(
      (attachment) => sanitizeAttachment(message.conversationId, message._id, attachment),
    ),
    createdAt: message.createdAt,
  };
}

// Task spec section 13 - the list endpoint's own compact per-conversation
// shape. `otherParticipant` resolves the CURRENT identity of the other
// user (fullName/role can change - always read fresh, never a snapshot,
// the same "resolve fresh at read time" convention DOC-72's own mentions
// already established) via an already-built lookup map (never N+1 - see
// `listConversations`'s own batched `User.find`).
function sanitizeConversationSummary(conversation, currentUserId, otherParticipant, unreadCount) {
  return {
    id: conversation._id,
    otherParticipant: otherParticipant
      ? sanitizeUserSummary(otherParticipant)
      : { id: null, fullName: 'Unknown user', role: null, hasProfileImage: false },
    lastMessagePreview: conversation.lastMessagePreview || null,
    lastMessageAt: conversation.lastMessageAt || null,
    unreadCount,
  };
}

function getOtherParticipantId(conversation, currentUserId) {
  return (conversation.participantIds || []).find(
    (id) => String(id) !== String(currentUserId),
  ) || null;
}

// ---------------------------------------------------------------------
// THE authorization gate - see this file's own top comment.
// ---------------------------------------------------------------------
//
// A missing conversation, one belonging to another Organization, and one
// the caller is simply not a participant of ALL resolve to the exact same
// `null` here - every call site turns that into the identical generic 404
// below (task spec section 9/23/24/25 - "must fail safely", never a
// distinguishing 403 that would itself confirm a conversation between two
// OTHER people exists).
async function loadAuthorizedConversation(conversationId, req) {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    return null;
  }
  const conversation = await DirectMessageConversation.findOne({
    _id: conversationId,
    organizationId: req.user.organizationId,
  });
  if (!conversation) {
    return null;
  }
  const isParticipant = (conversation.participantIds || []).some(
    (id) => String(id) === String(req.user.userId),
  );
  if (!isParticipant) {
    return null;
  }
  return conversation;
}

function conversationNotFoundResponse(res) {
  return res.status(404).json({ status: 'error', message: 'Conversation not found.' });
}

// ---------------------------------------------------------------------
// GET /api/direct-messages/users?q=<search text>
// ---------------------------------------------------------------------
//
// Task spec section 12/53 - same-Organization, active, allowed-role user
// discovery for the "start a new conversation" search box. Deliberately
// EXCLUDES the caller themselves (task spec: "Exclude current user if
// desired" - excluded outright here, since a self-DM is rejected by
// `createConversation` below regardless - never offering yourself as a
// selectable result avoids a confusing dead-end in the UI). Never a global
// user directory - always `organizationId: req.user.organizationId`.
const searchUsers = async (req, res, next) => {
  try {
    const rawQuery = req.query.q;
    let query = {
      organizationId: req.user.organizationId,
      isActive: true,
      role: { $in: ALLOWED_DM_ROLES },
      _id: { $ne: req.user.userId },
    };

    if (rawQuery !== undefined && rawQuery !== '') {
      if (typeof rawQuery !== 'string') {
        return res.status(400).json({ status: 'error', message: 'q must be a text search term.' });
      }
      const trimmedQuery = rawQuery.trim();
      if (trimmedQuery.length > MAX_USER_SEARCH_QUERY_LENGTH) {
        return res.status(400).json({ status: 'error', message: `q must be at most ${MAX_USER_SEARCH_QUERY_LENGTH} characters.` });
      }
      if (trimmedQuery.length > 0) {
        query = { ...query, fullName: new RegExp(escapeRegExp(trimmedQuery), 'i') };
      }
    }

    const candidates = await User
      .find(query)
      .sort({ fullName: 1 })
      .limit(USER_SEARCH_RESULT_LIMIT);

    return res.status(200).json({ status: 'success', data: candidates.map(sanitizeUserSummary) });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/direct-messages/conversations   body: { recipientId }
// ---------------------------------------------------------------------
//
// Task spec section 10 - accepts ONLY `recipientId`. `participantIds`/
// `senderId`/`organizationId`/`role` are never read from req.body even if
// present - the sender is always `req.user.userId`, the organization is
// always `req.user.organizationId`.
//
// Task spec section 11 - IDEMPOTENT: an existing conversation for this
// exact pair is returned as-is (200), never duplicated. A race between two
// concurrent "start conversation" requests for the same pair is handled by
// catching the unique index's own duplicate-key error and re-reading the
// now-existing document, rather than letting the second request fail.
const createConversation = async (req, res, next) => {
  try {
    const { recipientId } = req.body || {};

    if (!recipientId || typeof recipientId !== 'string' || !mongoose.Types.ObjectId.isValid(recipientId)) {
      return res.status(400).json({ status: 'error', message: 'A valid recipientId is required.' });
    }

    // Task spec section 3 - "No self-only conversation." Checked BEFORE
    // any database lookup - a self-id is never even a well-formed
    // candidate.
    if (String(recipientId) === String(req.user.userId)) {
      return res.status(400).json({ status: 'error', message: 'You cannot start a conversation with yourself.' });
    }

    // Task spec section 5/7/8/9's own combined validation, deliberately a
    // SINGLE generic error for every failure reason (nonexistent,
    // cross-Organization, inactive, disallowed role) - see
    // chat.controller.js's own createMessage for the identical "prefer one
    // generic message so a prober can never learn which reason applied"
    // rationale (task spec section 25: cross-org probing must fail
    // safely).
    const recipient = await User.findOne({
      _id: recipientId,
      organizationId: req.user.organizationId,
      isActive: true,
      role: { $in: ALLOWED_DM_ROLES },
    });
    if (!recipient) {
      return res.status(400).json({ status: 'error', message: 'Recipient could not be found.' });
    }

    const participantKey = DirectMessageConversation.buildParticipantKey(req.user.userId, recipientId);

    const existing = await DirectMessageConversation.findOne({
      organizationId: req.user.organizationId,
      participantKey,
    });
    if (existing) {
      const otherParticipant = await User.findById(getOtherParticipantId(existing, req.user.userId));
      const unreadCount = await countUnreadForConversation(existing, req.user.userId);
      return res.status(200).json({
        status: 'success',
        data: sanitizeConversationSummary(existing, req.user.userId, otherParticipant, unreadCount),
      });
    }

    let conversation;
    try {
      conversation = await DirectMessageConversation.create({
        organizationId: req.user.organizationId,
        participantIds: [req.user.userId, recipientId],
        participantKey,
        readStates: [
          { userId: req.user.userId, lastReadAt: null },
          { userId: recipientId, lastReadAt: null },
        ],
      });
    } catch (createError) {
      // Race-safe idempotency - see this function's own top comment.
      if (createError && createError.code === 11000) {
        conversation = await DirectMessageConversation.findOne({
          organizationId: req.user.organizationId,
          participantKey,
        });
        if (!conversation) {
          throw createError;
        }
      } else {
        throw createError;
      }
    }

    return res.status(201).json({
      status: 'success',
      data: sanitizeConversationSummary(conversation, req.user.userId, recipient, 0),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// Batches the unread-count computation for every conversation in ONE
// aggregation query (task spec section 29: "Do not perform huge
// per-conversation N+1 queries if avoidable") rather than one
// `countDocuments` call per conversation. Each conversation has its OWN
// unread threshold (this user's own `lastReadAt` for THAT conversation),
// so a single flat `$match` cannot express every conversation's condition
// at once - instead, one `$or` of per-conversation `{conversationId,
// createdAt: {$gt: threshold}}` clauses is combined with a single shared
// `senderId: {$ne: userId}` clause (task spec section 29's own formula),
// then grouped by conversationId - exactly one round trip regardless of
// how many conversations this user has.
async function buildUnreadCountMap(conversations, userId) {
  if (conversations.length === 0) {
    return new Map();
  }
  const orConditions = conversations.map((conversation) => ({
    conversationId: conversation._id,
    createdAt: { $gt: resolveUnreadThreshold(conversation, userId) },
  }));
  const rows = await DirectMessage.aggregate([
    { $match: { senderId: { $ne: new mongoose.Types.ObjectId(userId) }, $or: orConditions } },
    { $group: { _id: '$conversationId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

// Single-conversation convenience wrapper around the same formula, used
// by createConversation's own "return existing" branch above (a single
// conversation, so the batched aggregation above would be overkill).
async function countUnreadForConversation(conversation, userId) {
  return DirectMessage.countDocuments({
    conversationId: conversation._id,
    senderId: { $ne: userId },
    createdAt: { $gt: resolveUnreadThreshold(conversation, userId) },
  });
}

// ---------------------------------------------------------------------
// GET /api/direct-messages/conversations
// ---------------------------------------------------------------------
//
// Task spec section 13 - returns ONLY conversations where
// `req.user.userId` is a participant - never every conversation in the
// Organization (that would itself be the exact Manager-bypass task spec
// section 23 forbids). Task spec: "Do NOT return full conversation history
// in this endpoint" - only the small summary shape, never any
// DirectMessage documents.
const listConversations = async (req, res, next) => {
  try {
    const conversations = await DirectMessageConversation
      .find({ organizationId: req.user.organizationId, participantIds: req.user.userId })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(CONVERSATION_LIST_LIMIT);

    const otherParticipantIds = Array.from(new Set(
      conversations.map((conversation) => String(getOtherParticipantId(conversation, req.user.userId))),
    )).filter((id) => id !== 'null');

    const otherParticipants = otherParticipantIds.length > 0
      ? await User.find({ _id: { $in: otherParticipantIds } })
      : [];
    const userMap = new Map(otherParticipants.map((user) => [String(user._id), user]));

    const unreadCountMap = await buildUnreadCountMap(conversations, req.user.userId);

    const data = conversations.map((conversation) => {
      const otherParticipantId = getOtherParticipantId(conversation, req.user.userId);
      const otherParticipant = otherParticipantId ? userMap.get(String(otherParticipantId)) : null;
      const unreadCount = unreadCountMap.get(String(conversation._id)) || 0;
      return sanitizeConversationSummary(conversation, req.user.userId, otherParticipant, unreadCount);
    });

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/direct-messages/conversations/:conversationId/messages
// ---------------------------------------------------------------------
//
// Cursor pagination identical in shape to chat.controller.js's own
// listMessages (task spec section 15: "limit / before... newest-first
// internally... then render chronological order frontend").
function parseBeforeParam(rawValue) {
  if (rawValue === undefined || rawValue === '') {
    return { date: null, error: null };
  }
  if (typeof rawValue !== 'string') {
    return { date: null, error: 'before must be a valid ISO timestamp.' };
  }
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return { date: null, error: 'before must be a valid ISO timestamp.' };
  }
  return { date, error: null };
}

function parseLimitParam(rawValue) {
  if (rawValue === undefined || rawValue === '') {
    return { limit: DEFAULT_LIST_LIMIT, error: null };
  }
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue.trim())) {
    return { limit: null, error: `limit must be a whole number between 1 and ${MAX_LIST_LIMIT}.` };
  }
  const limit = Number.parseInt(rawValue, 10);
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    return { limit: null, error: `limit must be a whole number between 1 and ${MAX_LIST_LIMIT}.` };
  }
  return { limit, error: null };
}

const listMessages = async (req, res, next) => {
  try {
    const conversation = await loadAuthorizedConversation(req.params.conversationId, req);
    if (!conversation) {
      return conversationNotFoundResponse(res);
    }

    const { before: rawBefore, limit: rawLimit } = req.query || {};

    const { date: beforeDate, error: beforeError } = parseBeforeParam(rawBefore);
    if (beforeError) {
      return res.status(400).json({ status: 'error', message: beforeError });
    }

    const { limit, error: limitError } = parseLimitParam(rawLimit);
    if (limitError) {
      return res.status(400).json({ status: 'error', message: limitError });
    }

    const query = { conversationId: conversation._id };
    if (beforeDate) {
      query.createdAt = { $lt: beforeDate };
    }

    const page = await DirectMessage
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    const hasMore = page.length > limit;
    const pageMessages = hasMore ? page.slice(0, limit) : page;
    const chronological = [...pageMessages].reverse();

    const data = chronological.map((message) => sanitizeMessage(message, req.user.userId));

    return res.status(200).json({ status: 'success', data, meta: { hasMore } });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/direct-messages/conversations/:conversationId/messages
// ---------------------------------------------------------------------
//
// Task spec section 16/20/21/22 - text-only/attachment-only/text+
// attachment, reusing DOC-70's own upload-then-save-with-cleanup-on-
// failure order and text-or-attachment validation shape. `senderId` is
// ALWAYS `req.user.userId` (task spec section 21) - there is no code path
// here that ever reads a sender identity from req.body.
//
// Task spec section 48 - "block new sends if other participant is
// inactive". Checked fresh on every send (never cached from conversation-
// creation time) - a participant who was active when the conversation
// started but has SINCE been deactivated correctly blocks further new
// messages, while the conversation and its historical messages remain
// fully intact and readable for the still-active participant.
const sendMessage = async (req, res, next) => {
  const uploadedReferences = [];
  try {
    const conversation = await loadAuthorizedConversation(req.params.conversationId, req);
    if (!conversation) {
      return conversationNotFoundResponse(res);
    }

    const otherParticipantId = getOtherParticipantId(conversation, req.user.userId);
    const otherParticipant = await User.findOne({
      _id: otherParticipantId,
      organizationId: req.user.organizationId,
    });
    // Task spec section 25/51 - if the other participant can no longer be
    // resolved in THIS Organization at all (should not normally happen -
    // this project never hard-deletes Users and has no organization-
    // transfer feature, see this controller's own README documentation),
    // fail safely rather than let a message be created with an
    // unreachable recipient.
    if (!otherParticipant) {
      return res.status(404).json({ status: 'error', message: 'Conversation not found.' });
    }
    if (!otherParticipant.isActive) {
      return res.status(409).json({ status: 'error', message: 'This user is currently inactive.' });
    }

    const body = req.body || {};
    const files = Array.isArray(req.files) ? req.files : [];

    let trimmedContent = '';
    if (body.content !== undefined) {
      if (typeof body.content !== 'string') {
        return res.status(400).json({ status: 'error', message: 'Message content must be text.' });
      }
      trimmedContent = body.content.trim();
      if (trimmedContent.length > MAX_CONTENT_LENGTH) {
        return res.status(400).json({ status: 'error', message: `Message content must be at most ${MAX_CONTENT_LENGTH} characters.` });
      }
    }

    if (trimmedContent.length === 0 && files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Message must include text content or at least one attachment.' });
    }
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return res.status(400).json({ status: 'error', message: `A maximum of ${MAX_ATTACHMENTS_PER_MESSAGE} attachments may be sent per message.` });
    }

    const attachmentsMetadata = [];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const reference = await dmAttachmentStorage.uploadAttachment(file.buffer, {
        organizationId: req.user.organizationId,
        conversationId: conversation._id,
        mimeType: file.mimetype,
      });
      uploadedReferences.push(reference);
      attachmentsMetadata.push({
        ...reference,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      });
    }

    let message;
    try {
      message = await DirectMessage.create({
        organizationId: req.user.organizationId,
        conversationId: conversation._id,
        senderId: req.user.userId,
        content: trimmedContent,
        attachments: attachmentsMetadata,
      });
    } catch (createError) {
      for (const reference of uploadedReferences) {
        // eslint-disable-next-line no-await-in-loop
        await dmAttachmentStorage.deleteAttachment(reference);
      }
      throw createError;
    }

    // Task spec sections 13/14/29 - denormalized preview/activity fields,
    // updated once here so the conversation LIST never needs a second
    // query per conversation - see DirectMessageConversation.js's own top
    // comment.
    conversation.lastMessageAt = message.createdAt;
    conversation.lastMessagePreview = buildMessagePreview(message);
    await conversation.save();

    // Task spec section 39/40/41/43 - DIRECT_MESSAGE notification,
    // best-effort, generic wording, never the sender, never fails the
    // already-successful send. Mirrors DOC-72's own CHAT_MENTION dispatch
    // shape exactly (wrapped defensively even though createNotification
    // itself already never throws - defense in depth against a
    // hypothetical bug in this small block itself).
    try {
      const sender = await User.findById(req.user.userId);
      await createNotification({
        organizationId: req.user.organizationId,
        recipientId: otherParticipant._id,
        actorId: req.user.userId,
        type: 'DIRECT_MESSAGE',
        title: 'New message',
        message: `${sender ? sender.fullName : 'Someone'} sent you a private message.`,
        // Task spec section 40 - never the message's actual text/
        // attachment names, only opaque ids for future navigation.
        metadata: { conversationId: conversation._id, messageId: message._id },
      });
    } catch (notificationError) {
      // eslint-disable-next-line no-console
      console.error('Failed to dispatch DIRECT_MESSAGE notification:', notificationError.message);
    }

    return res.status(201).json({ status: 'success', data: sanitizeMessage(message, req.user.userId) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/direct-messages/conversations/:conversationId/read
// ---------------------------------------------------------------------
//
// Task spec section 28 - sets ONLY the CALLER's own readState entry;
// `readStates` is a fixed-shape array (exactly one entry per participant,
// created at conversation-creation time), so this only ever updates the
// entry whose userId already matches the caller - the other participant's
// entry is never read or written here.
const markConversationRead = async (req, res, next) => {
  try {
    const conversation = await loadAuthorizedConversation(req.params.conversationId, req);
    if (!conversation) {
      return conversationNotFoundResponse(res);
    }

    const now = new Date();
    let found = false;
    conversation.readStates = (conversation.readStates || []).map((entry) => {
      if (String(entry.userId) === String(req.user.userId)) {
        found = true;
        return { userId: entry.userId, lastReadAt: now };
      }
      return entry;
    });
    if (!found) {
      // Defensive - should be unreachable, since every conversation is
      // always created with exactly one readState entry per participant.
      conversation.readStates.push({ userId: req.user.userId, lastReadAt: now });
    }
    await conversation.save();

    return res.status(200).json({ status: 'success', data: { lastReadAt: now } });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET .../conversations/:conversationId/messages/:messageId/attachments/:attachmentId/content
// ---------------------------------------------------------------------
//
// Task spec section 18 - full authorization chain: authenticated (router
// middleware) -> active (router middleware/auth.js) -> same organization
// AND participant (loadAuthorizedConversation) -> message belongs to THIS
// conversation (scoped query below) -> attachment belongs to THIS message
// (`message.attachments.id(attachmentId)`, never a global lookup by
// attachment id alone - identical IDOR-protection shape to
// chat.controller.js's own getChatAttachmentContent).
const getAttachmentContent = async (req, res, next) => {
  try {
    const { conversationId, messageId, attachmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(messageId) || !mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid id.' });
    }

    const conversation = await loadAuthorizedConversation(conversationId, req);
    if (!conversation) {
      return conversationNotFoundResponse(res);
    }

    const message = await DirectMessage.findOne({ _id: messageId, conversationId: conversation._id });
    if (!message) {
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    const attachment = message.attachments.id(attachmentId);
    if (!attachment) {
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    const attachmentStream = await dmAttachmentStorage.getAttachmentStream(attachment);
    if (!attachmentStream) {
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    res.setHeader('Content-Type', attachmentStream.contentType);
    if (attachmentStream.contentLength) {
      res.setHeader('Content-Length', String(attachmentStream.contentLength));
    }
    res.setHeader('Content-Disposition', buildContentDispositionHeader(attachment));
    res.setHeader('Cache-Control', 'private, max-age=86400');

    attachmentStream.stream.on('error', (error) => next(error));
    return attachmentStream.stream.pipe(res);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  searchUsers,
  createConversation,
  listConversations,
  listMessages,
  sendMessage,
  markConversationRead,
  getAttachmentContent,
  loadAuthorizedConversation,
  sanitizeMessage,
  sanitizeConversationSummary,
  sanitizeUserSummary,
  buildMessagePreview,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  USER_SEARCH_RESULT_LIMIT,
};
