const mongoose = require('mongoose');

// DOC-73 - "Private Direct Messages". One document per message, in its OWN
// collection - a DirectMessageConversation is deliberately kept small
// (see that model's own top comment on why messages are never embedded
// there, task spec section 59). Mirrors models/ChatMessage.js's own
// attachment-schema shape almost exactly (task spec section 16/19: "Reuse
// DOC-70 attachment rules where practical") but is its OWN independent
// schema/collection, not a shared one - a DirectMessage has a
// `conversationId` a ChatMessage has no concept of, and, per task spec
// section 44, NEVER a `mentionedUserIds` field: a 1:1 conversation has
// only one other possible recipient, so a structural "@mention" concept
// would be pure redundant ceremony here - a literal `@text` a person types
// in a DM remains completely ordinary, un-tokenized text.
const MAX_CONTENT_LENGTH = 2000;

// DOC-73 - metadata/reference only, byte-for-byte the same shape
// ChatMessage.js's own `chatAttachmentSchema` already established (task
// spec section 17: "Do NOT duplicate storage code unnecessarily... Use
// dedicated metadata tied to DirectMessage") - the actual bytes always
// live in GridFS/S3 via services/dmAttachmentStorage.js, never Base64,
// never embedded here.
const directMessageAttachmentSchema = new mongoose.Schema(
  {
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

function ensureDirectMessageAttachmentStorageReference(next) {
  if (!this.fileId && !this.objectKey) {
    this.invalidate('objectKey', 'A direct message attachment must reference a GridFS fileId or an S3 objectKey.');
  }
  next();
}
directMessageAttachmentSchema.pre('validate', ensureDirectMessageAttachmentStorageReference);

const directMessageSchema = new mongoose.Schema(
  {
    // Denormalized from the parent DirectMessageConversation purely so
    // every real query this feature runs (task spec section 58: "{
    // organizationId, conversationId, createdAt }") can be answered
    // without an extra lookup/join - always copied from
    // `conversation.organizationId` at send time, never independently
    // trusted from anywhere else (see the controller's own sendMessage,
    // which only ever derives this from the already-authorized
    // conversation document, never from req.body).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DirectMessageConversation',
      required: true,
      index: true,
    },
    // Always req.user.userId - who sent this message. Never trusted from
    // the client (task spec section 21).
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Same "text OR attachment" shape as ChatMessage.js (task spec section
    // 20) - not unconditionally `required` at the schema level for the
    // identical reason: an attachment-only message is valid, so an empty
    // string must remain a legitimate value whenever at least one
    // attachment exists. The real "must have SOMETHING" rule is the
    // document-level `ensureContentOrAttachment` hook below.
    content: {
      type: String,
      trim: true,
      default: '',
      maxlength: [MAX_CONTENT_LENGTH, `Message content must be at most ${MAX_CONTENT_LENGTH} characters.`],
    },
    attachments: {
      type: [directMessageAttachmentSchema],
      default: [],
    },
  },
  { timestamps: true },
);

// Task spec section 20 - identical rule/shape to ChatMessage.js's own
// `ensureContentOrAttachment`.
directMessageSchema.pre('validate', function ensureContentOrAttachment(next) {
  const hasContent = typeof this.content === 'string' && this.content.trim().length > 0;
  const hasAttachments = Array.isArray(this.attachments) && this.attachments.length > 0;
  if (!hasContent && !hasAttachments) {
    this.invalidate('content', 'Message content is required.');
  }
  next();
});

// Task spec section 58 - the two real query shapes this feature runs:
// "this conversation's messages, newest-first for pagination" and, as a
// defense-in-depth compound covering the rarer cross-conversation shape,
// "this Organization's messages in this conversation". No separate
// senderId-only index is added - nothing in this feature ever queries
// "all messages from one sender across every conversation" (unlike
// Notification's own recipientId-first indexes, which serve exactly that
// shape for a different collection).
directMessageSchema.index({ conversationId: 1, createdAt: -1 });
directMessageSchema.index({ organizationId: 1, conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('DirectMessage', directMessageSchema);
module.exports.MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH;
