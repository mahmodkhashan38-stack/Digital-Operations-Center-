// DOC-57 - "Secure Password Management". Backend enforcement of the
// forced-password-change gate - a frontend redirect alone is never a
// security boundary (task spec is explicit about this), so this
// middleware is what actually blocks every "normal" protected business
// route while `req.user.mustChangePassword === true`.
//
// Must run AFTER middleware/auth.js's verifyToken, which is what
// populates `req.user.mustChangePassword` from a fresh per-request
// database read (see verifyToken's own comment) - never from anything
// client-supplied. Composed into route chains the exact same way
// requireRole/requireOrganizationMembership already are, immediately
// after verifyToken and before any role/organization check, since this
// gate applies uniformly regardless of role.
//
// The two explicitly allowed routes - GET /api/auth/me and PATCH
// /api/auth/change-password - both live on auth.routes.js and
// deliberately never have this middleware composed into their own chain
// at all (not "allowed through" by some exception list here - simply
// never subjected to the check in the first place). Every other
// protected router in this project (organizations, users,
// service-categories, requests) has this inserted immediately after its
// own verifyToken call(s), including routes registered ahead of a
// router's blanket role gate (the same "pre-gate" routes DOC-12/13/52/53/
// 56 already established) - there is no protected business route left
// unprotected by omission.
function requirePasswordChangeCompleted(req, res, next) {
  if (!req.user) {
    // Defensive: unreachable if verifyToken always runs first on this
    // route (exactly like requireRole's own equivalent defensive check),
    // but fail closed rather than silently letting the request through.
    return res.status(401).json({ status: 'error', message: 'Authentication required.' });
  }

  if (req.user.mustChangePassword === true) {
    return res.status(403).json({
      status: 'error',
      message: 'You must change your password before continuing. Use PATCH /api/auth/change-password.',
    });
  }

  return next();
}

module.exports = requirePasswordChangeCompleted;
