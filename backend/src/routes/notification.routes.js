const express = require('express');
const verifyToken = require('../middleware/auth');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const {
  listNotifications, getUnreadCount, markOneRead, markAllRead,
} = require('../controllers/notification.controller');

const router = express.Router();

// DOC-18 - "In-App Notifications". Reachable by every organization-scoped
// role (manager/operator/employee) - never System Admin, structurally:
// System Admin's own `organizationId` is always `null` (DOC-31), so
// `requireOrganizationMembership` already rejects it (403) before any
// notification route below ever runs, with zero new/duplicated logic
// (task spec section 37: "System Admin does not gain organization
// operational access" - satisfied by reusing this project's own existing
// isolation middleware, exactly like chat.routes.js already does for an
// analogous "every org role except System Admin" feature).
//
// Full chain, applied to every route on this router (identical
// composition to chat.routes.js/request.routes.js):
//   verifyToken                    -> WHO is calling (fresh DB-backed
//                                      context, DOC-38).
//   requirePasswordChangeCompleted -> a caller whose OWN mustChangePassword
//                                      is true cannot read or manage
//                                      notifications until they clear that
//                                      flag first (DOC-57).
//   requireOrganizationMembership  -> rejects System Admin (see above) and
//                                      any org-less legacy account.
//   requireActiveOrganization      -> a member of a deactivated
//                                      Organization cannot read/manage
//                                      notifications either.
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireOrganizationMembership,
  requireActiveOrganization,
);

// GET /api/notifications?limit=<1-100>&before=<notification id>
router.get('/', listNotifications);
// GET /api/notifications/unread-count
router.get('/unread-count', getUnreadCount);
// PATCH /api/notifications/:id/read
router.patch('/:id/read', markOneRead);
// PATCH /api/notifications/read-all
router.patch('/read-all', markAllRead);

module.exports = router;
