const mongoose = require('mongoose');
const Comment = require('../models/Comment');
const Request = require('../models/Request');
const User = require('../models/User');
const { canReadRequestComments, canWriteRequestComments } = require('../utils/commentAccess');

// DOC-13 - Add Comments to a Request (create + view only - no edit/delete,
// see the model's own top comment for why). Reused by both GET and POST
// below so read and write authorization can never drift apart from each
// other (task spec section 11).
// -----------------------------------------------------------------

// Strips a Comment document + its already-resolved author down to a safe,
// stable response shape. `author` is a document already resolved by the
// caller via a single batched lookup (see buildAuthorMap below) - never a
// second query per comment (N+1). Only `id`/`fullName`/`role` are ever
// returned for the author - never passwordHash, email, organizationId, or
// any other raw User field. `requestId`/`organizationId`/`authorId` are
// deliberately omitted from the top level: the caller already knows which
// Request this is (it is the one they just asked about), and the nested
// `author` object already carries the identity information the frontend
// needs (task spec section 14).
const sanitizeComment = (comment, author) => ({
  id: comment._id,
  content: comment.content,
  author: author
    ? { id: author._id, fullName: author.fullName, role: author.role }
    // Defensive fallback only - every authorId is written server-side
    // from a real, currently-or-formerly-valid User in this Organization
    // (task spec section 21), so this branch should not normally be
    // reachable. It exists so a comment's history is never lost/thrown
    // away by a response-building error if an author document is ever
    // genuinely unresolvable.
    : { id: comment.authorId, fullName: 'Unknown User', role: null },
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
});

// Batches every distinct authorId in a page of Comments into at most one
// additional query (never one query per comment - N+1). Scoped to
// organizationId as defense in depth, matching request.controller.js's
// buildRequestEnrichmentMaps. Deliberately does NOT filter by isActive -
// task spec section 21 explicitly requires that a historical comment
// written by a user who has since been deactivated must remain visible
// with their real name, not be hidden or shown as "Unknown User" merely
// because they are no longer active.
async function buildAuthorMap(comments, organizationId) {
  const authorIds = new Set(comments.map((comment) => String(comment.authorId)));
  if (authorIds.size === 0) {
    return new Map();
  }
  const authors = await User.find({ _id: { $in: Array.from(authorIds) }, organizationId });
  return new Map(authors.map((author) => [String(author._id), author]));
}

// Shared lookup used by both listComments and createComment. Always scopes
// by Organization FIRST - `Request.findOne({ _id, organizationId:
// req.user.organizationId })` - never findById() followed by a manual
// comparison (task spec section 5, the same DOC-38 anti-enumeration
// pattern DOC-11/12 already established). A nonexistent Request and one
// belonging to another Organization both produce the exact same 404 - this
// never reveals which of those two actually happened. A malformed :id is
// rejected with a clean 400 before any query runs.
//
// Returns `{ requestDoc }` on success, or `null` after already having sent
// a 400/404 response itself (mirroring the "send-or-return" shape the rest
// of this controller uses to keep both handlers short).
async function loadCommentableRequest(req, res) {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    return null;
  }

  const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });

  if (!requestDoc) {
    res.status(404).json({ status: 'error', message: 'Request not found.' });
    return null;
  }

  return requestDoc;
}

// GET /api/requests/:id/comments (Employee/Operator/Manager - NOT System
// Admin)
const listComments = async (req, res, next) => {
  try {
    // System Admin manages the platform, not day-to-day Organization
    // workflow (the same rule DOC-12 already applies to status changes) -
    // rejected explicitly here rather than relying on canReadRequestComments
    // alone, and BEFORE any Request lookup, since System Admin is org-less
    // by design and must never be given a fake/borrowed Organization to
    // search against (task spec section 9).
    if (req.user.role === 'system_admin') {
      return res.status(403).json({ status: 'error', message: 'System Admin cannot access Request comments.' });
    }

    const requestDoc = await loadCommentableRequest(req, res);
    if (!requestDoc) return undefined; // response already sent (400/404)

    const authorized = canReadRequestComments({
      role: req.user.role,
      userId: req.user.userId,
      requestCreatedBy: requestDoc.createdBy,
      assignedOperatorId: requestDoc.assignedOperatorId,
    });

    if (!authorized) {
      return res.status(403).json({ status: 'error', message: 'You are not authorized to view these comments.' });
    }

    // Oldest first (createdAt ascending) - reads like a conversation (task
    // spec section 12). Scoped by BOTH requestId AND organizationId, never
    // requestId alone.
    const comments = await Comment
      .find({ requestId: requestDoc._id, organizationId: req.user.organizationId })
      .sort({ createdAt: 1 });

    const authorMap = await buildAuthorMap(comments, req.user.organizationId);

    const data = comments.map((comment) => sanitizeComment(comment, authorMap.get(String(comment.authorId)) || null));

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// POST /api/requests/:id/comments (Employee/Operator/Manager - NOT System
// Admin)
//
// Reads exactly one field from the request body: content. organizationId,
// authorId, and requestId are always server-derived - never trusted from
// the client. A payload like { "content": "test", "authorId": "OTHER_USER",
// "organizationId": "OTHER_ORG", "requestId": "OTHER_REQUEST", "createdAt":
// "..." } still only ever produces a comment authored by the authenticated
// caller, on the Request identified by the URL's :id, inside the caller's
// own Organization - every other field is simply never read (explicit
// allowlist construction, not req.body spread - see Comment.create below).
const createComment = async (req, res, next) => {
  try {
    if (req.user.role === 'system_admin') {
      return res.status(403).json({ status: 'error', message: 'System Admin cannot access Request comments.' });
    }

    const requestDoc = await loadCommentableRequest(req, res);
    if (!requestDoc) return undefined; // response already sent (400/404)

    const authorized = canWriteRequestComments({
      role: req.user.role,
      userId: req.user.userId,
      requestCreatedBy: requestDoc.createdBy,
      assignedOperatorId: requestDoc.assignedOperatorId,
      requestStatus: requestDoc.status,
    });

    if (!authorized) {
      // Distinguishing "closed and otherwise-authorized" from "never
      // authorized at all" in the message would leak Request state to a
      // caller who should not even know they *would* have had access -
      // one generic 403 covers both (mirrors DOC-12's own single 403
      // message for every unauthorized status-transition attempt).
      return res.status(403).json({ status: 'error', message: 'You are not authorized to comment on this request.' });
    }

    const body = req.body || {};
    if (typeof body.content !== 'string') {
      return res.status(400).json({ status: 'error', message: 'Comment content is required.' });
    }
    const trimmed = body.content.trim();
    if (trimmed.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Comment content cannot be empty.' });
    }
    if (trimmed.length > 2000) {
      return res.status(400).json({ status: 'error', message: 'Comment content must be at most 2000 characters.' });
    }

    const comment = await Comment.create({
      requestId: requestDoc._id,
      organizationId: req.user.organizationId,
      authorId: req.user.userId,
      content: trimmed,
    });

    // req.user (set by middleware/auth.js's verifyToken) deliberately does
    // NOT carry fullName - only { userId, role, organizationId, isActive }
    // - so the author's display name for this immediate response is
    // resolved with one direct lookup by _id (not a second N+1-prone
    // batched query; there is exactly one author to resolve here, unlike
    // listComments' page of possibly-many distinct authors).
    const author = await User.findById(req.user.userId);

    return res.status(201).json({ status: 'success', data: sanitizeComment(comment, author) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

module.exports = { listComments, createComment, sanitizeComment };
