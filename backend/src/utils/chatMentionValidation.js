/**
 * DOC-72 - "@Mentions in Organization Chat" - pure, DB-free parsing/shape
 * validation for the `mentionUserIds` multipart field. The actual
 * existence/same-organization/active/role checks against the database
 * live in chat.controller.js (they need a User query, which does not
 * belong in a pure utility file - the same "pure validators in utils/,
 * DB-backed checks in the controller" split this project's other
 * utils/*Validation.js files already follow, e.g. utils/
 * userFieldValidation.js's `validateBio`).
 */
const mongoose = require('mongoose');

// Task spec section 8/31 - "Protect against abuse... max 10 unique
// mentioned users per message... Reject excessive mention count." Applied
// AFTER deduplication (task spec section 7: "If the same user is
// mentioned multiple times... Deduplicate IDs server-side") - ten
// DIFFERENT people, not ten raw entries.
const MAX_MENTIONS_PER_MESSAGE = 10;

// DOC-72 - who may be mentioned at all mirrors exactly who may
// participate in Organization Chat (task spec section 30: "Mentionable
// users should be those who can participate in Organization Chat...
// Exclude system_admin"). Kept as its own small constant here (not
// imported from routes/chat.routes.js, which has no exported constant of
// its own) so a future change to one is never silently assumed to apply
// to the other without a deliberate edit.
const ALLOWED_MENTION_ROLES = ['manager', 'operator', 'employee'];

// Parses the raw `mentionUserIds` multipart TEXT field (task spec section
// 10: "Because multipart/form-data is used, choose a robust
// representation such as mentionUserIds as JSON array string... Parse
// safely. Reject malformed JSON. Do NOT eval."). `JSON.parse` is used
// (never `eval`/`Function` - there is no code execution risk here at
// all), wrapped in its own try/catch so a malformed string is a clean,
// safe 400 rather than an uncaught exception reaching the generic error
// handler.
//
// Returns `{ error, ids }` - `error` is a client-safe string (or `null`
// when valid), `ids` is the raw, NOT-YET-DB-VALIDATED array of string ids
// (still needs deduplication + ObjectId-format checking, both done here,
// and existence/organization/active/role checking, done by the caller
// against the database).
//
// An absent or empty-string field normalizes to `{ error: null, ids: [] }`
// - "no mentions" is a completely normal, valid case (most chat messages
// have none), never an error.
function parseMentionUserIdsField(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { error: null, ids: [] };
  }
  if (typeof rawValue !== 'string') {
    return { error: 'mentionUserIds must be a JSON array of user ids.', ids: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    return { error: 'mentionUserIds must be valid JSON.', ids: [] };
  }

  if (!Array.isArray(parsed)) {
    return { error: 'mentionUserIds must be a JSON array.', ids: [] };
  }
  // Cheap, cap-before-dedup guard (task spec section 31) - rejects an
  // obviously abusive payload (e.g. 10,000 entries) before even reaching
  // the ObjectId-format/dedup work below, independent of the final
  // deduplicated-count check the caller performs after DB resolution.
  if (parsed.length > MAX_MENTIONS_PER_MESSAGE) {
    return { error: `A message may mention at most ${MAX_MENTIONS_PER_MESSAGE} users.`, ids: [] };
  }
  if (!parsed.every((entry) => typeof entry === 'string')) {
    return { error: 'mentionUserIds must contain only user id strings.', ids: [] };
  }

  // Task spec section 33 - "Reject: malformed ObjectId" - checked here,
  // before any database round trip, exactly like every other id-shape
  // check in this project (DOC-38's own convention).
  if (!parsed.every((entry) => mongoose.Types.ObjectId.isValid(entry))) {
    return { error: 'One or more mentioned users could not be found.', ids: [] };
  }

  // Deduplicate (task spec section 7) - case-sensitive string dedup is
  // sufficient here since every entry has already been confirmed to be a
  // syntactically valid ObjectId string (a 24-character lowercase hex
  // string), which has exactly one canonical textual form.
  const deduped = Array.from(new Set(parsed));
  if (deduped.length > MAX_MENTIONS_PER_MESSAGE) {
    return { error: `A message may mention at most ${MAX_MENTIONS_PER_MESSAGE} unique users.`, ids: [] };
  }

  return { error: null, ids: deduped };
}

module.exports = {
  parseMentionUserIdsField,
  MAX_MENTIONS_PER_MESSAGE,
  ALLOWED_MENTION_ROLES,
};
