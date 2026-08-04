const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const ServiceCategory = require('../models/ServiceCategory');
const Request = require('../models/Request');
const {
  sanitizeUser, EMAIL_REGEX, SALT_ROUNDS, validatePassword,
} = require('./auth.controller');

// DOC-35 - Manage Organization User Roles. DOC-48 - Organization Employee
// Removal.
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
//
// DOC-48 ("Organization Employee Removal") is deliberately NOT a new
// endpoint or a hard `DELETE /api/users/:id`. An audit of the existing
// implementation (see backend/README.md's DOC-48 section for the full
// writeup) found that DOC-50's `updateUserStatus` below already provides
// exactly the safe, tenant-scoped, self/manager/system_admin-protected
// soft-removal DOC-48 asks for - a Manager sets `isActive: false` on an
// Employee or Operator in their own Organization, which immediately blocks
// login and every protected API call (middleware/auth.js re-checks
// isActive on every request, DOC-38) while leaving every historical
// Request/Comment/attachment/assignment reference completely intact, since
// nothing about those records ever pointed at "an active user" in the
// first place - only at this User document's `_id`, which deactivation
// never touches. A hard delete was deliberately NOT added: it would either
// have to cascade-delete (destroying Request/Comment history, explicitly
// disallowed) or leave dangling `createdBy`/`assignedOperatorId`/
// `authorId` references behind (a data-integrity bug, not a feature) -
// see updateUserStatus's own comment for the one genuinely new piece of
// behavior DOC-48 adds on top of what DOC-50 already built.
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

// DOC-44 - builds a map of ServiceCategory _id (as a string) -> {id, name}
// for every specialty id referenced by ANY user in `users`, in ONE batched
// query - never one query per Operator, which would be an N+1 mess on a
// user list with many Operators. Scoped to the caller's own Organization
// even though every id in `user.specialties` was only ever written by the
// scoped updateUserSpecialties endpoint below (defense in depth, not the
// only isolation boundary). A specialty id whose Category cannot be
// resolved in this Organization (e.g. it belonged to another Organization,
// which should be structurally impossible) is simply absent from the map
// and silently dropped by sanitizeUserWithSpecialties below, rather than
// surfaced as a broken reference.
async function buildSpecialtyCategoryMap(users, organizationId) {
  const allIds = new Set();
  users.forEach((user) => {
    (user.specialties || []).forEach((categoryId) => allIds.add(String(categoryId)));
  });
  if (allIds.size === 0) {
    return new Map();
  }
  const categories = await ServiceCategory.find({
    _id: { $in: Array.from(allIds) },
    organizationId,
  });
  return new Map(categories.map((category) => [String(category._id), { id: category._id, name: category.name }]));
}

// Same safe shape as sanitizeUser, plus a `specialties` array of
// {id, name} populated from a pre-built categoryMap. Deliberately never
// includes the Category's normalizedName/isActive/organizationId - a
// specialty here is just "which Category, by name", nothing more.
function sanitizeUserWithSpecialties(user, categoryMap) {
  return {
    ...sanitizeUser(user),
    specialties: (user.specialties || [])
      .map((categoryId) => categoryMap.get(String(categoryId)))
      .filter(Boolean),
  };
}

// Strips a User document down to the same safe representation used
// everywhere else (auth.controller.js's sanitizeUser), plus its populated
// `specialties`. organizationId is always included as-is so the caller can
// see it did NOT change. Every mutating endpoint below responds through
// this (not the bare sanitizeUser) so the frontend's user objects always
// have a consistent shape whether they came from GET /api/users, a role
// change, a profile edit, a status toggle, or a specialties update.
//
// DOC-48 - `extra` is an optional object merged onto the top-level
// response alongside `status`/`data` (currently only ever used by
// updateUserStatus to attach a non-blocking `warning` string - see its
// own comment). Every existing caller passes nothing for it, so their
// response shape is completely unchanged (`{...undefined}` is a no-op).
const respondWithUser = async (req, res, statusCode, user, extra) => {
  const categoryMap = await buildSpecialtyCategoryMap([user], req.user.organizationId);
  return res.status(statusCode).json({
    status: 'success',
    data: sanitizeUserWithSpecialties(user, categoryMap),
    ...(extra || {}),
  });
};

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
    // DOC-44: one batched Category lookup for the whole list, not one per
    // Operator - see buildSpecialtyCategoryMap's own comment.
    const categoryMap = await buildSpecialtyCategoryMap(users, req.user.organizationId);
    return res.status(200).json({
      status: 'success',
      data: users.map((user) => sanitizeUserWithSpecialties(user, categoryMap)),
    });
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

    // DOC-44: demoting an Operator back to Employee must not leave stale
    // specialty responsibility attached to an account that is no longer
    // operationally responsible for anything - this is cleared as part of
    // the same transition, not left for a Manager to remember as a
    // separate step. Promotion (employee -> operator) intentionally does
    // NOT set any specialties; [] is a valid starting state, and the
    // Manager assigns specialties afterward via PATCH .../:id/specialties.
    if (targetUser.role === 'operator' && requestedRole === 'employee') {
      targetUser.specialties = [];
    }

    // organizationId is never touched here - only role changes. The
    // document was fetched scoped to req.user.organizationId above, and
    // nothing in this function ever assigns to targetUser.organizationId,
    // so a request body containing organizationId (or anything else) has
    // no effect on organization membership.
    targetUser.role = requestedRole;
    await targetUser.save();

    return respondWithUser(req, res, 200, targetUser);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// DOC-50: shared scoped-lookup + protected-target guard for the two new
