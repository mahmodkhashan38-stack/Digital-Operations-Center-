const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const {
  listOrganizationUsers,
  updateUserRole,
  updateUserProfile,
  updateMyProfile,
  updateUserStatus,
  updateUserSpecialties,
  resetUserPassword,
} = require('../controllers/user.controller');

const router = express.Router();

// DOC-62 - "User Profile". Registered BEFORE the blanket manager-only
// `router.use(...)` gate below, with its own small, independent chain -
// this route must be reachable by EVERY authenticated role (system_admin/
// manager/operator/employee), not just Manager. Composition, in order:
//   verifyToken                  -> WHO is calling (fresh DB-backed
//                                    context, DOC-38)
//   requirePasswordChangeCompleted -> a user whose OWN mustChangePassword
//                                    is true cannot use this endpoint
//                                    (task spec section 3/24: "Do not
//                                    accidentally let mustChangePassword
//                                    users bypass the forced change by
//                                    visiting Profile") - they must clear
//                                    that via PATCH /api/auth/change-
//                                    password first, exactly like every
//                                    other normal business route already
//                                    requires. GET /api/auth/me (reused
//                                    for READING a profile) deliberately
//                                    stays exempt from this gate, unchanged
//                                    - only this MUTATING endpoint adds it.
// Deliberately NOT composed with requireRole(...) or
// requireOrganizationMembership: system_admin's own organizationId is
// always null (DOC-31) and it must still be able to update its own
// fullName here - this is genuinely role-agnostic, self-scoped-only
// authorization, the same shape /api/organizations/me (DOC-42/DOC-61)
// already established for exactly this reason.
//
// Registered as a literal `/me` segment ahead of `/:id` below (and ahead
// of this router's own blanket gate) - the same non-collision-by-
// registration-order convention this project's other routers already
// document (a literal `/me` would otherwise be captured by `/:id` if `/:id`
// were registered first, since Express matches by registration order, not
// specificity).
router.patch('/me', verifyToken, requirePasswordChangeCompleted, updateMyProfile);

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
//
// DOC-57 - requirePasswordChangeCompleted is inserted immediately after
// verifyToken (before requireRole, since this gate is role-agnostic): a
// Manager whose OWN mustChangePassword is true cannot perform any action
// on this router - including resetting someone else's password - until
// they clear their own flag via PATCH /api/auth/change-password first.
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

router.get('/', listOrganizationUsers);
router.patch('/:id/role', updateUserRole);
// DOC-50: profile edit (fullName/email) and activate/deactivate - both
// scoped and protected-target-checked exactly like the role endpoint
// above, see resolveManageableTarget in user.controller.js.
router.patch('/:id', updateUserProfile);
router.patch('/:id/status', updateUserStatus);
// DOC-44: Manager-only, full-replacement specialty assignment for an
// Operator in the Manager's own Organization - see
// updateUserSpecialties in user.controller.js for the complete
// validation/isolation rules.
router.patch('/:id/specialties', updateUserSpecialties);
// DOC-57 - Flow B, "Manager Password Reset" - see resetUserPassword in
// user.controller.js for the complete authorization/target-protection/
// inactive-user-policy rules.
router.patch('/:id/reset-password', resetUserPassword);

module.exports = router;
