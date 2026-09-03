const mongoose = require('mongoose');

/**
 * UserSession (DOC-69 - "Login History & Active Sessions")
 * -------------------------------------------------------------------------
 *
 * WHY THIS MODEL EXISTS
 * Before this ticket, this project's JWTs were purely stateless: once
 * signed, a token stayed valid for its entire lifetime (`JWT_EXPIRES_IN`,
 * default 1h) with no way to invalidate it early - middleware/auth.js could
 * only check the token's own signature/expiry and re-read the ACCOUNT's
 * current `isActive` flag (DOC-38). There was no way to revoke ONE
 * specific login (e.g. "log out my phone, but not this browser") without
 * deactivating the whole account. This model adds server-side session
 * records alongside the existing JWT, without redesigning authentication:
 * the JWT still proves WHO is asking (via its signature), and now also
 * carries a `jti` (`tokenId` here) that names WHICH login it came from -
 * this document is the durable, revocable record of that login.
 *
 * NEVER STORES THE JWT ITSELF
 * `tokenId` is a random, unguessable identifier (`crypto.randomUUID()`,
 * generated fresh at login - see services/userSession.service.js) embedded
 * in the JWT's own `jti` claim. It is NOT a copy of the JWT, NOT a
 * plaintext refresh/access token, and by itself grants no access - it only
 * lets `verifyToken` look up "is the login that minted this token still
 * allowed to be used?" A leaked `tokenId` alone (e.g. from a database
 * backup) cannot authenticate as anyone; only a validly-SIGNED JWT
 * containing it can, and that signature still requires JWT_SECRET.
 *
 * SCHEMA
 *   userId - the account this login belongs to. Always `req.user.userId`/
 *     the just-authenticated User's own `_id` at login time - never
 *     client-suppliable.
 *   organizationId - copied from `user.organizationId` at login time for
 *     display/reference only (`null` for system_admin, exactly like the
 *     User document itself - task spec's own "null-safe for System Admin"
 *     requirement). Deliberately NEVER used to scope a query in this
 *     feature - session management here is stricter than DOC-38's
 *     organization isolation, it is USER-scoped: not even the acting
 *     user's own Manager can list or revoke another User's sessions
 *     through any endpoint this ticket adds (see requestSession.
 *     controller.js's own top comment).
 *   tokenId - the JWT `jti` this session was minted for. A plain unique
 *     index (below) - every session, by construction, corresponds to
 *     exactly one signed JWT, the same "one document, one real-world
 *     event" reasoning `RequestRating`'s own unique `requestId` index
 *     already uses in this project (see that model's header comment).
 *   userAgent - `req.get('user-agent')` at login time, capped at
 *     MAX_USER_AGENT_LENGTH. Display metadata only (task spec section 7)
 *     - NEVER read by any authorization decision in this project.
 *   ipAddress - the server-observed `req.ip` at login time (never a
 *     client-supplied value - see services/userSession.service.js's own
 *     comment on why, and app.js's existing TRUST_PROXY handling this
 *     reuses unchanged).
 *   createdAt - via `timestamps` below; the login time.
 *   lastActiveAt - updated (throttled - see the service) whenever this
 *     session is actually used on an authenticated request.
 *   expiresAt - set to the EXACT `exp` claim of the JWT this session was
 *     minted for (decoded right after signing, not independently computed
 *     from `JWT_EXPIRES_IN` a second time - see the login controller) so
 *     it can never drift out of sync with the token it represents.
 *   revokedAt / revokedReason - `null` for a still-active session.
 *     `revokedReason` is a CONTROLLED enum (REVOKE_REASONS below) - task
 *     spec section 25: "Do not store arbitrary sensitive strings." Once
 *     set, a session's `revokedAt`/`revokedReason` are never overwritten
 *     by a later, redundant revoke attempt (idempotency is enforced by the
 *     service layer, not by a schema-level lock).
 *
 * NO EDIT ENDPOINT
 * There is no PATCH for arbitrary session fields - a session is only ever
 * created (login) or revoked (a controlled, one-way transition). This
 * mirrors AuditLog/RequestActivity/Notification's own "immutable by the
 * complete absence of any edit endpoint" pattern already established in
 * this project.
 */
const REVOKE_REASONS = [
  'LOGOUT', // POST /api/auth/logout - the current session, self-service
  'USER_REVOKED', // DELETE /api/auth/sessions/:id - one other own session, self-service
  'LOGOUT_OTHERS', // POST /api/auth/sessions/logout-others
  'LOGOUT_ALL', // POST /api/auth/sessions/logout-all (includes current)
  'PASSWORD_CHANGED', // self-service change-password (DOC-57 Flow A)
  'PASSWORD_RESET', // Manager reset or DOC-70-approved reset (DOC-57 Flow B / DOC-70)
  'USER_DEACTIVATED', // Manager deactivation (DOC-48/DOC-50)
];

const MAX_USER_AGENT_LENGTH = 300;

const userSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
    },
    tokenId: {
      type: String,
      required: true,
    },
    userAgent: {
      type: String,
      default: null,
      maxlength: MAX_USER_AGENT_LENGTH,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedReason: {
      type: String,
      enum: REVOKE_REASONS,
      default: null,
    },
  },
  // Only `createdAt` - no `updatedAt` (the same choice AuditLog/
  // RequestActivity already make): `lastActiveAt` is this document's own,
  // deliberately-throttled "was this touched recently" field, and a
  // generic Mongoose `updatedAt` would just duplicate/race with it every
  // time either one is written.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Task spec section 29 - exactly the three indexes it names, no more:
//   - tokenId: the ONE lookup verifyToken performs on every single
//     authenticated request (task spec section 34) - must be fast, and a
//     plain unique index (not compound) is sufficient since tokenId alone
//     already identifies at most one document.
//   - userId+createdAt: "list my sessions"/"login history", newest first.
//   - userId+revokedAt+expiresAt: the "which of my sessions are currently
//     ACTIVE" shape (logout-others/logout-all's bulk update, and the
//     Active Sessions section of the list endpoint).
userSessionSchema.index({ tokenId: 1 }, { unique: true });
userSessionSchema.index({ userId: 1, createdAt: -1 });
userSessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('UserSession', userSessionSchema);
module.exports.REVOKE_REASONS = REVOKE_REASONS;
module.exports.MAX_USER_AGENT_LENGTH = MAX_USER_AGENT_LENGTH;
