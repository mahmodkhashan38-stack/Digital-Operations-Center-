const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Organization = require('../models/Organization');
const User = require('../models/User');
const ServiceCategory = require('../models/ServiceCategory');
const { generateUniqueCompanyCode } = require('../utils/companyCode');
const { ensureDefaultServiceCategories } = require('../utils/defaultServiceCategories');
const { sanitizeUser, SALT_ROUNDS, EMAIL_REGEX } = require('./auth.controller');
const { validatePassword } = require('../utils/passwordPolicy');
// DOC-64 - "Audit Log". Every write in this file that is a real
// administrative action (Organization lifecycle, Manager assignment/
// replacement) records one AuditLog entry AFTER its own business write has
// already succeeded - never before, never conditionally blocking the
// response on it (see services/auditLog.service.js's own top comment on
// failure strategy). This never replaces or duplicates anything - none of
// these calls touch RequestActivity/Notification, and this controller has
// no Request-related logic to begin with.
const { recordAuditLog } = require('../services/auditLog.service');

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;
// DOC-61 - "Organization Settings for Manager". Bounds for the three new
// optional profile fields - see models/Organization.js's own comment for
// why these three, and only these three, exist at all.
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_CONTACT_PHONE_LENGTH = 30;
// Deliberately permissive (task spec section 19): digits, a leading `+`,
// spaces, parentheses, and hyphens - enough to represent most real-world
// international formats ("+1 (555) 123-4567", "020-7946-0958",
// "+972 50-123-4567") without hard-coding any single country's own
// numbering plan. At least one digit is required (a phone number that is
// entirely punctuation/whitespace is not a phone number) - anything else
// is rejected, not silently accepted.
const CONTACT_PHONE_PATTERN = /^[0-9+\-()\s]+$/;

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
// `createdBy`/`managerId` stay as raw ids (unchanged since DOC-30/32) - the
// optional `extras` argument (DOC-49) is how callers that already looked up
// richer context attach it, without turning this into an async function
// itself or forcing every call site to fetch things it doesn't need:
//   - extras.manager: { id, fullName, email } | null - the current
//     Manager's safe contact fields (DOC-49 "Manager information" /
//     DOC-51 "Manager Contact"). Deliberately never the full sanitizeUser
//     shape (no role/isActive/organizationId repeated here - managerId
//     above already establishes the link).
//   - extras.employeeCount / extras.operatorCount: numbers (DOC-49
//     "Organization Overview"). Left undefined (not 0) when a caller
//     didn't compute them, so the frontend can tell "not fetched" apart
//     from "genuinely zero" if that distinction ever matters.
const sanitizeOrganization = (org, extras = {}) => ({
  id: org._id,
  name: org.name,
  companyCode: org.companyCode,
  isActive: org.isActive,
  createdBy: org.createdBy,
  managerId: org.managerId,
  manager: extras.manager !== undefined ? extras.manager : null,
  employeeCount: extras.employeeCount,
  operatorCount: extras.operatorCount,
  // DOC-61 - "Organization Settings for Manager". Included in EVERY
  // Organization response uniformly (System Admin's list/detail/update
  // endpoints too, not just GET/PATCH /me) - one shared response shape,
  // never a second, Manager-only variant. `|| null` (never `undefined`)
  // for a historical Organization created before this ticket, so the
  // frontend always receives a real, predictable value to render as an
  // empty field rather than needing its own "field might not exist yet"
  // handling.
  description: org.description || null,
  contactEmail: org.contactEmail || null,
  contactPhone: org.contactPhone || null,
  createdAt: org.createdAt,
  updatedAt: org.updatedAt,
});

// Reduces an already-fetched Manager User document to only the fields
// that are safe/useful as "contact info" elsewhere (DOC-49/DOC-51) - never
// passwordHash, never role/organizationId/isActive (those are either
// already implied by context or not this consumer's business).
const managerContactFrom = (managerUser) => (
  managerUser ? { id: managerUser._id, fullName: managerUser.fullName, email: managerUser.email } : null
);

