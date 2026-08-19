const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { buildCreatedAtRangeFilter } = require('../utils/requestQueryBuilder');

const { AUDIT_ACTIONS, TARGET_TYPES } = AuditLog;

// DOC-64 - "Audit Log" read API. Every function on this controller is
// scoped at the DATABASE QUERY level (never a fetch-then-filter) to
// exactly what the caller's role is allowed to see (task spec section 26):
//   - Manager: own Organization only - `organizationId` is ALWAYS
//     `req.user.organizationId`, never accepted from req.query, even if
//     the client sends one (task spec section 27: "Do not accept
//     arbitrary organizationId from Manager").
//   - System Admin: platform-wide by default; MAY narrow to one
//     Organization via a validated `?organization=<id>` filter (task spec
//     section 28: "Optional System Admin filters may include organization
//     if safely validated").
//   - Employee/Operator: never reach this controller at all - the route
//     itself (routes/auditLog.routes.js) only composes
//     `requireRole('manager', 'system_admin')`.
// -----------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

// Batch-resolves every distinct actorId in a page of audit entries in ONE
// query - never one query per entry (N+1), the same shape
// notification.controller.js's own `buildActorMap` already established.
// Deliberately NOT scoped by `organizationId` or `isActive` - an actor's
// account may since have been deactivated, or (for a System-Admin-viewed,
// cross-organization page) may belong to a different Organization than the
// audit entry's own `organizationId` (e.g. a System Admin acting on
// Organization A is themselves a platform-level account with no
// organizationId at all) - task spec section 5: "Handle deleted/
// deactivated historical actors gracefully." This project never hard-
// deletes a User, so "deleted" here really means "no longer resolvable for
// any reason" - the fallback below covers that defensively regardless.
async function buildActorMap(entries) {
  const actorIds = Array.from(new Set(entries.map((entry) => String(entry.actorId))));
  if (actorIds.length === 0) {
    return new Map();
  }
  const actors = await User.find({ _id: { $in: actorIds } });
  return new Map(actors.map((actor) => [String(actor._id), actor]));
}

// Safe actor shape (task spec section 5: "id, fullName, role") - never
// passwordHash, email, or any other User field. Falls back to a generic
// "Unknown user" identity (role: null) if the actor could not be resolved,
// rather than ever throwing or omitting the entry.
function sanitizeActor(actorId, actor) {
  if (!actor) {
    return { id: actorId, fullName: 'Unknown user', role: null };
  }
  return { id: actor._id, fullName: actor.fullName, role: actor.role };
}

// The TARGET display name is deliberately read straight from the audit
// entry's OWN already-safe `metadata` (`organizationName`/`targetUserName`/
// `categoryName` - see services/auditLog.service.js call sites in
// controllers/organization.controller.js, user.controller.js, and
// serviceCategory.controller.js, every one of which snapshots the target's
// name into metadata at write time) rather than a live lookup by
// `targetId`. This is a deliberate design choice, not a shortcut: it
// avoids an extra batched query per target TYPE on every page load, and it
// is the ONLY way a deleted target (e.g. a DOC-47 ORGANIZATION_DELETED
// entry, whose Organization document no longer exists at all) can still
// show a meaningful name instead of "Unknown" - the same snapshot
// principle Notification.title/message (DOC-18) already uses for its own
// read-once display strings. Falls back to a generic label if, for any
// reason, an entry's metadata does not carry a name (should not happen for
// any action type this ticket implements, but never throws either way).
function resolveTargetDisplayName(entry) {
  const metadata = entry.metadata || {};
  return metadata.organizationName || metadata.targetUserName || metadata.categoryName || 'Unknown';
}

// Strips one AuditLog document (+ its already-resolved actor) down to the
// safe response shape from task spec section 30 - never exposes the raw
// Mongoose document, `__v`, or anything beyond what is listed there.
function sanitizeAuditLogEntry(entry, actor) {
  return {
    id: entry._id,
    action: entry.action,
    actor: sanitizeActor(entry.actorId, actor),
    targetType: entry.targetType,
    target: { id: entry.targetId, displayName: resolveTargetDisplayName(entry) },
    changes: entry.changes || null,
    metadata: entry.metadata || {},
    organizationId: entry.organizationId || null,
    createdAt: entry.createdAt,
  };
}

