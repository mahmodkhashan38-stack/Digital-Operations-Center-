const mongoose = require('mongoose');

// DOC-60 - "Organization Chat". One main chat channel per Organization -
// deliberately NOT a copy of the DOC-13 Request Comments system
// (models/Comment.js): this is a separate, organization-wide
// communication feature, not tied to any single Request. No explicit
// "Chat" document is ever created for an Organization - the Organization
// chat exists logically the moment the Organization itself exists; a
// single `ChatMessage` collection scoped by `organizationId` is
// sufficient (task spec: "Do not create a separate Chat document unless
// it is genuinely necessary.").
//
// Deliberately does NOT include: an edited/deleted flag (messages remain
// immutable - no PATCH/DELETE endpoint exists, and DOC-70 does not
// introduce one - see chat.routes.js's own comment), `receiverId` (this
// is a shared Organization-wide channel, not a private message),
// `roomId` (exactly one implicit "room" per Organization -
// `organizationId` alone already identifies it, so a second field would
// be redundant), or read receipts. The author's `fullName`/`role` are
// also deliberately NOT stored redundantly here - they are always
// resolved fresh from `User` by the controller (see
// controllers/chat.controller.js's `sanitizeChatMessage`/
// `buildAuthorMap`), the same pattern comment.controller.js already
// established for exactly this reason: a User's `fullName`/`role` can
// change after a message was sent, and the message should always reflect
// their current identity, not a stale snapshot.
const MIN_CONTENT_LENGTH = 1;
const MAX_CONTENT_LENGTH = 2000;

// DOC-70 - "Organization Chat Attachments". Metadata/reference only -
// mirrors models/User.js's own `profileImageSchema` shape (DOC-71) more
// closely than models/Request.js's `attachmentSchema`: like a profile
// image, a chat attachment is never edited in place (no "replace this
// attachment" flow - a message's attachments are fixed at send time), and
// like `attachmentSchema`, this is an ARRAY (a message may carry up to 3
// attachments, task spec section 6) so `_id: true` is kept (each entry
// needs its own id for the `GET .../attachments/:attachmentId/content`
// route - task spec section 16). The actual bytes always live in GridFS
// or S3 (services/chatAttachmentStorage.js) - never Base64, never
// embedded here (task spec's own standing constraint: "Do NOT store file
// binaries directly inside ChatMessage documents").
const chatAttachmentSchema = new mongoose.Schema(
  {
    // Never trusted raw in a response header or rendered as HTML - always
    // passed through sanitizeContentDispositionFilename (chat.controller.js)
    // before ever reaching a Content-Disposition header, and always
    // rendered as plain React text on the frontend (task spec sections
    // 18/19/35).
    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [255, 'File name is too long.'],
    },
    mimeType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
      min: [1, 'File size must be greater than zero.'],
    },
    // Which of these two is populated IS the current storage provider for
    // THIS attachment - never a separate, redundant "provider" string
    // that could drift out of sync (the same convention
    // models/Request.js's `attachmentSchema` and models/User.js's
    // `profileImageSchema` already established).
    objectKey: {
      type: String,
      trim: true,
      default: null,
    },
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

// Defense in depth, identical shape to Request.js's own
// `ensureStorageReference`/User.js's own
// `ensureProfileImageStorageReference` - a saved attachment must
// reference either GridFS or S3, never neither. The controller never
// constructs one without a reference (see chat.controller.js's
// createMessage), so this should be unreachable in normal operation.
function ensureChatAttachmentStorageReference(next) {
  if (!this.fileId && !this.objectKey) {
    this.invalidate('objectKey', 'A chat attachment must reference a GridFS fileId or an S3 objectKey.');
  }
  next();
}
chatAttachmentSchema.pre('validate', ensureChatAttachmentStorageReference);