// Manager actions below (edit profile, activate/deactivate). Enforces the
// exact same rule updateUserRole above already enforces for role changes -
// self, system_admin, and manager targets are always rejected, regardless
// of what the caller is trying to do. Kept as its own helper rather than
// refactoring updateUserRole itself (which already works correctly and has
// its own action-specific wording/behavior) - only the two new functions
// below use this.
async function resolveManageableTarget(req, id, selfActionMessage) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return { error: { status: 400, message: 'Invalid user id.' } };
  }

  if (String(req.user.userId) === String(id)) {
    return { error: { status: 403, message: selfActionMessage } };
  }

  // Same scoped query as updateUserRole - "not found", "belongs to
  // another Organization", and (structurally) "is the global system_admin"
  // all collapse into one identical outcome (DOC-38 anti-enumeration).
  const user = await User.findOne({ _id: id, organizationId: req.user.organizationId });

  if (!user) {
    return { error: { status: 404, message: 'User not found.' } };
  }

  if (user.role === 'system_admin') {
    return { error: { status: 404, message: 'User not found.' } };
  }

  if (user.role === 'manager') {
    return { error: { status: 403, message: 'Managers cannot modify another Manager.' } };
  }

  return { user };
}

// PATCH /api/users/:id (manager only)
//
// DOC-50: edits fullName/email for an Employee or Operator in the
// Manager's own Organization. Never touches role, isActive,
// organizationId, or password - this is profile info only, exactly like
// PATCH /api/organizations/:id/manager's equivalent scope for editing a
// Manager's own profile (DOC-49).
const updateUserProfile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user: targetUser, error } = await resolveManageableTarget(
      req,
      id,
      'You cannot edit your own profile through this endpoint.',
    );
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    if (!targetUser.isActive) {
      return res.status(403).json({ status: 'error', message: 'Cannot edit a deactivated user.' });
    }

    const body = req.body || {};
    const updates = {};

    // Explicit allowlist - fullName/email only, the same pattern every
    // other PATCH endpoint in this project uses (Organization, Manager
    // profile) rather than a generic mass-assignable update.
    if (Object.prototype.hasOwnProperty.call(body, 'fullName')) {
      if (typeof body.fullName !== 'string' || body.fullName.trim().length === 0) {
        return res.status(400).json({ status: 'error', message: 'fullName must be a non-empty string.' });
      }
      updates.fullName = body.fullName.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, 'email')) {
      if (typeof body.email !== 'string' || !EMAIL_REGEX.test(body.email)) {
        return res.status(400).json({ status: 'error', message: 'Please provide a valid email address.' });
      }
      const normalizedEmail = body.email.toLowerCase().trim();
      const existing = await User.findOne({ email: normalizedEmail });
      if (existing && String(existing._id) !== String(targetUser._id)) {
        return res.status(409).json({ status: 'error', message: 'A user with this email already exists.' });
      }
      updates.email = normalizedEmail;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid fields to update. Allowed fields: fullName, email.',
      });
    }

    Object.assign(targetUser, updates);
    await targetUser.save();

    return respondWithUser(req, res, 200, targetUser);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: 'A user with this email already exists.' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// A Request is still "active" (worth warning a Manager about before they
// remove its Operator from the picture) while it is anywhere in the
// ongoing workflow - 'closed' and 'cancelled' are both terminal and
// intentionally excluded (task spec section 11).
const ACTIVE_REQUEST_STATUSES = ['open', 'in_progress', 'resolved', 'reopened'];

