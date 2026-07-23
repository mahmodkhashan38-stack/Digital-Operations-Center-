const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Organization = require('../models/Organization');
const User = require('../models/User');
const { generateUniqueCompanyCode } = require('../utils/companyCode');
const { sanitizeUser, SALT_ROUNDS, EMAIL_REGEX, MIN_PASSWORD_LENGTH } = require('./auth.controller');

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;

// Fields a System Admin may change through PATCH /api/organizations/:id.
// Anything else in the request body (companyCode, createdBy, managerId,
// _id, organizationId, role, ...) is silently ignored - this is an
// allowlist, not a denylist, so a new sensitive field added to the schema
// later is protected by default instead of needing someone to remember to
// blacklist it. managerId in particular stays off this list on purpose
// (DOC-34): manager assignment only ever happens through the controlled
// flows below, never through generic mass assignment.
const UPDATABLE_FIELDS = ['name', 'isActive'];

// Small typed error so the manager-creation helper below can report a
// specific HTTP status (400/404/409) up to whichever controller called it,
// the same way the rest of this file already returns clean 4xx responses
// instead of relying on the centralized error handler for expected cases.
class OrganizationError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Strips the Organization document down to a safe, stable response shape.
// References (createdBy/managerId) are returned as raw ids, not populated -
// consistent with how User.organizationId is exposed (DOC-30): nothing here
// is sensitive, but nothing pulls in related documents until something
// actually needs that.
const sanitizeOrganization = (org) => ({
  id: org._id,
  name: org.name,
  companyCode: org.companyCode,
  isActive: org.isActive,
  createdBy: org.createdBy,
  managerId: org.managerId,
  createdAt: org.createdAt,
  updatedAt: org.updatedAt,
});

const validateName = (name) => {
  if (typeof name !== 'string') {
    return 'Organization name is required.';
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'Organization name is required.';
  }
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    return `Organization name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`;
  }
  return null;
};

// Maps a MongoDB duplicate-key error to which field actually collided, so
// the client gets an accurate message instead of a generic one. Falls back
// gracefully if the driver's error shape doesn't include keyValue for some
// reason (never leaks the raw driver error either way).
const duplicateKeyMessage = (error) => {
  const field = error.keyValue && Object.keys(error.keyValue)[0];
  if (field === 'companyCode') {
    return 'Could not allocate a unique company code. Please try again.';
  }
  if (field === 'name') {
    return 'An organization with this name already exists.';
  }
  if (field === 'email') {
    return 'A user with this email already exists.';
  }
  return 'A conflicting record already exists.';
};

// Validates the fields needed to create a new Manager account - the exact
// same rules public registration uses (required fields, email format,
// minimum password length), imported from auth.controller.js rather than
// re-implemented, so the two can never drift apart.
const validateManagerInput = (input) => {
  const { fullName, email, password } = input || {};

  if (!fullName || !email || !password) {
    return 'fullName, email and password are all required for the Organization manager.';
  }
  if (typeof fullName !== 'string' || fullName.trim().length === 0) {
    return 'fullName is required for the Organization manager.';
  }
  if (!EMAIL_REGEX.test(email)) {
    return 'Please provide a valid email address for the Organization manager.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Manager password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  return null;
};

// DOC-34 core: creates a brand-new Manager account for `organization` and
// links the two together. This is the ONE place that logic exists - both
// "create Organization with its initial Manager" and the dedicated
// "POST /:id/manager" recovery endpoint call this, so there is no
// duplicated manager-creation implementation to keep in sync.
//
// This never assigns an EXISTING user as manager (no userId is accepted) -
// only a brand-new account, created here, with organizationId hardcoded to
// this Organization's _id. That is what makes the "Organization A.managerId
// -> User X, but User X.organizationId -> Organization B" cross-organization
// state structurally impossible: the manager account cannot exist pointing
// anywhere else, because it does not exist until this function creates it.
//
// Atomicity note: this project's MongoDB deployment is not confirmed to
// support multi-document transactions in every environment it runs in
// (that requires a replica set), so rather than assume that support and
// risk `session.startTransaction()` failing outright on a standalone
// instance, this uses explicit compensating rollback instead. If the
// Manager account is created but linking it to the Organization fails, the
// just-created account is deleted so no orphaned Manager is left behind.
async function createAndLinkManager(organization, managerInput) {
  const validationError = validateManagerInput(managerInput);
  if (validationError) {
    throw new OrganizationError(400, validationError);
  }

  const { fullName, email, password } = managerInput;
  const normalizedEmail = email.toLowerCase().trim();

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new OrganizationError(
      409,
      'A user with this email already exists. The Organization manager must be a new account.',
    );
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  let manager;
  try {
    manager = await User.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash,
      role: 'manager',
      organizationId: organization._id,
    });
  } catch (error) {
    if (error.code === 11000) {
      throw new OrganizationError(
        409,
        'A user with this email already exists. The Organization manager must be a new account.',
      );
    }
    if (error.name === 'ValidationError') {
      throw new OrganizationError(400, error.message);
    }
    throw error;
  }

  try {
    organization.managerId = manager._id;
    await organization.save();
  } catch (error) {
    // Roll back: the manager account was created but could not be linked to
    // the Organization - delete it rather than leave an orphaned Manager
    // account with no Organization actually pointing back at it.
    await User.deleteOne({ _id: manager._id }).catch((cleanupError) => {
      console.error('Failed to roll back orphaned manager after link failure:', cleanupError);
    });
    throw error;
  }

  return manager;
}

