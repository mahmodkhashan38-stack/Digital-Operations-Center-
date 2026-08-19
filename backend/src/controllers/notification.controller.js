const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { markNotificationRead, markAllNotificationsRead } = require('../services/notification.service');

// DOC-18 - "In-App Notifications". Every endpoint on this controller is
// scoped to `req.user.userId`/`req.user.organizationId` ONLY - there is no
// code path anywhere here that reads a recipientId from req.body/
// req.query/req.params (task spec section 15: "Do not let clients supply
// recipientId"). A caller can only ever read or mark-read THEIR OWN
// notifications; there is no "read another user's inbox" capability at
// any authorization level, not even Manager (task spec section 37:
// "Manager cannot read Employee notification inbox").
// -----------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

// Strips a Notification document + its already-resolved actor down to a
// safe response shape - never exposes organizationId, recipientId, __v,
// or any internal Mongo/storage/credential field (task spec section 37).
// `actor` may be `null` for a notification with no actor at all
// (`notification.actorId` itself is `null` - reserved for a future
// system-generated type, task spec section 38 item 5) OR, defensively,
// for the hypothetical case where the resolved actor could not be found
// (this project never hard-deletes a User, so this should not normally
// happen - the same "Unknown user" fallback DOC-17's own getRequestActivities
// already established for exactly this defensive case).
function sanitizeNotification(notification, actor) {
  return {
    id: notification._id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    requestId: notification.requestId || null,
    actor: notification.actorId
      ? (actor
        ? { id: actor._id, fullName: actor.fullName, role: actor.role }
        : { id: notification.actorId, fullName: 'Unknown user', role: null })
      : null,
    // Already-safe, compact, structured extra context - see
    // models/Notification.js's own comment on what this may/may not
    // contain. Passed straight through, exactly like DOC-17's own
    // `metadata` field on its activity response shape.
    metadata: notification.metadata || {},
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

// Batch-resolves every distinct actorId in a page of notifications in ONE
// query - never one query per notification (N+1), the same shape
// buildRequestEnrichmentMaps/buildAuthorMap already establish elsewhere in
// this project. Scoped to organizationId as defense in depth.
async function buildActorMap(notifications, organizationId) {
  const actorIds = Array.from(new Set(
    notifications.filter((n) => n.actorId).map((n) => String(n.actorId)),
  ));
  if (actorIds.length === 0) {
    return new Map();
  }
  const actors = await User.find({ _id: { $in: actorIds }, organizationId });
  return new Map(actors.map((actor) => [String(actor._id), actor]));
}

// GET /api/notifications?limit=<1-100>&before=<notification id>
//
// Returns ONLY the authenticated caller's own notifications, NEWEST FIRST
// (task spec section 14: "Newest first is appropriate for notifications" -
// the opposite reading order from DOC-17's own oldest-first Timeline, a
// deliberate and documented difference, not an inconsistency: a Timeline
// is read top-to-bottom as history; a notification inbox is read
// top-to-bottom as "what's new"). PAGINATION mirrors DOC-17's own
// `limit`/`before`-by-id cursor shape (task spec: "Prefer limit / before
// or another simple cursor approach") rather than chat's ISO-timestamp
// cursor - `before` must itself be a notification id already belonging to
// THIS recipient, so it can never be used to probe another user's
// notification timing (task spec section 43 item 39: "user cannot use
// cursor to cross recipient boundary").
const listNotifications = async (req, res, next) => {
  try {
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

    const query = { recipientId: req.user.userId, organizationId: req.user.organizationId };

    if (req.query.before !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(req.query.before)) {
        return res.status(400).json({ status: 'error', message: 'before must be a valid notification id.' });
      }
      const cursorNotification = await Notification.findOne({
        _id: req.query.before, recipientId: req.user.userId, organizationId: req.user.organizationId,
      });
      if (!cursorNotification) {
        return res.status(400).json({ status: 'error', message: 'before does not reference a known notification.' });
      }
      query.createdAt = { $lt: cursorNotification.createdAt };
    }

    // Fetch one extra document to cheaply detect "is there more" without a
    // second countDocuments query - the same trick chat.controller.js's
    // listMessages already uses.
    const page = await Notification
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);

    const hasMore = page.length > limit;
    const pageItems = hasMore ? page.slice(0, limit) : page;

    const actorMap = await buildActorMap(pageItems, req.user.organizationId);
    const data = pageItems.map((notification) => sanitizeNotification(
      notification,
      notification.actorId ? actorMap.get(String(notification.actorId)) : null,
    ));

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

// GET /api/notifications/unread-count
//
// Task spec section 15: counts ONLY `recipientId === req.user.id` AND
// `readAt === null`, within the caller's own organization context. The
// client can never supply/override recipientId here - there is no
// req.query.recipientId or similar read anywhere in this function.
const getUnreadCount = async (req, res, next) => {
  try {
    const unreadCount = await Notification.countDocuments({
      recipientId: req.user.userId,
      organizationId: req.user.organizationId,
      readAt: null,
    });
    return res.status(200).json({ status: 'success', data: { unreadCount } });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/notifications/:id/read
//
// Task spec section 16: only the recipient may mark their own
// notification read; idempotent (a second call for an already-read
// notification succeeds without changing `readAt`); another user (even
// one in the same Organization) gets a 404, never a 403 that would
// confirm the notification's existence - the same anti-enumeration
// posture this project already applies to Request lookups (DOC-38).
const markOneRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid notification id.' });
    }

    const notification = await markNotificationRead({
      notificationId: id,
      recipientId: req.user.userId,
      organizationId: req.user.organizationId,
    });

    if (!notification) {
      return res.status(404).json({ status: 'error', message: 'Notification not found.' });
    }

    const actor = notification.actorId
      ? await User.findOne({ _id: notification.actorId, organizationId: req.user.organizationId })
      : null;

    return res.status(200).json({ status: 'success', data: sanitizeNotification(notification, actor) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/notifications/read-all
//
// Task spec section 17: only ever affects the CALLER's own notifications -
// never another user's, even one in the same Organization. Returns
// `{modifiedCount}` (task spec: "Return useful count if easy").
const markAllRead = async (req, res, next) => {
  try {
    const { modifiedCount } = await markAllNotificationsRead({
      recipientId: req.user.userId,
      organizationId: req.user.organizationId,
    });
    return res.status(200).json({ status: 'success', data: { modifiedCount } });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  listNotifications,
  getUnreadCount,
  markOneRead,
  markAllRead,
  sanitizeNotification,
};
