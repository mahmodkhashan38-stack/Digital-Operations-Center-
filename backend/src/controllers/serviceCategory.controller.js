const mongoose = require('mongoose');
const ServiceCategory = require('../models/ServiceCategory');
const { ensureDefaultServiceCategories } = require('../utils/defaultServiceCategories');

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 60;

// Fields a Manager may change through PATCH /api/service-categories/:id.
// Anything else in the request body (organizationId, _id, createdAt,
// isActive, ...) is silently ignored - the same explicit-allowlist
// pattern organization.controller.js's UPDATABLE_FIELDS already uses.
// isActive has its OWN dedicated endpoint (PATCH .../:id/status) rather
// than being folded into this allowlist, mirroring how DOC-50 kept
// user.controller.js's profile edit and activate/deactivate as two
// separate endpoints instead of one do-everything PATCH.
const UPDATABLE_FIELDS = ['name'];

// Strips a ServiceCategory document down to a safe, stable response
// shape. `normalizedName` is intentionally NEVER included - it exists
// purely as an internal duplicate-detection key (see models/
// ServiceCategory.js), not something any client needs to see or could do
// anything useful with.
const sanitizeServiceCategory = (category) => ({
  id: category._id,
  name: category.name,
  organizationId: category.organizationId,
  isActive: category.isActive,
  createdAt: category.createdAt,
  updatedAt: category.updatedAt,
});

const validateName = (name) => {
  if (typeof name !== 'string') {
    return 'Category name is required.';
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'Category name is required.';
  }
  if (trimmed.length < MIN_NAME_LENGTH || trimmed.length > MAX_NAME_LENGTH) {
    return `Category name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`;
  }
  return null;
};

// A duplicate-key error on this collection can only ever mean one thing -
// the (organizationId, normalizedName) compound index rejected a name
// that's already in use in this Organization - so this never needs to
// inspect error.keyValue the way organization.controller.js's
// duplicateKeyMessage() does for a collection with more than one unique
// index. The message never echoes the raw Mongo error back to the client.
const duplicateNameMessage = () => 'A service category with this name already exists in your organization.';

