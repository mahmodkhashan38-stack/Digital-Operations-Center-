const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const { listOrganizationUsers, updateUserRole } = require('../controllers/user.controller');

const router = express.Router();

// DOC-35 - Organization user-role management is Manager-only. System Admin
// deliberately does NOT get access through this router - it already has
// global responsibilities via /api/organizations, and role management here
// is scoped to a single Organization by design (see requireRole below,
// which does not include 'system_admin').
//
// Full chain, applied to every route on this router:
//   verifyToken                  -> WHO is calling (fresh DB-backed context, DOC-38)
//   requireRole('manager')       -> only a Manager may call this router at all
//   requireOrganizationMembership -> defensive: manager schema already
//                                     guarantees organizationId is set, but
//                                     this keeps the same composition DOC-38
//                                     documents for every org-scoped router
//   requireActiveOrganization    -> a Manager whose own Organization has
//                                    been deactivated cannot manage roles
//                                    (DOC-38/DOC-35 section 13) - System
//                                    Admin can still reactivate it globally
//                                    via /api/organizations
router.use(verifyToken, requireRole('manager'), requireOrganizationMembership, requireActiveOrganization);

router.get('/', listOrganizationUsers);
router.patch('/:id/role', updateUserRole);

module.exports = router;
