const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const { listMessages, createMessage } = require('../controllers/chat.controller');

const router = express.Router();

// DOC-60 - "Organization Chat" is reachable by every ACTIVE member of an
// Organization except System Admin (task spec: "System Admin does not
// participate"). Both routes on this router share the exact same
// authorization chain - unlike request.routes.js, there is no
// role-specific sub-route here that needs to be registered ahead of a
// blanket gate, so a single `router.use(...)` (the same simple shape
// user.routes.js already uses) is sufficient.
//
// Full chain, applied to every route on this router:
//   verifyToken                    -> WHO is calling (fresh DB-backed
//                                      context, DOC-38) - also rejects an
//                                      unauthenticated caller (401) and a
//                                      deactivated user's token (403,
//                                      DOC-48's own isActive check).
//   requirePasswordChangeCompleted -> a member whose OWN mustChangePassword
//                                      is true cannot read or send chat
//                                      messages until they clear that flag
//                                      first (DOC-57) - inserted
//                                      immediately after verifyToken,
//                                      before any role check, the same
//                                      role-agnostic placement every other
//                                      router in this project already uses.
//   requireRole('manager',
//     'operator', 'employee')      -> the exact three roles task spec
//                                      allows - system_admin is
//                                      structurally rejected simply by
//                                      never being in this list (403).
//   requireOrganizationMembership  -> defensive: every one of the three
//                                      allowed roles already has
//                                      organizationId set by schema, but
//                                      this keeps the same composition
//                                      DOC-38 documents for every
//                                      org-scoped router (also rejects an
//                                      org-less legacy account, 403).
//   requireActiveOrganization      -> a member of a deactivated
//                                      Organization cannot read or send
//                                      chat messages (403) - System Admin
//                                      deactivating an Organization
//                                      therefore immediately blocks chat
//                                      access through this existing
//                                      middleware, with zero new code.
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager', 'operator', 'employee'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

// GET /api/chat/messages?before=<ISO timestamp>&limit=<1-100>
router.get('/messages', listMessages);
// POST /api/chat/messages  Body: { content }
// No PATCH/DELETE route exists anywhere on this router - messages are
// immutable in DOC-60 (task spec: "Do not add: PATCH .../:id, DELETE
// .../:id. Messages are immutable.").
router.post('/messages', createMessage);

module.exports = router;
