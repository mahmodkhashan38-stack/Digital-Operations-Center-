const express = require('express');
const verifyToken = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
const { requireOrganizationMembership, requireActiveOrganization } = require('../middleware/organizationScope');
const { uploadChatAttachments, handleChatUpload, MAX_ATTACHMENTS_PER_MESSAGE } = require('../middleware/chatUpload');
const {
  searchUsers, createConversation, listConversations, listMessages, sendMessage, markConversationRead, getAttachmentContent,
} = require('../controllers/directMessage.controller');

const router = express.Router();

// DOC-73 - "Private Direct Messages" (task spec section 19: "If reusing
// exact upload middleware is clean, do so"). The DOC-70 read-only audit
// found DM attachment rules to be byte-for-byte identical to Organization
// Chat's own (JPEG/PNG/WEBP/PDF/TXT, 10MB per file, 3 files per message) -
// reusing `middleware/chatUpload.js`'s existing Multer instance UNCHANGED
// here is therefore the correct call, not a shortcut: creating a second,
// parallel Multer config with identical rules would be pure duplication
// with no safety or clarity benefit (unlike DOC-70's OWN decision to build
// a dedicated instance instead of reusing `middleware/upload.js`, which
// was justified specifically because THOSE two features' rules genuinely
// differ - images-only/5MB/5-files for Request/Profile vs +PDF+text/10MB/
// 3-files for chat). The underlying STORAGE the uploaded bytes are
// ultimately written to is still fully independent
// (services/dmAttachmentStorage.js, its own dedicated GridFS bucket/S3
// prefix - see that file's own top comment) - only the multipart-parsing/
// validation middleware itself is shared.
const uploadDirectMessageAttachments = handleChatUpload(uploadChatAttachments.array('attachments', MAX_ATTACHMENTS_PER_MESSAGE));

// DOC-73 - reachable by ACTIVE manager/operator/employee members only -
// System Admin is structurally excluded simply by never appearing in this
// list (task spec section 6/24: "System Admin should NOT participate in
// organization DMs... Do not create special bypass" - there IS no special
// case anywhere in this file or in the controller; System Admin is
// rejected here, at the role gate, exactly the same way it is rejected
// from Organization Chat). Full chain identical in shape/order to
// routes/chat.routes.js's own (see that file's own per-middleware
// comment for the full rationale of each step - not repeated here).
router.use(
  verifyToken,
  requirePasswordChangeCompleted,
  requireRole('manager', 'operator', 'employee'),
  requireOrganizationMembership,
  requireActiveOrganization,
);

// GET /api/direct-messages/users?q=<search text> - same-Organization user
// discovery for starting a new conversation (task spec section 12).
// Registered as a literal `/users` segment - can never collide with the
// dynamic `/conversations/:conversationId/...` routes below regardless of
// registration order (different literal first segment).
router.get('/users', searchUsers);

// GET /api/direct-messages/conversations - every conversation the caller
// participates in (task spec section 13).
router.get('/conversations', listConversations);
// POST /api/direct-messages/conversations  body: { recipientId } - creates
// or returns the existing conversation for this pair (task spec sections
// 10/11).
router.post('/conversations', createConversation);

// GET /api/direct-messages/conversations/:conversationId/messages -
// cursor-paginated message history (task spec section 15).
router.get('/conversations/:conversationId/messages', listMessages);
// POST /api/direct-messages/conversations/:conversationId/messages
// multipart/form-data: content (optional text), attachments (0-3 files) -
// text-only/attachment-only/text+attachments, mirroring DOC-70 (task spec
// section 16).
router.post('/conversations/:conversationId/messages', uploadDirectMessageAttachments, sendMessage);

// POST /api/direct-messages/conversations/:conversationId/read - marks the
// CALLER's own read state (task spec section 28). No body.
router.post('/conversations/:conversationId/read', markConversationRead);

// GET .../conversations/:conversationId/messages/:messageId/attachments/:attachmentId/content
// (task spec section 18) - authenticated content-proxy, full authorization
// chain documented in the controller's own getAttachmentContent.
router.get(
  '/conversations/:conversationId/messages/:messageId/attachments/:attachmentId/content',
  getAttachmentContent,
);

// Task spec sections 46/52 - deliberately NO other routes exist on this
// router: no admin "list all conversations"/"read any conversation"/
// "export messages" endpoint (task spec section 46 - "This ticket is
// intentionally participant-private"), and no DELETE conversation route
// (task spec section 52 - "Not needed") or PATCH/DELETE message route
// (task spec section 47 - messages remain immutable, the same policy
// Organization Chat's own routes/chat.routes.js already documents).

module.exports = router;
