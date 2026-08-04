const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');

// DOC-60 - "Organization Chat". One main chat channel per Organization -
// every active manager/operator/employee member of an Organization shares
// the same message stream, scoped exclusively by organizationId. System
// Admin does not participate (rejected by this router's own role gate -
// see routes/chat.routes.js). Messages are immutable in this version - no
// edit/delete endpoint exists anywhere in this file.
// -----------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

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
const sanitizeChatMessage = (message, author) => ({
  id: message._id,
  content: message.content,
  author: author
    ? { id: author._id, fullName: author.fullName, role: author.role }
    : { id: null, fullName: 'Unknown User', role: null },
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

// Batches every distinct authorId in a page of messages into at most one
// additional query - never one query per message (N+1), the same shape
// comment.controller.js's buildAuthorMap already established. Scoped to
// organizationId as defense in depth. Deliberately does NOT filter by
// isActive - a deactivated member's historical messages must remain
// visible with their real name (task spec: "A deactivated user: ...
// historical messages remain visible" / "preserve their name and role in
// display").
async function buildAuthorMap(messages, organizationId) {
  const authorIds = new Set(messages.map((message) => String(message.authorId)));
  if (authorIds.size === 0) {
    return new Map();
  }
  const authors = await User.find({ _id: { $in: Array.from(authorIds) }, organizationId });
  return new Map(authors.map((author) => [String(author._id), author]));
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

    const authorMap = await buildAuthorMap(chronological, req.user.organizationId);
    const data = chronological.map((message) => sanitizeChatMessage(message, authorMap.get(String(message.authorId)) || null));

    return res.status(200).json({ status: 'success', data, meta: { hasMore } });
  } catch (error) {
    return next(error);
  }
};

// POST /api/chat/messages (manager/operator/employee)
//
// Reads exactly ONE field from the request body: content. organizationId,
// authorId, role, createdAt, and updatedAt are ALL always server-derived
// or server-controlled - never trusted from the client (task spec's own
// explicit allowlist requirement). A payload like { "content": "hi",
// "authorId": "OTHER_USER", "organizationId": "OTHER_ORG", "role":
// "manager", "createdAt": "2020-01-01" } still only ever produces a
// message authored by the authenticated caller, inside their own
// Organization, timestamped by the server - every other field is simply
// never read.
const createMessage = async (req, res, next) => {
  try {
    const body = req.body || {};

    if (typeof body.content !== 'string') {
      return res.status(400).json({ status: 'error', message: 'Message content is required.' });
    }
    const trimmed = body.content.trim();
    if (trimmed.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Message content cannot be empty.' });
    }
    if (trimmed.length > 2000) {
      return res.status(400).json({ status: 'error', message: 'Message content must be at most 2000 characters.' });
    }

    const message = await ChatMessage.create({
      organizationId: req.user.organizationId,
      authorId: req.user.userId,
      content: trimmed,
    });

    // req.user (middleware/auth.js's verifyToken) deliberately does not
    // carry fullName - resolved with one direct lookup by _id, exactly
    // like comment.controller.js's createComment does for the identical
    // reason (exactly one author to resolve for this single new message,
    // not a batched N+1-prone lookup).
    const author = await User.findById(req.user.userId);

    return res.status(201).json({ status: 'success', data: sanitizeChatMessage(message, author) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

module.exports = {
  listMessages,
  createMessage,
  sanitizeChatMessage,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
};
