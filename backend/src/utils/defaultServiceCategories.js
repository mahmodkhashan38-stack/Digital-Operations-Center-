/**
 * Sprint 4 - "Employee blocked by an empty Category list" gap fix.
 * -----------------------------------------------------------------
 * A brand-new Organization has zero Service Categories (DOC-43), and
 * POST /api/requests (DOC-10) has always correctly required a valid,
 * active, same-Organization categoryId - so a fresh Organization with no
 * Manager-created Categories yet leaves every Employee unable to open a
 * Request at all, with no self-service way out. This is NOT a Request
 * validation bug (that requirement is correct and stays unchanged - see
 * request.controller.js) - it is a missing-onboarding-step problem, fixed
 * here by seeding a small, practical default Category set automatically.
 *
 * This module is the ONE source of truth for what "the defaults" are and
 * how they get created, reused by both:
 *   - organization.controller.js's createOrganization (new Organizations
 *     get defaults immediately, as part of System Admin creating them)
 *   - serviceCategory.controller.js's createDefaultServiceCategories
 *     (a Manager-facing recovery action for an existing Organization that
 *     predates this feature, or that had its only Categories deactivated)
 * Neither controller re-implements this list or its idempotency logic -
 * see each call site's own comment.
 */
const ServiceCategory = require('../models/ServiceCategory');
const { normalizeCategoryName } = require('./serviceCategoryName');

// A small, practical starter set for a brand-new Organization. Deliberately
// generic (not industry-specific) - a real Organization is always free to
// rename, deactivate, or add its own via the existing DOC-43 management
// endpoints; these just mean "you are never blocked on day one."
const DEFAULT_SERVICE_CATEGORIES = ['Computers', 'Electricity', 'Plumbing', 'Network', 'Maintenance'];

// Idempotent: creates only the default names that do not already exist in
// this Organization (by normalizedName - the exact same comparison the
// model's own compound unique index enforces), regardless of whether an
// existing match is active or inactive (task requirement: an inactive
// "Computers" must never cause a second "Computers" to be created).
// Safe to call repeatedly, safe to call concurrently (a duplicate-key race
// on the individual create() below is treated as "someone else already
// created it," not an error), and safe to call on an Organization that
// already has some custom Categories (those are left completely
// untouched - only genuinely missing default names are added).
//
// Returns { createdCount, categories } where `categories` is the
// Organization's full resulting Category list (defaults AND any
// pre-existing custom ones), sorted the same way listServiceCategories
// already does - callers that need to show/return "the resulting list"
// (the Manager-facing recovery endpoint) get it directly, without a
// second query of their own.
async function ensureDefaultServiceCategories(organizationId) {
  const existing = await ServiceCategory.find({ organizationId });
  const existingNormalized = new Set(existing.map((category) => category.normalizedName));

  let createdCount = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const name of DEFAULT_SERVICE_CATEGORIES) {
    const normalized = normalizeCategoryName(name);
    if (existingNormalized.has(normalized)) {
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await ServiceCategory.create({ name, organizationId });
      existingNormalized.add(normalized);
      createdCount += 1;
    } catch (error) {
      // A concurrent call (e.g. the Manager clicking "Create Default
      // Categories" twice in quick succession, or a retried Organization
      // creation) may have inserted this exact name between our existence
      // check above and this create() call - the model's own compound
      // unique index (organizationId + normalizedName) is the real
      // backstop against that race, not this in-memory Set. A duplicate-
      // key error here means "already handled," not a failure of this
      // call as a whole.
      if (error.code === 11000) {
        existingNormalized.add(normalized);
        continue;
      }
      throw error;
    }
  }

  const categories = await ServiceCategory.find({ organizationId }).sort({ name: 1 });
  return { createdCount, categories };
}

module.exports = { DEFAULT_SERVICE_CATEGORIES, ensureDefaultServiceCategories };
