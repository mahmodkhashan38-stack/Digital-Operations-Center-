/**
 * DOC-17 - Optional Historical Backfill: REQUEST_CREATED Only
 * -------------------------------------------------------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * DOC-17 added the RequestActivity timeline after many Requests already
 * existed in the database. Those pre-existing Requests simply have zero
 * activity records - the application already handles this safely on its
 * own (RequestActivityTimeline.jsx renders "No activity recorded yet.",
 * task spec section 30). This script is an OPTIONAL, one-time way to give
 * those historical Requests at least a starting point in their timeline,
 * instead of staying empty forever.
 *
 * WHAT THIS SCRIPT DOES, PER REQUEST WITH ZERO ACTIVITY RECORDS
 * Creates exactly ONE RequestActivity: `type: 'REQUEST_CREATED'`, using
 * ONLY data already honestly on the Request document itself:
 *   - `actorId`  = request.createdBy (who actually opened it - the same
 *                  field createRequest itself has always set from
 *                  req.user.userId; this script invents nothing here)
 *   - `createdAt` = request.createdAt (the Request's own real creation
 *                  time - Mongoose's `timestamps` option on
 *                  RequestActivity is explicitly overridden for this one
 *                  write only, so the backfilled event's timestamp matches
 *                  history instead of "now, whenever this script happens
 *                  to run")
 *   - `metadata` = { initialPriority, initialCategoryId, initialStatus:
 *                  'open', backfilled: true } - the same shape
 *                  createRequest's own live REQUEST_CREATED event uses,
 *                  plus an explicit `backfilled: true` flag so a
 *                  genuinely-live-recorded REQUEST_CREATED event is always
 *                  distinguishable from one this script produced (task
 *                  spec: "if implemented... but only if honest").
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO (task spec section 31, verbatim
 * constraints)
 *   - It NEVER invents who assigned an operator, who changed status, when
 *     priority changed, or any other historical event - ONLY
 *     REQUEST_CREATED is ever backfilled, for every Request, regardless of
 *     its current status/priority/assignment history. A Request that is
 *     today `in_progress` with an assigned Operator still only gets ONE
 *     backfilled event (its creation) - not a fabricated ASSIGNED or
 *     STATUS_CHANGED sequence leading up to its current state, because no
 *     honest record of exactly when/by-whom those real changes happened
 *     exists to backfill from.
 *   - It NEVER runs automatically on server startup - src/server.js never
 *     requires this file. Manual command only.
 *   - It NEVER touches a Request that already has at least one
 *     RequestActivity record (see the query below) - a Request with any
 *     activity, whether from live usage or an earlier run of this exact
 *     script, is left completely untouched.
 *   - It NEVER modifies the Request document itself - only ever creates
 *     new RequestActivity documents.
 *
 * IDEMPOTENCY
 * Safe to run any number of times. The candidate query is "Requests with
 * zero RequestActivity documents" - after the first run, every Request
 * that was missing activity now has exactly one (its backfilled
 * REQUEST_CREATED), so it is structurally excluded from the candidate set
 * on every later run. The same idempotency shape
 * migrateRequestSla.js/migrateUsersToOrganizations.js already established
 * for this project.
 *
 * HOW TO RUN
 *   cd backend
 *   npm run backfill:request-activity
 *
 * Requires the same MONGODB_URI used by the server (backend/.env). This
 * script does not start the HTTP server and does not require JWT_SECRET.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Request = require('../src/models/Request');
const RequestActivity = require('../src/models/RequestActivity');

const run = async () => {
  await connectDB();

  console.log('\n=== DOC-17: Request activity timeline backfill (REQUEST_CREATED only) ===\n');

  const totalRequests = await Request.countDocuments({});

  // Requests with at least one activity record already (live-recorded or
  // from an earlier run of this script) - the aggregation below is only
  // used to compute a distinct list of requestIds that already have
  // activity, so the actual candidate query can exclude them cleanly.
  const requestIdsWithActivity = await RequestActivity.distinct('requestId');

  const candidateFilter = { _id: { $nin: requestIdsWithActivity } };
  const candidateCountBefore = await Request.countDocuments(candidateFilter);

  let backfilledCount = 0;
  const skipped = [];

  if (candidateCountBefore > 0) {
    const candidates = await Request.find(candidateFilter);

    // eslint-disable-next-line no-restricted-syntax
    for (const requestDoc of candidates) {
      if (!requestDoc.createdBy) {
        // Should not be possible under the schema's own `required: true`
        // validator, but this script does not assume that has never been
        // bypassed by a direct database edit - reported and SKIPPED, never
        // guessed at or defaulted to a made-up actor.
        skipped.push({ id: requestDoc._id.toString(), reason: 'missing createdBy - cannot attribute an honest actor' });
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const activity = new RequestActivity({
        organizationId: requestDoc.organizationId,
        requestId: requestDoc._id,
        actorId: requestDoc.createdBy,
        type: 'REQUEST_CREATED',
        oldValue: null,
        newValue: null,
        metadata: {
          initialPriority: requestDoc.priority,
          initialCategoryId: requestDoc.categoryId,
          initialStatus: 'open',
          backfilled: true,
        },
      });
      // Overriding the timestamp this one time only, so the backfilled
      // event reads as "created when the Request was actually created",
      // not "created when this script happened to run" - `timestamps:
      // true` on the schema still applies `updatedAt` normally; only
      // `createdAt` is deliberately overwritten here, after the document
      // is otherwise fully built by Mongoose's own defaults.
      activity.createdAt = requestDoc.createdAt;

      // eslint-disable-next-line no-await-in-loop
      await activity.save();
      backfilledCount += 1;
    }
  }

  const stillMissingCount = await Request.countDocuments({
    _id: { $nin: await RequestActivity.distinct('requestId') },
  });
  const alreadyHadActivityCount = totalRequests - candidateCountBefore;

  console.log(`Total requests in database:                        ${totalRequests}`);
  console.log(`Requests that already had activity records:        ${alreadyHadActivityCount} (untouched by this run)`);
  console.log(`Requests missing all activity before this run:     ${candidateCountBefore}`);
  console.log(`Requests backfilled this run (REQUEST_CREATED):    ${backfilledCount}`);
  console.log(`Requests skipped (missing createdBy):               ${skipped.length}`);
  console.log(`Requests still with zero activity after this run:  ${stillMissingCount} (should equal skipped count)`);

  if (skipped.length > 0) {
    console.log('\nSkipped requests (left untouched - investigate manually):');
    skipped.forEach((entry) => {
      console.log(`  - Request ${entry.id}: ${entry.reason}`);
    });
  }

  console.log('\nThis backfill ONLY ever creates a REQUEST_CREATED event per Request. It');
  console.log('never invents assignment, status-change, priority-change, or any other');
  console.log('historical event - those never happened on record for these Requests, so');
  console.log('this script does not pretend they did. Every backfilled event carries');
  console.log('metadata.backfilled = true so it stays distinguishable from a genuinely');
  console.log('live-recorded REQUEST_CREATED event.');
  console.log('\n=== Backfill complete ===\n');
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/backfillRequestActivity.js`
// or `npm run backfill:request-activity`) - not when required by other code
// (e.g. a test harness that wants to call `run()` itself against a mocked
// database). Never run automatically on server startup - src/server.js
// never requires this file.
if (require.main === module) {
  run()
    .then(async () => {
      await mongoose.connection.close();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Backfill failed:', error);
      try {
        await mongoose.connection.close();
      } catch (closeError) {
        // Connection may already be closed/never opened - safe to ignore.
      }
      process.exit(1);
    });
}