// DOC-49: builds the full "Organization Overview" response shape for a
// SINGLE Organization - current Manager's contact info plus live
// Employee/Operator counts. Used by every endpoint that returns one
// Organization's detail (get/me/update/regenerate-code) so the response
// shape is identical everywhere, not just on the ones that happened to
// need it first.
//
// SCALE NOTE: this is up to 3 extra queries per Organization (a Manager
// lookup + 2 role counts) - fine at this project's current scale (no
// pagination anywhere yet, consistent with prior Sprint 2/3 scale
// decisions), but would need batching (see enrichOrganizations below,
// used by the list endpoint) if this were ever called in a tight loop
// over many Organizations one at a time.
async function enrichOrganization(org) {
  const [manager, employeeCount, operatorCount] = await Promise.all([
    org.managerId ? User.findOne({ _id: org.managerId, role: 'manager' }) : Promise.resolve(null),
    User.countDocuments({ organizationId: org._id, role: 'employee' }),
    User.countDocuments({ organizationId: org._id, role: 'operator' }),
  ]);
  return sanitizeOrganization(org, {
    manager: managerContactFrom(manager),
    employeeCount,
    operatorCount,
  });
}

// DOC-49: the same overview shape as enrichOrganization, but for a whole
// LIST of Organizations at once (GET /api/organizations) without an N+1
// query per Organization for the Manager-contact part - one batched
// `$in` lookup covers every Organization's Manager in a single query.
// Employee/Operator counts are still one pair of countDocuments per
// Organization (see the scale note above); batching those too would need
// an aggregation pipeline, which is more machinery than this project's
// current size justifies.
async function enrichOrganizations(organizations) {
  const managerIds = [...new Set(organizations.map((org) => org.managerId).filter(Boolean).map(String))];
  const managers = managerIds.length > 0
    ? await User.find({ _id: { $in: managerIds }, role: 'manager' }).sort({ createdAt: -1 })
    : [];
  const managersById = new Map(managers.map((m) => [String(m._id), m]));

  return Promise.all(organizations.map(async (org) => {
    const [employeeCount, operatorCount] = await Promise.all([
      User.countDocuments({ organizationId: org._id, role: 'employee' }),
      User.countDocuments({ organizationId: org._id, role: 'operator' }),
    ]);
    return sanitizeOrganization(org, {
      manager: managerContactFrom(org.managerId ? managersById.get(String(org.managerId)) : null),
      employeeCount,
      operatorCount,
    });
  }));
}

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

