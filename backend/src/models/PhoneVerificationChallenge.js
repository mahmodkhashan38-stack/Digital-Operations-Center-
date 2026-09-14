const mongoose = require('mongoose');

/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade" - Phone Verification.
 * -------------------------------------------------------------------------
 *
 * WHY THIS MODEL EXISTS
 * A durable, single-use record of ONE issued OTP challenge, used both by
 * public registration (a brand-new employee verifying their own phone
 * before their account can ever log in) and by System-Admin-initiated
 * Manager creation (the new Manager verifying their own phone, on their
 * own device, at their own first login attempt - see
 * controllers/organization.controller.js's `createAndLinkManager`). Both
 * flows share this exact same model/service (services/
 * phoneVerification.service.js) - there is no second, duplicated OTP
 * implementation for "registration OTP" vs "Manager OTP" (task spec's own
 * repeated "do not build a second X engine" principle, already
 * established in this project by DOC-70's performPasswordReset reuse).
 *
 * NEVER STORES A PLAINTEXT OTP (task spec Phase 4 "OTP REQUIREMENTS" -
 * "Store hashed OTP/challenge data... never stored as plaintext if
 * avoidable... never logged"). `codeHash` is a bcrypt hash of the 6-digit
 * code (services/phoneVerification.service.js's own `issueChallenge`) -
 * the plaintext code exists only transiently, in memory, for exactly as
 * long as it takes to hash it and hand it to services/sms.service.js for
 * delivery; it is never written to this document, any log line, any
 * AuditLog entry, or any HTTP response body.
 *
 * SCHEMA
 *   userId - the account this challenge belongs to. Always a real,
 *     already-created User._id (see this file's own top comment on why
 *     registration creates the User row BEFORE OTP verification completes
 *     - the account exists in a `phoneVerificationStatus: 'pending'`
 *     state, which is what actually blocks login, not the absence of a
 *     User document).
 *   phoneNumber - the E.164 number this specific challenge was issued
 *     for, SNAPSHOTTED at issuance. Deliberately not just "read
 *     user.phoneNumber at verification time" - this guards against a
 *     narrow inconsistency window if a future ticket ever allows changing
 *     an unverified phone number before its challenge is consumed; this
 *     challenge always verifies the exact number it was issued for.
 *   codeHash - bcrypt hash of the 6-digit OTP (see this file's own top
 *     comment).
 *   expiresAt - task spec: "short expiration, e.g. 5-10 minutes" - see
 *     services/phoneVerification.service.js's own OTP_EXPIRES_IN_MINUTES.
 *   attempts - incremented on every WRONG guess (never on a correct one,
 *     which immediately consumes the challenge instead). Task spec:
 *     "limited attempts" - services/phoneVerification.service.js's own
 *     MAX_OTP_ATTEMPTS is the enforced ceiling.
 *   consumedAt - `null` while still usable. Set the instant a challenge is
 *     either successfully verified OR superseded by a newer challenge for
 *     the same user (services/phoneVerification.service.js's own
 *     `issueChallenge` invalidates any still-pending prior challenge
 *     before creating a new one - task spec: "one-time use", extended
 *     here to also mean "at most one LIVE challenge per user at a time",
 *     which is what makes "resend code" safe rather than leaving multiple
 *     simultaneously-valid codes outstanding).
 *   createdAt - via `timestamps` below.
 *
 * IMMUTABILITY / NO READ API
 * There is no GET endpoint for this collection anywhere in this project -
 * it exists purely as the service layer's own internal bookkeeping, never
 * surfaced to any client (not even to the account's own owner - the
 * frontend only ever learns "verified" or "not verified" via the User
 * document itself, never by reading a challenge record).
 */
const phoneVerificationChallengeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },
    codeHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  // Only `createdAt` - no `updatedAt` (mirrors UserSession/AuditLog/
  // RequestActivity's own identical choice: `attempts`/`consumedAt` are
  // this document's own explicit, purposeful mutation fields, and a
  // generic `updatedAt` would just duplicate/race with them).
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The one query shape services/phoneVerification.service.js actually
// performs: "the current LIVE (not yet consumed) challenge for this
// user", newest first (in case more than one somehow exists momentarily -
// defense in depth alongside the service's own invalidate-before-issue
// logic).
phoneVerificationChallengeSchema.index({ userId: 1, consumedAt: 1, createdAt: -1 });

module.exports = mongoose.model('PhoneVerificationChallenge', phoneVerificationChallengeSchema);
