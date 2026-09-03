const mongoose = require('mongoose');

/**
 * DOC-68 - "Employee Satisfaction Rating".
 * -------------------------------------------------------------------------
 *
 * WHY A SEPARATE MODEL (audit question 6)
 * A rating is a genuinely separate concern from the Request document
 * itself: it is written exactly once, long after the Request's own fields
 * have stopped changing (status is terminal - 'closed'), it is read by a
 * different audience (Manager reporting/statistics) far more often than it
 * is read alongside the Request detail itself, and most Requests will
 * never have one at all (only closed ones, and only if the Employee
 * chooses to rate). Embedding it as a field on Request would mean every
 * single Request list/detail response either grows a mostly-null
 * `rating` object or requires a second population step - the same
 * "separate, independently-queryable collection" reasoning this project
 * already applied to Comment (DOC-13), RequestActivity (DOC-17), and
 * Notification (DOC-18), all of which deliberately chose a referencing
 * collection over an embedded array/field for the identical reasons.
 *
 * ONE RATING PER REQUEST (task spec section 5 - enforced at BOTH layers)
 * The unique index on `requestId` below is the database-level guarantee;
 * `requestRating.controller.js`'s `createRating` also checks for an
 * existing rating first so a duplicate attempt gets a clean, specific
 * error message rather than ever reaching a raw Mongo duplicate-key error
 * (task spec section 31). The controller-level check narrows the common
 * case; the index is what makes a genuinely concurrent double-submission
 * impossible regardless.
 *
 * WHAT THIS MODEL NEVER STORES
 * No raw HTML (comment is plain text only, validated and stored as-is -
 * rendered as text by React, never via `dangerouslySetInnerHTML` - see
 * frontend's RequestRatingSection.jsx). No password/secret of any kind.
 *
 * IMMUTABILITY (task spec section 14)
 * No edit/delete endpoint exists anywhere for this model. A rating
 * represents a one-time historical service evaluation, exactly like
 * RequestActivity's own immutability rationale - there is no current
 * requirement in this ticket that would justify the extra
 * authorization/audit surface an edit/delete endpoint would add.
 *
 * OPERATOR ATTRIBUTION (task spec section 8, decision documented here)
 * `operatorId` is always read from `request.assignedOperatorId` at rating
 * time, never from the client. Audited: `assignRequestOperator`
 * (request.controller.js) only permits assign/reassign/unassign while
 * `status === 'open'` - once a Request progresses to `in_progress` (which
 * itself requires an assigned Operator to transition it there),
 * `assignedOperatorId` can never change again through any endpoint. By
 * the time a Request reaches `closed`, its `assignedOperatorId` is
 * therefore already the one, final Operator who actually did the work -
 * there is no reassignment-after-completion path to worry about. `null`
 * is still explicitly supported (schema default `null`, never required)
 * as defense in depth for a theoretical historical/data-integrity edge
 * case (a closed Request somehow missing an assignment) - rating creation
 * never crashes or refuses to proceed merely because this is null.
 *
 * HISTORICAL / INACTIVE USERS (task spec section 36)
 * `employeeId`/`operatorId` are never denormalized copies of a User's
 * name - only the reference id is stored, resolved to a safe display name
 * (with an "Unknown user" fallback) at READ time by the controller,
 * exactly like every other historical-actor-resolution pattern in this
 * project (RequestActivity's actorId, Comment's authorId, AuditLog's
 * actorId). A User being deactivated later never deletes or hides an
 * existing rating.
 */
const MIN_SCORE = 1;
const MAX_SCORE = 5;
const MAX_COMMENT_LENGTH = 500;

const requestRatingSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // One rating per Request, enforced by the unique index below.
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
    },
    // Always `request.createdBy` at submission time - the Employee who
    // opened the Request, never anyone else (task spec section 7).
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Always `request.assignedOperatorId` at submission time - see this
    // file's own header comment for the full "why this is safe" audit.
    // Nullable (defense in depth only - see above), never required.
    operatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    score: {
      type: Number,
      required: true,
      min: [MIN_SCORE, `score must be between ${MIN_SCORE} and ${MAX_SCORE}.`],
      max: [MAX_SCORE, `score must be between ${MIN_SCORE} and ${MAX_SCORE}.`],
      validate: {
        // Defense in depth beyond min/max - rejects a non-integer (e.g.
        // 2.5) at the schema level too, even though the controller's own
        // authoritative validation (Number.isInteger) already rejects it
        // first in the normal request path.
        validator: Number.isInteger,
        message: 'score must be a whole number.',
      },
    },
    // Optional plain-text feedback (task spec section 3/13) - trimmed,
    // capped at MAX_COMMENT_LENGTH, never HTML. An empty/whitespace-only
    // comment normalizes to `null` (see requestRating.controller.js),
    // never an empty string - the same "empty means nothing to say, not
    // an empty-but-present value" convention `cancelReason`/`comment`
    // fields elsewhere in this project already use.
    comment: {
      type: String,
      trim: true,
      default: null,
      maxlength: [MAX_COMMENT_LENGTH, `comment must be at most ${MAX_COMMENT_LENGTH} characters.`],
    },
  },
  {
    // Task spec section 4 - createdAt only, no updatedAt (a rating is
    // never updated - see this file's own immutability comment above).
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Task spec section 5 - the database-level half of "one rating per
// Request", the same partial/plain unique-index pattern this project
// already uses (models/User.js's system_admin index,
// models/PasswordResetRequest.js's pending-request index) - here a plain
// (non-partial) unique index is correct because EVERY RequestRating
// document that exists at all is, by definition, for exactly one
// Request; there is no "some ratings don't count" case to carve out with
// a partial filter.
requestRatingSchema.index({ requestId: 1 }, { unique: true });

// Manager's own list/statistics queries are always "my Organization,
// newest first, optionally filtered by score/operator/date" - this
// compound index serves that shape directly, mirroring
// PasswordResetRequest's identical `{organizationId, status, requestedAt}`
// index for the analogous reason.
requestRatingSchema.index({ organizationId: 1, createdAt: -1 });
// Per-operator breakdown (task spec section 19) - scoped by Organization
// first, then Operator.
requestRatingSchema.index({ organizationId: 1, operatorId: 1 });

module.exports = mongoose.model('RequestRating', requestRatingSchema);
module.exports.MIN_SCORE = MIN_SCORE;
module.exports.MAX_SCORE = MAX_SCORE;
module.exports.MAX_COMMENT_LENGTH = MAX_COMMENT_LENGTH;