// DOC-61 - "Organization Settings for Manager". Three new validators,
// mirroring `validateName`'s own shape exactly (a pure function returning
// either `null` - valid - or a client-safe error string). All three
// fields are OPTIONAL (task spec section 3/25: "description: optional",
// "contactEmail: optional", "contactPhone: optional") - `null`/`undefined`/
// an empty (or whitespace-only) string are all valid ways to say "no
// value", and are normalized to `null` by the caller
// (`updateMyOrganization` below), never stored as `''`. A non-string
// value (array/object/number/boolean) is always rejected outright (task
// spec: "Reject object/array payloads where strings expected.") - this is
// checked BEFORE anything else, so `{}.trim is not a function` can never
// happen here.
const validateDescription = (description) => {
  if (description === null || description === undefined) {
    return null;
  }
  if (typeof description !== 'string') {
    return 'Description must be text.';
  }
  if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
    return `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  return null;
};

// Reuses this file's own already-imported `EMAIL_REGEX` (from
// auth.controller.js) - the SAME format rule Login/Register/every other
// email field in this project already uses, never a second, slightly
// different email regex. This is presentation-only contact information,
// not a login identity (task spec section 18) - it is never checked
// against `User.email` for uniqueness, and never written to any `User`
// document.
const validateContactEmail = (contactEmail) => {
  if (contactEmail === null || contactEmail === undefined || contactEmail === '') {
    return null;
  }
  if (typeof contactEmail !== 'string') {
    return 'Contact email must be text.';
  }
  if (!EMAIL_REGEX.test(contactEmail.trim())) {
    return 'Please provide a valid contact email address.';
  }
  return null;
};

// Deliberately permissive (task spec section 19) - see
// CONTACT_PHONE_PATTERN's own comment above for exactly which characters
// are allowed and why.
const validateContactPhone = (contactPhone) => {
  if (contactPhone === null || contactPhone === undefined || contactPhone === '') {
    return null;
  }
  if (typeof contactPhone !== 'string') {
    return 'Contact phone must be text.';
  }
  const trimmed = contactPhone.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_CONTACT_PHONE_LENGTH) {
    return `Contact phone must be at most ${MAX_CONTACT_PHONE_LENGTH} characters.`;
  }
  if (!CONTACT_PHONE_PATTERN.test(trimmed) || !/\d/.test(trimmed)) {
    return 'Please provide a valid contact phone number.';
  }
  return null;
};

// DOC-61 - the explicit, clearly-rejected denylist (task spec section 9:
// "Prefer rejecting forbidden fields clearly where practical.") for
// PATCH /api/organizations/me. Checked BEFORE any allowed field is even
// looked at, so a request mixing a legitimate field with a forged one
// (e.g. `{ name: "New Name", isActive: false }`) is rejected outright
// with a clear, specific message - never silently split into "apply the
// good part, ignore the bad part". `organizationId`/`_id`/`id` are
// included even though this endpoint never reads a target id from the
// body at all (the Organization is always `req.user.organizationId` -
// task spec section 8/12) - purely defensive, so a client attempting to
// influence WHICH Organization is updated via the body gets an explicit,
// clear rejection rather than having that field silently ignored with no
// feedback at all.
const FORBIDDEN_ORGANIZATION_SELF_UPDATE_FIELDS = [
  'companyCode', 'isActive', 'createdAt', 'updatedAt', 'createdBy', 'manager',
  'managerId', 'organizationId', '_id', 'id', 'users',
];

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
// password format). DOC-57 - the password check now calls the same
// shared `validatePassword` (utils/passwordPolicy.js) that registration
// and every DOC-57 password-setting endpoint use, rather than a third
// inline copy of a length check - the two (three, four) can never drift
// apart from each other.
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
  const passwordFormatError = validatePassword(password);
  if (passwordFormatError) {
    return `Manager ${passwordFormatError.charAt(0).toLowerCase()}${passwordFormatError.slice(1)}`;
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

// Sprint 4 - shared cleanup for createOrganization's two failure points
// below (default-Category seeding failure, and the pre-existing Manager-
// creation failure). This project does not use MongoDB multi-document
// transactions (see createAndLinkManager's own "Atomicity note" above -
// the same reasoning applies here), so a failed Organization creation is
// unwound with explicit compensating deletes instead: any default
// Categories already created for this Organization are removed, then the
// Organization itself. Nothing outside this exact Organization is ever
// touched - `organizationId` scopes the Category cleanup exactly the same
// way every other query in this codebase is scoped (DOC-38).
async function rollbackOrganizationCreation(organizationId) {
  await ServiceCategory.deleteMany({ organizationId }).catch((cleanupError) => {
    console.error('Failed to roll back default categories after Organization creation failure:', cleanupError);
  });
  await Organization.deleteOne({ _id: organizationId }).catch((cleanupError) => {
    console.error('Failed to roll back Organization after setup failure:', cleanupError);
  });
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
//
// Sprint 4: every newly created Organization is also seeded with a small
// default Service Category set (see utils/defaultServiceCategories.js) -
// otherwise an Employee cannot open a Request at all (DOC-10 correctly
// requires a valid, active, same-Organization Category) until a Manager
// remembers to create one manually. This runs BEFORE the optional Manager
// step below and uses the exact same "fail closed, roll back everything
// created so far" policy: an Organization is never left half-configured.
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

    let defaultCategoriesCreated = 0;
    try {
      const result = await ensureDefaultServiceCategories(organization._id);
      defaultCategoriesCreated = result.createdCount;
    } catch (categoryError) {
      await rollbackOrganizationCreation(organization._id);
      return next(categoryError);
    }

    // DOC-64 - "Audit Log". Recorded AFTER the Organization is fully
    // created (and, in the branch below, after its Manager is fully
    // linked) - never before, never blocking this response on it (see
    // services/auditLog.service.js's own failure-strategy comment). One
    // ORGANIZATION_CREATED event either way; a SEPARATE MANAGER_ASSIGNED
    // event only when an initial Manager was actually created in the same
    // call (task spec section 13: "Prefer one meaningful audit event per
    // administrative action" - creating an Organization and assigning its
    // first Manager are two distinct facts, even when they happen in one
    // HTTP request).
    recordAuditLog({
      actorId: req.user.userId,
      organizationId: organization._id,
      action: 'ORGANIZATION_CREATED',
      targetType: 'Organization',
      targetId: organization._id,
      metadata: { organizationName: organization.name },
    });

    if (!managerInput) {
      return res.status(201).json({
        status: 'success',
        data: sanitizeOrganization(organization, { employeeCount: 0, operatorCount: 0 }),
        // Additive, optional field - existing callers that don't read it
        // are completely unaffected. Lets the Admin UI show a short setup
        // summary without a second round-trip (task section 12).
        setup: { defaultCategoriesCreated },
      });
    }

    try {
      const manager = await createAndLinkManager(organization, managerInput);
      recordAuditLog({
        actorId: req.user.userId,
        organizationId: organization._id,
        action: 'MANAGER_ASSIGNED',
        targetType: 'Organization',
        targetId: organization._id,
        changes: { manager: { from: null, to: manager.fullName } },
        metadata: { organizationName: organization.name, managerId: manager._id, managerName: manager.fullName },
      });
      return res.status(201).json({
        status: 'success',
        data: sanitizeOrganization(organization, {
          manager: managerContactFrom(manager),
          employeeCount: 0,
          operatorCount: 0,
        }),
        manager: sanitizeUser(manager),
        setup: { defaultCategoriesCreated },
      });
    } catch (managerError) {
      await rollbackOrganizationCreation(organization._id);

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

    return res.status(200).json({ status: 'success', data: await enrichOrganization(organization) });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/organizations/me (manager only)
//
// DOC-61 - "Organization Settings for Manager". The Manager-only
// counterpart to GET /me above, reusing the identical "derive the target
// Organization exclusively from req.user.organizationId" contract - this
// route has no :id, no organizationId is ever read from the body/query,
// and it is therefore structurally incapable of updating any Organization
// other than the caller's own (task spec section 8/12: "Do NOT make
// Manager send organizationId... Manager A must NOT update Organization B
// by changing URL/body/query."). Registered with its own `requireRole
// ('manager')` chain (see routes/organization.routes.js) - Employee/
// Operator tokens never reach this function at all, and System Admin
// (whose organizationId is always null) would 404 here the same way it
// does on GET /me, though it never needs to: System Admin's own,
// separate PATCH /api/organizations/:id is completely unaffected by this
// endpoint (task spec section 11 - "System Admin behavior unchanged").
//
// SECURITY - explicit allowlist, never mass assignment (task spec section
// 9/10): only `name`/`description`/`contactEmail`/`contactPhone` are ever
// read from the body. `FORBIDDEN_ORGANIZATION_SELF_UPDATE_FIELDS` is
// checked FIRST and rejects the entire request (400) if the body contains
// any of companyCode/isActive/createdAt/updatedAt/createdBy/manager/
// managerId/organizationId/_id/id/users - never silently ignored, never
// partially applied. This project already has an established, audited-safe
// pattern for exactly this shape (`updateOrganization` above, System
// Admin's own PATCH /:id) - this function deliberately mirrors it (build
// `updates` explicitly, then `Object.assign(organization, updates)` -
// never `Object.assign(organization, req.body)`) rather than inventing a
// second way to safely update an Organization document.
//
// DOC-64 AUDIT LOG READINESS (task spec section 22, explicitly NOT built
// here): this function is intentionally small and linear - validate,
// build `updates`, save, respond - specifically so a future DOC-64 change
// can insert one `recordAuditLogEntry(...)` call after the `.save()`
// below (mirroring how services/requestActivity.service.js's
// `recordRequestActivity` is called from request.controller.js) without
// needing to restructure this function at all.
const UPDATABLE_SELF_FIELDS = ['name', 'description', 'contactEmail', 'contactPhone'];

const updateMyOrganization = async (req, res, next) => {
  try {
    if (!req.user.organizationId) {
      return res.status(404).json({
        status: 'error',
        message: 'You are not associated with an Organization.',
      });
    }

    const body = req.body || {};

    const forbiddenField = FORBIDDEN_ORGANIZATION_SELF_UPDATE_FIELDS.find(
      (field) => Object.prototype.hasOwnProperty.call(body, field),
    );
    if (forbiddenField) {
      return res.status(400).json({
        status: 'error',
        message: `${forbiddenField} cannot be updated through this endpoint.`,
      });
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      const nameError = validateName(body.name);
      if (nameError) {
        return res.status(400).json({ status: 'error', message: nameError });
      }
      updates.name = body.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const descriptionError = validateDescription(body.description);
      if (descriptionError) {
        return res.status(400).json({ status: 'error', message: descriptionError });
      }
      const trimmed = typeof body.description === 'string' ? body.description.trim() : body.description;
      updates.description = trimmed || null;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'contactEmail')) {
      const contactEmailError = validateContactEmail(body.contactEmail);
      if (contactEmailError) {
        return res.status(400).json({ status: 'error', message: contactEmailError });
      }
      const trimmed = typeof body.contactEmail === 'string' ? body.contactEmail.trim().toLowerCase() : body.contactEmail;
      updates.contactEmail = trimmed || null;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'contactPhone')) {
      const contactPhoneError = validateContactPhone(body.contactPhone);
      if (contactPhoneError) {
        return res.status(400).json({ status: 'error', message: contactPhoneError });
      }
      const trimmed = typeof body.contactPhone === 'string' ? body.contactPhone.trim() : body.contactPhone;
      updates.contactPhone = trimmed || null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: `No valid fields to update. Allowed fields: ${UPDATABLE_SELF_FIELDS.join(', ')}.`,
      });
    }

    const organization = await Organization.findById(req.user.organizationId);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    // DOC-64 - captured BEFORE Object.assign, one snapshot per field that
    // is actually PRESENT in `updates` (never every field on the document -
    // task spec section 9/22: "Do not store unchanged values" /
    // "Store only fields that actually changed").
    const previousValues = {};
    Object.keys(updates).forEach((field) => {
      previousValues[field] = organization[field];
    });

    Object.assign(organization, updates);
    await organization.save();

    // DOC-64 - "Audit Log" (task spec section 22). Only fields whose value
    // GENUINELY changed end up in `changes` - re-sending the exact same
    // value for a field (a safe no-op the controller above already
    // allows) never produces a misleading "from X to X" audit entry, and a
    // request where every touched field's new value equals its old one
    // (a technically valid "no-op save") records no audit entry at all
    // (task spec section 43 item 32: "unchanged name creates no log" - the
    // same principle DOC-62's own Profile audit entry below follows too).
    const settingsChanges = {};
    Object.keys(updates).forEach((field) => {
      const before = previousValues[field];
      const after = organization[field];
      if (before !== after) {
        settingsChanges[field] = { from: before, to: after };
      }
    });
    if (Object.keys(settingsChanges).length > 0) {
      recordAuditLog({
        actorId: req.user.userId,
        organizationId: organization._id,
        action: 'ORGANIZATION_SETTINGS_UPDATED',
        targetType: 'Organization',
        targetId: organization._id,
        changes: settingsChanges,
        metadata: { organizationName: organization.name },
      });
    }

    return res.status(200).json({ status: 'success', data: await enrichOrganization(organization) });
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

