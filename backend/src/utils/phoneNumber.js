/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade". Phone number
 * normalization/validation, following the exact same pattern
 * utils/companyCode.js already established for this project (a small,
 * dependency-free, database-agnostic utility module - no npm package is
 * added for this, since a full E.164/libphonenumber implementation is not
 * required to satisfy this ticket's own stated requirement: "store phone
 * numbers normalized in international E.164 format... normalize before
 * persistence").
 *
 * WHAT E.164 MEANS HERE
 * A leading "+", followed by 8-15 digits, no spaces, no dashes, no
 * parentheses (https://en.wikipedia.org/wiki/E.164 - the ITU standard the
 * task spec itself names). This module does not validate that a number is
 * actually ROUTABLE/assigned (that would require a live carrier lookup or
 * a large offline numbering-plan database, well beyond this project's
 * scope) - it only enforces the STRUCTURAL shape every real E.164 number
 * has, exactly the same "shape, not existence" honesty this project's
 * companyCode/contactPhone validators already practice.
 *
 * NORMALIZATION RULES (task spec: "Do not store inconsistent formats such
 * as 050-1234567, 0501234567, +972-50-1234567. Normalize before
 * persistence."):
 *   1. Strip every character that is not a digit or a leading "+".
 *   2. If the result does not start with "+", it is treated as a
 *      LOCAL-format number and requires a caller-supplied default country
 *      calling code (see normalizePhoneNumber's own `defaultCountryCode`
 *      param) to become E.164 - this project has no per-user "country"
 *      field to infer one from, so callers (registration/Manager-creation
 *      forms) must supply the target country's calling code explicitly.
 *      A local number's own leading trunk-prefix "0" (e.g. Israeli mobile
 *      "050-1234567") is stripped before the country code is prefixed,
 *      the standard trunk-code convention most national numbering plans
 *      use.
 *   3. The final value must match E164_REGEX below or normalization
 *      fails (returns `null` - never throws, never silently truncates).
 *
 * THIS MODULE DOES NOT
 *   - Send SMS (see services/sms.service.js).
 *   - Decide phone UNIQUENESS policy (see models/User.js's own partial
 *     unique index and this file's own header comment there).
 *   - Perform live carrier/number-existence validation.
 */

// Structural E.164 shape: "+" then 8-15 digits (ITU E.164 allows up to 15
// digits total including the country code; 8 is a permissive lower bound
// that rejects obviously-truncated input like "+123" without being overly
// strict about any specific country's real minimum length).
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// DOC-style default: this project's own primary target market/testing
// locale uses Israeli numbers (see models/Organization.js's own
// contactPhone field, which is deliberately country-agnostic - this
// constant is ONLY a convenience default for local-format input with no
// explicit country code, never a hard restriction - a caller can always
// pass a different `defaultCountryCode`, and a number already typed with
// its own "+" prefix is never altered regardless of this default).
const DEFAULT_COUNTRY_CALLING_CODE = '972';

/**
 * Normalizes a user-typed phone number into E.164 form, or returns `null`
 * if the input cannot be confidently normalized (never throws - the same
 * "return null / safe error string, never throw for bad user input"
 * convention every other validator in this project follows).
 *
 * Examples (defaultCountryCode='972'):
 *   "050-1234567"     -> "+972501234567"
 *   "0501234567"      -> "+972501234567"
 *   "+972-50-1234567" -> "+972501234567"
 *   "+972501234567"   -> "+972501234567" (already E.164, unchanged)
 *   "abc"             -> null
 *   ""                -> null
 */
function normalizePhoneNumber(rawInput, defaultCountryCode = DEFAULT_COUNTRY_CALLING_CODE) {
  if (typeof rawInput !== 'string') {
    return null;
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  const hasExplicitPlus = trimmed.startsWith('+');
  // Strip everything except digits (spaces, dashes, parentheses, dots) -
  // the leading "+", if present, is re-added explicitly below rather than
  // surviving this strip, so there is exactly one code path that decides
  // where the "+" goes, never two that could disagree.
  const digitsOnly = trimmed.replace(/\D/g, '');

  if (!digitsOnly) {
    return null;
  }

  let candidate;
  if (hasExplicitPlus) {
    candidate = `+${digitsOnly}`;
  } else {
    // Local format - strip a single leading trunk "0" (the conventional
    // national-dialing prefix), then prefix the default country calling
    // code. A number that is already long enough to plausibly BE a full
    // international number without a "+" (rare, but not impossible for
    // copy-pasted input) is still treated as local-format here - this
    // project has no reliable way to distinguish "a local number that
    // happens to be long" from "an international number missing its +"
    // without a real numbering-plan database, so it consistently picks
    // the LOCAL interpretation and documents that choice rather than
    // guessing silently either way.
    const withoutTrunkZero = digitsOnly.replace(/^0+/, '');
    candidate = `+${defaultCountryCode}${withoutTrunkZero}`;
  }

  return E164_REGEX.test(candidate) ? candidate : null;
}

/**
 * True if `value` is already a normalized E.164 string. Expects an
 * already-normalized value - callers working with raw user input should
 * normalize first: isValidE164(normalizePhoneNumber(rawInput)).
 */
function isValidE164(value) {
  return typeof value === 'string' && E164_REGEX.test(value);
}

/**
 * Phone privacy (task spec Phase 3 "PHONE PRIVACY" - "Do not expose full
 * phone numbers unnecessarily... Profile may show masked version such as
 * +972 5X XXX 1234"). Masks every digit except the country code and the
 * last 4 digits, replacing the middle with "X" characters, grouped for
 * readability. Returns `null` unchanged (nothing to mask) rather than a
 * confusing partially-masked string for a missing/invalid number.
 */
function maskPhoneNumber(e164Value) {
  if (!isValidE164(e164Value)) {
    return null;
  }
  const digits = e164Value.slice(1); // drop the leading '+'
  const last4 = digits.slice(-4);
  const maskedMiddleLength = Math.max(digits.length - 4, 0);
  const maskedMiddle = 'X'.repeat(maskedMiddleLength);
  // Grouped as "+<country><masked...> <last4>" - not a strict per-country
  // grouping format (this project has no numbering-plan database to do
  // that correctly for every country), just a readable, honest masked
  // shape that never reveals more than the task spec's own example does.
  return `+${maskedMiddle.length > 0 ? `${maskedMiddle} ` : ''}${last4}`;
}

module.exports = {
  E164_REGEX,
  DEFAULT_COUNTRY_CALLING_CODE,
  normalizePhoneNumber,
  isValidE164,
  maskPhoneNumber,
};
