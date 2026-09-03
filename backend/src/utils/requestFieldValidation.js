// DOC-46 - extracted from request.controller.js's original DOC-10
// creation-time validators so createRequest and updateMyRequest share the
// exact same title/description/priority rules rather than two copies that
// could quietly drift apart from each other over time. Deliberately kept
// as small, pure, synchronous functions - no DB access, no req/res - so
// they stay trivially unit-testable and easy to reuse from anywhere else
// a Request's fields need the same validation in the future.
const MIN_TITLE_LENGTH = 5;
const MAX_TITLE_LENGTH = 150;
const MIN_DESCRIPTION_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 2000;

const validateTitle = (title) => {
  if (typeof title !== 'string') {
    return 'Title is required.';
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return 'Title is required.';
  }
  if (trimmed.length < MIN_TITLE_LENGTH || trimmed.length > MAX_TITLE_LENGTH) {
    return `Title must be between ${MIN_TITLE_LENGTH} and ${MAX_TITLE_LENGTH} characters.`;
  }
  return null;
};

const validateDescription = (description) => {
  if (typeof description !== 'string') {
    return 'Description is required.';
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return 'Description is required.';
  }
  if (trimmed.length < MIN_DESCRIPTION_LENGTH || trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return `Description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  return null;
};

// `allowedValues` is passed in by the caller (Request.PRIORITY_VALUES)
// rather than imported here, so this file never has to require the
// Request model itself just to validate one enum field.
const validatePriority = (priority, allowedValues) => {
  if (!allowedValues.includes(priority)) {
    return `priority must be one of: ${allowedValues.join(', ')}.`;
  }
  return null;
};

// Sprint 4 (DOC-59) - Manager cancellation reason. A short mandatory note,
// not a free-form comment (task spec: "Reason required") - deliberately a
// tighter bound than Comment.content's 2000-character cap (comment.
// controller.js), since this is a brief administrative note, not a
// conversation. Mirrors this same file's title/description validators:
// pure, synchronous, no DB access.
const MIN_CANCEL_REASON_LENGTH = 3;
const MAX_CANCEL_REASON_LENGTH = 500;

const validateCancelReason = (reason) => {
  if (typeof reason !== 'string') {
    return 'A cancellation reason is required.';
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return 'A cancellation reason is required.';
  }
  if (trimmed.length < MIN_CANCEL_REASON_LENGTH || trimmed.length > MAX_CANCEL_REASON_LENGTH) {
    return `Cancellation reason must be between ${MIN_CANCEL_REASON_LENGTH} and ${MAX_CANCEL_REASON_LENGTH} characters.`;
  }
  return null;
};

// DOC-15 - "Advanced Request History & Reassignment". A reason required
// whenever a Manager REPLACES or REMOVES an already-assigned Operator
// (reassignment/unassignment) - deliberately NOT required for a genuine
// first assignment (unassigned -> Operator A), per the task spec's own
// explicit carve-out. Mirrors validateCancelReason's exact bounds (min 3,
// max 500, reject whitespace-only) - the same "brief mandatory
// administrative note, not a free-form comment" shape this project already
// established for Manager cancellation - reused here as its own function
// (rather than calling validateCancelReason directly) purely so the error
// message text stays accurate to what is actually being validated.
const MIN_ASSIGNMENT_REASON_LENGTH = 3;
const MAX_ASSIGNMENT_REASON_LENGTH = 500;

const validateAssignmentReason = (reason) => {
  if (typeof reason !== 'string') {
    return 'A reason is required.';
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return 'A reason is required.';
  }
  if (trimmed.length < MIN_ASSIGNMENT_REASON_LENGTH || trimmed.length > MAX_ASSIGNMENT_REASON_LENGTH) {
    return `Reason must be between ${MIN_ASSIGNMENT_REASON_LENGTH} and ${MAX_ASSIGNMENT_REASON_LENGTH} characters.`;
  }
  return null;
};

// DOC-68 - "Employee Satisfaction Rating". Backend-authoritative score
// validation (task spec section 12): accepts ONLY an actual integer
// Number in [1, 5] - never a numeric string ("5"), a decimal (2.5), an
// array/object, or a NaN-like value. `typeof score !== 'number'` rejects
// a string before `Number.isInteger` is even consulted (Number.isInteger
// itself already returns `false` for a string, an array, an object, and
// `NaN`, but the explicit typeof check documents the intent and matches
// this file's own "reject the wrong type before inspecting the value"
// style used by validateTitle/validateDescription above).
const MIN_SCORE = 1;
const MAX_SCORE = 5;

const validateScore = (score) => {
  if (typeof score !== 'number' || !Number.isInteger(score)) {
    return `score must be a whole number between ${MIN_SCORE} and ${MAX_SCORE}.`;
  }
  if (score < MIN_SCORE || score > MAX_SCORE) {
    return `score must be a whole number between ${MIN_SCORE} and ${MAX_SCORE}.`;
  }
  return null;
};

// Optional plain-text feedback (task spec section 3/13). `undefined`/`''`/
// whitespace-only are all valid "no comment given" states - normalized to
// `null` by the caller (requestRating.controller.js), never rejected here;
// this function only rejects a genuinely WRONG type (object/array/number)
// or a comment that is present but too long. Trimming happens here so the
// caller always receives either `null` (no comment) or an already-trimmed
// string ready to store as-is - never raw HTML, since this is a plain
// string field with no markup interpretation anywhere in this project
// (React renders it as text, never via dangerouslySetInnerHTML - task
// spec section 13/32).
const MAX_RATING_COMMENT_LENGTH = 500;

const validateRatingComment = (comment) => {
  if (comment === undefined || comment === null || comment === '') {
    return { error: null, value: null };
  }
  if (typeof comment !== 'string') {
    return { error: 'comment must be a string.', value: null };
  }
  const trimmed = comment.trim();
  if (trimmed.length === 0) {
    return { error: null, value: null };
  }
  if (trimmed.length > MAX_RATING_COMMENT_LENGTH) {
    return { error: `comment must be at most ${MAX_RATING_COMMENT_LENGTH} characters.`, value: null };
  }
  return { error: null, value: trimmed };
};

module.exports = {
  validateTitle,
  validateDescription,
  validatePriority,
  validateCancelReason,
  validateAssignmentReason,
  validateScore,
  validateRatingComment,
  MIN_TITLE_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MIN_CANCEL_REASON_LENGTH,
  MAX_CANCEL_REASON_LENGTH,
  MIN_ASSIGNMENT_REASON_LENGTH,
  MAX_ASSIGNMENT_REASON_LENGTH,
  MIN_SCORE,
  MAX_SCORE,
  MAX_RATING_COMMENT_LENGTH,
};
