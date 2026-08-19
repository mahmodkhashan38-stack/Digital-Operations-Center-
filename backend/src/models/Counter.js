const mongoose = require('mongoose');

/**
 * Atomic Sequence Counters (DOC-16 - "Request Number / Human-Friendly ID")
 * -------------------------------------------------------------------------
 *
 * WHY THIS MODEL EXISTS
 * Generates the numeric portion of `Request.requestNumber` (REQ-000001,
 * REQ-000002, ...) safely under concurrent Request creation. This is the
 * classic MongoDB "atomic counter" pattern - a tiny collection of
 * `{key, seq}` documents, one per named sequence, incremented via a single
 * atomic `findOneAndUpdate` with `$inc` (see
 * services/requestNumber.service.js's own comment for the exact call).
 *
 * WHY NOT `Request.countDocuments() + 1` OR "LAST REQUEST + 1"
 * Both are read-then-write races: two concurrent Requests can read the
 * same count/last-number, then both write the same next number, producing
 * a duplicate. A single-document `findOneAndUpdate({key}, {$inc:{seq:1}})`
 * has no such window - MongoDB guarantees single-document writes are
 * atomic even on a standalone (non-replica-set) deployment (this project's
 * own `config/db.js` connects to a plain, non-transactional `mongod` -
 * see requestActivity.service.js's/notification.service.js's own
 * documented reason for avoiding multi-document transactions). This
 * counter never needs a transaction at all - it is exactly the
 * single-document operation MongoDB was always safe for.
 *
 * WHY GLOBAL, NOT PER-ORGANIZATION (task spec section 4)
 * This project already has a strong, load-bearing per-Organization
 * isolation boundary for AUTHORIZATION (`organizationId` on every
 * Request-scoped query - DOC-38) - `requestNumber` is deliberately NOT
 * part of that boundary. A single global sequence (`key: 'request'`)
 * keeps every visible Request number unique across the whole system,
 * simpler for cross-organization support/debugging (task spec's own
 * stated preference), and avoids the extra "which Organization's counter"
 * lookup a per-Organization sequence would need on every single Request
 * creation. There is no product requirement anywhere in this project for
 * an Organization-branded id (e.g. "ORG1-REQ-000001") - if one ever
 * emerges, a NEW counter key scoped by organizationId could be added
 * alongside this one without disturbing any existing document's already-
 * assigned `requestNumber` (immutable, task spec section 3).
 *
 * ONE COLLECTION, MULTIPLE FUTURE KEYS
 * This model is intentionally generic (`key` + `seq`), not
 * `RequestCounter` - a future ticket needing its own atomic sequence
 * (unrelated to Requests) can reuse this exact same collection/pattern
 * with a different `key` value, never a second bespoke counter model.
 */
const counterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    seq: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Counter', counterSchema);

// The one key this ticket ever uses. Exported as a constant (not a
// hardcoded string repeated at every call site) so requestNumber.service.js
// and the migration script can never accidentally drift to two different
// spellings of the same logical sequence.
module.exports.REQUEST_COUNTER_KEY = 'request';