// GET /api/organizations (system_admin only)
const listOrganizations = async (req, res, next) => {
  try {
    const organizations = await Organization.find({}).sort({ createdAt: -1 });
    return res.status(200).json({ status: 'success', data: await enrichOrganizations(organizations) });
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

    return res.status(200).json({ status: 'success', data: await enrichOrganization(organization) });
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

    // DOC-64 - captured BEFORE Object.assign overwrites them, so the audit
    // entry below can show a real before/after diff rather than reading
    // the already-mutated in-memory document.
    const previousName = organization.name;
    const previousIsActive = organization.isActive;

    Object.assign(organization, updates);
    await organization.save();

    // DOC-64 - "Audit Log". A single PATCH here may legitimately change
    // `name` and/or `isActive` in one request (both are on UPDATABLE_FIELDS)
    // - each is its own distinct administrative fact (task spec section 13),
    // so up to two separate audit events are recorded for one HTTP call:
    // ORGANIZATION_UPDATED for a name change, and ORGANIZATION_ACTIVATED/
    // DEACTIVATED for a status change - never a single vague "organization
    // updated" event that hides which of the two actually happened.
    if (Object.prototype.hasOwnProperty.call(updates, 'name') && previousName !== organization.name) {
      recordAuditLog({
        actorId: req.user.userId,
        organizationId: organization._id,
        action: 'ORGANIZATION_UPDATED',
        targetType: 'Organization',
        targetId: organization._id,
        changes: { name: { from: previousName, to: organization.name } },
        metadata: { organizationName: organization.name },
      });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'isActive') && previousIsActive !== organization.isActive) {
      recordAuditLog({
        actorId: req.user.userId,
        organizationId: organization._id,
        action: organization.isActive ? 'ORGANIZATION_ACTIVATED' : 'ORGANIZATION_DEACTIVATED',
        targetType: 'Organization',
        targetId: organization._id,
        changes: { isActive: { from: previousIsActive, to: organization.isActive } },
        metadata: { organizationName: organization.name },
      });
    }

    return res.status(200).json({ status: 'success', data: await enrichOrganization(organization) });
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

    // DOC-64 - "Audit Log". Task spec sections 8/15 - CRITICAL: the actual
    // old/new companyCode values are deliberately NEVER stored here, only
    // the fact that a regeneration happened. This collection must never
    // become a secondary store of onboarding codes.
    recordAuditLog({
      actorId: req.user.userId,
      organizationId: organization._id,
      action: 'COMPANY_CODE_REGENERATED',
      targetType: 'Organization',
      targetId: organization._id,
      changes: { companyCodeChanged: true },
      metadata: { organizationName: organization.name },
    });

    return res.status(200).json({ status: 'success', data: await enrichOrganization(organization) });
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

    // DOC-64 - "Audit Log". Same MANAGER_ASSIGNED shape createOrganization's
    // own inline-manager branch already records above - this is simply the
    // OTHER call site that produces the same real-world fact ("an initial
    // Manager was assigned to this Organization").
    recordAuditLog({
      actorId: req.user.userId,
      organizationId: organization._id,
      action: 'MANAGER_ASSIGNED',
      targetType: 'Organization',
      targetId: organization._id,
      changes: { manager: { from: null, to: manager.fullName } },
      metadata: { organizationName: organization.name, managerId: manager._id, managerName: manager.fullName },
    });

    return res.status(201).json({
      status: 'success',
      data: sanitizeOrganization(organization, {
        manager: managerContactFrom(manager),
        employeeCount: 0,
        operatorCount: 0,
      }),
      manager: sanitizeUser(manager),
    });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/organizations/:id/manager (system_admin only)
//
// DOC-49: edits the CURRENT Manager's fullName/email - a different
// operation from POST above (create initial Manager) and PUT below
// (replace the Manager entirely). This is deliberately narrow: it never
// touches password, role, organizationId, or which Organization the
// Manager belongs to. 409 if the Organization has no Manager yet - there
// is nothing to edit, and this is not the endpoint that creates one.
const updateManagerProfile = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    if (!organization.managerId) {
      return res.status(409).json({
        status: 'error',
        message: 'This organization has no Manager yet - use POST to assign an initial Manager first.',
      });
    }

    // Scoped by role too, not just _id - defense in depth, mirroring
    // updateUserRole's structural guarantee that managerId can only ever
    // reference a User whose role is actually 'manager'.
    const manager = await User.findOne({ _id: organization.managerId, role: 'manager' });
    if (!manager) {
      return res.status(404).json({ status: 'error', message: 'Manager not found.' });
    }

    const body = req.body || {};
    const updates = {};

    // Explicit allowlist - fullName/email only. password, role,
    // organizationId, isActive, and anything else in the body is never
    // read here, exactly like PATCH /api/organizations/:id's allowlist
    // above for Organization fields.
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
      if (existing && String(existing._id) !== String(manager._id)) {
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

    Object.assign(manager, updates);
    await manager.save();

    return res.status(200).json({
      status: 'success',
      data: await enrichOrganization(organization),
      manager: sanitizeUser(manager),
    });
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

// PUT /api/organizations/:id/manager (system_admin only)
//
// DOC-49: replaces the CURRENT Manager with a brand-new Manager account -
// "safely", per the task's explicit requirement. Reuses createAndLinkManager
// (the exact same helper POST above and DOC-34's original flow use), which
// unconditionally overwrites organization.managerId with the new account -
// exactly the behavior a replacement needs. Requires an existing Manager
// (409 if none - use POST instead, this is not how an Organization gets
// its FIRST Manager).
//
// The OLD Manager is DEACTIVATED (isActive: false), never deleted and
// never silently detached from their Organization - organizationId is left
// untouched, preserving the historical/audit trail (this project's
// consistent preference for deactivation over destructive change, see
// DOC-47) and correctly keeping DOC-47's Organization-deletion safety
// check still blocked by this account until a System Admin explicitly
// resolves it later.
const replaceManager = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    if (!organization.managerId) {
      return res.status(409).json({
        status: 'error',
        message: 'This organization has no Manager yet - use POST to assign an initial Manager instead.',
      });
    }

    const oldManagerId = organization.managerId;

    let newManager;
    try {
      // Unconditionally overwrites organization.managerId and saves - see
      // createAndLinkManager's own doc comment above. If anything in here
      // fails, its own rollback logic deletes the just-created account and
      // rethrows; the OLD manager is never touched by this try block, so a
      // failure here always leaves the Organization exactly as it was.
      newManager = await createAndLinkManager(organization, req.body);
    } catch (managerError) {
      if (managerError instanceof OrganizationError) {
        return res.status(managerError.statusCode).json({ status: 'error', message: managerError.message });
      }
      return next(managerError);
    }

    // Deactivate the old Manager only AFTER the new one is confirmed
    // linked. Defensive re-check that the old manager's organizationId
    // still actually matches this Organization before touching it at all
    // (structurally it always should, by construction - see DOC-34/DOC-47 -
    // but this endpoint never assumes that without verifying it).
    const oldManager = await User.findOne({ _id: oldManagerId, role: 'manager' });
    if (oldManager && String(oldManager.organizationId) === String(organization._id)) {
      oldManager.isActive = false;
      await oldManager.save();
    }

    // DOC-64 - "Audit Log". `changes.manager` shows safe identities only
    // (task spec section 16: "previous manager id/name, new manager
    // id/name. Never password information.") - `oldManager` may be `null`
    // here in the defensive edge case above, so this falls back to a safe
    // placeholder rather than throwing.
    recordAuditLog({
      actorId: req.user.userId,
      organizationId: organization._id,
      action: 'MANAGER_REPLACED',
      targetType: 'Organization',
      targetId: organization._id,
      changes: {
        manager: {
          from: oldManager ? oldManager.fullName : 'Unknown manager',
          to: newManager.fullName,
        },
      },
      metadata: {
        organizationName: organization.name,
        previousManagerId: oldManagerId,
        newManagerId: newManager._id,
        newManagerName: newManager.fullName,
      },
    });

    return res.status(200).json({
      status: 'success',
      data: await enrichOrganization(organization),
      manager: sanitizeUser(newManager),
      previousManagerId: oldManagerId,
    });
  } catch (error) {
    return next(error);
  }
};

