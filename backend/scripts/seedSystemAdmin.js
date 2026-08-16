/**
 * DOC-31 - Create System Admin
 * -----------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * The System Admin is a single, global, system-level account:
 *   - role = 'system_admin'
 *   - organizationId = null (it does not belong to any Organization)
 * It must never be reachable through the public POST /api/auth/register
 * endpoint (that endpoint always hardcodes role = 'employee' and ignores
 * anything the client sends for role/organizationId - see
 * src/controllers/auth.controller.js). Creating a System Admin is therefore
 * a deliberate, manual, server-side action: this bootstrap script.
 *
 * CREDENTIALS
 * The System Admin's email/password/full name are read from environment
 * variables, never hardcoded here and never committed to the repository:
 *   SYSTEM_ADMIN_EMAIL       (required only to CREATE the first admin)
 *   SYSTEM_ADMIN_PASSWORD    (required only to CREATE the first admin)
 *   SYSTEM_ADMIN_FULL_NAME   (optional, defaults to "System Administrator")
 * Add real values to your local backend/.env (which is gitignored) before
 * running this script for the first time. See backend/.env.example for the
 * placeholder keys.
 *
 * SECURITY AUDIT (password/secrets refactor) - BOOTSTRAP-ONLY PASSWORD
 * This script's own database check ("does a system_admin already exist?")
 * now always runs BEFORE SYSTEM_ADMIN_PASSWORD is read or required at all
 * (see `run()` below) - previously the password was required up front,
 * even on a rerun that was about to discover the admin already exists and
 * do nothing. That meant a routine "always run the seed script on deploy,
 * it's a no-op if already bootstrapped" workflow would fail once
 * SYSTEM_ADMIN_PASSWORD was removed from `.env` after the real System
 * Admin already existed - even though the password was never actually
 * needed for that no-op outcome. Now: once a System Admin exists,
 * SYSTEM_ADMIN_PASSWORD is never read, never required, and irrelevant to
 * this script - normal server startup (`npm start` / `src/server.js`)
 * never depended on it in the first place (it is only ever read here, in
 * this separate, manually-invoked script), so a bootstrapped installation
 * can safely remove SYSTEM_ADMIN_PASSWORD from `backend/.env` entirely.
 * The existing System Admin's passwordHash is never read, compared,
 * touched, or re-hashed by this script under any circumstances - it has
 * no "reset" capability at all, by design.
 *
 * PASSWORD SECURITY
 * The password is validated and hashed with bcrypt using the exact same
 * MIN_PASSWORD_LENGTH and SALT_ROUNDS as public registration (imported
 * from src/controllers/auth.controller.js, not re-implemented here). The
 * plaintext password is never logged, never stored, and never printed.
 *
 * IDEMPOTENCY / "EXACTLY ONE SYSTEM ADMIN"
 * Safe to run more than once:
 *   - If a system_admin already exists and SYSTEM_ADMIN_EMAIL is unset OR
 *     matches its email, the script does nothing and exits successfully
 *     (0), without ever reading or requiring SYSTEM_ADMIN_PASSWORD. This
 *     is the normal "already bootstrapped" case.
 *   - If a system_admin already exists with a DIFFERENT email than an
 *     explicitly-set SYSTEM_ADMIN_EMAIL, the script refuses to create a
 *     second one and exits with an error (1), reporting the conflict
 *     instead of guessing which account is correct - still without ever
 *     reading SYSTEM_ADMIN_PASSWORD.
 *   - If no system_admin exists yet, but SYSTEM_ADMIN_EMAIL already belongs
 *     to a different (non-system_admin) user, the script refuses to
 *     silently promote that account and exits with an error (1). DOC-31 is
 *     not a role-promotion task - it never converts an existing Employee
 *     into a System Admin.
 * As a second line of defense (e.g. two bootstrap runs racing each other,
 * or a manual database edit), User.js also has a partial unique index on
 * { role: 'system_admin' }, so MongoDB itself will reject a second
 * system_admin document even if the application-level check above were
 * ever bypassed.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - It does not touch any existing Sprint 1 / DOC-39 user.
 *   - It does not assign the System Admin (or anyone else) to an
 *     Organization - organizationId is always explicitly null.
 *   - It does not create Organizations, managers, operators, or any
 *     dashboard/authorization infrastructure. That is later Sprint 2 work
 *     (DOC-32/34/35/37/38).
 *   - It never reads, changes, or resets an existing System Admin's
 *     password under any circumstances.
 *
 * HOW TO RUN
 *   cd backend
 *   npm run seed:system-admin
 *
 * Requires MONGODB_URI (same as the server) always. SYSTEM_ADMIN_EMAIL/
 * SYSTEM_ADMIN_PASSWORD are only required the first time, to create the
 * very first System Admin - see above. Does not require JWT_SECRET and
 * does not start the HTTP server.
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const User = require('../src/models/User');
const { SALT_ROUNDS, EMAIL_REGEX, MIN_PASSWORD_LENGTH } = require('../src/controllers/auth.controller');

const DEFAULT_FULL_NAME = 'System Administrator';

class SeedError extends Error {}

const run = async () => {
  // SYSTEM_ADMIN_EMAIL is read here (never sensitive - just an address,
  // used only to detect/report a conflict below), but SYSTEM_ADMIN_PASSWORD
  // is deliberately NOT read yet - see the security-audit comment above.
  // It is only ever read further down, inside the "no admin exists yet"
  // branch, exactly when it is actually about to be used.
  const email = (process.env.SYSTEM_ADMIN_EMAIL || '').toLowerCase().trim();
  const fullName = (process.env.SYSTEM_ADMIN_FULL_NAME || DEFAULT_FULL_NAME).trim();

  await connectDB();

  console.log('\n=== DOC-31: System Admin bootstrap ===\n');

  const existingAdmin = await User.findOne({ role: 'system_admin' });

  if (existingAdmin) {
    // Already bootstrapped - the ENTIRE point of this branch is that it
    // never needs, reads, validates, or touches SYSTEM_ADMIN_PASSWORD, or
    // the existing admin's passwordHash, at all. A missing/unset
    // SYSTEM_ADMIN_EMAIL is not a conflict (there is nothing to compare
    // against), so it is treated the same as a match - only an
    // EXPLICITLY-set, DIFFERENT email is ever reported as a conflict.
    if (!email || existingAdmin.email === email) {
      console.log(`System Admin already exists (${existingAdmin.email}). Nothing to do.`);
      return { created: false, conflict: false };
    }

    throw new SeedError(
      `A System Admin already exists with a different email (${existingAdmin.email}). ` +
        `Refusing to create a second System Admin for "${email}". ` +
        'There must be exactly one System Admin - resolve this manually if that email is wrong.',
    );
  }

  // No System Admin exists yet - this is the one and only path that ever
  // needs to create one, so SYSTEM_ADMIN_EMAIL/SYSTEM_ADMIN_PASSWORD are
  // both required starting here, not before.
  const password = process.env.SYSTEM_ADMIN_PASSWORD || '';

  if (!email || !password) {
    throw new SeedError(
      'No System Admin exists yet. SYSTEM_ADMIN_EMAIL and SYSTEM_ADMIN_PASSWORD must both be set in ' +
        'backend/.env to create the first one.',
    );
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new SeedError(`SYSTEM_ADMIN_EMAIL ("${email}") is not a valid email address.`);
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new SeedError(`SYSTEM_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }

  const conflictingUser = await User.findOne({ email });
  if (conflictingUser) {
    throw new SeedError(
      `A user with email "${email}" already exists with role "${conflictingUser.role}". ` +
        'This script never promotes an existing account to system_admin - choose a different ' +
        'SYSTEM_ADMIN_EMAIL, or resolve the conflict manually.',
    );
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const admin = await User.create({
    fullName,
    email,
    passwordHash,
    role: 'system_admin',
    organizationId: null,
  });

  console.log('System Admin created successfully:');
  console.log(`  id:              ${admin._id}`);
  console.log(`  fullName:        ${admin.fullName}`);
  console.log(`  email:           ${admin.email}`);
  console.log(`  role:            ${admin.role}`);
  console.log(`  organizationId:  ${admin.organizationId}`);
  console.log('\n(Password is not shown. It was hashed with bcrypt before being stored.)');

  return { created: true, conflict: false };
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/seedSystemAdmin.js`
// or `npm run seed:system-admin`) - not when required by a test harness that
// wants to call `run()` against a mocked database.
if (require.main === module) {
  run()
    .then(async () => {
      console.log('\n=== Done ===\n');
      await mongoose.connection.close();
      process.exit(0);
    })
    .catch(async (error) => {
      if (error instanceof SeedError) {
        console.error(`\nSystem Admin bootstrap failed: ${error.message}\n`);
      } else {
        console.error('\nSystem Admin bootstrap failed with an unexpected error:', error);
      }
      try {
        await mongoose.connection.close();
      } catch (closeError) {
        // Connection may already be closed/never opened - safe to ignore.
      }
      process.exit(1);
    });
}
