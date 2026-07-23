const Organization = require('../models/Organization');

// DOC-38 - Reusable tenant-isolation building blocks.
// -----------------------------------------------------------------
// These sit alongside requireRole.js (WHO may call an endpoint) but
// answer a different question: WHICH Organization's data may this caller
// touch. Role and organizationId are two separate axes and must both be
// checked - a Manager is authorized to manage users in general, but only
// within their own Organization (see backend/README.md's isolation
// section for the full role/organization matrix).
//
// All three helpers below read exclusively from req.user, which
// middleware/auth.js populates from a fresh per-request database read
// AFTER verifying the JWT signature - never from req.body.organizationId,
// req.params.organizationId, or req.query.organizationId. Those client-
// supplied values are never trusted as proof of organization membership
// anywhere in this codebase.
//
// system_admin is intentionally exempt from all three: it is a global
// role (organizationId is always null by schema/validator, DOC-31), and
// its job - System Admin Organization CRUD (DOC-32/34) - is deliberately
// cross-Organization. Those routes stay protected by requireRole
// ('system_admin') alone, which is unaffected by this file.
//
// CURRENT USAGE NOTE: as of DOC-38, the only endpoints that expose or
// mutate organization-owned data are System Admin's global Organization
// CRUD (correctly ungated by these helpers - see above) and the
// self-scoped auth endpoints (register/login/me, which only ever read or
// write the caller's own single User document by _id, so there is no
// "other user in my organization" or "another organization's data" for
// a tenant-boundary check to guard). There is currently no manager- or
// employee-facing endpoint that lists or targets another user or another
// organization's resources - DOC-35 (role management), DOC-36 (Manager
// Dashboard) and any future Ticket feature will be the first real callers
// of requireSameOrganization/requireActiveOrganization. Those future
// controllers MUST compose the relevant helper(s) below instead of
// hand-rolling `String(x.organizationId) !== String(req.user.organizationId)`
// checks inline - see README.md "Organization Data Isolation (DOC-38)"
// for the required pattern.

// Blocks a request from an organization-scoped user (manager/employee)
// whose organizationId is null. This is exactly the state a legacy
// pre-DOC-30 user can still be in (DOC-39 deliberately never guesses an
// Organization for them) - such an account can still authenticate, but
// must not be treated as a member of any tenant. Does not check role by
// itself; compose with requireRole(...) when a route also needs to
// restrict which roles may call it.
function requireOrganizationMembership(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ status: 'error', message: 'Authentication required.' });
  }

  if (req.user.role === 'system_admin') {
    return next();
  }

  if (req.user.organizationId == null) {
    return res.status(403).json({
      status: 'error',
      message: 'This account is not associated with an Organization.',
    });
  }

  return next();
}

// Middleware factory: confirms a specific resource belongs to the
// caller's own Organization before letting the request continue.
// `getResourceOrganizationId(req)` is caller-supplied (may be async) and
// should return the target resource's organizationId, or a falsy value if
// the resource does not exist.
//
// A missing resource and a resource that exists but belongs to a
// different Organization both resolve to the same 404 response on
// purpose - this is what stops an attacker from using the response to
// tell "no such record" apart from "that record belongs to another
// company" (tenant enumeration - see README.md / DOC-38 section 14).
//
// Example future usage (Ticket controller, illustrative only - Tickets do
// not exist yet and are NOT implemented by DOC-38):
//   router.get(
//     '/tickets/:id',
//     verifyToken,
//     requireOrganizationMembership,
//     requireSameOrganization(async (req) => {
//       const ticket = await Ticket.findById(req.params.id);
//       return ticket && ticket.organizationId;
//     }),
//     getTicket,
//   );
function requireSameOrganization(getResourceOrganizationId) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Authentication required.' });
      }

      if (req.user.role === 'system_admin') {
        return next();
      }

      if (req.user.organizationId == null) {
        return res.status(403).json({
          status: 'error',
          message: 'This account is not associated with an Organization.',
        });
      }

      const resourceOrganizationId = await getResourceOrganizationId(req);

      if (!resourceOrganizationId || String(resourceOrganizationId) !== String(req.user.organizationId)) {
        return res.status(404).json({ status: 'error', message: 'Resource not found.' });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

// Ensures the caller's own Organization is currently active before an
// organization-scoped business operation continues (as opposed to
// System Admin management of an Organization's active status itself,
// which must keep working regardless - see DOC-32's PATCH endpoint,
// which can both deactivate AND reactivate an Organization, and is
// correctly exempt here via the system_admin bypass).
//
// Not wired into any route yet - see the "CURRENT USAGE NOTE" above, the
// same reasoning applies. Future organization-scoped business routes
// (DOC-35/36, Tickets) MUST compose this after requireOrganizationMembership.
async function requireActiveOrganization(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ status: 'error', message: 'Authentication required.' });
    }

    if (req.user.role === 'system_admin') {
      return next();
    }

    if (req.user.organizationId == null) {
      return res.status(403).json({
        status: 'error',
        message: 'This account is not associated with an Organization.',
      });
    }

    const organization = await Organization.findById(req.user.organizationId);

    if (!organization || !organization.isActive) {
      return res.status(403).json({
        status: 'error',
        message: 'This Organization is not currently active.',
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  requireOrganizationMembership,
  requireSameOrganization,
  requireActiveOrganization,
};
