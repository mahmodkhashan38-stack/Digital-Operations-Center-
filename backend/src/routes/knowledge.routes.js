const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const {
  createQuestion, listQuestions, getQuestion, updateQuestion, closeQuestion, reopenQuestion,
  listAnswers, createAnswer, updateAnswer, acceptAnswer, unacceptAnswer,
} = require('../controllers/knowledge.controller');

const router = express.Router();

// DOC-75 - "Organization Q&A / Knowledge Board". Reachable by ACTIVE
// manager/operator/employee members only - System Admin is structurally
// excluded simply by never appearing in this list (task spec section 8/
// 50: "System Admin should remain excluded if no org membership... No
// global knowledge surveillance page"), the identical pattern
// routes/policy.routes.js / routes/directMessage.routes.js / routes/
// chat.routes.js already establish.
//
// UNLIKE routes/policy.routes.js, NO route here adds an additional
// `requireRole('manager')` - the extra Manager privilege on
// close/reopen/accept/unaccept is "question author OR Manager" (task
// spec sections 16/19), a per-RESOURCE ownership check that a static
// route-level role gate cannot express (a Manager is not the only
// person allowed to call these routes - the question's own author, who
// may be an Employee or Operator, must be able to as well). This
// permission check therefore lives inside knowledge.controller.js's own
// `isOwnerOrManager` instead - see that file's own top comment.
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager', 'operator', 'employee'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

// GET /api/knowledge/questions - list, with pagination/search/category/
// status filters + sort (task spec section 11/12).
router.get('/questions', listQuestions);
// POST /api/knowledge/questions - any of the three allowed roles may ask
// (task spec section 8).
router.post('/questions', createQuestion);

// GET /api/knowledge/questions/:questionId - get one (task spec section
// 13). No per-role visibility restriction - see this file's own top
// comment.
router.get('/questions/:questionId', getQuestion);
// PATCH /api/knowledge/questions/:questionId - question author only
// (task spec section 21), enforced inside the controller.
router.patch('/questions/:questionId', updateQuestion);

// POST .../close and .../reopen - question author OR Manager (task spec
// sections 19/20), enforced inside the controller.
router.post('/questions/:questionId/close', closeQuestion);
router.post('/questions/:questionId/reopen', reopenQuestion);

// GET /api/knowledge/questions/:questionId/answers - oldest-first,
// paginated (task spec section 14).
router.get('/questions/:questionId/answers', listAnswers);
// POST /api/knowledge/questions/:questionId/answers - any active
// same-Organization user (task spec section 9), rejected server-side if
// the question is CLOSED (task spec section 42).
router.post('/questions/:questionId/answers', createAnswer);

// PATCH .../answers/:answerId - answer author only (task spec section
// 22), enforced inside the controller.
router.patch('/questions/:questionId/answers/:answerId', updateAnswer);

// POST .../answers/:answerId/accept - question author OR Manager (task
// spec section 16).
router.post('/questions/:questionId/answers/:answerId/accept', acceptAnswer);
// DELETE .../accepted-answer - "unaccept" (task spec section 18),
// question author OR Manager, idempotent.
router.delete('/questions/:questionId/accepted-answer', unacceptAnswer);

// Task spec section 23 - deliberately NO delete route anywhere on this
// router (no hard delete, no soft-delete field even - see
// models/KnowledgeAnswer.js's own top comment for the documented
// decision).

module.exports = router;
