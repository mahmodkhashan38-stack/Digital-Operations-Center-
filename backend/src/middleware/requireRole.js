// Role-based authorization middleware factory (DOC-32).
//
// Must run AFTER verifyToken - it only reads req.user.role, which
// verifyToken populated from a cryptographically verified JWT. It never
// reads role from the request body, query string, or any other
// client-supplied input, so a client cannot talk its way into a role it
// doesn't actually have.
//
// Usage:
//   router.post('/organizations', verifyToken, requireRole('system_admin'), createOrganization);
//   router.get('/reports', verifyToken, requireRole('system_admin', 'manager'), ...); // future example
//
// This is intentionally the smallest useful building block - not a full
// permissions engine. Route-specific field-level protection (e.g. which
// fields an update endpoint allows) still lives in each controller.
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    // Defensive: should be unreachable if verifyToken always runs first on
    // this route, but fail closed (401, "not authenticated") rather than
    // silently letting the request through.
    return res.status(401).json({ status: 'error', message: 'Authentication token is missing.' });
  }

  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ status: 'error', message: 'You do not have permission to perform this action.' });
  }

  return next();
};

module.exports = requireRole;
