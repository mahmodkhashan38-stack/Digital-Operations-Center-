const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const { upload, handleUpload, MAX_FILES_PER_REQUEST } = require('../middleware/upload');
const {
  createRequest,
  listMyRequests,
  getMyRequestById,
  listOrganizationRequests,
  listAssignedRequests,
  updateRequestStatus,
  assignRequestOperator,
  updateMyRequest,
  cancelMyRequest,
  addRequestAttachments,
  removeRequestAttachment,
  addCompletionImages,
  removeCompletionImage,
  managerUpdateRequest,
  managerCancelRequest,
  managerCloseRequest,
  getMyRequestStatistics,
  getAssignedRequestStatistics,
  getOrganizationRequestStatistics,
} = require('../controllers/request.controller');
const { listComments, createComment } = require('../controllers/comment.controller');

const router = express.Router();

// DOC-45 - the one Multer instance used by every route that accepts image
// uploads on this router (POST / for creation, POST /:id/attachments for
// adding to an existing Request). Both use the same 'attachments' field
// name and the same per-call ceiling; the DYNAMIC "how many more can THIS
// Request accept" check (existing + new <= 5) happens inside the
// controller, which is the only place that knows a specific Request's
// current attachment count.
const uploadAttachments = handleUpload(upload.array('attachments', MAX_FILES_PER_REQUEST));

// DOC-56 - a SECOND, independent Multer instance for completion-proof
// images, reusing the exact same underlying configuration (task spec:
// "Same Multer configuration as DOC-45") but bound to its own field name,
// 'completionAttachments' - never 'attachments'. This is what keeps the
// two attachment collections structurally separate all the way from the
// HTTP boundary down to the schema (models/Request.js's own separate
// `completionAttachments` array) - a client can never accidentally (or
// deliberately) populate the wrong collection just by choosing a
// different field name, since each route below only ever wires up one of
// these two Multer instances.
const uploadCompletionAttachments = handleUpload(upload.array('completionAttachments', MAX_FILES_PER_REQUEST));

// DOC-12 - registered BEFORE the blanket requireRole('employee') gate
// below, the same way organization.routes.js's GET /me and
// serviceCategory.routes.js's GET /available sit before their own
// blanket role gates. Status updates are reachable by Employee, Operator,
// AND Manager (three different rulesets) - NOT system_admin - so this
// route cannot share the Employee-only chain every other route on this
// router uses. Authorization here is intentionally minimal
// (verifyToken + requireOrganizationMembership + requireActiveOrganization,
// no requireRole) - all role-specific transition rules live in
// updateRequestStatus/canTransitionRequestStatus, not in middleware.
// System Admin is explicitly rejected inside the controller itself, since
// requireOrganizationMembership/requireActiveOrganization both bypass
// system_admin (DOC-31/38) rather than blocking it.
router.patch(
  '/:id/status',
  verifyToken,
  requirePasswordChangeCompleted,
  requireOrganizationMembership,
  requireActiveOrganization,
  updateRequestStatus,
);

// DOC-13 - Request comments. Reachable by Employee, Operator, AND Manager
// (three different rulesets, same as DOC-12's status endpoint above) - NOT
// System Admin (rejected explicitly inside comment.controller.js, since
// requireOrganizationMembership/requireActiveOrganization both bypass
// system_admin rather than blocking it - see those middleware's own
// comments). Same minimal chain as the status endpoint: no requireRole.
// All role/Request-specific authorization lives in
// canReadRequestComments/canWriteRequestComments (utils/commentAccess.js),
// used identically by both routes so read and write access can never
// drift apart from each other.
router.get(
  '/:id/comments',
  verifyToken,
  requirePasswordChangeCompleted,
  requireOrganizationMembership,
  requireActiveOrganization,
  listComments,
);
router.post(
  '/:id/comments',
  verifyToken,
  requirePasswordChangeCompleted,
  requireOrganizationMembership,
  requireActiveOrganization,
  createComment,
);

