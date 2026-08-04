/**
 * DOC-43 - Service Category name normalization.
 * -----------------------------------------------------------------
 * Mirrors utils/companyCode.js's approach: one canonical normalization
 * function, used by both the Mongoose model (so it can never drift) and
 * anything else that needs to compare names the same way.
 *
 * Category names are natural-language display text ("Electricity",
 * "IT Support") - unlike a Company Code, the ORIGINAL casing/spacing a
 * Manager typed is preserved and displayed as-is (models/ServiceCategory.js's
 * `name` field only ever gets `trim: true`, never case-folded).
 * `normalizedName` (a separate, never-displayed field) is what actually
 * enforces "these are the same category" within one Organization:
 * lowercased, trimmed, and internal whitespace collapsed to a single
 * space, so "Electricity", " electricity ", "ELECTRICITY", and
 * "Electricity  Panel" / "Electricity Panel" are compared the same way.
 *
 * WHY NOT JUST NORMALIZE `name` ITSELF (like companyCode does)
 * A Company Code is never shown as a "display name" a human wrote - it is
 * already a machine-facing label, so normalizing it in place loses
 * nothing. A Category name IS a display label a Manager typed
 * ("Electricity", not "ELECTRICITY") - forcing its casing would be a
 * needless, surprising rewrite of what they entered. Keeping `name` and
 * `normalizedName` as two fields gets both: an unmodified display value
 * and a reliable duplicate-detection key.
 */
function normalizeCategoryName(name) {
  return String(name == null ? '' : name)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

module.exports = { normalizeCategoryName };
