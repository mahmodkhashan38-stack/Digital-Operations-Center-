// DOC-74 - "Organization Policies & Guidelines". A small, dedicated
// validator file, mirroring the exact shape utils/userFieldValidation.js's
// own `validateBio` (DOC-71) already established - pure, DB-free, string-
// in/error-or-value-out functions, reused as a PATTERN (not imported
// directly - this is a genuinely different model with genuinely different
// rules) so each concern stays independently readable/changeable.
const TITLE_MAX_LENGTH = 150;
const CONTENT_MAX_LENGTH = 10000;

// Task spec section 3 - a controlled, safe set of categories (never an
// arbitrary free-text field a policy list could be spammed/miscategorized
// with).
const POLICY_CATEGORIES = ['GENERAL', 'SECURITY', 'IT', 'SAFETY', 'HR', 'OPERATIONS', 'OTHER'];

// title - required, trimmed, max 150 chars (task spec section 3).
function validateTitle(title) {
  if (typeof title !== 'string') {
    return 'title is required.';
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return 'title is required.';
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    return `title must be at most ${TITLE_MAX_LENGTH} characters.`;
  }
  return null;
}

// content - required, PLAIN TEXT ONLY (task spec section 4 - "Do not
// support raw HTML... No dangerouslySetInnerHTML... No innerHTML"). This
// function never strips/escapes HTML-looking text - it does not need to,
// because the frontend NEVER renders policy content via
// dangerouslySetInnerHTML/innerHTML (see Policies.jsx): a value like
// `<script>alert(1)</script>` is stored and returned completely
// unmodified, and is therefore always displayed as harmless literal text,
// never executed - the exact same "storage is honest, rendering is safe"
// contract validateBio already established for User.bio. Line breaks are
// preserved (never collapsed) - `content.trim()` only removes LEADING/
// TRAILING whitespace, never anything in the middle, so a policy's own
// paragraph structure survives round-trip exactly as typed (task spec:
// "Preserve line breaks safely" - the frontend renders them via CSS
// `white-space: pre-wrap`, the same technique this project's own chat
// messages already use, never manual `<br>` injection).
function validateContent(content) {
  if (typeof content !== 'string') {
    return 'content is required.';
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return 'content is required.';
  }
  if (trimmed.length > CONTENT_MAX_LENGTH) {
    return `content must be at most ${CONTENT_MAX_LENGTH} characters.`;
  }
  return null;
}

// category - optional (defaults to 'GENERAL' at the schema level); when
// supplied, must be one of the controlled enum values - never an arbitrary
// string.
function validateCategory(category) {
  if (category === undefined) {
    return null;
  }
  if (typeof category !== 'string' || !POLICY_CATEGORIES.includes(category)) {
    return `category must be one of: ${POLICY_CATEGORIES.join(', ')}.`;
  }
  return null;
}

module.exports = {
  validateTitle,
  validateContent,
  validateCategory,
  POLICY_CATEGORIES,
  TITLE_MAX_LENGTH,
  CONTENT_MAX_LENGTH,
};