// PATCH /api/users/:id/status (manager only)
//
// DOC-50 built this endpoint - the Manager-controlled soft
// activate/deactivate that DOC-48 ("Organization Employee Removal") is
// satisfied by reusing rather than duplicating (task spec explicitly
// forbids a second deactivate endpoint or a destructive hard delete by
// default - see the controller file's own top-level notes and
// backend/README.md's DOC-48 section for the full reasoning). Body:
// `{ isActive: true|false }` - the only field read. A deactivated
// account is rejected on its very next authenticated request regardless
// of anything else, because middleware/auth.js re-reads isActive from the
// database on every request (DOC-38) - there is no separate session/token
// list this needs to invalidate, and nothing here needs to build one.
//
// Idempotent by design (task spec section 17's second allowed option):
// setting isActive to the value it already has is treated as a normal
// success, not a rejected no-op - a Manager clicking Deactivate twice (a
// double-click, a slow network retry, two open tabs) gets the same safe
// "yes, this user is now inactive" result both times, never an error that
// would suggest something went wrong.
//
// DOC-48 adds exactly one thing on top of DOC-50's existing behavior: when
// DEACTIVATING an Operator who currently has one or more non-terminal
// assigned Requests, the response carries a non-blocking `warning` string
// (task spec section 11's recommended policy - "allow deactivation, but
// warn"). This never blocks the deactivation, never touches
// Request.assignedOperatorId, and never reassigns anything automatically
// - it is purely informational, read by the frontend and shown as an
// inline notice (OrganizationUserRow.jsx).
const updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user: targetUser, error } = await resolveManageableTarget(
      req,
      id,
      'You cannot change your own active status through this endpoint.',
    );
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const body = req.body || {};
    if (typeof body.isActive !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isActive must be a boolean.' });
    }

    // Computed BEFORE the write, from the target's role and CURRENT
    // assignment data - never from anything in the request body. Only
    // relevant when the Manager is deactivating (not reactivating) an
    // Operator specifically; an Employee target never has
    // assignedOperatorId set on any Request, so this is skipped entirely
    // for that role (task spec section 15: specialties/assignment
    // concerns are Operator-only).
    let warning;
    if (body.isActive === false && targetUser.role === 'operator') {
      const activeAssignedCount = await Request.countDocuments({
        assignedOperatorId: targetUser._id,
        organizationId: req.user.organizationId,
        status: { $in: ACTIVE_REQUEST_STATUSES },
      });
      if (activeAssignedCount > 0) {
        warning = `This operator still has ${activeAssignedCount} active assigned request(s). Consider reassigning them to another operator before or after deactivating.`;
      }
    }

    // Deactivation/reactivation NEVER touches assignedOperatorId on any
    // Request, NEVER touches createdBy, and NEVER cascades to Comments or
    // attachments (task spec section 10) - the only field written here is
    // this User document's own isActive.
    targetUser.isActive = body.isActive;
    await targetUser.save();

    return respondWithUser(req, res, 200, targetUser, warning ? { warning } : undefined);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/users/:id/specialties (manager only)
//
// DOC-44 - full-replacement contract: the entire `categoryIds` array
// becomes the Operator's new specialty set in one request (send [] to
// clear everything, or the complete desired list to add/remove any
// Category) - one endpoint rather than a separate add/remove pair, per
// the task's own "simpler at this scale" guidance.
const REQUIRED_CATEGORY_IDS_MESSAGE = 'categoryIds is required and must be an array of service category ids.';

