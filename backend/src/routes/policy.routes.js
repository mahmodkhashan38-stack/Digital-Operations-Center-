const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const {
  createPolicy, updatePolicy, archivePolicy, listPolicies, getPolicy, acknowledgePolicy, getPolicyAcknowledgements,
} = require('../controllers/policy.controller');

const router = express.Router();

// DOC-74 - "Organization Policies & Guidelines" (task spec: "Policies
// belong to exactly one Organization... Employees/Operators are
// read-only"). Shared baseline identical in shape/order to
// routes/directMessage.routes.js / routes/chat.routes.js's own chain -
// System Admin is structurally excluded simply by never appearing in this
// list (task spec: "System Admin does not participate in organization
// policy reading/editing by default").
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager', 'operator', 'employee'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

// GET /api/policies - list, all three roles (backend decides visibility -
// see policy.controller.js's own listPolicies).
router.get('/', listPolicies);

// POST /api/policies - Manager only (task spec section 7). The blanket
// three-role chain above is narrowed further here with an ADDITIONAL
// `requireRole('manager')`, the exact same route-level middleware-
// stacking pattern routes/organization.routes.js's own `/me` PATCH route
// already established (see that file's own comment for the precedent).
router.post('/', requireRole('manager'), createPolicy);

// GET /api/policies/:policyId - get one, all three roles (Manager: any
// status; Employee/Operator: published+active only, else uniform 404).
router.get('/:policyId', getPolicy);

// PATCH /api/policies/:policyId - Manager only, own Organization.
router.patch('/:policyId', requireRole('manager'), updatePolicy);

// PATCH /api/policies/:policyId/archive - Manager only, own Organization.
// A dedicated endpoint, deliberately NOT part of the PATCH whitelist above
// (task spec section 8's own whitelist is exactly title/content/category/
// isPublished - see policy.controller.js's own archivePolicy for the full
// "why archive is its own action, not a PATCH field" rationale).
router.patch('/:policyId/archive', requireRole('manager'), archivePolicy);

// GET /api/policies/:policyId/acknowledgements - Manager only, compliance
// statistics + per-user acknowledgement inspection (task spec section 24).
router.get('/:policyId/acknowledgements', requireRole('manager'), getPolicyAcknowledgements);

// POST /api/policies/:policyId/acknowledge - all three roles (task spec
// section 10: "Manager may acknowledge too" - though compliance reporting
// above excludes Managers from its own denominator/list, a Manager is
// still allowed to record their own acknowledgement here).
router.post('/:policyId/acknowledge', acknowledgePolicy);

// Task spec section 9/29 - deliberately NO hard-DELETE route anywhere on
// this router (soft-archive only - see OrganizationPolicy.js's own top
// comment for the full referential-integrity rationale).

module.exports = router;
