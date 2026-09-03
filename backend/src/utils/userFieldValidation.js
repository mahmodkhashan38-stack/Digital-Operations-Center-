// DOC-71 - "Enhanced User Profile: Profile Picture + Bio". A small,
// dedicated validator file, mirroring the exact shape utils/
// requestFieldValidation.js's own `validateRatingComment` already
// established for DOC-68 (optional, trimmed, max-length, string-only) -
// the same rule shape, reused as a pattern (not imported directly, since
// this is a genuinely different field on a genuinely different model, and
// duplicating ~10 lines here keeps each concern independently readable and
// independently changeable).
const MAX_BIO_LENGTH = 250;

// Returns `{ error, value }` - `error` is a client-safe string (or `null`
// when valid), `value` is the normalized value to actually store (or
// `null` when valid but nothing to store). Task spec section 3/32:
//   - undefined/null/empty-after-trim all normalize to `null` (task spec:
//     "empty Bio normalizes safely") - clearing a bio is a normal,
//     supported action, not an error.
//   - a non-string (object/array/number/boolean) is rejected outright -
//     checked BEFORE `.trim()` is ever called, so an object/array payload
//     can never reach it and throw (task spec: "Reject object... Reject
//     array").
//   - Plain text only. This function never strips HTML/scripts - it does
//     not need to, because the frontend NEVER renders a bio via
//     `dangerouslySetInnerHTML`/`innerHTML` (see Profile.jsx) - a value
//     like `<script>alert(1)</script>` is stored and returned completely
//     unmodified, and is therefore always displayed as harmless literal
//     text, never executed (task spec section 3's own explicit example).
function validateBio(bio) {
  if (bio === undefined || bio === null || bio === '') {
    return { error: null, value: null };
  }
  if (typeof bio !== 'string') {
    return { error: 'bio must be a string.', value: null };
  }
  const trimmed = bio.trim();
  if (trimmed.length === 0) {
    return { error: null, value: null };
  }
  if (trimmed.length > MAX_BIO_LENGTH) {
    return { error: `bio must be at most ${MAX_BIO_LENGTH} characters.`, value: null };
  }
  return { error: null, value: trimmed };
}

module.exports = { validateBio, MAX_BIO_LENGTH };
