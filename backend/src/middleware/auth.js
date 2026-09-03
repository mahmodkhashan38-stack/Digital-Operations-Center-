const jwt = require('jsonwebtoken');
const User = require('../models/User');
// DOC-69 - "Login History & Active Sessions".
const { findSessionByTokenId, touchLastActive, isSessionActive } = require('../services/userSession.service');

// Verifies the JWT sent in the Authorization header, then loads the
// authenticated user's CURRENT state from the database and attaches a
// small, trusted context to req.user: { userId, role, organizationId,
// isActive }.
//
// DOC-38: this is the one and only place "trusted organization context"
// comes from. Every downstream organization-isolation check (requireRole,
// requireOrganizationMembership, requireSameOrganization,
// requireActiveOrganization, and every controller) reads req.user.role /
// req.user.organizationId - never req.body.organizationId,
// req.params.organizationId, or req.query.organizationId, none of which
// are proof of anything about the caller.
//
// WHY A DB LOOKUP ON EVERY REQUEST (not just decoding the JWT payload):
// Before DOC-38, this middleware only decoded the token and copied
// {userId, role} out of its (signed, but potentially STALE) payload - it
// never included organizationId at all, and never checked whether the
// account was still active. That is a real staleness gap: if a user's
// role or organizationId changed, or their account was deactivated,
// their existing JWT would keep working exactly as before until it
// naturally expired. Re-reading the user from the database on every
// authenticated request closes that gap cheaply (one indexed lookup by
// _id) without building token revocation/refresh-token infrastructure,
// which DOC-38 explicitly says not to overengineer. The JWT itself still
// does its job (proving WHO is asking, via a signature only the server
// could have produced) - the database is simply asked what is true about
// that user right now, rather than trusting what was true about them at
// login time.
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Authentication token is missing.' });
  }

  const token = authHeader.slice('Bearer '.length).trim();

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Authentication token is missing.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'error', message: 'Authentication token has expired.' });
    }
    return res.status(401).json({ status: 'error', message: 'Invalid authentication token.' });
  }

  // DOC-69 - "Login History & Active Sessions" (task spec section 4 -
  // "Existing tokens without jti require a compatibility decision... a
  // clean migration strategy that does not silently weaken revocation").
  // A token signed before this ticket shipped has no `jti` at all and
  // therefore no corresponding UserSession that could ever be revoked -
  // silently accepting it forever (falling back to the old,
  // session-less verification path) would permanently exempt every
  // pre-DOC-69 token from the one guarantee this whole ticket exists to
  // add. Instead, such a token is rejected outright with the exact same
  // message/status as any other invalid token - the person simply logs in
  // again once (their existing account/password/data are completely
  // unaffected) and receives a brand-new, session-aware token. Given this
  // project's default JWT_EXPIRES_IN of 1 hour, any pre-DOC-69 token still
  // in use at deploy time would have expired naturally within an hour
  // regardless - this only makes that cutover immediate and unambiguous
  // rather than silently partial.
  if (!decoded.jti) {
    return res.status(401).json({ status: 'error', message: 'Invalid authentication token.' });
  }

  try {
    const user = await User.findById(decoded.userId);

    // The account behind a validly-signed token may no longer exist (e.g.
    // deleted) - treat exactly like an invalid token, not a 404, since
    // this is an authentication failure from the caller's point of view.
    if (!user) {
      return res.status(401).json({ status: 'error', message: 'Invalid authentication token.' });
    }

    // Deactivated accounts are rejected immediately, the same way Login
    // already refuses a deactivated account (403) - a JWT issued before
    // deactivation must not keep working afterward.
    if (!user.isActive) {
      return res.status(403).json({ status: 'error', message: 'This account has been deactivated.' });
    }

    // DOC-69 - task spec section 10's exact verification order: JWT
    // signature (done above) -> user exists (done above) -> user active
    // (done above) -> session exists -> belongs to same user -> not
    // revoked -> not expired. `findSessionByTokenId` looks up by the
    // unique `tokenId` index only (task spec section 34 - the one query
    // this middleware is allowed to make per request), never a broader
    // scan.
    const session = await findSessionByTokenId(decoded.jti);
    if (!session || String(session.userId) !== String(user._id) || !isSessionActive(session)) {
      // Deliberately the SAME message/status as every other "this token
      // cannot be used" case above (task spec section 10: "safe 401/403
      // behavior consistent with existing auth UX") - this is also one of
      // the exact strings frontend/src/services/api.js's own
      // SESSION_INVALID_MESSAGES set already matches on, so a session
      // revoked out from under an open tab (logout-others, a Manager
      // password reset, deactivation, ...) triggers the EXISTING
      // automatic logout/session-expired redirect with zero frontend
      // changes required for that behavior (task spec section 10's own
      // instruction).
      return res.status(401).json({ status: 'error', message: 'Invalid authentication token.' });
    }

    // Task spec section 8 - throttled, best-effort; never blocks or fails
    // the request this is piggybacking on.
    await touchLastActive(session);

    req.user = {
      userId: user._id,
      role: user.role,
      organizationId: user.organizationId,
      isActive: user.isActive,
      // DOC-57 - re-read fresh on every request, exactly like every other
      // field on this trusted context (never trusted from the JWT
      // payload itself, which never includes it) - a Manager reset takes
      // effect on the very next request this user makes, and a
      // successful self-change clears it just as immediately, with no
      // token refresh/re-login required either way.
      mustChangePassword: !!user.mustChangePassword,
    };
    // DOC-69 - the CURRENT session's own document, for controllers that
    // need to know "which session is this request's own" (logout,
    // change-password's "except current", and the session-management
    // endpoints' `isCurrent` flag) - never exposed to the client directly,
    // and never the JWT/tokenId itself in any response body.
    req.session = session;

    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = verifyToken;