const updateUserSpecialties = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user: targetUser, error } = await resolveManageableTarget(
      req,
      id,
      'You cannot assign specialties to yourself.',
    );
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    // resolveManageableTarget already rejects self (403), a nonexistent/
    // cross-org/system_admin target (404), and a manager target (403).
    // The one rule it does NOT apply is this endpoint's own: specialties
    // are meaningful ONLY for role: 'operator' (see the User model's own
    // role-conditional validator) - an Employee target is a real, visible,
    // same-Organization user, so this is a clean 403, not a 404.
    if (targetUser.role !== 'operator') {
      return res.status(403).json({
        status: 'error',
        message: 'Service category specialties can only be assigned to Operators.',
      });
    }

    if (!targetUser.isActive) {
      return res.status(403).json({ status: 'error', message: 'Cannot edit a deactivated user.' });
    }

    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'categoryIds') || !Array.isArray(body.categoryIds)) {
      return res.status(400).json({ status: 'error', message: REQUIRED_CATEGORY_IDS_MESSAGE });
    }

    // Dedupe first (a payload like [A, A, B] must never produce a stored
    // duplicate), then validate shape, before any database query runs.
    const uniqueIds = [...new Set(body.categoryIds.map((value) => String(value)))];

    if (uniqueIds.some((value) => !mongoose.Types.ObjectId.isValid(value))) {
      return res.status(400).json({ status: 'error', message: 'One or more service category ids are invalid.' });
    }

    let resolvedCategories = [];
    if (uniqueIds.length > 0) {
      // Scoped query, not a findById loop: organizationId is read only
      // from req.user.organizationId (DOC-38), never from the request
      // body - a Category id from another Organization simply will not be
      // part of this result set, no matter what the client sends.
      // isActive: true is required here (DOC-44 section 9: a Manager may
      // not assign a currently-inactive Category as a NEW specialty) - an
      // id that resolves to an inactive Category, a cross-org Category, or
      // nothing at all are all indistinguishable via the length check
      // below (anti-enumeration, DOC-38 convention).
      resolvedCategories = await ServiceCategory.find({
        _id: { $in: uniqueIds },
        organizationId: req.user.organizationId,
        isActive: true,
      });

      if (resolvedCategories.length !== uniqueIds.length) {
        return res.status(400).json({
          status: 'error',
          message: 'One or more service categories could not be found, are inactive, or do not belong to your organization.',
        });
      }
    }

    // Store the ids from the RESOLVED documents, not the client's raw
    // strings - defense in depth, the same spirit as createServiceCategory
    // storing `name.trim()` rather than raw input.
    targetUser.specialties = resolvedCategories.map((category) => category._id);
    await targetUser.save();

    const categoryMap = new Map(
      resolvedCategories.map((category) => [String(category._id), { id: category._id, name: category.name }]),
    );
    return res.status(200).json({ status: 'success', data: sanitizeUserWithSpecialties(targetUser, categoryMap) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/users/:id/reset-password (manager only)
//
// DOC-57 - Flow B, "Manager Password Reset". Reuses resolveManageableTarget
// (above) exactly as-is - the SAME self/system_admin/manager/cross-org
// protections updateUserProfile/updateUserStatus/updateUserSpecialties
// already established (task spec's own recommended target lookup shape:
// `User.findOne({ _id, organizationId: req.user.organizationId })`) - a
// Manager can never reset their own password through this endpoint,
// another Manager's, System Admin's, or a User in a different
// Organization's, and a malformed/nonexistent/cross-org id all collapse
// into the exact same 404 (DOC-38 anti-enumeration convention).
//
// Only reads newPassword/confirmPassword from the body - nothing else
// (role/organizationId/isActive/mustChangePassword injection all have
// structurally zero effect, task spec).
//
// DOC-57's documented inactive-user policy (see backend/README.md): a
// Manager MAY reset an inactive Employee/Operator's password - unlike
// every other resolveManageableTarget-based action in this file, there is
// deliberately NO `if (!targetUser.isActive) return 403` guard here. The
// target still cannot log in until reactivated (middleware/auth.js's
// isActive check is independent of this), and once reactivated they will
// be forced through the change-password flow at their very next login,
// exactly like an active target would be immediately. Reset never
// auto-reactivates the account - `isActive` is never touched here.
const resetUserPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user: targetUser, error } = await resolveManageableTarget(
      req,
      id,
      'You cannot reset your own password through this endpoint.',
    );
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const body = req.body || {};
    const { newPassword, confirmPassword } = body;

    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      return res.status(400).json({ status: 'error', message: 'newPassword is required.' });
    }
    if (typeof confirmPassword !== 'string' || confirmPassword.length === 0) {
      return res.status(400).json({ status: 'error', message: 'confirmPassword is required.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ status: 'error', message: 'newPassword and confirmPassword do not match.' });
    }

    const passwordFormatError = validatePassword(newPassword);
    if (passwordFormatError) {
      return res.status(400).json({ status: 'error', message: passwordFormatError });
    }

    // The Manager never sees, chooses a hint for, or otherwise learns the
    // OLD password - this endpoint never reads or compares against it at
    // all (unlike self-change, there is no "current password" concept
    // here, by design - the whole point of a Manager reset is that the
    // Manager does not need to know it).
    targetUser.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    // Forces the target through the change-password flow at their very
    // next successful login/request - the one and only place this
    // endpoint ever sets this field, always to `true`, never client-
    // controlled.
    targetUser.mustChangePassword = true;
    await targetUser.save();

    // respondWithUser already reuses sanitizeUserWithSpecialties ->
    // sanitizeUser, which never includes passwordHash/the new password/a
    // bcrypt salt - the response here is identical in shape to every
    // other user-mutation response in this file, just with
    // mustChangePassword now flipped to true.
    return respondWithUser(req, res, 200, targetUser);
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
  updateUserProfile,
  updateUserStatus,
  updateUserSpecialties,
  resetUserPassword,
  ALLOWED_ROLE_TRANSITIONS,
  REQUESTABLE_ROLES,
};