// DOC-52 - Manager assignment + the two whole-list endpoints, all
// registered here (ahead of the blanket Employee-only gate below) for the
// same reason DOC-12's status endpoint and DOC-13's comment endpoints
// already are: none of the three are reachable by an Employee token, so
// none of them can share this router's blanket `requireRole('employee')`
// chain. Each instead gets its own single-role chain.
//
// GET /organization and GET /assigned are both registered here - BEFORE
// GET /:id (which is registered further below, after the blanket gate) -
// on purpose: Express matches route patterns in registration order, and
// `/:id` would otherwise happily (and incorrectly) match the literal path
// segment "organization" or "assigned" as if it were a Request id. This
// is the same ordering discipline organization.routes.js's GET /me and
// serviceCategory.routes.js's GET /available already established.
//
// PATCH /:id/assign has no such collision risk (it is a distinct
// two-segment path, unlike the one-segment /:id), but is kept in this
// same pre-gate block for readability, alongside the other two DOC-52
// routes it belongs with conceptually.
router.get(
  '/organization',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  listOrganizationRequests,
);
router.get(
  '/assigned',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('operator'),
  requireOrganizationMembership,
  requireActiveOrganization,
  listAssignedRequests,
);
router.patch(
  '/:id/assign',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  assignRequestOperator,
);

// Sprint 4 (DOC-59) - "Manager Request Administration". Three dedicated,
// Manager-only routes, registered here alongside the rest of this
// router's pre-gate Manager block for the exact same reason: none of them
// are reachable by an Employee token, so none of them can share this
// router's blanket `requireRole('employee')` chain below. Distinct,
// literal sub-paths under `/:id/manager...` - none of them can ever
// collide with the Employee-only `/:id`/`/:id/cancel` routes further
// down, or with each other.
router.patch(
  '/:id/manager',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  managerUpdateRequest,
);
router.patch(
  '/:id/manager/cancel',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  managerCancelRequest,
);
router.patch(
  '/:id/manager/close',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  managerCloseRequest,
);

// Sprint 4 (DOC-53) - "Dashboard Statistics". Three dedicated, single-role
// statistics routes, registered here alongside this router's other
// pre-gate sibling endpoints (GET /organization, GET /assigned) for the
// same reason: each is reachable by exactly ONE role, never the blanket
// Employee-only chain below - Manager's and Operator's statistics need a
// role check the blanket gate does not provide, and Employee's is kept
// here too purely for readability, grouped with its two siblings rather
// than split across two different places in this file. Each two-segment
// path (`/statistics/mine`, `/statistics/assigned`,
// `/statistics/organization`) can never collide with the single-segment
// `/:id` pattern registered further down - Express path parameters match
// exactly one path segment, the same non-collision guarantee `/:id/assign`
// and `/:id/manager` already rely on.
router.get(
  '/statistics/mine',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('employee'),
  requireOrganizationMembership,
  requireActiveOrganization,
  getMyRequestStatistics,
);
router.get(
  '/statistics/assigned',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('operator'),
  requireOrganizationMembership,
  requireActiveOrganization,
  getAssignedRequestStatistics,
);
router.get(
  '/statistics/organization',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager'),
  requireOrganizationMembership,
  requireActiveOrganization,
  getOrganizationRequestStatistics,
);

