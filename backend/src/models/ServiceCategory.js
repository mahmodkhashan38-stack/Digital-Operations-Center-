const mongoose = require('mongoose');
const { normalizeCategoryName } = require('../utils/serviceCategoryName');

// DOC-43 - a Service Category belongs to exactly one Organization
// (Computers/Electricity/Plumbing/Maintenance for Org A; IT Support/
// Networks/Software/Office Equipment for Org B). This model is
// deliberately small: DOC-44 (Operator Specialties) and the future
// Request/Ticket model will both reference ServiceCategory._id later, but
// neither is implemented here - see the two tasks' own scope.
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 60;

const serviceCategorySchema = new mongoose.Schema(
  {
    // The Manager-facing display name, exactly as typed (only trimmed,
    // never case-folded) - "Electricity" stays "Electricity", not
    // "ELECTRICITY". See utils/serviceCategoryName.js for why uniqueness
    // is enforced through a separate field instead of normalizing this
    // one in place.
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: [MIN_NAME_LENGTH, `Category name must be at least ${MIN_NAME_LENGTH} characters.`],
      maxlength: [MAX_NAME_LENGTH, `Category name must be at most ${MAX_NAME_LENGTH} characters.`],
    },
    // Derived, never set directly by a client or exposed in any API
    // response (see controllers/serviceCategory.controller.js's
    // sanitizeServiceCategory) - kept in sync with `name` by the
    // pre-validate hook below, not by controller code remembering to set
    // it, so it structurally cannot drift out of sync with `name`. This is
    // the actual key the compound unique index below enforces uniqueness
    // on.
    normalizedName: {
      type: String,
      required: true,
    },
    // Reference to the owning Organization. Always set from
    // req.user.organizationId server-side (DOC-38) - a client can never
    // choose or change which Organization a category belongs to. Indexed
    // both individually (fast "all categories for my Organization" lookups)
    // and as part of the compound unique index below.
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // No hard delete (DOC-43 explicit requirement): a future Request may
    // reference a Category by _id, and deleting the Category would corrupt
    // that historical record. Deactivating instead keeps the document (and
    // every existing reference to it) intact, while signaling it should no
    // longer be offered for NEW Requests - the actual "cannot select an
    // inactive Category" enforcement belongs to DOC-10 (Request creation),
    // not here.
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

// Recomputes normalizedName whenever `name` is set or the document is new -
// this runs on every create() and every save() after `category.name = ...`,
// so there is no code path in this project that can persist a `name`
// without an up-to-date `normalizedName` alongside it.
serviceCategorySchema.pre('validate', function computeNormalizedName(next) {
  if (this.isNew || this.isModified('name')) {
    this.normalizedName = normalizeCategoryName(this.name);
  }
  next();
});

// DOC-43: uniqueness is scoped to ONE Organization, never global - two
// different Organizations may both have a category named "Electricity".
// This is a deliberately different shape from the two existing uniqueness
// decisions in this project: Organization.companyCode is globally unique
// (one shared onboarding namespace, DOC-41), and Organization.name has NO
// uniqueness at all (DOC-40 removed an accidental global constraint on it).
// A compound index on (organizationId, normalizedName) is the correct
// third shape: unique per-parent, not globally and not un-enforced.
serviceCategorySchema.index({ organizationId: 1, normalizedName: 1 }, { unique: true });

module.exports = mongoose.model('ServiceCategory', serviceCategorySchema);
