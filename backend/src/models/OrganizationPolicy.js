const mongoose = require('mongoose');
const { POLICY_CATEGORIES, TITLE_MAX_LENGTH, CONTENT_MAX_LENGTH } = require('../utils/policyFieldValidation');

// DOC-74 - "Organization Policies & Guidelines".
// -----------------------------------------------------------------------
// A DEDICATED model, deliberately NOT an unbounded array embedded inside
// Organization (task spec section 2: "Do NOT embed an unlimited policy
// list directly inside Organization" - the read-only audit confirmed
// Organization.js currently holds only a small, fixed set of scalar
// settings fields (DOC-61), never an unbounded child list, and adding one
// here would risk the same 16MB BSON document ceiling this project's other
// unbounded-child features already avoid by using their own collection -
// Notification/RequestActivity/ChatMessage/DirectMessage all made the
// identical choice for the identical reason).
//
// PLAIN TEXT ONLY (task spec section 4 - CRITICAL). `content` is a plain
// String field with no HTML-aware type/sanitizer of its own - there is
// deliberately no rich-text/HTML storage anywhere in this schema. Safety
// comes entirely from the RENDERING side (Policies.jsx renders `content`
// as plain React text, never `dangerouslySetInnerHTML`) - see
// utils/policyFieldValidation.js's own `validateContent` for the full
// "storage is honest, rendering is safe" writeup, the same contract
// User.bio (DOC-71) already established.
const organizationPolicySchema = new mongoose.Schema(
  {
    // The tenant boundary (task spec: "Policies belong to exactly one
    // Organization... Managers may manage only policies from their own
    // Organization") - always derived from req.user.organizationId at
    // creation time, never trusted from req.body (see
    // controllers/policy.controller.js's own createPolicy).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [TITLE_MAX_LENGTH, `title must be at most ${TITLE_MAX_LENGTH} characters.`],
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: [CONTENT_MAX_LENGTH, `content must be at most ${CONTENT_MAX_LENGTH} characters.`],
    },
    category: {
      type: String,
      enum: POLICY_CATEGORIES,
      default: 'GENERAL',
    },
    // task spec section 6 - "Support isPublished: false / true... Manager
    // can see both Draft and Published. Employee/Operator: only
    // Published." The actual visibility gate for a non-Manager additionally
    // requires `status: 'ACTIVE'` (see `status` below) - the two flags are
    // independent (task spec section 29's own "Archived policy... Do not
    // hard-delete acknowledgement history" implies an archived policy's
    // own isPublished value is left as historical record, not force-reset
    // - see this file's own `status` comment).
    isPublished: {
      type: Boolean,
      default: false,
    },
    // task spec section 5 - "Each published policy should have a version
    // number... starts at 1... When Manager changes meaningful policy
    // content: increment version." Server-controlled ONLY - never accepted
    // from req.body on either create or update (task spec section 38:
    // "Reject/ignore attempts to submit... version. Server controls all of
    // these.") - see policy.controller.js's own explicit field allowlists.
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    // task spec section 9 - "Prefer soft-retire/archive rather than hard
    // delete if acknowledgement history exists... Recommended better
    // design: status: ACTIVE / ARCHIVED... Do not permanently destroy
    // historical acknowledgement data casually." DECISION: this project
    // implements ONLY soft-archive - there is no hard-DELETE endpoint for
    // a policy anywhere in this ticket (routes/policy.routes.js has no
    // DELETE route at all), since a PolicyAcknowledgement always
    // references a `policyId` that must keep resolving to a real document
        // for a Manager's own historical compliance reporting to remain
    // meaningful. `status: 'ARCHIVED'` (plus `archivedAt`, set once) is
    // the ONLY gate a non-Manager's policy list/detail/acknowledge checks
    // in addition to `isPublished` - archiving therefore always hides a
    // policy from Employee/Operator regardless of its own `isPublished`
    // value, without this field needing to be force-reset to `false` at
    // archive time (task spec section 29: "Archived policy: Manager can
    // still inspect history. Employee/Operator should not see it in
    // normal active policy list.").
    status: {
      type: String,
      enum: ['ACTIVE', 'ARCHIVED'],
      default: 'ACTIVE',
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    // Always req.user.userId at creation time - never trusted from the
    // client (task spec section 7/38).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Always req.user.userId, re-set on every successful update (task spec
    // section 7/38) - never trusted from the client either.
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

// Task spec section 58 - the two real query shapes this feature runs:
// "this Organization's policies, filtered by status/publish state,
// most-recently-updated first" (the Manager's own management list, and
// the Employee/Operator's own read list, both scoped identically by
// organizationId first) and "this Organization's policies in one
// category" (the optional category filter, task spec section 30). No
// separate title-text index is added - `q` search (task spec: "Do not
// overbuild") is a simple case-insensitive regex scan over an already
// small, already organization-scoped result set, not a full-text search
// feature.
organizationPolicySchema.index({ organizationId: 1, status: 1, isPublished: 1, updatedAt: -1 });
organizationPolicySchema.index({ organizationId: 1, category: 1 });

module.exports = mongoose.model('OrganizationPolicy', organizationPolicySchema);
module.exports.POLICY_CATEGORIES = POLICY_CATEGORIES;
