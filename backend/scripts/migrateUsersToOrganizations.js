/**
 * DOC-39 - Migrate Existing Users to Organization Structure
 * ---------------------------------------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * DOC-30 added `User.organizationId` (a reference to Organization) after
 * Sprint 1 was already shipped. Every user account created during Sprint 1
 * was written to MongoDB before that field existed, so those documents have
 * no `organizationId` key at all. Mongoose hides this in the app (it applies
 * the schema default of `null` whenever it hydrates a document), but the
 * raw data in MongoDB is still inconsistent: some documents have the key,
 * some don't. This script makes that explicit and uniform.
 *
 * WHAT "LEGACY" MEANS HERE
 * A legacy user is a User document where the `organizationId` field is
 * completely missing from the stored document (checked with MongoDB's
 * `$exists: false`, which only matches on the raw field, not on Mongoose's
 * in-memory default).
 *
 * WHAT THIS SCRIPT DOES
 *   1. Finds legacy users (organizationId missing) and sets
 *      organizationId = null on them explicitly.
 *   2. Reports how many users already have organizationId = null (nothing
 *      to do for them - already normalized, e.g. anyone who registered
 *      through the current Sprint 1 endpoint, which always defaults to
 *      null).
 *   3. Reports how many users already reference an Organization, and
 *      verifies each of those references still points at a real
 *      Organization document. Dangling references are only ever reported,
 *      never modified or guessed at.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - It never assigns a user to a real Organization. As of this task, no
 *     code path in the repository creates Organization documents yet
 *     (DOC-32) and there is no reliable signal (company code, invite, etc.)
 *     for which organization a Sprint 1 user belongs to (DOC-33). Guessing
 *     would violate multi-organization data isolation, so unassigned users
 *     are left at organizationId = null on purpose.
 *   - It never changes passwordHash, email, fullName, createdAt, isActive,
 *     or role.
 *   - It never creates an Organization (no "Default Organization" or
 *     similar placeholder).
 *   - It never creates or deletes a User document.
 *   - It never promotes anyone's role (no system_admin, manager, operator).
 *
 * IDEMPOTENCY
 * Safe to run any number of times. The only write this script performs is
 * `updateMany({ organizationId: { $exists: false } }, { $set: { organizationId: null } })`.
 * After the first run, no document matches that filter anymore, so every
 * later run finds zero legacy documents and performs no writes at all. The
 * dangling-reference check is read-only every time.
 *
 * HOW TO RUN
 *   cd backend
 *   npm run migrate:users-organizations
 *
 * Requires the same MONGODB_URI used by the server (backend/.env). This
 * script does not start the HTTP server and does not require JWT_SECRET.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');

const run = async () => {
  await connectDB();

  console.log('\n=== DOC-39: User -> Organization migration ===\n');

  const totalUsers = await User.countDocuments({});

  // Step 1: normalize legacy documents (organizationId key missing entirely).
  const missingFieldFilter = { organizationId: { $exists: false } };
  const missingCountBefore = await User.countDocuments(missingFieldFilter);

  let normalizedCount = 0;
  if (missingCountBefore > 0) {
    const result = await User.updateMany(missingFieldFilter, { $set: { organizationId: null } });
    normalizedCount = result.modifiedCount ?? result.nModified ?? 0;
  }

  // Step 2: users already normalized (organizationId explicitly null).
  const explicitNullCount = await User.countDocuments({ organizationId: null });

  // Step 3: users that already reference an Organization. Never modified -
  // only checked for whether the reference still resolves.
  const assignedUsers = await User.find(
    { organizationId: { $ne: null } },
    { _id: 1, email: 1, organizationId: 1 },
  );

  const danglingReferences = [];
  for (const user of assignedUsers) {
    // eslint-disable-next-line no-await-in-loop
    const orgExists = await Organization.exists({ _id: user.organizationId });
    if (!orgExists) {
      danglingReferences.push({
        userId: user._id.toString(),
        email: user.email,
        organizationId: user.organizationId.toString(),
      });
    }
  }

  console.log(`Total users in database:                    ${totalUsers}`);
  console.log(`Legacy users normalized this run:           ${normalizedCount} (organizationId was missing -> set to null)`);
  console.log(`Users with organizationId = null (total):   ${explicitNullCount} (unassigned - awaiting DOC-32 / DOC-33)`);
  console.log(`Users already referencing an Organization:  ${assignedUsers.length}`);

  if (danglingReferences.length > 0) {
    console.log(`\nWARNING: ${danglingReferences.length} user(s) reference an Organization that no longer exists:`);
    danglingReferences.forEach((u) => {
      console.log(`  - ${u.email} (user ${u.userId}) -> missing organization ${u.organizationId}`);
    });
    console.log('These were left untouched. Investigate manually - do not guess a replacement organization.');
  } else {
    console.log('No dangling organization references found.');
  }

  console.log('\nThis migration does not assign any user to an Organization.');
  console.log('Real organization membership requires DOC-32 (Create and Manage Organizations)');
  console.log('and DOC-33 (Register with Organization and Company Code) to exist first.');
  console.log('\n=== Migration complete ===\n');
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/migrateUsersToOrganizations.js`
// or `npm run migrate:users-organizations`) - not when required by other code
// (e.g. a test harness that wants to call `run()` itself against a mocked
// database, without this file also opening a real MongoDB connection and
// calling process.exit()).
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
