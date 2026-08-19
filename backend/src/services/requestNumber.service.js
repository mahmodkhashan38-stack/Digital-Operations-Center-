/**
 * Request Number generation (DOC-16 - "Request Number / Human-Friendly ID")
 * -------------------------------------------------------------------------
 *
 * The sole owner of turning the atomic Counter (models/Counter.js) into a
 * formatted `requestNumber` string - no controller or script reads/writes
 * the Counter collection directly, mirroring the same "one owner of write
 * logic" discipline requestActivity.service.js/notification.service.js
 * already established for their own collections.
 *
 * FORMAT (task spec section 3): `REQ-` + the sequence number, zero-padded
 * to 6 digits - `REQ-000001`, `REQ-000002`, ... `REQ-999999`. Uppercase,
 * fixed prefix, immutable once assigned (enforced by the schema itself -
 * see models/Request.js's own `requestNumber` field comment). A sequence
 * value beyond 999999 simply produces a longer numeric portion
 * (`REQ-1000000`) rather than throwing or wrapping around - `padStart`
 * never truncates, it only ever pads short numbers up to the minimum
 * width. This project has no realistic path to seven-digit Request
 * volume, so this is a defensive, not a functional, consideration.
 */

const Counter = require('../models/Counter');

const { REQUEST_COUNTER_KEY } = Counter;

const REQUEST_NUMBER_PREFIX = 'REQ-';
const REQUEST_NUMBER_PAD_LENGTH = 6;

function formatRequestNumber(seq) {
  return `${REQUEST_NUMBER_PREFIX}${String(seq).padStart(REQUEST_NUMBER_PAD_LENGTH, '0')}`;
}

// Atomically allocates and returns the NEXT requestNumber - safe under
// concurrent callers (task spec section 9: "10 users creating Requests at
// the same time must produce 10 different numbers"). `findOneAndUpdate`
// with `$inc` is a single-document write, which MongoDB guarantees is
// atomic even on this project's own standalone (non-replica-set)
// deployment - no transaction, session, or application-level locking is
// needed or used here (see this file's own top comment, and
// models/Counter.js's own longer writeup, for why this is different from
// the multi-document-write cases DOC-17/DOC-18 deliberately avoid making
// atomic). `upsert: true` means the very FIRST call ever made (no Counter
// document exists yet) creates one starting at `seq: 1` automatically -
// no separate seed/bootstrap step is required.
//
// SEQUENCE GAPS ARE ACCEPTABLE, DUPLICATES ARE NOT (task spec sections 8/
// 27, stated explicitly here as this project's documented policy): once
// this function returns a number, that exact number has been permanently
// consumed from the sequence - if the Request document itself then fails
// to save for any reason, that number is simply never reused. A gap in
// the visible numbering (`REQ-000101`, `REQ-000103`) is a normal, expected
// outcome and is never "repaired" by this project. Uniqueness is the only
// guarantee this function makes; continuity is explicitly NOT a
// guarantee.
//
// Never swallows its own errors (unlike requestActivity.service.js/
// notification.service.js's own best-effort writes) - a Request without a
// requestNumber would be a silent, permanent data-integrity gap on a
// field this project's schema also treats as unique, so
// createRequest is expected to let a failure here abort Request creation
// entirely (task spec section 26: "If counter generation fails: Request
// creation must fail safely" / "Do not silently create a Request without
// requestNumber").
async function getNextRequestNumber() {
  const counter = await Counter.findOneAndUpdate(
    { key: REQUEST_COUNTER_KEY },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return formatRequestNumber(counter.seq);
}

// MIGRATION-ONLY (task spec section 11): advances the counter to at least
// `minimumSeq`, never backward, and never below whatever the counter
// already holds - used exactly once per migration run, immediately after
// the migration has finished assigning historical requestNumbers, so the
// very next NEW Request created afterward continues the sequence rather
// than colliding with (or duplicating) a number the migration just
// assigned. Deliberately a simple read-then-conditionally-write (not a
// single atomic operation) - safe because this is only ever invoked by a
// manual, one-at-a-time migration script (scripts/migrateRequestNumbers.js),
// never under the concurrent-creation load getNextRequestNumber above is
// designed for; running the real application's createRequest endpoint
// concurrently with an in-progress migration is out of scope (the
// migration is expected to run against a quiescent database, the same
// operational assumption every other one-time migration script in this
// project already makes).
async function ensureCounterAtLeast(minimumSeq) {
  const existing = await Counter.findOne({ key: REQUEST_COUNTER_KEY });
  if (!existing) {
    await Counter.create({ key: REQUEST_COUNTER_KEY, seq: minimumSeq });
    return;
  }
  if (existing.seq < minimumSeq) {
    await Counter.updateOne({ key: REQUEST_COUNTER_KEY }, { $set: { seq: minimumSeq } });
  }
}

module.exports = {
  formatRequestNumber,
  getNextRequestNumber,
  ensureCounterAtLeast,
  REQUEST_NUMBER_PREFIX,
  REQUEST_NUMBER_PAD_LENGTH,
};
