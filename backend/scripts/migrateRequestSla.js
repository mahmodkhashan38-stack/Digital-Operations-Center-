/**
 * DOC-55 - Backfill SLA Fields on Existing Requests
 * --------------------------------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * DOC-55 added `slaDueAt`/`slaPolicyHours` (and `resolvedAt`/`closedAt`) to
 * the Request schema after DOC-10 was already shipped. Every Request
 * document created before this task was written to MongoDB before those
 * fields existed, so those documents simply have no `slaDueAt`/
 * `slaPolicyHours` at all. The application already handles this safely on
 * its own (see models/Request.js's own comment: Mongoose's `required`
 * validator only runs on save, never retroactively, and
 * request.controller.js's sanitizeRequest reports a safe `sla: null` -
 * "SLA not available" - for exactly this case) - this script is an
 * OPTIONAL, one-time way to bring historical Requests up to date so they
 * get real SLA data too, instead of staying "SLA not available" forever.
 *
 * WHAT "MISSING SLA DATA" MEANS HERE
 * A Request document where the `slaDueAt` field is completely missing from
 * the stored document (checked with MongoDB's `$exists: false`, the same
 * raw-field check migrateUsersToOrganizations.js already established as
 * this project's convention for "was this field ever written").
 *
 * WHAT THIS SCRIPT DOES, PER MISSING-SLA REQUEST
 *   1. Uses the Request's OWN CURRENT `priority` and OWN CURRENT
 *      `createdAt` - never "now" - to compute `slaDueAt`/`slaPolicyHours`
 *      via the exact same `calculateSlaDueAt`/`SLA_HOURS_BY_PRIORITY`
 *      every live code path (createRequest, managerUpdateRequest,
 *      updateMyRequest) already uses - one source of truth, never a
 *      second, parallel calculation.
 *   2. Sets `slaBreachedAt: null` (unless already present) - this
 *      project's own documented policy is that `slaBreachedAt` is never
 *      auto-populated at all in this version (see utils/slaPolicy.js's own
 *      comment) - it stays optional/null here too, never invented.
 *   3. Does NOT invent a `resolvedAt` for an already-resolved/closed
 *      historical Request (task spec: "if resolved/closed and resolvedAt
 *      is unavailable, do not invent a resolution time") - a historical
 *      resolved/closed Request that has no real `resolvedAt` on record
 *      simply keeps `resolvedAt: null` after this script runs, exactly as
 *      before. Its SLA compliance/average-resolution-time statistics will
 *      correctly continue to exclude it (see
 *      utils/requestStatistics.js's computeSlaStatistics - both
 *      calculations require a real `resolvedAt`).
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - It never overwrites a Request that already has `slaDueAt` set (task
 *     spec: "Do not overwrite Requests that already have SLA data.") -
 *     the query filter itself (`slaDueAt: { $exists: false }`) makes an
 *     already-migrated or newly-created (post-DOC-55) Request structurally
 *     unreachable by this script's own update, on every run.
 *   - It never changes title/description/category/status/attachments/
 *     comments or any other field.
 *   - It never invents a `resolvedAt`/`closedAt` value (see point 3
 *     above) - those stay `null` unless a real one is already on record.
 *   - It never runs automatically on server startup - it is only ever
 *     invoked explicitly via `npm run migrate:request-sla`.
 *   - An unsupported/invalid/missing `priority` on a legacy document
 *     (should not exist under the schema's own enum validator, but this
 *     script does not assume that has never been bypassed by a direct
 *     database edit) is reported and SKIPPED, never guessed at or
 *     defaulted to a made-up policy.
 *
 * IDEMPOTENCY
 * Safe to run any number of times. After the first run, no document
 * matches `{ slaDueAt: { $exists: false } }` anymore (every one of them
 * now has a real `slaDueAt`), so every later run finds zero candidates and
 * performs no writes at all - the exact same idempotency shape
 * migrateUsersToOrganizations.js already established for this project.
 *
 * HOW TO RUN
 *   cd backend
 *   npm run migrate:request-sla
 *
 * Requires the same MONGODB_URI used by the server (backend/.env). This
 * script does not start the HTTP server and does not require JWT_SECRET.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Request = require('../src/models/Request');
const { calculateSlaDueAt, SLA_HOURS_BY_PRIORITY, isValidSlaPriority } = require('../src/utils/slaPolicy');

const run = async () => {
  await connectDB();

  console.log('\n=== DOC-55: Request SLA backfill migration ===\n');

  const totalRequests = await Request.countDocuments({});

  const missingSlaFilter = { slaDueAt: { $exists: false } };
  const missingCountBefore = await Request.countDocuments(missingSlaFilter);

  let migratedCount = 0;
  const skipped = [];

  if (missingCountBefore > 0) {
    // Loaded as real Mongoose documents (not a raw updateMany) - each one
    // needs its OWN createdAt/priority read individually to compute a
    // per-document slaDueAt; there is no single `$set` value that could
    // apply to every legacy Request uniformly.
    const candidates = await Request.find(missingSlaFilter);

    // eslint-disable-next-line no-restricted-syntax
    for (const requestDoc of candidates) {
      if (!isValidSlaPriority(requestDoc.priority)) {
        skipped.push({
          id: requestDoc._id.toString(),
          reason: `unsupported/invalid priority "${requestDoc.priority}"`,
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      requestDoc.slaPolicyHours = SLA_HOURS_BY_PRIORITY[requestDoc.priority];
      requestDoc.slaDueAt = calculateSlaDueAt({ priority: requestDoc.priority, createdAt: requestDoc.createdAt });
      if (requestDoc.slaBreachedAt === undefined) {
        requestDoc.slaBreachedAt = null;
      }
      // Task spec: "if resolved/closed and resolvedAt is unavailable, do
      // not invent a resolution time" - resolvedAt/closedAt are simply
      // never written by this script at all, in either branch. Mongoose's
      // own schema defaults (`null`) already apply the first time this
      // document is saved with the field genuinely absent, which is the
      // correct, honest "we don't know" value - never a guessed timestamp.

      // eslint-disable-next-line no-await-in-loop
      await requestDoc.save();
      migratedCount += 1;
    }
  }

  const stillMissingCount = await Request.countDocuments(missingSlaFilter);
  const alreadyHadSlaCount = totalRequests - missingCountBefore;

  console.log(`Total requests in database:                 ${totalRequests}`);
  console.log(`Requests that already had SLA data:         ${alreadyHadSlaCount} (untouched by this run)`);
  console.log(`Requests missing SLA data before this run:  ${missingCountBefore}`);
  console.log(`Requests migrated this run:                 ${migratedCount}`);
  console.log(`Requests skipped (invalid priority):        ${skipped.length}`);
  console.log(`Requests still missing SLA data after run:  ${stillMissingCount} (should equal skipped count)`);

  if (skipped.length > 0) {
    console.log('\nSkipped requests (left untouched - investigate manually):');
    skipped.forEach((entry) => {
      console.log(`  - Request ${entry.id}: ${entry.reason}`);
    });
  }

  console.log('\nThis migration never invents a resolvedAt/closedAt for an already-');
  console.log('resolved/closed historical Request that has no real timestamp on record -');
  console.log('those Requests are correctly excluded from SLA compliance / average');
  console.log('resolution time statistics going forward (see utils/requestStatistics.js).');
  console.log('\n=== Migration complete ===\n');
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/migrateRequestSla.js`
// or `npm run migrate:request-sla`) - not when required by other code (e.g.
// a test harness that wants to call `run()` itself against a mocked
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
