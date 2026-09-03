const mongoose = require('mongoose');

// DOC-73 - "Private Direct Messages".
// -----------------------------------------------------------------------
// A DEDICATED model, deliberately NOT mixed into ChatMessage/Organization
// Chat (task spec section 2: "Do NOT mix private DMs into the Organization
// Chat collection unless the audit proves a cleaner and equally safe
// approach" - the DOC-73 read-only audit found no such case: Organization
// Chat's entire authorization model is "any active same-organization
// member may read everything", while a DM's entire point is the opposite
// - "only these exact two people may ever read this" - conflating the two
// would mean every single ChatMessage/DirectMessage read query would need
// an extra conditional branch to decide which privacy rule applies,
// forever, for two features with genuinely incompatible access models).
//
// EXACTLY TWO PARTICIPANTS, NO GROUP CHAT (task spec section 3). This is
// enforced by the `participantIds` validator below, not merely by
// controller convention - a document that ever ends up with 0, 1, 3, or a
// duplicated participant id cannot be saved at all, regardless of which
// code path constructed it.
//
// PARTICIPANT KEY / DUPLICATE-CONVERSATION PREVENTION (task spec section
// 4). `participantKey` is `sorted([userIdA, userIdB]).join(':')` - a
// deterministic string that is IDENTICAL regardless of which of the two
// participants is "A" and which is "B", so `{organizationId,
// participantKey}` can carry a UNIQUE index (below) that makes "Alice
// starts a conversation with Bob" and "Bob starts a conversation with
// Alice" always resolve to the exact same underlying document - the
// database itself refuses a second document for the same pair, not just
// the controller's own find-before-create check (defense in depth against
// a race between two concurrent "start conversation" requests - see
// controllers/directMessage.controller.js's own createConversation for how
// a duplicate-key error from this exact index is handled as a safe,
// idempotent "return the existing one" rather than a request failure).
//
// PER-PARTICIPANT READ STATE (task spec sections 26/27 - "Avoid storing
// one global `read` boolean on message because there are two
// participants... Prefer clear structured subdocuments: readStates:
// [{userId, lastReadAt}]"). A structured array (rather than a Map keyed by
// a dynamic ObjectId string, which the task spec itself flags as
// "awkward") - exactly two entries in steady state, one per participant,
// each independently updated only by its own owning user (see
// markConversationRead in the controller, which only ever touches the
// CALLER's own entry, never the other participant's - task spec section
// 28: "Do not modify other participant's state").
//
// UNBOUNDED MESSAGES ARE NEVER EMBEDDED HERE (task spec section 59) - this
// document only ever holds two participant ids, a short denormalized
// preview string, and two small read-state entries; the actual messages
// always live in the separate DirectMessage collection below, exactly the
// same "small parent document, unbounded children in their own collection"
// shape Notification/RequestActivity/ChatMessage already established.
//
// LAST-MESSAGE PREVIEW DENORMALIZATION (task spec sections 13/14/29 -
// "avoid huge per-conversation N+1 queries if avoidable"). `lastMessageAt`
// and `lastMessagePreview` are updated once, directly on this document,
// every time a message is successfully sent (see the controller's own
// sendMessage) - so GET /api/direct-messages/conversations never needs a
// second query per conversation to find "what was the last message" the
// way a naive implementation reading the DirectMessage collection
// separately for every conversation in the list would. `lastMessagePreview`
// is always a short, already-safe, already-truncated plain-text string
// (task spec section 14) - never the raw full message content, and never
// attachment internals (an attachment-only message's preview is the fixed
// string "Sent an attachment", never a filename/mimeType/objectKey).
const readStateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // `null` means "this participant has never opened this conversation
    // yet" - every message from the other participant counts as unread
    // (task spec section 29's own unread-count formula reads this
    // directly: `createdAt > lastReadAt`, and treats `null` as "the dawn
    // of time" - see controllers/directMessage.controller.js's own
    // `resolveUnreadThreshold`).
    lastReadAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const MAX_PREVIEW_LENGTH = 140;

const directMessageConversationSchema = new mongoose.Schema(
  {
    // The tenant boundary (task spec section 5) - always derived from
    // req.user.organizationId at creation time, never from req.body. Both
    // participants are validated (at creation time, in the controller) to
    // share this exact organizationId - see this file's own top comment
    // for why System Admin (organizationId always null) can therefore
    // never be a participant in any DM conversation without a special
    // bypass ever being written (task spec section 6).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Exactly two distinct User ids - see this file's own top comment.
    // Order is not meaningful (participantKey below is what makes lookups
    // order-independent) - the controller never assumes index 0 is "the
    // creator", it always finds "the other participant" by filtering out
    // req.user.userId.
    participantIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator(value) {
          if (!Array.isArray(value) || value.length !== 2) {
            return false;
          }
          const [a, b] = value.map((id) => String(id));
          return a !== b;
        },
        message: 'A direct-message conversation must have exactly two distinct participants.',
      },
    },
    // See this file's own top comment - deterministic, order-independent,
    // used only by the {organizationId, participantKey} unique index and
    // by createConversation's own existing-conversation lookup. Never
    // exposed in any API response (an internal lookup key only).
    participantKey: {
      type: String,
      required: true,
    },
    readStates: {
      type: [readStateSchema],
      default: [],
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastMessagePreview: {
      type: String,
      trim: true,
      maxlength: [MAX_PREVIEW_LENGTH, `Preview must be at most ${MAX_PREVIEW_LENGTH} characters.`],
      default: null,
    },
  },
  { timestamps: true },
);

// Task spec section 4/58 - the one index that actually enforces "no
// duplicate conversation between the same two people", scoped per
// Organization (defense in depth - participantKey alone is already
// globally unique in practice since a User only ever belongs to one
// Organization, but scoping by organizationId here costs nothing and
// keeps this index's intent self-documenting).
directMessageConversationSchema.index({ organizationId: 1, participantKey: 1 }, { unique: true });
// Task spec section 58 - serves the one real query GET
// /api/direct-messages/conversations runs: "every conversation this user
// participates in, most-recently-active first".
directMessageConversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

// Deterministic, order-independent key - see this file's own top comment.
// A free function (not an instance/static method) so the controller can
// compute a candidate key from two raw ids BEFORE any document exists yet
// (needed for the initial "does a conversation for this pair already
// exist" lookup).
function buildParticipantKey(userIdA, userIdB) {
  return [String(userIdA), String(userIdB)].sort().join(':');
}

module.exports = mongoose.model('DirectMessageConversation', directMessageConversationSchema);
module.exports.buildParticipantKey = buildParticipantKey;
module.exports.MAX_PREVIEW_LENGTH = MAX_PREVIEW_LENGTH;
