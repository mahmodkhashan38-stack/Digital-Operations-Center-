// DOC-75 - "Organization Q&A / Knowledge Board". A small, dedicated
// validator file, mirroring the exact shape utils/policyFieldValidation.js
// (DOC-74) and utils/userFieldValidation.js (DOC-71) already established -
// pure, DB-free, string-in/error-or-value-out functions.
const TITLE_MIN_LENGTH = 5;
const TITLE_MAX_LENGTH = 200;
const QUESTION_CONTENT_MIN_LENGTH = 10;
const QUESTION_CONTENT_MAX_LENGTH = 5000;
const ANSWER_CONTENT_MIN_LENGTH = 2;
const ANSWER_CONTENT_MAX_LENGTH = 5000;

// Task spec section 6 - CATEGORY DECISION (documented). The read-only
// audit examined `models/ServiceCategory.js` and found it is a Manager-
// owned, PER-ORGANIZATION, dynamically-created list tied specifically to
// Request routing and Operator specialty-matching (DOC-43/DOC-44) - a
// brand-new Organization starts with ZERO Service Categories until a
// Manager creates some (or runs the DOC-43 "create defaults" recovery
// action), and a Manager may rename/deactivate one at any time for
// Request-routing reasons that have nothing to do with Knowledge Board
// content. Reusing that same dynamic, per-org, Manager-curated list here
// would make asking a question depend on Request-routing configuration
// that may not exist yet, and would let a Manager's Request-routing
// decision (deactivating a Service Category) silently affect the
// Knowledge Board's own category filter in a way no one asking a
// question would expect. A separate, CONTROLLED, fixed enum - the exact
// one the task spec itself suggests - is therefore the safer, simpler,
// and more predictable choice; it always exists (no per-org setup
// required) and can never be emptied out from under this feature by an
// unrelated Request-routing change. This is the same "small controlled
// enum, not a dynamic per-org list" decision DOC-74's own
// `POLICY_CATEGORIES` already made for the identical reason.
const KNOWLEDGE_CATEGORIES = [
  'GENERAL', 'IT', 'NETWORK', 'COMPUTERS', 'ELECTRICITY', 'PLUMBING', 'MAINTENANCE', 'SECURITY', 'HR', 'OTHER',
];

function validateTitle(title) {
  if (typeof title !== 'string') {
    return 'title is required.';
  }
  const trimmed = title.trim();
  if (trimmed.length < TITLE_MIN_LENGTH) {
    return `title must be at least ${TITLE_MIN_LENGTH} characters.`;
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    return `title must be at most ${TITLE_MAX_LENGTH} characters.`;
  }
  return null;
}

// Question content - required PLAIN TEXT (task spec section 4 - "No
// HTML. No rich-text editor"). Never HTML-stripped/escaped at write time -
// the frontend never renders it via dangerouslySetInnerHTML/innerHTML, the
// same "storage is honest, rendering is safe" contract
// utils/policyFieldValidation.js's own `validateContent` already
// documents. Line breaks are preserved (trim only removes LEADING/
// TRAILING whitespace).
function validateQuestionContent(content) {
  if (typeof content !== 'string') {
    return 'content is required.';
  }
  const trimmed = content.trim();
  if (trimmed.length < QUESTION_CONTENT_MIN_LENGTH) {
    return `content must be at least ${QUESTION_CONTENT_MIN_LENGTH} characters.`;
  }
  if (trimmed.length > QUESTION_CONTENT_MAX_LENGTH) {
    return `content must be at most ${QUESTION_CONTENT_MAX_LENGTH} characters.`;
  }
  return null;
}

// Answer content - same plain-text contract as question content, with its
// own (shorter) minimum length - task spec section 5: a short but genuine
// answer like "Restart the router." is a completely valid answer, unlike
// a question, which needs enough detail to actually describe a problem.
function validateAnswerContent(content) {
  if (typeof content !== 'string') {
    return 'content is required.';
  }
  const trimmed = content.trim();
  if (trimmed.length < ANSWER_CONTENT_MIN_LENGTH) {
    return `content must be at least ${ANSWER_CONTENT_MIN_LENGTH} characters.`;
  }
  if (trimmed.length > ANSWER_CONTENT_MAX_LENGTH) {
    return `content must be at most ${ANSWER_CONTENT_MAX_LENGTH} characters.`;
  }
  return null;
}

// category - optional (defaults to 'GENERAL' at the schema level); when
// supplied, must be one of the controlled enum values above.
function validateCategory(category) {
  if (category === undefined) {
    return null;
  }
  if (typeof category !== 'string' || !KNOWLEDGE_CATEGORIES.includes(category)) {
    return `category must be one of: ${KNOWLEDGE_CATEGORIES.join(', ')}.`;
  }
  return null;
}

module.exports = {
  validateTitle,
  validateQuestionContent,
  validateAnswerContent,
  validateCategory,
  KNOWLEDGE_CATEGORIES,
  TITLE_MIN_LENGTH,
  TITLE_MAX_LENGTH,
  QUESTION_CONTENT_MIN_LENGTH,
  QUESTION_CONTENT_MAX_LENGTH,
  ANSWER_CONTENT_MIN_LENGTH,
  ANSWER_CONTENT_MAX_LENGTH,
};
