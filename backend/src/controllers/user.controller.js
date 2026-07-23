const mongoose = require('mongoose');
const User = require('../models/User');
const { sanitizeUser } = require('./auth.controller');

// DOC-35 - Manage Organization User Roles.
// -----------------------------------------------------------------
// This is NOT a generic RBAC engine. The only role changes this controller
// ever performs are the two directions of one business flow:
//
//   employee --(Manager promotes)--> operator
//   operator --(Manager demotes)---> employee
//
// Every other transition (anything involving 'manager' or 'system_admin',
// on either side) is rejected by the explicit allowlist below - there is
// no code path here that does `targetUser.role = req.body.role` without
// first checking it against ALLOWED_ROLE_TRANSITIONS.
const ALLOWED_ROLE_TRANSITIONS = {
  employee: 'operator',
  operator: 'employee',
};

// The only values this endpoint ever accepts as a *requested* role. Even
// though ALLOWED_ROLE_TRANSITIONS above already only maps to these two
// values, this list is checked first so a request for an unsupported role
// (e.g. "manager", "system_admin", or a typo) gets one clear, consistent
// 400 response before any user lookup happens.
const REQUESTABLE_ROLES = ['employee', 'operator'];

// Strips a User document down to the same safe representation used
// everywhere else (auth.controller.js's sanitizeUser) - never passwordHash,
// and organizationId is always included as-is so the caller can see it did
// NOT change.
const respondWithUser = (res, statusCode, user) => (
  res.status(statusCode).json({ status: 'success', data: sanitizeUser(user) })
);

// GET /api/users (manager only)
//
// The role-management endpoint below operates on a specific user id, but
// until now a Manager had no safe way to discover which ids exist in their
// own Organization at all - there is no other endpoint that exposes that.
// This list is the minimum needed to make DOC-35 actually usable: scoped
// at the database query level to the caller's own Organization (never
// User.find({}) followed by filtering), safe fields only (sanitizeUser,
// never passwordHash), no pagination/search/sorting beyond a stable
// order - none of that is required by this task and is left to DOC-36's
// Manager Dashboard if it ever needs it.
const listOrganizationUsers = async (req, res, next) => {
  try {
    const users = await User.find({ organizationId: req.user.organizationId }).sort({ createdAt: -1 });
    return res.status(200).json({ status: 'success', data: users.map(sanitizeUser) });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/users/:id/role (manager only)
//
// Request body is read for exactly one field: `role`, the requested target
// role. Nothing else in the body (organizationId, managerId, isActive,
// email, passwordHash, ...) is ever read here - there is no mass-
// assignment surface on this endpoint at all, by construction, not by
// allowlist-filtering a larger object.
const updateUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid user id.' });
    }

    const requestedRole = req.body ? req.body.role : undefined;

    if (!REQUESTABLE_ROLES.includes(requestedRole)) {
      return res.status(400).json({
        status: 'error',
        message: `role must be one of: ${REQUESTABLE_ROLES.join(', ')}.`,
      });
    }

    // A Manager can never change their own role through this endpoint,
    // even by targeting their own id with a request that would otherwise
    // look valid. Manager identity/authorization (DOC-34) must stay
    // protected from being self-modified away.
    if (String(req.user.userId) === String(id)) {
      return res.status(403).json({
        status: 'error',
        message: 'You cannot change your own role.',
      });
    }

    // Scoped query, not findById()+filtering: this single query is what
    // makes "user not found", "user belongs to another Organization", and
    // (structurally) "user is the global system_admin, whose organizationId
    // is always null" all collapse into the exact same "no matching
    // document" outcome - the response below cannot be used to tell any of
    // those apart (DOC-38 anti-enumeration convention).
    const targetUser = await User.findOne({
      _id: id,
      organizationId: req.user.organizationId,
    });

    if (!targetUser) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    // Defense in depth: targetUser.role can never actually be
    // 'system_admin' here (the scoped query above already makes that
    // unreachable, since system_admin.organizationId is always null and
    // therefore can never equal req.user.organizationId), but this keeps
    // the rule explicit and readable rather than relying solely on that
    // structural argument.
    if (targetUser.role === 'system_admin') {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    // A Manager cannot modify another Manager - demotion/replacement of a
    // Manager is not part of this task (see DOC-34's manager-assignment
    // flow, which is the only thing allowed to touch a Manager account).
    if (targetUser.role === 'manager') {
      return res.status(403).json({
        status: 'error',
        message: 'Managers cannot modify another Manager.',
      });
    }

    // Role management and account activation are different concerns
    // (see README) - a deactivated user's role is left untouched rather
    // than silently reactivating them as a side effect of a role change.
    if (!targetUser.isActive) {
      return res.status(403).json({
        status: 'error',
        message: 'Cannot change the role of a deactivated user.',
      });
    }

    // At this point targetUser.role is guaranteed to be 'employee' or
    // 'operator' (system_admin/manager were already rejected above).
    // Transition checked against the CURRENT database state, not any
    // client-supplied claim about what the user's role is - this is the
    // one and only place role is ever written, and only ever through this
    // allowlist.
    if (targetUser.role === requestedRole) {
      // Explicit, not a silent no-op 200: asking for the role the user
      // already has is treated as an invalid transition, the same way any
      // other unsupported transition is, so the caller always gets a clear
      // signal rather than guessing whether anything happened.
      return res.status(400).json({
        status: 'error',
        message: `User already has role '${targetUser.role}'.`,
      });
    }

    if (ALLOWED_ROLE_TRANSITIONS[targetUser.role] !== requestedRole) {
      return res.status(400).json({
        status: 'error',
        message: `Cannot change role from '${targetUser.role}' to '${requestedRole}'.`,
      });
    }

    // organizationId is never touched here - only role changes. The
    // document was fetched scoped to req.user.organizationId above, and
    // nothing in this function ever assigns to targetUser.organizationId,
    // so a request body containing organizationId (or anything else) has
    // no effect on organization membership.
    targetUser.role = requestedRole;
    await targetUser.save();

    return respondWithUser(res, 200, targetUser);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

module.exports = {
  listOrganizationUsers,
  updateUserRole,
  ALLOWED_ROLE_TRANSITIONS,
  REQUESTABLE_ROLES,
};