// DELETE /api/organizations/:id (system_admin only)
//
// DOC-47: a real, hard delete - but deliberately NOT a cascade delete, and
// only ever performed when it is safe. Before removing anything, this
// checks whether ANY User document still has `organizationId` equal to
// this Organization's `_id`. That single check already covers every
// dependent account this project currently has: an assigned Manager
// (DOC-34) always has `organizationId` set to its Organization, and so
// does every Employee/Operator (DOC-33/35) - there is no separate
// "manager relationship" to check independently. If any such User exists,
// the Organization is left completely untouched and this returns 409; the
// caller must resolve those Users' membership through some other action
// first. Nothing here ever deletes or detaches a User automatically.
//
// FUTURE DATA NOTE: this project has no Ticket/Request model yet (Sprint 3
// has not built one as of DOC-47). If/when one is added and it stores an
// `organizationId`, this same safety check MUST be extended to also reject
// deletion while that Organization has any Tickets - the task spec
// explicitly requires this, and forgetting to update this function when
// Tickets ship would silently reopen the exact orphaning risk this check
// exists to prevent.
const deleteOrganization = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid organization id.' });
    }

    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ status: 'error', message: 'Organization not found.' });
    }

    // Deliberately a existence count, not a fetch-and-inspect: this only
    // ever needs to know IF a dependent User exists, never who they are or
    // any of their fields, so there is nothing here that could leak user
    // data through an error response.
    const dependentUserCount = await User.countDocuments({ organizationId: organization._id });
    if (dependentUserCount > 0) {
      return res.status(409).json({
        status: 'error',
        message: 'This organization cannot be deleted while users are still assigned to it.',
      });
    }

    await Organization.deleteOne({ _id: organization._id });

    // DOC-64 - "Audit Log". `ORGANIZATION_DELETED` is not on the task
    // spec's own "at minimum consider" enum list, but this is real,
    // existing, high-consequence administrative functionality (DOC-47's
    // hard delete) that the task spec explicitly asked this audit to
    // inspect ("any Organization deletion behavior if it exists") - a
    // deliberate, justified addition, not scope creep. `organizationId` is
    // still set to the just-deleted Organization's own id (it existed and
    // was affected at the moment of this action, even though the document
    // itself is now gone) - the read API's own target-resolution already
    // degrades gracefully for a target that no longer exists (see
    // controllers/auditLog.controller.js's own `resolveTargetDisplayName`).
    recordAuditLog({
      actorId: req.user.userId,
      organizationId: organization._id,
      action: 'ORGANIZATION_DELETED',
      targetType: 'Organization',
      targetId: organization._id,
      metadata: { organizationName: organization.name },
    });

    // Same response shape as every other endpoint in this file
    // ({status, data}) rather than a bare 204 - kept consistent with the
    // rest of the API rather than introducing a one-off response format.
    return res.status(200).json({ status: 'success', data: { id: organization._id } });
  } catch (error) {
    return next(error);
  }
};

