const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const {
  createOrganization,
  listOrganizations,
  getOrganization,
  getMyOrganization,
  updateMyOrganization,
  updateOrganization,
  regenerateCompanyCode,
  assignManager,
  updateManagerProfile,
  replaceManager,
  deleteOrganization,
  getOrganizationStatistics,
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
// DOC-57 - requirePasswordChangeCompleted inserted right after
// verifyToken: GET /api/organizations/me is a normal protected business
// route (not on the task spec's explicit allowlist of GET /api/auth/me +
// PATCH /api/auth/change-password), so it is blocked like everything else
// while the caller's own mustChangePassword is true.
router.get('/me', verifyToken, requirePasswordChangeCompleted, requireOrganizationMembership, getMyOrganization);

// DOC-61 - "Organization Settings for Manager". Registered here, right
// alongside GET /me, for the identical structural reason: it must be
// reachable by a Manager token and can never share the blanket
// system_admin-only `router.use(...)` gate a few lines below. Unlike
// GET /me (any organization-scoped role may read their own Organization),
// this is Manager-ONLY (`requireRole('manager')`) - Employee/Operator
// tokens are rejected before `updateMyOrganization` is ever reached (task
// spec section 2: "Manager should have Organization Settings"; section 26
// tests 3/4: "Employee rejected" / "Operator rejected"). Also requires
// `requireActiveOrganization` (GET /me deliberately does not - a Manager
// whose Organization has been deactivated by System Admin can still SEE
// their own settings, matching every other read-only endpoint in this
// project, but cannot edit them while deactivated - the same
// active-required gate every other Manager business-mutation route in
// this project already composes, e.g. request.routes.js's
// PATCH /:id/manager).
router.patch(
  '/me',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  updateMyOrganization,
);

// Every Organization-management route below this point is global System
// Admin functionality (DOC-32/DOC-34). Authentication alone is not enough:
// verifyToken confirms WHO is calling, requireRole('system_admin') confirms
// they are allowed to call it - this also means an authenticated Manager
// cannot assign itself (or anyone else) as manager of any Organization
// through these routes. Applied once here with router.use() so every
// current and future route below this point is protected by default - a
// new route can't accidentally ship unprotected.
// DOC-57 - requirePasswordChangeCompleted inserted right after
// verifyToken, before requireRole: a System Admin whose own
// mustChangePassword is true is blocked from every route below, exactly
// like any other role would be on their own router.
router.use(verifyToken, requirePasswordChangeCompleted, requireRole('system_admin'));

router.post('/', createOrganization);
router.get('/', listOrganizations);
// DOC-53 - "Dashboard Statistics" (System Admin's platform-level slice).
// Registered here, still under this router's blanket system_admin gate
// above, but BEFORE the single-segment `/:id` route directly below - the
// same non-collision-by-registration-order convention request.routes.js
// already documents (a literal `/statistics` segment would otherwise be
// captured by `:id` if it were registered first, since both are single
// path segments; `/:id` never distinguishes a literal path from a real id
// on its own, only registration ORDER does).
router.get('/statistics', getOrganizationStatistics);
router.get('/:id', getOrganization);
router.patch('/:id', updateOrganization);
router.post('/:id/regenerate-code', regenerateCompanyCode);
router.post('/:id/manager', assignManager);
// DOC-49: PATCH edits the CURRENT Manager's own fullName/email; PUT
// replaces the Manager entirely with a new account (old one deactivated,
// never deleted/detached). Both share the same '/:id/manager' path as the
// POST above - REST method (not URL) is what distinguishes create/edit/
// replace here, consistent with PATCH vs POST already distinguishing
// "update the Organization" from "create the Organization" at '/:id' vs '/'.
router.patch('/:id/manager', updateManagerProfile);
router.put('/:id/manager', replaceManager);
// DOC-47: a dedicated DELETE route, not a repurposed PATCH - deletion is a
// distinct, higher-consequence operation (UPDATABLE_FIELDS above never
// included a way to delete via PATCH, and still doesn't).
router.delete('/:id', deleteOrganization);

module.exports = router;
