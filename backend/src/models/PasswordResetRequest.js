const mongoose = require('mongoose');

/**
 * DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
 * -------------------------------------------------------------------------
 *
 * WHY THIS MODEL EXISTS
 * This project deliberately has no email delivery (no SMTP, no third-party
 * provider, no reset links - task spec's own standing constraint). Recovery
 * is instead routed through the user's Organization Manager, the same
 * trusted-approval-point pattern DOC-57's "Manager Reset Password" already
 * established. This model is the durable, auditable record of ONE such
 * recovery request - it never itself changes a password. Approving a
 * request reuses the existing Manager Reset Password mechanism unchanged
 * (see controllers/user.controller.js's `performPasswordReset`, shared by
 * both `resetUserPassword` and this ticket's new approval endpoint) - this
 * model is purely a request/review record layered on top of it.
 *
 * WHAT THIS MODEL NEVER STORES (task spec section 3 - CRITICAL)
 * No password, no new/temporary password, no passwordHash, no JWT, no
 * secret of any kind. `requestedEmail` is the ONLY user-supplied value ever
 * persisted here, and it is not sensitive (it is already the User's own
 * `email` field, visible to any Manager via GET /api/users).
 *
 * ORGANIZATION ISOLATION (task spec section 8)
 * `organizationId` is always derived server-side from either (a) the
 * Organization resolved from a validated companyCode (request creation,
 * `auth.controller.js`'s `forgotPassword`) or (b) the target User's own
 * `organizationId` (approval/rejection, `user.controller.js`) - never from
 * anything client-supplied. Every read/write in this feature scopes by this
 * field, exactly like every other tenant-scoped collection in this project
 * (DOC-38).
 *
 * DUPLICATE-REQUEST PROTECTION (task spec section 4)
 * The partial unique index below (`{userId, status}` unique WHERE
 * status === 'pending'`) is database-level defense in depth - the
 * controller itself already checks for an existing pending request first
 * and returns a clear message rather than ever attempting a duplicate
 * insert, but a partial unique index (the exact same pattern
 * models/User.js already uses for "at most one system_admin") closes the
 * narrow race-condition window between that check and the insert, at zero
 * cost to every other status value (approved/rejected/cancelled requests
 * for the same user are NOT constrained by this index - a user may have
 * many historical, resolved requests, just never more than one pending one
 * at a time).
 *
 * STATUS LIFECYCLE
 *   pending   - just created by the public forgot-password endpoint.
 *   approved  - a Manager reset the password through this request; terminal.
 *   rejected  - a Manager declined the request; terminal.
 *   cancelled - reserved for a future self-service "cancel my own pending
 *     request" feature (task spec's own suggested enum includes it) - no
 *     endpoint in this ticket ever sets this value; it exists purely so a
 *     later ticket can add that without a schema migration.
 * Terminal states (approved/rejected/cancelled) can never be re-reviewed -
 * both the approve and reject endpoints re-check `status === 'pending'`
 * inside their own scoped query, so a request that already left the
 * pending state structurally cannot be approved or rejected a second time
 * (task spec section 22: "request replay after already approved/rejected"
 * must be impossible).
 */
const STATUS_VALUES = ['pending', 'approved', 'rejected', 'cancelled'];

const passwordResetRequestSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // Snapshotted at request-creation time (task spec's own suggested
  // field). Always the target User's own real `email` at that moment -
  // never a client-supplied, unverified value used for anything beyond
  // display; every authorization decision in this feature is made against
  // `userId`/`organizationId`, never against this string.
  requestedEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  status: {
    type: String,
    enum: STATUS_VALUES,
    default: 'pending',
  },
  requestedAt: {
    type: Date,
    default: Date.now,
  },
  reviewedAt: {
    type: Date,
    default: null,
  },
  // Which Manager approved/rejected this request - always
  // `req.user.userId` at the moment of review, never client-supplied.
  // `null` while still pending.
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
});

// Task spec section 4 - one pending request per user at a time, enforced
// at the database level (see this file's own top comment). Mirrors
// models/User.js's identical partial-unique-index pattern for
// "at most one system_admin".
passwordResetRequestSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

// Manager's own list view is always "my Organization, newest first,
// optionally filtered by status" - this compound index serves that exact
// query shape directly (task spec section 44-equivalent: sensible, not
// excessive, indexing).
passwordResetRequestSchema.index({ organizationId: 1, status: 1, requestedAt: -1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