const chatMessageSchema = new mongoose.Schema(
  {
    // The tenant boundary for every query this feature ever runs (task
    // spec: "Every ChatMessage query must include: organizationId:
    // req.user.organizationId"). Always req.user.organizationId - never
    // trusted from req.body/req.query/req.params (see the controller's
    // explicit allowlist construction).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Always req.user.userId - who sent this message. Never trusted from
    // the client.
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // DOC-70 - no longer unconditionally `required` at the schema level:
    // a message may now be attachment-only (task spec section 2/11 - "text
    // is non-empty OR at least one valid attachment exists"). The "at
    // least one of content/attachments" rule is enforced in the
    // controller (createMessage), which is where the attachment upload
    // itself also happens - see that function's own comment for why this
    // could not be a simple schema-level `required`. `minlength` is
    // dropped for the same reason (an empty string is now a legitimate
    // value when at least one attachment exists); `trim`/`maxlength`
    // remain exactly as before.
    content: {
      type: String,
      trim: true,
      default: '',
      maxlength: [MAX_CONTENT_LENGTH, `Message content must be at most ${MAX_CONTENT_LENGTH} characters.`],
    },
    // DOC-70 - "Organization Chat Attachments". Defaults to an empty array
    // for every message sent before this ticket and every text-only
    // message sent after it - no migration required (the same
    // no-migration-required pattern this project's other optional-array
    // fields already established, e.g. User.specialties).
    attachments: {
      type: [chatAttachmentSchema],
      default: [],
    },
    // DOC-72 - "@Mentions in Organization Chat". USER-ID-BASED ONLY (task
    // spec section 3: "The canonical identity of a mention is: userId...
    // NOT fullName/email/username text alone" - names are not unique and
    // can change). Stores ONLY the ObjectId reference - never a copy of
    // the mentioned user's fullName/role/profileImage (task spec section
    // 9: "Do NOT store arbitrary full user objects inside message"). The
    // human-readable `@Ahmad Saleh` text the mention actually displays as
    // lives in `content` itself (typed/inserted by the sender at send
    // time - see chat.controller.js's own `sanitizeChatMessage` for how a
    // *current*, freshly-resolved fullName is additionally returned
    // alongside this id for rendering, without ever being stored here).
    // Every id in this array has ALREADY been validated by the controller
    // (valid ObjectId, exists, same organizationId, isActive, allowed
    // chat role, deduplicated, capped at MAX_MENTIONS_PER_MESSAGE) before
    // a document is ever constructed with it - this field is never
    // populated from raw, unvalidated client input.
    //
    // Defaults to an empty array for every message sent before this
    // ticket and every message with no mentions sent after it - no
    // migration required (the same pattern `attachments` above and
    // `User.specialties` already established).
    mentionedUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      validate: {
        // Defense in depth, mirrors the controller's own pre-save check -
        // the controller is the primary gate (task spec section 8), this
        // is a second, independent backstop against a future code path
        // that might construct a ChatMessage without going through it.
        validator: (value) => !Array.isArray(value) || value.length <= 10,
        message: 'A message may mention at most 10 users.',
      },
    },
  },
  {
    timestamps: true,
  },
);

// DOC-70 - "at least one of content or attachments" - the one rule that
// genuinely cannot be expressed as a single field's own validator, so it
// lives on the parent document instead (still schema-level defense in
// depth; the controller's own pre-upload check is the primary, user-
// facing gate - see createMessage's own comment on why validating this
// AFTER files are already uploaded would be too late to avoid an orphaned
// upload).
chatMessageSchema.pre('validate', function ensureContentOrAttachment(next) {
  const hasContent = typeof this.content === 'string' && this.content.trim().length > 0;
  const hasAttachments = Array.isArray(this.attachments) && this.attachments.length > 0;
  if (!hasContent && !hasAttachments) {
    this.invalidate('content', 'Message content is required.');
  }
  next();
});

// Compound index matching the one real query this feature runs: "the most
// recent messages for one Organization" (task spec's own recommended
// index). `-1` on createdAt directly serves both the default
// newest-messages-first internal fetch (see the controller's own
// pagination comment) and the `before` cursor's `$lt` range scan - no
// separate ascending-order index is added since nothing in this feature
// queries in that direction at the database level (the ascending display
// order the frontend actually shows is produced by a cheap in-memory
// `.reverse()` on an already-small, already-limited page, not a second
// index).
chatMessageSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
// DOC-70 - MIN_CONTENT_LENGTH is kept exported for backward compatibility
// but is no longer enforced as a per-field `minlength` (an empty string is
// now valid content, provided at least one attachment is present) - the
// real "must have SOMETHING" rule is `ensureContentOrAttachment` above,
// and the controller's own pre-upload check (chat.controller.js's
// createMessage).
module.exports.MIN_CONTENT_LENGTH = MIN_CONTENT_LENGTH;
module.exports.MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH;