// POST /api/organizations (system_admin only)
//
// `manager` is an OPTIONAL nested object: { fullName, email, password }.
// - Omitted: behaves exactly as before DOC-34 - Organization is created
//   with managerId left null, to be assigned later (see
//   POST /:id/manager below).
// - Provided: the Organization and its initial Manager are created as one
//   business operation. If Manager creation/linking fails for any reason,
//   the just-created Organization is rolled back (deleted) too, so callers
//   never see a "half-finished" Organization with managerId stuck at null
//   because of a failure they have no way to retry cleanly.
const createOrganization = async (req, res, next) => {
  try {
    const { name, manager: managerInput } = req.body || {};

    const nameError = validateName(name);
    if (nameError) {
      return res.status(400).json({ status: 'error', message: nameError });
    }

    // companyCode is always generated server-side. The client cannot supply
    // one - req.body.companyCode (or createdBy, managerId, organizationId,
    // role, anything else) is never read here. Application-level collision
    // checking (generateUniqueCompanyCode) is the first line of defense;
    // the schema's `unique: true` index on companyCode is the backstop -
    // see the E11000 handling below and DOC-41's utils/companyCode.js.
    const companyCode = await generateUniqueCompanyCode(
      (code) => Organization.exists({ companyCode: code }),
    );

    const organization = await Organization.create({
      name: name.trim(),
      companyCode,
      createdBy: req.user.userId,
    });

    if (!managerInput) {
      return res.status(201).json({ status: 'success', data: sanitizeOrganization(organization) });
    }

    try {
      const manager = await createAndLinkManager(organization, managerInput);
      return res.status(201).json({
        status: 'success',
        data: sanitizeOrganization(organization),
        manager: sanitizeUser(manager),
      });
    } catch (managerError) {
      await Organization.deleteOne({ _id: organization._id }).catch((cleanupError) => {
        console.error('Failed to roll back Organization after manager creation failure:', cleanupError);
      });

      if (managerError instanceof OrganizationError) {
        return res.status(managerError.statusCode).json({ status: 'error', message: managerError.message });
      }
      return next(managerError);
    }
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: duplicateKeyMessage(error) });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// GET /api/organizations/me (any authenticated, organization-scoped user)
//
// DOC-42: gives a Manager (and any other organization-scoped role) a safe
// way to discover their OWN Organization's name/companyCode/status - this
// is the one and only source for the Manager Dashboard's "Organization
// Information" section. There is deliberately no :id in this route: the
// Organization is derived exclusively from req.user.organizationId, which
// middleware/auth.js populates from a fresh per-request database read
// (DOC-38) - never from req.body/req.query/req.params. That means this
// endpoint is structurally incapable of returning any Organization other
// than the caller's own, regardless of what a client sends.
//
// system_admin's organizationId is always null (DOC-31) - it simply gets a
// 404 here, the same "nothing to return" response a legacy user with no
// organization would get. System Admin already has its own global
// Organization CRUD (the routes below); this route does not change or
// duplicate any of that.
const getMyOrganization = async (req, res, next) => {
  try {
    if (!req.user.organizationId) {
      return res.status(404).json({
        status: 'error',
        message: 'You are not associated with an Organization.',
      });
    }

    const organization = await Organization.findById(req.user.organizationId);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    return res.status(200).json({ status: 'success', data: sanitizeOrganization(organization) });
  } catch (error) {
    return next(error);
  }
};

