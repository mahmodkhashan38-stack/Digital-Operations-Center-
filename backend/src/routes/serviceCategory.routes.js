const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const {
  createServiceCategory,
  listServiceCategories,
  listAvailableServiceCategories,
  updateServiceCategory,
  updateServiceCategoryStatus,
  createDefaultServiceCategories,
} = require('../controllers/serviceCategory.controller');

const router = express.Router();

// DOC-10 - registered BEFORE the blanket requireRole('manager') gate
// below, the same way organization.routes.js's GET /me sits before its
// own blanket system_admin gate. This is the ONLY route on this router
// that is not Manager-only: any authenticated member of an active
// Organization (Employee, Operator, or Manager) may read the active
// Category list - see listAvailableServiceCategories's own comment for
// why this does not weaken the management endpoints below.
router.get(
  '/available',
  verifyToken,
  requirePasswordChangeCompleted,
  requireOrganizationMembership,
  requireActiveOrganization,
  listAvailableServiceCategories,
);

// DOC-43 - Service Category management is Manager-only, scoped to a
// single Organization - the exact same authorization shape DOC-35/DOC-50's
// user.routes.js already uses. System Admin deliberately does NOT get
// access through this router - it already has global responsibilities via
// /api/organizations, and nothing about this task extends that; a
// system_admin token gets 403 here exactly like it would on /api/users.
//
// Full chain, applied to every route on this router:
//   verifyToken                   -> WHO is calling (fresh DB-backed context, DOC-38)
//   requireRole('manager')        -> only a Manager may call this router at all
//   requireOrganizationMembership -> defensive: manager schema already
//                                     guarantees organizationId is set, but
//                                     this keeps the same composition DOC-38
//                                     documents for every org-scoped router
//   requireActiveOrganization     -> a Manager whose own Organization has
//                                     been deactivated cannot manage
//                                     Categories - System Admin can still
//                                     reactivate it globally via
//                                     /api/organizations
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

router.get('/', listServiceCategories);
router.post('/', createServiceCategory);
// Sprint 4 - Manager-only recovery action for an Organization with zero
// Categories (or that only has inactive ones and wants the starter set
// back). Registered here, alongside the rest of this router's Manager-
// only routes (same blanket chain above) - not a special case. Safe to
// call repeatedly: see ensureDefaultServiceCategories's own comment.
router.post('/create-defaults', createDefaultServiceCategories);
router.patch('/:id', updateServiceCategory);
router.patch('/:id/status', updateServiceCategoryStatus);

module.exports = router;
