/**
 * DOC-41 - Company Code generation, normalization and validation.
 * -----------------------------------------------------------------
 *
 * WHAT A COMPANY CODE IS
 * A short, human-typeable onboarding code that uniquely identifies one
 * Organization. Later (DOC-33), an employee will type this code during
 * registration so the backend can look up the matching Organization and
 * set the new user's `organizationId` accordingly.
 *
 * A Company Code is NOT a credential. It never appears in Login, it never
 * implies a role, and knowing it does not grant access to anything by
 * itself - it only identifies *which* Organization a registration request
 * is for. Authentication is, and remains, Email + Password.
 *
 * FORMAT
 * Canonical form: exactly 6 characters, uppercase letters and digits only
 * (see COMPANY_CODE_REGEX). No spaces, no punctuation, no lowercase in
 * storage. It contains no embedded information at all - not the
 * Organization's _id, not a manager id, nothing sensitive - it is just a
 * random-looking label.
 *
 * NORMALIZATION
 * "abc123", "ABC123" and " AbC123 " must all refer to the same
 * Organization. normalizeCompanyCode() is the single canonical place that
 * turns any user-typed variant into the stored form (trim + uppercase).
 * Organization.js (the Mongoose model) uses this exact function as the
 * schema's `set` transform, so normalization can never drift between this
 * module and the database layer.
 *
 * GENERATION
 * generateCompanyCode() always produces a value that satisfies
 * isValidCompanyCode() by construction. Codes are generated with Node's
 * built-in crypto.randomInt (cryptographically strong, no extra
 * dependency) from a 32-character alphabet that deliberately excludes
 * 0/O and 1/I - not for security, purely so a human copying a code by eye
 * doesn't mistype it. This is a UX choice, not a validation rule: the
 * *validation* regex is intentionally broader (any uppercase letter or
 * digit) so it isn't coupled to this specific generator's alphabet choice.
 * 32^6 (~1.07 billion) possible codes makes accidental collisions
 * extremely unlikely at any realistic number of organizations.
 *
 * UNIQUENESS / COLLISION HANDLING
 * Random generation alone is never trusted as "probably unique enough".
 * generateUniqueCompanyCode(codeExistsFn) generates a candidate, asks the
 * caller-supplied `codeExistsFn` whether that code is already taken, and
 * retries (up to maxAttempts) if so. The database-level defense in depth
 * is the `unique: true` index on Organization.companyCode (see
 * Organization.js) - even if this retry logic were ever bypassed, MongoDB
 * itself will still reject a duplicate companyCode.
 *
 * WHO USES THIS MODULE
 * This file has no dependency on the Organization model and performs no
 * database access itself - `codeExistsFn` is injected by the caller. That
 * keeps it a small, reusable, easily-testable utility. DOC-32 (Create and
 * Manage Organizations), when implemented, is expected to use it like:
 *
 *   const { generateUniqueCompanyCode } = require('../utils/companyCode');
 *   const companyCode = await generateUniqueCompanyCode(
 *     (code) => Organization.exists({ companyCode: code }),
 *   );
 *   await Organization.create({ ...otherFields, companyCode });
 *
 * REGENERATING AN EXISTING ORGANIZATION'S CODE (future DOC-32/DOC-37 use)
 * The same generateUniqueCompanyCode() call is reused for regeneration -
 * there is no separate "regenerate" algorithm. The safe sequence is:
 *   1. Generate and confirm a new unique code (as above) BEFORE touching
 *      the existing document, so the old, still-working code is never
 *      discarded until a valid replacement is confirmed to exist.
 *   2. Only then set organization.companyCode = newCode and save().
 * Organizations are referenced by other documents (User.organizationId)
 * using MongoDB's immutable `_id`, never by companyCode. So regenerating a
 * companyCode never requires touching any User document - existing members
 * stay associated through organizationId exactly as before.
 *
 * THIS MODULE DOES NOT
 *   - Implement Organization CRUD or any HTTP endpoint (DOC-32).
 *   - Implement Register-with-Company-Code (DOC-33).
 *   - Grant any permission, role, or access based on the code.
 */

const crypto = require('crypto');

const COMPANY_CODE_LENGTH = 6;

// Validation accepts any 6-character uppercase letter/digit string. This is
// intentionally broader than the generation alphabet below (which avoids
// visually-ambiguous characters), so any code that was ever legitimately
// generated - now or under a future generator tweak - still validates.
const COMPANY_CODE_REGEX = /^[A-Z0-9]{6}$/;

// Alphabet used only when GENERATING a new code. Excludes 0/O and 1/I.
const GENERATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters

const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Canonical representation of a Company Code: trimmed and upper-cased.
 */
function normalizeCompanyCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

/**
 * True if `code` matches the fixed length/character rules every Company
 * Code must satisfy. Expects an already-normalized value; callers working
 * with raw user input should normalize first:
 *   isValidCompanyCode(normalizeCompanyCode(rawInput))
 */
function isValidCompanyCode(code) {
  return typeof code === 'string' && COMPANY_CODE_REGEX.test(code);
}

/**
 * Generates a single random Company Code candidate. Always satisfies
 * isValidCompanyCode() by construction. Does NOT check uniqueness against
 * the database - see generateUniqueCompanyCode() for that.
 */
function generateCompanyCode() {
  let code = '';
  for (let i = 0; i < COMPANY_CODE_LENGTH; i += 1) {
    const index = crypto.randomInt(GENERATION_ALPHABET.length);
    code += GENERATION_ALPHABET[index];
  }
  return code;
}

/**
 * Generates a Company Code confirmed unique via the injected async
 * `codeExistsFn(code) => boolean` check, retrying on collision.
 * Throws if no unique code is found within maxAttempts.
 */
async function generateUniqueCompanyCode(codeExistsFn, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  if (typeof codeExistsFn !== 'function') {
    throw new TypeError('generateUniqueCompanyCode requires a codeExistsFn(code) => Promise<boolean> argument.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = generateCompanyCode();
    // eslint-disable-next-line no-await-in-loop
    const exists = await codeExistsFn(candidate);
    if (!exists) {
      return candidate;
    }
  }

  throw new Error(
    `Could not generate a unique company code after ${maxAttempts} attempts. ` +
      'This should be virtually impossible at realistic scale - investigate the codeExistsFn check.',
  );
}

module.exports = {
  COMPANY_CODE_LENGTH,
  COMPANY_CODE_REGEX,
  normalizeCompanyCode,
  isValidCompanyCode,
  generateCompanyCode,
  generateUniqueCompanyCode,
};