// GET /api/organizations (system_admin only)
const listOrganizations = async (req, res, next) => {
  try {
    const organizations = await Organization.find({}).sort({ createdAt: -1 });
    return res.status(200).json({ status: 'success', data: organizations.map(sanitizeOrganization) });
  } catch (error) {
    return next(error);
  }
};

// GET /api/organizations/:id (system_admin only)
const getOrganization = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    return res.status(200).json({ status: 'success', data: sanitizeOrganization(organization) });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/organizations/:id (system_admin only)
const updateOrganization = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const body = req.body || {};
    const updates = {};

    // Explicit allowlist - anything not in UPDATABLE_FIELDS is ignored even
    // if present in the request body (companyCode, createdBy, managerId,
    // _id, organizationId, role, ...). This is what stops a request like
    // { "createdBy": "...", "managerId": "...", "companyCode": "..." }
    // from mass-assigning protected fields.
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      const nameError = validateName(body.name);
      if (nameError) {
        return res.status(400).json({ status: 'error', message: nameError });
      }
      updates.name = body.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, 'isActive')) {
      if (typeof body.isActive !== 'boolean') {
        return res.status(400).json({ status: 'error', message: 'isActive must be a boolean.' });
      }
      updates.isActive = body.isActive;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: `No valid fields to update. Allowed fields: ${UPDATABLE_FIELDS.join(', ')}.`,
      });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    Object.assign(organization, updates);
    await organization.save();

    return res.status(200).json({ status: 'success', data: sanitizeOrganization(organization) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: duplicateKeyMessage(error) });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// POST /api/organizations/:id/regenerate-code (system_admin only)
//
// Replaces an Organization's companyCode with a newly generated, confirmed
// unique one. organizationId (the Organization's _id) never changes, and no
// User document is touched - existing members (including its Manager) stay
// associated through organizationId, never through companyCode (see
// DOC-41/DOC-30/DOC-34). The old code simply stops resolving to anything
// once replaced.
const regenerateCompanyCode = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    // Generate and confirm a new unique code BEFORE touching the existing
    // document, so the old, still-working code is never discarded unless a
    // valid replacement is already confirmed to exist.
    const newCompanyCode = await generateUniqueCompanyCode(
      (code) => Organization.exists({ companyCode: code }),
    );

    organization.companyCode = newCompanyCode;
    await organization.save();

    return res.status(200).json({ status: 'success', data: sanitizeOrganization(organization) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: duplicateKeyMessage(error) });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// POST /api/organizations/:id/manager (system_admin only)
//
// Dedicated recovery/legacy-assignment endpoint (DOC-34): establishes the
// initial Manager for an Organization that does not already have one -
// primarily for Organizations created via DOC-32 before this task existed,
// or via POST /api/organizations without a `manager` payload. Reuses the
// exact same createAndLinkManager() helper as organization creation, so
// there is only one manager-creation implementation in the codebase.
const assignManager = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    if (!organization.isActive) {
      return res.status(400).json({ status: 'error', message: 'Cannot assign a manager to an inactive Organization.' });
    }

    if (organization.managerId) {
      return res.status(409).json({ status: 'error', message: 'This Organization already has a Manager assigned.' });
    }

    const manager = await createAndLinkManager(organization, req.body);

    return res.status(201).json({
      status: 'success',
      data: sanitizeOrganization(organization),
      manager: sanitizeUser(manager),
    });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

module.exports = {
  createOrganization,
  listOrganizations,
  getOrganization,
  getMyOrganization,
  updateOrganization,
  regenerateCompanyCode,
  assignManager,
  sanitizeOrganization,
  UPDATABLE_FIELDS,
};