// GET /api/audit-logs?limit=&before=&action=&targetType=&actor=&createdFrom=&createdTo=&organization=
//
// Manager and System Admin only (route-level `requireRole`). PAGINATION
// mirrors notification.controller.js's own `limit`/`before`-by-id cursor
// shape exactly (task spec section 29: "consistent with existing
// Notification/Chat patterns") - newest-first, `before` must itself be an
// audit-log id already visible to THIS caller (so it can never be used to
// probe entries outside their own authorized scope).
const listAuditLogs = async (req, res, next) => {
  try {
    const query = {};

    // --- organization scoping (task spec sections 26/27) -------------------
    if (req.user.role === 'manager') {
      // Always the Manager's OWN Organization - req.query.organization (or
      // any other client-supplied value) is never read for a Manager,
      // even if present in the request.
      query.organizationId = req.user.organizationId;
    } else if (req.query.organization !== undefined && req.query.organization !== '') {
      // System Admin only, and only when explicitly requested - platform-
      // wide (no organizationId filter at all) is the default. Validated
      // like every other id-based filter in this project before being
      // trusted.
      if (!mongoose.Types.ObjectId.isValid(req.query.organization)) {
        return res.status(400).json({ status: 'error', message: 'organization must be a valid organization id.' });
      }
      const organizationExists = await Organization.exists({ _id: req.query.organization });
      if (!organizationExists) {
        return res.status(400).json({ status: 'error', message: 'organization does not reference a known organization.' });
      }
      query.organizationId = req.query.organization;
    }

    // --- action filter -------------------------------------------------------
    if (req.query.action !== undefined && req.query.action !== '') {
      if (!AUDIT_ACTIONS.includes(req.query.action)) {
        return res.status(400).json({ status: 'error', message: `action must be one of: ${AUDIT_ACTIONS.join(', ')}.` });
      }
      query.action = req.query.action;
    }

    // --- targetType filter ----------------------------------------------------
    if (req.query.targetType !== undefined && req.query.targetType !== '') {
      if (!TARGET_TYPES.includes(req.query.targetType)) {
        return res.status(400).json({ status: 'error', message: `targetType must be one of: ${TARGET_TYPES.join(', ')}.` });
      }
      query.targetType = req.query.targetType;
    }

    // --- actor filter ----------------------------------------------------------
    if (req.query.actor !== undefined && req.query.actor !== '') {
      if (!mongoose.Types.ObjectId.isValid(req.query.actor)) {
        return res.status(400).json({ status: 'error', message: 'actor must be a valid user id.' });
      }
      query.actorId = req.query.actor;
    }

    // --- date range (reuses the exact same createdFrom/createdTo semantics
    // DOC-54's request search already established - see
    // utils/requestQueryBuilder.js's own header comment) ------------------
    const dateRange = buildCreatedAtRangeFilter(req.query);
    if (dateRange.error) {
      return res.status(dateRange.error.status).json({ status: 'error', message: dateRange.error.message });
    }
    Object.assign(query, dateRange.filter);

    // --- pagination ------------------------------------------------------------
    let limit = DEFAULT_LIST_LIMIT;
    if (req.query.limit !== undefined) {
      const parsedLimit = Number.parseInt(req.query.limit, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIST_LIMIT) {
        return res.status(400).json({
          status: 'error',
          message: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`,
        });
      }
      limit = parsedLimit;
    }

    if (req.query.before !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(req.query.before)) {
        return res.status(400).json({ status: 'error', message: 'before must be a valid audit log id.' });
      }
      // The cursor entry must itself be visible under the SAME scoping
      // query already built above - a Manager can never use `before` to
      // page past the boundary of their own Organization's log, even by
      // supplying an id that genuinely exists in a different Organization
      // (task spec section 44 item 41: "Manager filter remains
      // org-scoped").
      const cursorEntry = await AuditLog.findOne({ ...query, _id: req.query.before });
      if (!cursorEntry) {
        return res.status(400).json({ status: 'error', message: 'before does not reference a known audit log entry.' });
      }
      query.createdAt = { ...(query.createdAt || {}), $lt: cursorEntry.createdAt };
    }

    // Fetch one extra document to cheaply detect "is there more" without a
    // second countDocuments query - the same trick chat.controller.js's
    // listMessages and notification.controller.js's listNotifications
    // already use.
    const page = await AuditLog
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    const hasMore = page.length > limit;
    const pageItems = hasMore ? page.slice(0, limit) : page;

    const actorMap = await buildActorMap(pageItems);
    const data = pageItems.map((entry) => sanitizeAuditLogEntry(entry, actorMap.get(String(entry.actorId))));

    return res.status(200).json({
      status: 'success',
      data,
      meta: {
        hasMore,
        nextCursor: hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1]._id : null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  listAuditLogs,
  sanitizeAuditLogEntry,
};
