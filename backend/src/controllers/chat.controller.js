const mongoose = require('mongoose');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
// DOC-70 - "Organization Chat Attachments".
const chatAttachmentStorage = require('../services/chatAttachmentStorage');
const { MAX_ATTACHMENTS_PER_MESSAGE } = require('../middleware/chatUpload');
// DOC-72 - "@Mentions in Organization Chat".
const { parseMentionUserIdsField, ALLOWED_MENTION_ROLES } = require('../utils/chatMentionValidation');
const { createNotification } = require('../services/notification.service');
const { escapeRegExp } = require('../utils/requestQueryBuilder');

// DOC-60 - "Organization Chat". One main chat channel per Organization -
// every active manager/operator/employee member of an Organization shares
// the same message stream, scoped exclusively by organizationId. System
// Admin does not participate (rejected by this router's own role gate -
// see routes/chat.routes.js). Messages are immutable in this version - no
// edit/delete endpoint exists anywhere in this file (DOC-70 did not
// change this - task spec section 32: "If chat messages are immutable/
// no-delete: do not introduce delete just for attachments.").
// -----------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_CONTENT_LENGTH = 2000;

// DOC-70 - Content-Disposition filename safety (task spec section 19:
// "Avoid header injection through filenames... Do not trust original
// filename raw in headers."). Strips CR/LF/NUL (the actual header-
// injection vector - a raw `\r\n` in a header value could inject
// additional headers) and quote/backslash characters (which would
// otherwise need their own escaping inside the quoted-string form), then
// caps the length. `originalName` is still stored and DISPLAYED verbatim
// elsewhere (task spec section 35 - it is only ever rendered as plain
// React text, never HTML) - this sanitization is specific to its use
// inside an HTTP header, not a general-purpose text sanitizer.
function sanitizeContentDispositionFilename(originalName) {
  const fallback = 'attachment';
  if (typeof originalName !== 'string' || originalName.length === 0) {
    return fallback;
  }
  const stripped = originalName.replace(/[\r\n\0]/g, '').replace(/["\\]/g, '');
  const trimmed = stripped.trim().slice(0, 150);
  return trimmed.length > 0 ? trimmed : fallback;
}

// Builds the Content-Disposition header value for one attachment. Images
// render `inline` (task spec section 18: "For images: render inline where
// useful"); every other supported type (PDF, plain text) is offered as an
// `attachment` (download/open via authenticated fetch - task spec: "For
// PDF/other files: download/open"). Both branches still include a safe,
// sanitized filename (via `filename*` RFC 5987 UTF-8 encoding, which also
// naturally handles non-ASCII names without needing a second escaping
// scheme) so a browser's "Save As" dialog offers a sensible name either
// way.
function buildContentDispositionHeader(attachment) {
  const disposition = attachment.mimeType && attachment.mimeType.startsWith('image/') ? 'inline' : 'attachment';
  const safeName = sanitizeContentDispositionFilename(attachment.originalName);
  return `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

// DOC-70 - the safe, outward-facing shape for one attachment - never the
// raw `objectKey`/`fileId` storage reference (task spec section 33: "Only
// safe reference metadata"). `url` always points at the authenticated
// content-proxy route below (GET .../attachments/:attachmentId/content) -
// never a raw GridFS/S3 URL (task spec section 16/36). No cache-busting
// `?v=` query parameter is needed here the way DOC-71's profile-image URL
// has one: a chat attachment is immutable and write-once (no "replace"
// flow - task spec section 32/immutable messages), so its content-proxy
// URL never changes for the lifetime of the message, and can safely be
// cached by the browser without ever going stale (see this file's own
// `Cache-Control` header below).
function sanitizeChatAttachment(messageId, attachment) {
  return {
    id: attachment._id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedAt: attachment.uploadedAt,
    url: `/chat/messages/${messageId}/attachments/${attachment._id}/content`,
  };
}

// Strips a ChatMessage document + its already-resolved author down to a
// safe, stable response shape - the exact same "author resolved
// separately, never stored redundantly" pattern
// comment.controller.js's sanitizeComment already established for DOC-13.
// Never exposes organizationId, authorId as a raw field, passwordHash, or
// any other internal User/Mongoose detail. `author` may be `null` in two
// cases, both handled identically here (task spec: "Do not crash the
// entire chat."):
//   1. The author still exists but has since been DEACTIVATED - task spec
//      explicitly requires their real name/role to remain visible on
//      historical messages, so `buildAuthorMap` below deliberately never
//      filters by `isActive` - a deactivated author is still resolved and
//      still shown with their real identity, this is NOT the fallback
//      case.
//   2. The author no longer exists at all (should not normally happen -
//      Users are never hard-deleted anywhere in this project - but this
//      is the documented, safe fallback regardless): `{ id: null,
//      fullName: 'Unknown User', role: null }`.
// DOC-72 - resolves one mentioned user id against an already-fetched
// lookup map into the safe `{ id, fullName }` shape (task spec section
// 34: "Return enough sanitized mention info for frontend rendering...
// mentions: [{id, fullName}]... Only after server resolves trusted
// users. Do not expose entire User docs."). Never `role`/`email`/
// `profileImage` - a mention chip only ever needs a name to render (the
// composer's own suggestion dropdown, a separate endpoint, is where
// role/avatar are shown instead - see `searchMentionUsers` below).
//
// FRESH-EVERY-READ, NEVER STORED (task spec section 17: "If a user's
// fullName changes later... The structural mention remains tied to
// userId. This is acceptable. Do not rewrite historical chat content.").
// This fullName is resolved from the CURRENT User document every time a
// message is read/listed - not a snapshot taken at send time. The
// literal `@OldName` text the message actually DISPLAYS inline lives
// unchanged in `content` (typed once, immutable forever) - so it is
// completely normal and expected for the two to eventually disagree
// after a rename; this function does not attempt to reconcile them.
//
// DEACTIVATED USER (task spec section 28: "existing message remains...
// according to existing notification policy... Do not mutate historical
// message"). Deliberately resolved the SAME WAY `author` already is -
// `buildUserLookupMap` below never filters by `isActive`, so a mention of
// a since-deactivated user still renders their real name, exactly like a
// deactivated message author already does.
function sanitizeMention(userId, userMap) {
  const user = userMap.get(String(userId));
  return user
    ? { id: user._id, fullName: user.fullName }
    : { id: userId, fullName: 'Unknown user' };
}

// DOC-70 - `attachments` is always an array (possibly empty), never
// `undefined` - a text-only message (every message sent before this
// ticket, and every text-only message sent after it) simply has `[]`.
// DOC-72 - `mentions` is likewise always an array (possibly empty) - a
// message sent before this ticket, or one with no mentions, simply has
// `[]` (task spec section 35: "Older messages without mention fields must
// still render. Default: []. No migration required.").
const sanitizeChatMessage = (message, author, userMap = new Map()) => ({
  id: message._id,
  content: message.content,
  author: author
    ? { id: author._id, fullName: author.fullName, role: author.role }
    : { id: null, fullName: 'Unknown User', role: null },
  attachments: (message.attachments || []).map((attachment) => sanitizeChatAttachment(message._id, attachment)),
  mentions: (message.mentionedUserIds || []).map((userId) => sanitizeMention(userId, userMap)),
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

// Batches every distinct user id referenced by a page of messages - BOTH
// the author AND every mentioned user - into at most one additional
// query, never one query per message or one query per mention (N+1), the
// same shape comment.controller.js's own buildAuthorMap already
// established, now generalized to cover DOC-72's own second kind of user
// reference on the exact same document. Scoped to organizationId as
// defense in depth. Deliberately does NOT filter by isActive - a
// deactivated member's historical messages (as author OR as a mention)
// must remain visible with their real name (task spec: "A deactivated
// user: ... historical messages remain visible" / "preserve their name
// and role in display").
async function buildUserLookupMap(messages, organizationId) {
  const userIds = new Set();
  messages.forEach((message) => {
    userIds.add(String(message.authorId));
    (message.mentionedUserIds || []).forEach((id) => userIds.add(String(id)));
  });
  if (userIds.size === 0) {
    return new Map();
  }
  const users = await User.find({ _id: { $in: Array.from(userIds) }, organizationId });
  return new Map(users.map((user) => [String(user._id), user]));
}

// GET /api/chat/messages (manager/operator/employee - see
// routes/chat.routes.js for the full authorization chain)
//
// Returns ONLY the authenticated caller's Organization messages - every
// query below starts from `{ organizationId: req.user.organizationId }`,
// never a global fetch filtered afterward (task spec: "Do not load
// messages globally and filter afterward."). organizationId is never read
// from req.body/req.query/req.params - only from req.user, the same
// trusted, fresh-per-request context every other org-scoped endpoint in
// this project already uses (DOC-38).
//
// PAGINATION (task spec's own recommended, simpler timestamp-based
// approach): `limit` (default 50, maximum 100) and `before` (an ISO
// timestamp - messages strictly older than this are returned). Both are
// validated explicitly; an invalid value of either is REJECTED with 400
// (task spec: "invalid limit rejected" / "invalid before rejected") -
// this project's own established convention (DOC-54's own filter/sort
// validation) is to reject a bad value loudly rather than silently
// clamping or ignoring it, so a limit above the maximum is rejected the
// same way a limit below 1 or a non-numeric value is, rather than being
// silently clamped down to 100 (task spec explicitly allows either choice
// - "clamp or reject consistently" - rejection was chosen for consistency
// with every other validated query parameter in this project).
//
// ORDERING: the database is queried newest-first (`{ createdAt: -1, _id:
// -1 }`, `_id` as a stable secondary key for the rare case of two
// messages sharing an identical millisecond timestamp - task spec) so
// `before`/`limit` can be expressed as a simple, efficient
// "most recent N messages older than this cursor" query - then reversed
// in memory into the chronological ascending order the frontend actually
// displays (task spec: "createdAt ascending... Oldest first, newest
// last."). This is a cheap array reverse on an already-limited, already-
// small page (at most 100 documents) - not a second database round trip
// or a full-collection sort.
//
// `meta.hasMore` tells the frontend whether an older "Load Older
// Messages" page might exist - computed by fetching one EXTRA document
// beyond `limit` and checking whether it was actually returned, never a
// separate `countDocuments` call.
//
// DOC-70 - this endpoint returns ATTACHMENT METADATA ONLY (id/
// originalName/mimeType/size/url), the same small JSON payload every
// message already carried, now with one small additional array - never
// the attachment bytes themselves. Polling (every 7 seconds, unchanged -
// see OrganizationChat.jsx) therefore never re-downloads any binary; the
// frontend's authenticated image/file components fetch actual bytes
// exactly once per attachment `url`, keyed by that same stable url string
// (see AuthenticatedChatAttachment.jsx's own comment for why a poll
// re-fetching identical metadata never triggers a second binary
// download).
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
    const { before: rawBefore, limit: rawLimit } = req.query || {};

    const { date: beforeDate, error: beforeError } = parseBeforeParam(rawBefore);
    if (beforeError) {
      return res.status(400).json({ status: 'error', message: beforeError });
    }

    const { limit, error: limitError } = parseLimitParam(rawLimit);
    if (limitError) {
      return res.status(400).json({ status: 'error', message: limitError });
    }

    const query = { organizationId: req.user.organizationId };
    if (beforeDate) {
      query.createdAt = { $lt: beforeDate };
    }

    // Fetch one extra document to cheaply detect "is there more" without
    // a second countDocuments query.
    const page = await ChatMessage
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    const hasMore = page.length > limit;
    const pageMessages = hasMore ? page.slice(0, limit) : page;
    // Reverse into chronological ascending order for display.
    const chronological = [...pageMessages].reverse();

    const userMap = await buildUserLookupMap(chronological, req.user.organizationId);
    const data = chronological.map((message) => sanitizeChatMessage(
      message,
      userMap.get(String(message.authorId)) || null,
      userMap,
    ));

    return res.status(200).json({ status: 'success', data, meta: { hasMore } });
  } catch (error) {
    return next(error);
  }
};

// POST /api/chat/messages (manager/operator/employee)
// multipart/form-data - fields: `content` (optional text), `attachments`
// (0-3 files - task spec section 13's own recommended single-atomic-
// endpoint shape: "This avoids orphaned uploads from a separate
// upload-first flow.").
//
// organizationId, authorId, role, createdAt, and updatedAt are ALL always
// server-derived or server-controlled - never trusted from the client
// (task spec sections 14/15's own explicit "never accept organizationId/
// senderId/uploadedBy from frontend" requirement). A payload like
// `{ content: "hi", organizationId: "OTHER_ORG", authorId: "OTHER_USER" }`
// still only ever produces a message authored by the authenticated
// caller, inside their own Organization, timestamped by the server -
// every other field is simply never read.
//
// TEXT-OR-ATTACHMENT REQUIREMENT (task spec section 11): valid whenever
// trimmed text is non-empty OR at least one attachment was uploaded;
// rejected only when both are empty. This check runs BEFORE any file is
// uploaded to storage (task spec section 10's own recommended safe flow:
// "Validate message text + files" happens first) - an attachment-only
// message with unsupported files is caught by
// middleware/chatUpload.js's own fileFilter/limits before this handler
// ever runs, and an all-fields-empty submission is rejected here without
// ever touching GridFS/S3.
//
// SAFE UPLOAD-THEN-SAVE ORDER, WITH CLEANUP ON FAILURE (task spec section
// 10/31): each file is uploaded to storage first (each upload failure
// aborts immediately - see the `try/catch` below - any already-uploaded
// sibling files in the SAME request are best-effort cleaned up so a
// partial multi-file upload never leaves more orphans than necessary),
// then the ChatMessage is created with the resulting reference metadata.
// If the ChatMessage.create() call itself fails (a schema validation
// error should not normally happen here since every field is
// server-constructed, but a database error is always possible), every
// attachment ALREADY uploaded for this message is best-effort deleted -
// documented tradeoff, identical in spirit to DOC-71's own
// uploadMyProfileImage: a failure at this rare cleanup step is logged
// server-side and never surfaces storage internals to the client, and
// never retried, since retrying itself could leave a second generation of
// orphans.
const createMessage = async (req, res, next) => {
  const uploadedReferences = [];
  try {
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
    // Defense in depth - middleware/chatUpload.js's own Multer `limits.files`
    // already enforces this at the multipart-parsing level (task spec
    // section 6/29: "Maximum 3 attachments"), this is a second, cheap
    // check in case this handler is ever reached a different way.
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return res.status(400).json({ status: 'error', message: `A maximum of ${MAX_ATTACHMENTS_PER_MESSAGE} attachments may be sent per message.` });
    }

    // DOC-72 - "@Mentions in Organization Chat". Parsed/shape-validated
    // BEFORE any file is uploaded (task spec section 10's own "validate
    // message text + files" ordering, extended here to "text + files +
    // mentions") - a malformed mentionUserIds payload is rejected without
    // ever touching GridFS/S3, exactly like an empty-text/zero-attachment
    // submission already is above.
    const { error: mentionParseError, ids: rawMentionIds } = parseMentionUserIdsField(body.mentionUserIds);
    if (mentionParseError) {
      return res.status(400).json({ status: 'error', message: mentionParseError });
    }

    // DOC-72 (task spec section 11) - EVERY supplied id is independently
    // re-validated against the database here - the frontend's own
    // suggestion dropdown only ever offers valid same-organization,
    // active, allowed-role users, but this endpoint never trusts that: a
    // hand-crafted request with a spoofed/cross-org/inactive/wrong-role id
    // must fail exactly as safely as one built through the real UI (task
    // spec's own standing constraint: "Do NOT allow spoofed user IDs from
    // the client without validation").
    //
    // "PREFER REJECT WITH A CLEAR SAFE ERROR" (task spec section 5) - a
    // single generic message covers every failure reason (malformed,
    // nonexistent, cross-org, inactive, disallowed role) so a cross-org
    // probe can never learn WHICH of those reasons applied (task spec
    // section 33: "Do not expose which cross-org user exists") - the
    // entire message is rejected, never partially applied with the
    // invalid mention silently dropped.
    let resolvedMentionUsers = [];
    if (rawMentionIds.length > 0) {
      resolvedMentionUsers = await User.find({
        _id: { $in: rawMentionIds },
        organizationId: req.user.organizationId,
        isActive: true,
        role: { $in: ALLOWED_MENTION_ROLES },
      });
      if (resolvedMentionUsers.length !== rawMentionIds.length) {
        return res.status(400).json({ status: 'error', message: 'One or more mentioned users could not be found.' });
      }
    }
    const mentionedUserIds = resolvedMentionUsers.map((mentionedUser) => mentionedUser._id);

    const attachmentsMetadata = [];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      const reference = await chatAttachmentStorage.uploadAttachment(file.buffer, {
        organizationId: req.user.organizationId,
        userId: req.user.userId,
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
      message = await ChatMessage.create({
        organizationId: req.user.organizationId,
        authorId: req.user.userId,
        content: trimmedContent,
        attachments: attachmentsMetadata,
        mentionedUserIds,
      });
    } catch (createError) {
      // DOC-70 (task spec section 10/31) - the message failed to save
      // AFTER attachments were already uploaded: best-effort clean up
      // every one of them so a rejected/failed message never leaves
      // permanent orphans for a routine validation-shaped failure.
      // eslint-disable-next-line no-await-in-loop
      for (const reference of uploadedReferences) {
        // eslint-disable-next-line no-await-in-loop
        await chatAttachmentStorage.deleteAttachment(reference);
      }
      throw createError;
    }

    // req.user (middleware/auth.js's verifyToken) deliberately does not
    // carry fullName - resolved with one direct lookup by _id, exactly
    // like comment.controller.js's createComment does for the identical
    // reason (exactly one author to resolve for this single new message,
    // not a batched N+1-prone lookup).
    const author = await User.findById(req.user.userId);

    // DOC-72 - "@Mentions in Organization Chat" - Notification dispatch.
    // Runs AFTER the message has already been successfully saved (task
    // spec section 24: "Message persistence is primary... prefer chat
    // message creation NOT to fail merely because notification creation
    // fails"). `createNotification` (services/notification.service.js) is
    // already unconditionally best-effort - it never throws, logging and
    // swallowing any failure internally - so no additional try/catch is
    // needed here to protect this response; the entire loop is still
    // wrapped defensively below purely so a hypothetical bug in THIS loop
    // itself (not in createNotification) could never turn an already-
    // successful message send into a 500.
    //
    // ONE NOTIFICATION PER UNIQUE MENTIONED USER (task spec section 7) -
    // trivially satisfied here since `resolvedMentionUsers` was already
    // built from `mentionedUserIds`, which was already deduplicated by
    // `parseMentionUserIdsField` before the database lookup ever ran.
    //
    // NO SELF-NOTIFICATION (task spec section 6/21) - skipped explicitly
    // here (never sends a self-mention through to createNotification at
    // all) AND independently guarded again inside createNotification
    // itself (actorId === recipientId -> silent no-op) - defense in
    // depth, not reliance on only one of the two checks.
    try {
      const recipientsExcludingSelf = resolvedMentionUsers.filter(
        (mentionedUser) => String(mentionedUser._id) !== String(req.user.userId),
      );
      for (const recipient of recipientsExcludingSelf) {
        // eslint-disable-next-line no-await-in-loop
        await createNotification({
          organizationId: req.user.organizationId,
          recipientId: recipient._id,
          actorId: req.user.userId,
          type: 'CHAT_MENTION',
          title: 'You were mentioned in Organization Chat',
          message: `${author ? author.fullName : 'Someone'} mentioned you in a chat message.`,
          // DOC-72 (task spec section 20) - "Do not duplicate full chat
          // message contents unnecessarily into Notification" - only the
          // message's own id is stored, never its text/attachments.
          metadata: { chatMessageId: message._id },
        });
      }
    } catch (notificationError) {
      // Should be unreachable (createNotification never throws), but see
      // this block's own top comment - never let a notification-layer
      // problem affect the already-successful message-send response.
      // eslint-disable-next-line no-console
      console.error('Failed to dispatch CHAT_MENTION notifications:', notificationError.message);
    }

    const mentionUserMap = new Map(resolvedMentionUsers.map((mentionedUser) => [String(mentionedUser._id), mentionedUser]));
    return res.status(201).json({ status: 'success', data: sanitizeChatMessage(message, author, mentionUserMap) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// GET /api/chat/mention-users?q=<search text> (manager/operator/employee -
// same router-level chain as list/create - task spec section 29: "Follow
// existing Organization Chat access policy... keep [System Admin]
// excluded from mention search and mention send.").
//
// Task spec section 12/13 - a dedicated, minimal-fields lookup endpoint
// for the composer's own suggestion dropdown. No existing endpoint could
// be safely reused: `GET /api/users` (routes/user.routes.js) is
// Manager-only (an Employee/Operator composing a chat message could never
// call it), and it returns far more than a mention chip ever needs
// (email, isActive, specialties, createdAt, ...).
//
// SAME-ORGANIZATION, ACTIVE, ALLOWED-ROLE ONLY (task spec sections 4/5/30)
// - identical filter shape to `createMessage`'s own server-side mention
// validation below, so a name that appears in this dropdown is
// GUARANTEED to also pass that validation at send time (barring an
// active-between-keystroke-and-send race, which createMessage's own
// re-validation - never this endpoint's results - is what actually
// protects against, per task spec section 5's own "active users only,
// re-validate at send" guidance).
//
// MINIMAL FIELDS ONLY (task spec section 12) - `id`/`fullName`/`role`/
// `hasProfileImage`. Never email (not already part of this project's chat
// UX - task spec: "Do NOT expose email unless already intentionally
// visible in chat UX", and it currently is not), never bio, never
// isActive/organizationId/any other internal field.
//
// SEARCH (task spec section 13) - case-insensitive, regex-escaped
// substring match on `fullName` only, reusing `utils/
// requestQueryBuilder.js`'s own `escapeRegExp` (the same "never let a
// caller inject a raw, potentially catastrophic-backtracking RegExp"
// guard DOC-54's own Request search already established) rather than
// writing a second copy. An empty/missing `q` returns the organization's
// most relevant members without a text filter (still capped by `limit`
// below) - this is a small, deliberately shallow "browse" affordance,
// not a full active-directory browser.
//
// RESULT CAP (task spec section 13: "Limit results: e.g. 8-10... Do not
// return entire organization user list on every keystroke") - capped at
// 8, applied at the DATABASE level (`.limit(8)`), never fetched-then-
// sliced in memory.
const MENTION_SEARCH_RESULT_LIMIT = 8;
const MAX_MENTION_SEARCH_QUERY_LENGTH = 100;

function sanitizeMentionCandidate(user) {
  return {
    id: user._id,
    fullName: user.fullName,
    role: user.role,
    hasProfileImage: !!user.profileImage,
  };
}

const searchMentionUsers = async (req, res, next) => {
  try {
    const rawQuery = req.query.q;
    let query = { organizationId: req.user.organizationId, isActive: true, role: { $in: ALLOWED_MENTION_ROLES } };

    if (rawQuery !== undefined && rawQuery !== '') {
      if (typeof rawQuery !== 'string') {
        return res.status(400).json({ status: 'error', message: 'q must be a text search term.' });
      }
      const trimmedQuery = rawQuery.trim();
      if (trimmedQuery.length > MAX_MENTION_SEARCH_QUERY_LENGTH) {
        return res.status(400).json({ status: 'error', message: `q must be at most ${MAX_MENTION_SEARCH_QUERY_LENGTH} characters.` });
      }
      if (trimmedQuery.length > 0) {
        query = { ...query, fullName: new RegExp(escapeRegExp(trimmedQuery), 'i') };
      }
    }

    const candidates = await User
      .find(query)
      .sort({ fullName: 1 })
      .limit(MENTION_SEARCH_RESULT_LIMIT);

    return res.status(200).json({ status: 'success', data: candidates.map(sanitizeMentionCandidate) });
  } catch (error) {
    return next(error);
  }
};

// GET /api/chat/messages/:messageId/attachments/:attachmentId/content
// (manager/operator/employee - same router-level chain as list/create)
//
// ORGANIZATION-SCOPED MESSAGE LOOKUP FIRST (task spec section 17 - "IDOR
// PROTECTION... Use organization-scoped message lookup first. Do not
// check attachment globally by file id alone."). The ChatMessage is
// always looked up as `{ _id: messageId, organizationId:
// req.user.organizationId }` in one query - a message that does not
// exist and a message that exists but belongs to another Organization
// produce the EXACT SAME 404 below, so a caller can never distinguish
// "wrong id" from "right id, wrong Organization" (the same DOC-38
// anti-enumeration convention every other cross-tenant lookup in this
// project already uses). The attachment itself is then looked up ONLY
// within that already-organization-scoped message's own `attachments`
// subdocument array (`message.attachments.id(attachmentId)`) - never a
// separate, global `ChatMessage.findOne({ 'attachments._id': attachmentId
// })`, which is exactly the "check attachment globally by file id alone"
// pattern the task spec explicitly warns against (it would let an
// attacker who somehow learned a valid attachmentId from Org B skip the
// Organization check entirely).
const getChatAttachmentContent = async (req, res, next) => {
  try {
    const { messageId, attachmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(messageId) || !mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid id.' });
    }

    const message = await ChatMessage.findOne({ _id: messageId, organizationId: req.user.organizationId });
    if (!message) {
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    const attachment = message.attachments.id(attachmentId);
    if (!attachment) {
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    const attachmentStream = await chatAttachmentStorage.getAttachmentStream(attachment);
    if (!attachmentStream) {
      // Covers every "bytes not found" case uniformly - a missing S3
      // object or a missing GridFS file (should be unreachable given the
      // model's own pre('validate') hook, but never trusted blindly here
      // either).
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    res.setHeader('Content-Type', attachmentStream.contentType);
    if (attachmentStream.contentLength) {
      res.setHeader('Content-Length', String(attachmentStream.contentLength));
    }
    res.setHeader('Content-Disposition', buildContentDispositionHeader(attachment));
    // Task spec section 37 - "reasonable PRIVATE caching... do not make
    // private chat attachments publicly cacheable." An attachment is
    // immutable once sent (no replace/edit flow), so a long-lived cache is
    // safe as long as it stays private to the browser that fetched it
    // with its own valid JWT - never a shared/CDN-level cache.
    res.setHeader('Cache-Control', 'private, max-age=86400');

    attachmentStream.stream.on('error', (error) => next(error));
    return attachmentStream.stream.pipe(res);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  listMessages,
  createMessage,
  searchMentionUsers,
  getChatAttachmentContent,
  sanitizeChatMessage,
  sanitizeContentDispositionFilename,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MENTION_SEARCH_RESULT_LIMIT,
};
