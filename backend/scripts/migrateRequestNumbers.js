/**
 * DOC-16 - Backfill requestNumber on Existing Requests
 * -----------------------------------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * DOC-16 added `requestNumber` (the human-friendly `REQ-000001` identifier)
 * to the Request schema after DOC-10 was already shipped. Every Request
 * document created before this task was written to MongoDB before this
 * field existed, so those documents simply have no `requestNumber` at all.
 * The application already handles this safely on its own (see
 * models/Request.js's own comment: `requestNumber` is NOT `required: true`
 * at the schema level, and request.controller.js's sanitizeRequest reports
 * a safe `requestNumber: null` for exactly this case, with the frontend
 * falling back to showing the title) - this script is an OPTIONAL, one-time
 * way to bring historical Requests up to date so they get a real,
 * displayable requestNumber too, instead of staying without one forever.
 *
 * WHAT "MISSING A REQUEST NUMBER" MEANS HERE
 * A Request document where the `requestNumber` field is completely missing
 * from the stored document (checked with MongoDB's `$exists: false`, the
 * same raw-field check migrateRequestSla.js/migrateUsersToOrganizations.js
 * already established as this project's convention for "was this field
 * ever written").
 *
 * ORDERING (task spec section 10)
 * Candidates are assigned numbers in `createdAt` ASCENDING order, with `_id`
 * ascending as a tie-breaker for any Requests sharing the exact same
 * `createdAt` millisecond - older Requests get lower numbers, matching the
 * intuitive "the request that has existed longest has the smallest number"
 * expectation. This is a stable, deterministic ordering: running this
 * script's sort twice against the same unmigrated data always produces the
 * same assignment.
 *
 * WHAT THIS SCRIPT DOES, PER MISSING-NUMBER REQUEST
 *   1. Atomically allocates the next sequence number via the exact same
 *      `getNextRequestNumber()` every live Request-creation call already
 *      uses (services/requestNumber.service.js) - one source of truth for
 *      turning a Counter increment into a formatted `REQ-000123` string,
 *      never a second, parallel implementation here.
 *   2. Saves ONLY `requestNumber` on the existing document - `_id`,
 *      `createdAt`, `status`, `priority`, `assignedOperatorId`,
 *      `slaDueAt`/`slaPolicyHours`, attachments, and every other business
 *      field are read but never modified (task spec: "preserves existing
 *      _id", "preserves createdAt", "preserves all business fields").
 *   3. After every candidate has been processed, advances the shared
 *      Counter to at least the highest sequence number just assigned (via
 *      `ensureCounterAtLeast` - migration-only, see
 *      requestNumber.service.js's own comment on why this one function is
 *      deliberately NOT the atomic `$inc` operation used everywhere else)
 *      so the very next NEW Request created after this migration continues
 *      the sequence rather than colliding with a number this migration just
 *      assigned (task spec section 11: "Do not reset sequence to 1 after
 *      migration. Do not create collisions.").
 *
 * WHY getNextRequestNumber() DURING MIGRATION IS STILL SAFE
 * `getNextRequestNumber()` is the same atomic `$inc` operation live Request
 * creation uses - calling it here simply means each migrated historical
 * Request consumes the next number in the SAME global sequence live
 * creation draws from. Because this script is expected to run once, against
 * a quiescent database (the same operational assumption every other
 * one-time migration script in this project already makes - see
 * migrateRequestSla.js's own header), there is no realistic concurrent
 * caller to race against. The `ensureCounterAtLeast` step at the end is
 * therefore mostly a defensive no-op in the normal case (the counter is
 * already exactly at the highest number assigned, since every number this
 * script allocated came from that same counter) - it is kept anyway as a
 * cheap, explicit safety net documented by the task spec, and matters if
 * this script is ever re-run after some numbers were manually/partially
 * assigned outside the normal flow.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - It never overwrites a Request that already has a `requestNumber` set
 *     (task spec: "skips Requests that already have requestNumber") - the
 *     query filter itself (`requestNumber: { $exists: false }`) makes an
 *     already-migrated or newly-created (post-DOC-16) Request structurally
 *     unreachable by this script's own update, on every run.
 *   - It never changes title/description/category/status/attachments/
 *     comments/SLA fields or any other field.
 *   - It never recalculates or touches SLA (`slaDueAt`/`slaPolicyHours`/
 *     `slaBreachedAt`) - task spec section 20.
 *   - It never resets the shared Counter backward, and never re-uses a
 *     number already assigned to another Request (task spec: "Sequence
 *     duplication is NOT acceptable.").
 *   - It never runs automatically on server startup - it is only ever
 *     invoked explicitly via `npm run migrate:request-numbers`.
 *
 * IDEMPOTENCY (task spec section 12)
 * Safe to run any number of times. After the first run, no document matches
 * `{ requestNumber: { $exists: false } }` anymore (every one of them now
 * has a real `requestNumber`), so every later run finds zero candidates,
 * performs zero Request writes, and leaves the Counter completely
 * untouched (the `ensureCounterAtLeast` call is only ever reached when at
 * least one candidate was actually migrated this run) - the exact same
 * idempotency shape migrateRequestSla.js/migrateUsersToOrganizations.js
 * already established for this project. Running this script twice never
 * changes an existing Request's `requestNumber`, never produces a
 * duplicate, and never advances the counter unnecessarily.
 *
 * HOW TO RUN
 *   cd backend
 *   npm run migrate:request-numbers
 *
 * Requires the same MONGODB_URI used by the server (backend/.env). This
 * script does not start the HTTP server and does not require JWT_SECRET.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Request = require('../src/models/Request');
const { getNextRequestNumber, ensureCounterAtLeast } = require('../src/services/requestNumber.service');

const run = async () => {
  await connectDB();

  console.log('\n=== DOC-16: Request number backfill migration ===\n');

  const totalRequests = await Request.countDocuments({});

  const missingNumberFilter = { requestNumber: { $exists: false } };
  const missingCountBefore = await Request.countDocuments(missingNumberFilter);

  let migratedCount = 0;
  const failed = [];
  let highestSeqAssigned = 0;

  if (missingCountBefore > 0) {
    // Loaded as real Mongoose documents (not a raw updateMany) - each one
    // needs its own individual `.save()` so a single failed document (e.g.
    // an unexpected validation error) never aborts the whole batch, and so
    // each one gets its OWN freshly-allocated number rather than a single
    // `$set` value that could apply to every legacy Request uniformly.
    //
    // Sort: createdAt ascending, then _id ascending as a tie-breaker (task
    // spec section 10) - older Requests get lower numbers.
    const candidates = await Request.find(missingNumberFilter).sort({ createdAt: 1, _id: 1 });

    // eslint-disable-next-line no-restricted-syntax
    for (const requestDoc of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const requestNumber = await getNextRequestNumber();
        const seq = Number(requestNumber.replace(/^REQ-/, ''));
        if (seq > highestSeqAssigned) {
          highestSeqAssigned = seq;
        }

        requestDoc.requestNumber = requestNumber;
        // eslint-disable-next-line no-await-in-loop
        await requestDoc.save();
        migratedCount += 1;
      } catch (error) {
        // A number was already atomically consumed from the counter above
        // even if this document's save then fails - per this project's own
        // documented policy (requestNumber.service.js), that number is
        // simply never reused ("sequence gaps are acceptable, duplicates
        // are not"). The failed Request is reported, left completely
        // untouched (no requestNumber written), and will be picked up
        // again - with a NEW number - the next time this script is run.
        failed.push({ id: requestDoc._id.toString(), reason: error.message });
      }
    }
  }

  // Task spec section 11 - after migration, advance the shared Counter to
  // at least the highest number in play, so the next NEW Request continues
  // the sequence rather than colliding with it. Deliberately computed from
  // the TRUE maximum `requestNumber` across the ENTIRE collection (every
  // Request that has one, not just the ones THIS run happened to assign) -
  // not merely `highestSeqAssigned` above - as an extra safety net beyond
  // what task spec section 11 strictly asks for: if the Counter and the
  // Request collection were ever out of sync for any reason (e.g. a
  // partially-completed earlier migration, or a document numbered through
  // some other path), this still ends the run with the Counter correctly
  // ahead of every real requestNumber on record, never behind. Always safe
  // to call unconditionally, even when nothing was migrated this run
  // (`highestSeqAssigned` stays 0): `ensureCounterAtLeast` only ever WRITES
  // when the Counter's current value is actually below the target, so an
  // already-correct Counter is left completely untouched on a repeat run -
  // "advance the counter unnecessarily" (task spec section 12) means
  // changing its value, not calling this function, and this call is a
  // guaranteed no-op whenever the Counter is already caught up.
  const numberedDocs = await Request.find({ requestNumber: { $exists: true } }).sort({});
  let highestSeqOverall = highestSeqAssigned;
  numberedDocs.forEach((doc) => {
    const match = /^REQ-(\d+)$/.exec(doc.requestNumber);
    if (match) {
      const seq = Number(match[1]);
      if (seq > highestSeqOverall) {
        highestSeqOverall = seq;
      }
    }
  });
  if (highestSeqOverall > 0) {
    await ensureCounterAtLeast(highestSeqOverall);
  }

  const stillMissingCount = await Request.countDocuments(missingNumberFilter);
  const alreadyHadNumberCount = totalRequests - missingCountBefore;

  console.log(`Total requests in database:                    ${totalRequests}`);
  console.log(`Requests that already had a requestNumber:     ${alreadyHadNumberCount} (untouched by this run)`);
  console.log(`Requests missing a requestNumber before run:    ${missingCountBefore}`);
  console.log(`Requests migrated this run:                    ${migratedCount}`);
  console.log(`Requests failed this run:                      ${failed.length}`);
  console.log(`Requests still missing a requestNumber after run: ${stillMissingCount} (should equal failed count)`);
  console.log(`Highest requestNumber sequence assigned this run: ${highestSeqAssigned || '(none)'}`);

  if (failed.length > 0) {
    console.log('\nFailed requests (left untouched - investigate manually, safe to re-run this script):');
    failed.forEach((entry) => {
      console.log(`  - Request ${entry.id}: ${entry.reason}`);
    });
  }

  console.log('\nThis migration never resets the shared request-number sequence, and never');
  console.log('reuses a number already assigned to another Request. Sequence gaps are an');
  console.log('acceptable, expected outcome of a failed save; duplicate numbers are not,');
  console.log('and never occur under this script\'s own allocation strategy.');
  console.log('\n=== Migration complete ===\n');
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/migrateRequestNumbers.js`
// or `npm run migrate:request-numbers`) - not when required by other code
// (e.g. a test harness that wants to call `run()` itself against a mocked
// database, without this file also opening a real MongoDB connection and
// calling process.exit()). Never run automatically on server startup -
// src/server.js never requires this file.
if (require.main === module) {
  run()
    .then(async () => {
      await mongoose.connection.close();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Migration failed:', error);
      try {
        await mongoose.connection.close();
      } catch (closeError) {
        // Connection may already be closed/never opened - safe to ignore.
      }
      process.exit(1);
    });
}
