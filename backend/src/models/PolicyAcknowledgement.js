const mongoose = require('mongoose');

// DOC-74 - "Organization Policies & Guidelines" - acknowledgement records.
// -----------------------------------------------------------------------
// A DEDICATED, separate collection - one row per (user, policy, VERSION)
// acknowledgement, never embedded inside OrganizationPolicy itself (the
// same "unbounded child data lives in its own collection" reasoning that
// model's own top comment already documents - a policy with hundreds of
// Employees could otherwise accumulate hundreds of acknowledgement
// entries directly on the policy document).
//
// WHY VERSION IS PART OF THE IDENTITY (task spec section 14 - CRITICAL).
// If a user acknowledged policy v1 and the Manager later makes a
// meaningful change (title/content/category), producing v2, the OLD
// acknowledgement must NOT silently count as acknowledgement of v2 - a
// person who read and accepted the OLD wording never agreed to whatever
// changed. Recording `policyVersion` on every row (rather than only ever
// keeping the single "latest" acknowledgement per user, which would lose
// this history) is what lets the compliance calculation ask the narrow,
// correct question "did this user acknowledge THIS EXACT version" instead
// of the misleading "has this user ever acknowledged this policy at all".
//
// IDEMPOTENCY / NO DUPLICATES (task spec section 16). The unique index
// below on `{policyId, userId, policyVersion}` makes acknowledging the
// same version twice a database-level no-op, not merely a controller
// convention - the same "unique index is the real backstop, the
// controller's own find-first is the fast path" shape DOC-73's own
// DirectMessageConversation.participantKey index already established.
//
// IMMUTABLE, NEVER EDITED (task spec: an acknowledgement is a factual,
// one-time record - "I read this on this date" - there is no PATCH/DELETE
// endpoint for this collection anywhere, and none is needed: a NEW
// acknowledgement row is created for a NEW version instead of mutating an
// old one, preserving full historical compliance data forever (task spec
// section 9: "Do not permanently destroy historical acknowledgement data
// casually").
const policyAcknowledgementSchema = new mongoose.Schema(
  {
    // Defense in depth / query convenience - always copied from the
    // already-authorized policy's own organizationId at acknowledge time,
    // never independently trusted from anywhere else (mirrors
    // DirectMessage.organizationId's own identical "denormalized from the
    // authorized parent" rationale, DOC-73).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    policyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'OrganizationPolicy',
      required: true,
      index: true,
    },
    // Always req.user.userId - task spec section 15: "Use authenticated
    // userId. Do not accept userId in body." There is no code path in
    // controllers/policy.controller.js's own acknowledgePolicy that ever
    // reads a user identity from req.body.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    policyVersion: {
      type: Number,
      required: true,
      min: 1,
    },
    acknowledgedAt: {
      type: Date,
      default: Date.now,
    },
  },
  // No `updatedAt` - an acknowledgement is never edited after creation
  // (see this file's own top comment), so a "last updated" concept has no
  // meaning here, the same deliberate choice AuditLog.js already made for
  // the identical reason.
  { timestamps: { createdAt: false, updatedAt: false } },
);

// Task spec section 16 - THE real duplicate-prevention mechanism (the
// controller's own find-before-create is only the fast, common-case path
// - see policy.controller.js's own acknowledgePolicy for how a race
// between two concurrent acknowledge calls is handled by catching this
// exact index's duplicate-key error, the same pattern DOC-73's own
// DirectMessageConversation creation already established).
policyAcknowledgementSchema.index({ policyId: 1, userId: 1, policyVersion: 1 }, { unique: true });
// Task spec section 23/24 - serves the Manager's own compliance-statistics
// query shape: "every acknowledgement of THIS policy's CURRENT version,
// scoped to this Organization".
policyAcknowledgementSchema.index({ organizationId: 1, policyId: 1, policyVersion: 1 });

module.exports = mongoose.model('PolicyAcknowledgement', policyAcknowledgementSchema);
