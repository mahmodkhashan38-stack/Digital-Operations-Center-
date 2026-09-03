const crypto = require('crypto');
const UserSession = require('../models/UserSession');
const { MAX_USER_AGENT_LENGTH } = UserSession;

/**
 * UserSession - creation / verification / revocation service (DOC-69)
 * -------------------------------------------------------------------------
 * The sole owner of all UserSession writes, mirroring the "one owner of
 * write logic" discipline requestActivity.service.js (DOC-17),
 * notification.service.js (DOC-18), and auditLog.service.js (DOC-64)
 * already established in this project - controllers never call
 * `UserSession.create`/`.updateMany` directly.
 *
 * SESSION FIXATION (task spec section 30)
 * `generateTokenId` is the ONLY place a `tokenId` is ever produced, and it
 * is called exactly once per successful login (auth.controller.js's
 * `login`) - a fresh, unguessable, cryptographically random id every time,
 * never reused, never accepted from a request body/query/header. There is
 * no code path anywhere in this project that lets a client supply its own
 * `jti`/`tokenId` and have it accepted.
 */
function generateTokenId() {
  return crypto.randomUUID();
}

// Task spec section 6/7 - server-observed metadata only, capped length,
// display-only. `req.ip` already respects this app's own explicit,
// opt-in-only `trust proxy` configuration (see app.js's own comment) - this
// function never re-parses X-Forwarded-For itself, and never reads an IP
// from the request body (task spec section 6: "Do NOT accept IP address
// from request body").
function captureRequestMetadata(req) {
  const rawUserAgent = req.get('user-agent') || null;
  const userAgent = rawUserAgent ? rawUserAgent.slice(0, MAX_USER_AGENT_LENGTH) : null;
  const ipAddress = req.ip || null;
  return { userAgent, ipAddress };
}

// Called once, immediately after a successful login, with the JWT already
// signed. `jwtExpiresAt` is decoded from the JWT's OWN `exp` claim (see
// auth.controller.js's `login`) rather than independently re-parsing
// `JWT_EXPIRES_IN` a second time here - task spec section 9: "Session
// expiresAt should correspond to JWT expiry" - this makes that
// correspondence exact by construction, not by keeping two independent
// calculations in sync by hand.
async function createSession({
  userId, organizationId, tokenId, req, jwtExpiresAt,
}) {
  const { userAgent, ipAddress } = captureRequestMetadata(req);
  return UserSession.create({
    userId,
    organizationId: organizationId || null,
    tokenId,
    userAgent,
    ipAddress,
    lastActiveAt: new Date(),
    expiresAt: jwtExpiresAt,
    revokedAt: null,
    revokedReason: null,
  });
}

// The ONE lookup middleware/auth.js performs on every authenticated
// request (task spec section 34) - by the unique `tokenId` index only,
// never a broader scan. Returns the raw document (possibly revoked/expired
// - the caller decides what that means) or `null` if no session was ever
// created for this tokenId at all (e.g. a pre-DOC-69 token with no `jti`
// never reaches this call in the first place - see middleware/auth.js).
async function findSessionByTokenId(tokenId) {
  if (!tokenId) return null;
  return UserSession.findOne({ tokenId });
}

// Task spec section 8 - "Avoid a database write on every single API
// request... Use throttling." Only writes when the session has not been
// touched in the last LAST_ACTIVE_THROTTLE_MS - a single targeted
// `updateOne` by `_id` (already indexed via `_id`'s own default index),
// never a full document re-save. Fire-and-forget from the caller's point
// of view is unnecessary here (this is already a single, cheap, indexed
// write when it does happen) but it never throws outward - a failure to
// record "last active" must never fail the request it is piggybacking on.
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

async function touchLastActive(session) {
  const now = Date.now();
  const lastWrite = session.lastActiveAt ? session.lastActiveAt.getTime() : 0;
  if (now - lastWrite < LAST_ACTIVE_THROTTLE_MS) {
    return;
  }
  try {
    await UserSession.updateOne({ _id: session._id }, { $set: { lastActiveAt: new Date(now) } });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to update UserSession.lastActiveAt:', error.message);
  }
}

// Task spec section 9 - "active = not revoked AND expiresAt > now",
// centralized in exactly one place (task spec section 24: "Centralize
// logic") so the middleware, the list endpoint, and the bulk-revoke
// endpoints can never disagree with each other about what "active" means.
function isSessionActive(session, now = new Date()) {
  return !session.revokedAt && session.expiresAt > now;
}

// Task spec section 24 - the three states the frontend ever needs to
// render (ACTIVE / REVOKED / EXPIRED), computed the same way everywhere.
function classifySessionStatus(session, now = new Date()) {
  if (session.revokedAt) return 'REVOKED';
  if (session.expiresAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

// Revokes exactly one session document, idempotently: a session that is
// ALREADY inactive (already revoked, or already naturally expired) is left
// completely untouched - its original `revokedAt`/`revokedReason` (or lack
// thereof) is never overwritten by a later, redundant revoke call (task
// spec sections 14/39: "repeated revoke behaves safely" /
// "already expired/revoked unaffected"). Returns `true` if this call
// actually changed anything, `false` if it was a no-op.
async function revokeSession(session, reason) {
  if (!isSessionActive(session)) {
    return false;
  }
  session.revokedAt = new Date();
  session.revokedReason = reason;
  await session.save();
  return true;
}

// Bulk revoke - task spec sections 15/16/18/19/20. Only ever touches
// documents that are CURRENTLY active (the same `isSessionActive` shape,
// expressed as a query) - an already-revoked or already-expired session is
// never matched, so its original revocation reason/timestamp is preserved
// exactly like the single-session path above. `exceptTokenId` (optional)
// excludes exactly one session from the bulk update - used by
// logout-others (keep the caller's own current session) and by
// self-service password change (task spec section 18: "Current session
// may remain valid"). Omitted entirely for logout-others' bulk sibling
// logout-all, and for the Manager-reset/deactivation paths, where there is
// no "current session" concept to protect (the ACTOR is a different
// person, or the target is not the one making the request at all).
// Returns the number of sessions actually revoked, for the caller's own
// response (task spec section 15: "Response: count of sessions revoked").
async function revokeAllSessionsForUser(userId, reason, { exceptTokenId } = {}) {
  const query = {
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  };
  if (exceptTokenId) {
    query.tokenId = { $ne: exceptTokenId };
  }
  const result = await UserSession.updateMany(query, {
    $set: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.modifiedCount || 0;
}

module.exports = {
  generateTokenId,
  createSession,
  findSessionByTokenId,
  touchLastActive,
  isSessionActive,
  classifySessionStatus,
  revokeSession,
  revokeAllSessionsForUser,
  LAST_ACTIVE_THROTTLE_MS,
};