// GET /api/organizations/statistics (system_admin only)
//
// DOC-53 - "Dashboard Statistics", System Admin's platform-level slice.
// Deliberately the ONLY statistics endpoint that has nothing to do with
// Requests at all (task spec: "System Admin remains platform-level, not
// operational" / "Do not expose Organization operational Request data to
// System Admin unless it already has that permission" - it never did, and
// this task does not change that). Four small, independent
// `countDocuments` calls run in parallel - never a full
// `Organization.find({})` fetch just to count, and never one query per
// Organization (no N+1, regardless of how many Organizations exist).
//
// `totalManagers` counts EVERY User document with `role: 'manager'`,
// active or not - a deliberate, documented choice, not an oversight:
// DOC-49's replaceManager deactivates (never deletes) a replaced Manager,
// so a straightforward "count of accounts currently holding the Manager
// role" can include a historical, no-longer-in-service Manager whose
// Organization has since moved on to a different one. This mirrors how
// "Total Organizations" itself already includes inactive Organizations
// (a raw headcount, not a "currently in service" count) - the
// active/inactive BREAKDOWN is what `organizationsWithManager`/
// `organizationsWithoutManager` already provides for Organizations
// themselves. Only `id`/role-derived counts are ever touched here - no
// User document's passwordHash or any other field is read or returned.
const getOrganizationStatistics = async (req, res, next) => {
  try {
    const [total, active, withManager, totalManagers] = await Promise.all([
      Organization.countDocuments({}),
      Organization.countDocuments({ isActive: true }),
      Organization.countDocuments({ managerId: { $ne: null } }),
      User.countDocuments({ role: 'manager' }),
    ]);

    return res.status(200).json({
      status: 'success',
      data: {
        totalOrganizations: total,
        activeOrganizations: active,
        inactiveOrganizations: total - active,
        organizationsWithManager: withManager,
        organizationsWithoutManager: total - withManager,
        totalManagers,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createOrganization,
  listOrganizations,
  getOrganization,
  getMyOrganization,
  updateMyOrganization,
  updateOrganization,
  regenerateCompanyCode,
  assignManager,
  updateManagerProfile,
  replaceManager,
  deleteOrganization,
  getOrganizationStatistics,
  sanitizeOrganization,
  UPDATABLE_FIELDS,
  UPDATABLE_SELF_FIELDS,
};
