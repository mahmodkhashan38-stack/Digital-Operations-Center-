const jwt = require('jsonwebtoken');
const User = require('../models/User');

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

    req.user = {
      userId: user._id,
      role: user.role,
      organizationId: user.organizationId,
      isActive: user.isActive,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = verifyToken;
