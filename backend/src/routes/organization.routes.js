const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { requireOrganizationMembership } = require('../middleware/organizationScope');
const {
  createOrganization,
  listOrganizations,
  getOrganization,
  getMyOrganization,
  updateOrganization,
  regenerateCompanyCode,
  assignManager,
} = require('../controllers/organization.controller');

const router = express.Router();

// DOC-42: registered BEFORE the blanket system_admin gate below, with its
// own, independent, smaller middleware chain - this route is intentionally
// NOT inside `router.use(verifyToken, requireRole('system_admin'))` below,
// because it must be reachable by Manager/Operator/Employee too, not just
// System Admin. requireOrganizationMembership (not requireRole) is what
// gates it: any authenticated user who belongs to an Organization may call
// it, and it can only ever return THAT caller's own Organization (see
// getMyOrganization's doc comment - the id comes from req.user.organizationId,
// never from a client-supplied :id/query/body). Because Express matches
// routes in registration order, a GET /api/organizations/me request is
// fully handled here and never reaches the system_admin-only routes below.
router.get('/me', verifyToken, requireOrganizationMembership, getMyOrganization);

// Every Organization-management route below this point is global System
// Admin functionality (DOC-32/DOC-34). Authentication alone is not enough:
// verifyToken confirms WHO is calling, requireRole('system_admin') confirms
// they are allowed to call it - this also means an authenticated Manager
// cannot assign itself (or anyone else) as manager of any Organization
// through these routes. Applied once here with router.use() so every
// current and future route below this point is protected by default - a
// new route can't accidentally ship unprotected.
router.use(verifyToken, requireRole('system_admin'));

router.post('/', createOrganization);
router.get('/', listOrganizations);
router.get('/:id', getOrganization);
router.patch('/:id', updateOrganization);
router.post('/:id/regenerate-code', regenerateCompanyCode);
router.post('/:id/manager', assignManager);

module.exports = router;
