const mongoose = require('mongoose');
const UserSession = require('../models/UserSession');
const {
  classifySessionStatus, revokeSession, revokeAllSessionsForUser,
} = require('../services/userSession.service');

/**
 * DOC-69 - "Login History & Active Sessions".
 * -------------------------------------------------------------------------
 * Four endpoints, ALL scoped by `userId: req.user.userId` ONLY - never by
 * `organizationId`, never by role. This is deliberately a STRICTER
 * boundary than this project's usual DOC-38 organization isolation: not
 * even a Manager can list or act on another user's sessions through any of
 * these endpoints, regardless of Organization membership (task spec's own
 * standing constraint: "Do NOT allow one user to inspect or revoke another
 * user's sessions" - no role exception is granted anywhere in this file).
 *
 *   GET    /api/auth/sessions                 - list own sessions (active + recent history)
 *   POST   /api/auth/sessions/logout-others    - revoke every OTHER own active session
 *   POST   /api/auth/sessions/logout-all       - revoke EVERY own active session (including current)
 *   DELETE /api/auth/sessions/:sessionId       - revoke exactly one own session
 *
 * ANTI-ENUMERATION (task spec section 31): every single-session lookup
 * uses the scoped `{ _id: sessionId, userId: req.user.userId }` shape - a
 * session that does not exist and one that belongs to another user are
 * structurally indistinguishable (the same DOC-38 404-collapsing
 * convention this project already uses everywhere else, just re-scoped to
 * userId instead of organizationId here).
 *
 * NEVER RETURNED (task spec section 12/33): the JWT, the Authorization
 * header, `tokenId`/`jti`, `passwordHash`, or any secret. `sanitizeSession`
 * below is the ONE place a UserSession document is ever turned into a
 * response shape - every endpoint in this file routes through it.
 */

const HISTORY_LIMIT = 30;

// The single place a UserSession document becomes a client-facing shape.
// `isCurrent` is computed from `req.session` (the document middleware/
// auth.js already resolved for the CURRENT request's own token) - never
// from re-decoding a JWT here, and never returned as a raw comparison
// value the client could spoof (it's a plain boolean, derived server-side
// every time).
function sanitizeSession(session, currentSessionId) {
  return {
    id: session._id,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    revokedReason: session.revokedReason,
    status: classifySessionStatus(session),
    isCurrent: String(session._id) === String(currentSessionId),
  };
}

// GET /api/auth/sessions (any authenticated, non-forced-change role - see
// routes/auth.routes.js). Returns up to HISTORY_LIMIT most recent sessions
// for the caller, newest first (task spec section 13 - "Recommended
// history limit: e.g. latest 20-50... Do not return unlimited historical
// data"). The frontend splits this single list into "Active Sessions" vs
// "Recent Login History" purely by each entry's own `status` - there is
// deliberately only one query/one array here, never two separate fetches
// that could disagree with each other about the same underlying data.
const listMySessions = async (req, res, next) => {
  try {
    const sessions = await UserSession
      .find({ userId: req.user.userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(HISTORY_LIMIT);

    const data = sessions.map((session) => sanitizeSession(session, req.session._id));

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// POST /api/auth/sessions/logout-others (task spec section 15). Revokes
// every OTHER currently-active session for the caller - the current
// session (the one making this very request) is always excluded, so this
// call can never log the caller themselves out.
const logoutOtherSessions = async (req, res, next) => {
  try {
    const revokedCount = await revokeAllSessionsForUser(
      req.user.userId,
      'LOGOUT_OTHERS',
      { exceptTokenId: req.session.tokenId },
    );
    return res.status(200).json({ status: 'success', data: { revokedCount } });
  } catch (error) {
    return next(error);
  }
};

// POST /api/auth/sessions/logout-all (task spec section 16). Revokes
// EVERY currently-active session for the caller, INCLUDING the current
// one - the request that just made this very call will itself be rejected
// by verifyToken on its very next use. The frontend is expected to treat a
// successful call here exactly like pressing Logout (clear the local
// token immediately - see frontend/src/pages/Profile.jsx), since the
// server has already made that token unusable regardless.
const logoutAllSessions = async (req, res, next) => {
  try {
    const revokedCount = await revokeAllSessionsForUser(req.user.userId, 'LOGOUT_ALL');
    return res.status(200).json({ status: 'success', data: { revokedCount } });
  } catch (error) {
    return next(error);
  }
};

// DELETE /api/auth/sessions/:sessionId (task spec section 14). Revokes
// exactly one of the caller's OWN sessions - never another user's, even if
// the id is guessed/known (see this file's own top comment on
// anti-enumeration). Idempotent (task spec: "repeated revoke behaves
// safely") - revoking an already-inactive (revoked or naturally expired)
// session is a safe no-op that still returns 200 with that session's
// (unchanged) current state, never a second error. Revoking the CURRENT
// session is explicitly ALLOWED (task spec section 14's own "prefer
// allowing it only if UX handles immediate logout cleanly" - see this
// response's own `isCurrent` flag, which the frontend uses to immediately
// perform a local logout exactly like the dedicated Logout button).
const revokeMySession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid session id.' });
    }

    // Scoped by userId, not just _id (task spec section 31) - a session
    // belonging to any other user, or a nonexistent id, both produce the
    // exact same 404, never revealing which.
    const session = await UserSession.findOne({ _id: sessionId, userId: req.user.userId });
    if (!session) {
      return res.status(404).json({ status: 'error', message: 'Session not found.' });
    }

    // `revokeSession` itself is idempotent (a no-op on an already-inactive
    // session - see userSession.service.js) - this endpoint always
    // responds 200 with the session's current (possibly already-revoked)
    // state either way, never a distinct "already revoked" error.
    await revokeSession(session, 'USER_REVOKED');

    return res.status(200).json({ status: 'success', data: sanitizeSession(session, req.session._id) });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  listMySessions,
  logoutOtherSessions,
  logoutAllSessions,
  revokeMySession,
  sanitizeSession,
};
