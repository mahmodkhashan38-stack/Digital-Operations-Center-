const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership } = require('../middleware/organizationScope');
const { listAuditLogs } = require('../controllers/auditLog.controller');

const router = express.Router();

// DOC-64 - "Audit Log". Manager and System Admin only (task spec section
// 26: Employee/Operator have NO access at all - not even to their own
// actions, since this is an administrative view, not a personal activity
// feed). `requireOrganizationMembership` is defensive for Manager (whose
// organizationId is already guaranteed by the User schema's own validator)
// and a structural no-op for System Admin (bypassed entirely for that
// role, DOC-38) - included for the same "compose the same building blocks
// every other organization-scoped router already uses" consistency every
// other router in this project follows.
//
// Deliberately NOT composed with `requireActiveOrganization` - this is a
// read-only endpoint, matching every other read-only, organization-scoped
// GET in this project (e.g. GET /api/organizations/me) that stays
// reachable even while the caller's own Organization has been deactivated,
// rather than the Manager-mutation routes that do require one.
//
// DOC-57 - `requirePasswordChangeCompleted` inserted immediately after
// `verifyToken`, before the role gate, the same position every other
// protected business route in this project already uses.
router.get(
  '/',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager', 'system_admin'),
  requireOrganizationMembership,
  listAuditLogs,
);

// DOC-64 - task spec section 36 ("IMMUTABILITY"): deliberately no
// PATCH/DELETE route anywhere on this router, and none should ever be
// added. No role, including System Admin, may edit or delete an audit
// entry through any API in this project.

module.exports = router;
