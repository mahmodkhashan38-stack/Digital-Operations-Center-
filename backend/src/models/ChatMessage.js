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
// Deliberately does NOT include: attachment fields (text-only in this
// version - task spec explicitly rules out images/files/voice), an
// edited/deleted flag (messages are immutable - no PATCH/DELETE endpoint
// exists), `receiverId` (this is a shared Organization-wide channel, not
// a private message), `roomId` (exactly one implicit "room" per
// Organization - `organizationId` alone already identifies it, so a
// second field would be redundant), or read receipts. The author's
// `fullName`/`role` are also deliberately NOT stored redundantly here -
// they are always resolved fresh from `User` by the controller (see
// controllers/chat.controller.js's `sanitizeChatMessage`/
// `buildAuthorMap`), the same pattern comment.controller.js already
// established for exactly this reason: a User's `fullName`/`role` can
// change after a message was sent, and the message should always reflect
// their current identity, not a stale snapshot.
const MIN_CONTENT_LENGTH = 1;
const MAX_CONTENT_LENGTH = 2000;

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
    content: {
      type: String,
      required: true,
      trim: true,
      minlength: [MIN_CONTENT_LENGTH, 'Message content cannot be empty.'],
      maxlength: [MAX_CONTENT_LENGTH, `Message content must be at most ${MAX_CONTENT_LENGTH} characters.`],
    },
  },
  {
    timestamps: true,
  },
);

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
module.exports.MIN_CONTENT_LENGTH = MIN_CONTENT_LENGTH;
module.exports.MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH;
