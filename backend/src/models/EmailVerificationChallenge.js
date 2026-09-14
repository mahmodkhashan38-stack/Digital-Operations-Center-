const mongoose = require('mongoose');

/**
 * DOC EMAIL AUTHENTICATION & NOTIFICATION UPGRADE - Email Verification.
 * -------------------------------------------------------------------------
 *
 * WHY THIS MODEL EXISTS
 * A durable, single-use record of ONE issued OTP challenge, used both by
 * public registration (a brand-new employee verifying their own email
 * before their account can ever log in) and by System-Admin-initiated
 * Manager creation (the new Manager verifying their own email, at their
 * own first login attempt - see controllers/organization.controller.js's
 * `createAndLinkManager`). Both flows share this exact same model/service
 * (services/emailVerification.service.js) - there is no second,
 * duplicated OTP implementation for "registration OTP" vs "Manager OTP".
 *
 * REPLACES PhoneVerificationChallenge (retired - see that model's own
 * former header comment / git history). Same shape, same guarantees,
 * same one-owner-of-write-logic discipline - only the delivery channel
 * (email instead of SMS) and the field name (`email` instead of
 * `phoneNumber`) changed.
 *
 * NEVER STORES A PLAINTEXT OTP - `codeHash` is a bcrypt hash of the
 * 6-digit code (services/emailVerification.service.js's own
 * `issueChallenge`). The plaintext code exists only transiently, in
 * memory, for exactly as long as it takes to hash it and hand it to
 * services/email.service.js for delivery; it is never written to this
 * document, any log line, any AuditLog entry, or any HTTP response body.
 *
 * SCHEMA
 *   userId - the account this challenge belongs to. Always a real,
 *     already-created User._id (the account exists in an
 *     `emailVerificationStatus: 'pending'` state, which is what actually
 *     blocks login, not the absence of a User document).
 *   email - the address this specific challenge was issued for,
 *     SNAPSHOTTED at issuance. Deliberately not just "read user.email at
 *     verification time" - this guards against a narrow inconsistency
 *     window if a future ticket ever allows changing an unverified email
 *     before its challenge is consumed; this challenge always verifies
 *     the exact address it was issued for.
 *   codeHash - bcrypt hash of the 6-digit OTP (see this file's own top
 *     comment).
 *   expiresAt - 10-minute expiry - see
 *     services/emailVerification.service.js's own OTP_EXPIRES_IN_MINUTES.
 *   attempts - incremented on every WRONG guess (never on a correct one,
 *     which immediately consumes the challenge instead). Limited by
 *     services/emailVerification.service.js's own MAX_OTP_ATTEMPTS.
 *   consumedAt - `null` while still usable. Set the instant a challenge is
 *     either successfully verified OR superseded by a newer challenge for
 *     the same user (services/emailVerification.service.js's own
 *     `issueChallenge` invalidates any still-pending prior challenge
 *     before creating a new one - "one-time use", extended here to also
 *     mean "at most one LIVE challenge per user at a time", which is what
 *     makes "resend code" safe rather than leaving multiple
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
const emailVerificationChallengeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
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

// The one query shape services/emailVerification.service.js actually
// performs: "the current LIVE (not yet consumed) challenge for this
// user", newest first (in case more than one somehow exists momentarily -
// defense in depth alongside the service's own invalidate-before-issue
// logic).
emailVerificationChallengeSchema.index({ userId: 1, consumedAt: 1, createdAt: -1 });

module.exports = mongoose.model('EmailVerificationChallenge', emailVerificationChallengeSchema);