// DOC-56 - "Operator Completion Proof Images". Two Operator-only routes,
// registered here alongside this router's other pre-gate sibling
// endpoints for the same reason as every one of them: neither is
// reachable by an Employee token, so neither can share this router's
// blanket `requireRole('employee')` chain below - if these were
// registered AFTER that blanket `router.use(...)` line, an Operator's
// token would be rejected by the Employee-only gate before ever reaching
// this route's own `requireRole('operator')` chain. `/:id/completion-
// images` and `/:id/completion-images/:attachmentId` are both distinct,
// literal two-segment/three-segment sub-paths under `/:id/...` - neither
// can ever collide with the Employee-only `/:id`, `/:id/cancel`, or
// `/:id/attachments...` routes further down (or with each other), the
// same non-collision guarantee `/:id/assign` and `/:id/manager` already
// rely on. All ownership/status eligibility (assigned Operator only,
// status === 'in_progress' only) is enforced inside the controller via
// loadOperatorOwnedInProgressRequestOrRespond - never scattered inline
// role/state checks here.
router.post(
  '/:id/completion-images',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('operator'),
  requireOrganizationMembership,
  requireActiveOrganization,
  uploadCompletionAttachments,
  addCompletionImages,
);
router.delete(
  '/:id/completion-images/:attachmentId',
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('operator'),
  requireOrganizationMembership,
  requireActiveOrganization,
  removeCompletionImage,
);

// DOC-10 - Request creation is Employee-only, scoped to a single
// Organization - the same authorization shape every other org-scoped
// router in this project uses (DOC-38).
//
// Full chain, applied to every route on this router:
//   verifyToken                   -> WHO is calling (fresh DB-backed context, DOC-38)
//   requireRole('employee')       -> only an Employee may call this router at all
//                                     (Operator/Manager/System Admin all get 403 -
//                                     DOC-10 explicitly does not broaden this)
//   requireOrganizationMembership -> defensive: employee schema already
//                                     guarantees organizationId is set for
//                                     accounts created since DOC-33, but
//                                     this keeps the same composition DOC-38
//                                     documents for every org-scoped router
//   requireActiveOrganization     -> an Employee whose own Organization has
//                                     been deactivated cannot open a Request
// DOC-57 - requirePasswordChangeCompleted inserted right after
// verifyToken (before requireRole('employee')), the exact same "gate is
// role-agnostic, checked before any role-specific chain" placement used
// on every other router in this project.
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('employee'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

// DOC-45: multipart/form-data-capable - `uploadAttachments` parses any
// uploaded images into req.files (and every text field onto req.body)
// BEFORE createRequest runs; creating a Request with zero images still
// works unchanged (no images is a perfectly ordinary multipart or JSON
// request with an empty/absent `attachments` file field).
router.post('/', uploadAttachments, createRequest);
// DOC-11: "My Requests" list and single-Request detail, both scoped to
// this Employee's own Requests only (createdBy + organizationId, see
// request.controller.js). No Manager/Operator Request view exists on
// this router yet - later integration tasks add those separately rather
// than broadening this endpoint's authorization.
router.get('/', listMyRequests);
router.get('/:id', getMyRequestById);
// DOC-46: Edit and cancel, both Employee-only and both scoped to this
// Employee's own Requests - deliberately sharing this router's blanket
// Employee-only chain above (not a broadened one), since neither action
// is available to Operator/Manager/System Admin (task spec sections 29-
// 31). `/:id/cancel` is registered ahead of `/:id` purely for readability
// (Express already distinguishes them structurally - a one-segment
// `/:id` pattern never matches the two-segment `/:id/cancel` path, so
// there is no actual routing ambiguity either way).
router.patch('/:id/cancel', cancelMyRequest);
router.patch('/:id', updateMyRequest);
// DOC-45: add/remove image attachments, Employee-only, sharing this same
// blanket chain (task spec section 7: "Employee-only. Authorization
// chain: verifyToken, requireRole('employee'), requireOrganizationMembership,
// requireActiveOrganization"). Eligibility (open + unassigned, own
// Request, own Organization) is enforced inside the controller via the
// exact same scoped-lookup shape DOC-46 already established - never
// broadened to Operator/Manager/System Admin.
router.post('/:id/attachments', uploadAttachments, addRequestAttachments);
router.delete('/:id/attachments/:attachmentId', removeRequestAttachment);

module.exports = router;