// POST /api/service-categories (manager only)
//
// Reads exactly one field from the request body: `name`. organizationId
// is never read from req.body/req.query/req.params - it always comes from
// req.user.organizationId, the fresh, per-request, database-backed value
// middleware/auth.js populates (DOC-38). A request body like
// { "name": "Electricity", "organizationId": "<some other org>" } still
// only ever creates a Category in the CALLER's own Organization - the
// extra field is simply never read.
const createServiceCategory = async (req, res, next) => {
  try {
    const { name } = req.body || {};

    const nameError = validateName(name);
    if (nameError) {
      return res.status(400).json({ status: 'error', message: nameError });
    }

    const category = await ServiceCategory.create({
      name: name.trim(),
      organizationId: req.user.organizationId,
    });

    return res.status(201).json({ status: 'success', data: sanitizeServiceCategory(category) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: duplicateNameMessage() });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// GET /api/service-categories (manager only)
//
// Scoped at the database query level to req.user.organizationId - never
// ServiceCategory.find({}) followed by filtering. Returns both active and
// inactive categories (the Manager Dashboard needs to show and manage
// both - see the frontend); which ones are selectable for a NEW Request is
// DOC-10's concern, not this endpoint's.
const listServiceCategories = async (req, res, next) => {
  try {
    const categories = await ServiceCategory
      .find({ organizationId: req.user.organizationId })
      .sort({ name: 1 });
    return res.status(200).json({ status: 'success', data: categories.map(sanitizeServiceCategory) });
  } catch (error) {
    return next(error);
  }
};

// GET /api/service-categories/available (any authenticated Organization
// member - employee, operator, or manager)
//
// DOC-10 - a read-only, active-only view of the caller's own
// Organization's Categories. Added as a SEPARATE endpoint rather than
// loosening the Manager-only management endpoints above: an Employee
// needs to discover which Categories they may pick when opening a
// Request (DOC-10), but must never gain any ability to create/edit/
// activate/deactivate a Category - this route is wired in
// routes/serviceCategory.routes.js BEFORE the blanket
// requireRole('manager') gate, with its own smaller authorization chain
// (verifyToken + requireOrganizationMembership + requireActiveOrganization,
// no role restriction beyond "belongs to an active Organization").
// Operator/Manager can safely reuse this same endpoint for any future UI
// that also needs "this Organization's active Categories" - it exposes
// nothing a Manager can't already see via the full listServiceCategories
// above, and nothing an Operator/Employee shouldn't see about their own
// Organization's own Categories.
//
// Deliberately excludes inactive Categories (an Employee must never be
// able to select one for a new Request - see request.controller.js's own
// server-side enforcement of the same rule) and, like every other
// endpoint here, is scoped at the query level to req.user.organizationId,
// never a global ServiceCategory.find({ isActive: true }).
const listAvailableServiceCategories = async (req, res, next) => {
  try {
    // requireOrganizationMembership deliberately bypasses system_admin
    // (it is a global, non-organization-scoped role, DOC-31/38) - but a
    // system_admin has no organizationId to scope this query by. Rather
    // than silently querying `{ organizationId: null }` (which would
    // simply return an empty list, not a security leak, but is a
    // meaningless call for that role), this mirrors getMyOrganization's
    // own explicit "not associated with an Organization" response.
    if (!req.user.organizationId) {
      return res.status(404).json({
        status: 'error',
        message: 'You are not associated with an Organization.',
      });
    }

    const categories = await ServiceCategory
      .find({ organizationId: req.user.organizationId, isActive: true })
      .sort({ name: 1 });
    return res.status(200).json({ status: 'success', data: categories.map(sanitizeServiceCategory) });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/service-categories/:id (manager only)
//
// Explicit allowlist (UPDATABLE_FIELDS: name only) - organizationId,
// _id, createdAt, and isActive can never be changed through this
// endpoint, even if present in the request body.
const updateServiceCategory = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid service category id.' });
    }

    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'name')) {
      return res.status(400).json({
        status: 'error',
        message: `No valid fields to update. Allowed fields: ${UPDATABLE_FIELDS.join(', ')}.`,
      });
    }

    const nameError = validateName(body.name);
    if (nameError) {
      return res.status(400).json({ status: 'error', message: nameError });
    }

    // Scoped query, not findById() + a manual comparison afterward: this
    // single query is what makes "no such category" and "that category
    // belongs to another Organization" produce the identical 404 response
    // - a cross-organization category id behaves exactly like a
    // nonexistent one (DOC-38 anti-enumeration convention).
    const category = await ServiceCategory.findOne({ _id: id, organizationId: req.user.organizationId });
    if (!category) {
      return res.status(404).json({ status: 'error', message: 'Service category not found.' });
    }

    category.name = body.name.trim();
    await category.save();

    return res.status(200).json({ status: 'success', data: sanitizeServiceCategory(category) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: duplicateNameMessage() });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/service-categories/:id/status (manager only)
//
// Body: `{ isActive: true|false }` - the only field read. No hard delete
// exists anywhere in this router (DOC-43 explicit requirement) - this is
// the only way a Category's availability ever changes, and the document
// itself (and its _id, for any future Request that references it) is
// never removed.
const updateServiceCategoryStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid service category id.' });
    }

    const body = req.body || {};
    if (typeof body.isActive !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isActive must be a boolean.' });
    }

    const category = await ServiceCategory.findOne({ _id: id, organizationId: req.user.organizationId });
    if (!category) {
      return res.status(404).json({ status: 'error', message: 'Service category not found.' });
    }

    category.isActive = body.isActive;
    await category.save();

    return res.status(200).json({ status: 'success', data: sanitizeServiceCategory(category) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// POST /api/service-categories/create-defaults (manager only)
//
// Sprint 4 - the Manager-facing recovery action for an Organization that
// has zero Categories (predates this feature, or every default was
// manually deleted-in-spirit via deactivation and a Manager wants the
// starter set back). organizationId comes exclusively from
// req.user.organizationId (DOC-38) - there is no way to target another
// Organization through this endpoint. Delegates entirely to
// ensureDefaultServiceCategories - this controller adds no logic of its
// own beyond authorization and response shaping, so the create-only-
// what's-missing/idempotent/never-reactivate behavior is guaranteed
// identical to what a brand-new Organization gets at creation time (see
// organization.controller.js's createOrganization).
const createDefaultServiceCategories = async (req, res, next) => {
  try {
    const { createdCount, categories } = await ensureDefaultServiceCategories(req.user.organizationId);
    return res.status(200).json({
      status: 'success',
      data: categories.map(sanitizeServiceCategory),
      createdCount,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createServiceCategory,
  listServiceCategories,
  listAvailableServiceCategories,
  updateServiceCategory,
  updateServiceCategoryStatus,
  createDefaultServiceCategories,
  sanitizeServiceCategory,
  UPDATABLE_FIELDS,
};
