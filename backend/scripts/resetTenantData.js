/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade" - Phase 2, "SAFE
 * PLATFORM RESET SCRIPT".
 * -------------------------------------------------------------------------
 *
 * WHAT THIS SCRIPT DOES
 * Wipes every Organization and every non-System-Admin User, plus every
 * collection whose data only ever exists BECAUSE of one of those
 * (Requests, Chat, Direct Messages, Policies, Knowledge Board, Ratings,
 * Sessions, Service Categories, email-verification challenges, email
 * delivery logs, and tenant-scoped Audit Log entries), so the platform can
 * move to the email-verified account model from a clean slate. See
 * this file's own `TENANT_COLLECTIONS_DELETED` list below for the exact,
 * complete inventory - it is the single source of truth for "what this
 * script touches", cross-referenced against this ticket's own Phase 1
 * read-only audit of every organizationId/userId-bearing collection in
 * this codebase.
 *
 * WHAT THIS SCRIPT NEVER DOES
 *   - Run automatically. It is never required/imported by server.js,
 *     app.js, config/db.js, or any seed script - it is invoked ONLY as an
 *     explicit `node scripts/resetTenantData.js` (via the two npm scripts
 *     below), exactly like this project's existing one-off migration
 *     scripts (scripts/migrateRequestSla.js, etc.).
 *   - Delete anything without an operator FIRST seeing a dry-run summary
 *     of exactly what would be removed (see `printSummary` below) and
 *     THEN explicitly setting CONFIRM_TENANT_RESET=YES.
 *   - Touch the System Admin account itself, under any circumstance -
 *     see `assertExactlyOneSystemAdmin` below, which refuses to run at
 *     all (not just "skips deleting it") if it cannot find EXACTLY one.
 *   - Print a password, password hash, JWT, OTP, temporary password, or
 *     full/unmasked phone number. Only ids, counts, and the surviving
 *     System Admin's email (not a secret - already displayed throughout
 *     this project's own Manager/Audit Log UI) are ever logged.
 *
 * USAGE
 *   npm run reset:tenant-data:dry-run        (never deletes anything)
 *   CONFIRM_TENANT_RESET=YES npm run reset:tenant-data   (actually deletes)
 * Without CONFIRM_TENANT_RESET=YES, the destructive path refuses to run -
 * see the very first check in `main()` below, which runs BEFORE this
 * script even connects to MongoDB.
 *
 * STORAGE CLEANUP (task spec: "tenant GridFS files / storage objects when
 * safely identifiable"). Every Request attachment/completion attachment,
 * every ChatMessage/DirectMessage attachment, and every non-admin User's
 * profile image is collected BEFORE its owning document is deleted, then
 * removed via the EXACT SAME storage-service functions
 * (requestImageStorage.deleteImage / profileImageStorage.deleteImage /
 * chatAttachmentStorage.deleteAttachment / dmAttachmentStorage.
 * deleteAttachment) every other delete path in this project already uses -
 * no separate/duplicated S3-or-GridFS branching logic is written here.
 * Each one is already internally best-effort (never throws - see those
 * files' own `deleteImage`/`deleteAttachment`), so a single missing/
 * already-deleted object can never abort the rest of the reset.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');

const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const Request = require('../src/models/Request');
const RequestActivity = require('../src/models/RequestActivity');
const RequestRating = require('../src/models/RequestRating');
const Comment = require('../src/models/Comment');
const Notification = require('../src/models/Notification');
const UserSession = require('../src/models/UserSession');
const ChatMessage = require('../src/models/ChatMessage');
const DirectMessage = require('../src/models/DirectMessage');
const DirectMessageConversation = require('../src/models/DirectMessageConversation');
const OrganizationPolicy = require('../src/models/OrganizationPolicy');
const PolicyAcknowledgement = require('../src/models/PolicyAcknowledgement');
const KnowledgeQuestion = require('../src/models/KnowledgeQuestion');
const KnowledgeAnswer = require('../src/models/KnowledgeAnswer');
const ServiceCategory = require('../src/models/ServiceCategory');
const AuditLog = require('../src/models/AuditLog');
// Retired (see this model's own header notice) but still a real
// collection that may still hold historical documents from before this
// ticket - task spec explicitly lists "PasswordResetRequests" in its own
// "Delete:" inventory, so this script cleans it up regardless of the
// fact that no live code path can ever create a new one anymore.
const PasswordResetRequest = require('../src/models/PasswordResetRequest');
// DOC Email Authentication & Notification Upgrade's own new tenant/
// user-scoped collections - orphaned the exact same way UserSession/
// Notification would be if left behind ("Audit all collections first and
// include anything else that would otherwise become orphaned"). Replaces
// the retired Sprint 7 PhoneVerificationChallenge/SmsDelivery requires
// (see git history and those models' own retirement notices) - a
// pre-existing MongoDB collection under either old name from before this
// migration is not touched by this script (this project ships no
// migration scripts for that - see backend/README.md's own "Migration /
// Existing Data" note), but per this refactor's own explicit scope
// decision ("do NOT over-engineer tenant migration... we plan to reset
// all tenant data") this is intentionally not over-engineered further.
const EmailVerificationChallenge = require('../src/models/EmailVerificationChallenge');
const EmailDelivery = require('../src/models/EmailDelivery');

const requestImageStorage = require('../src/services/requestImageStorage');
const profileImageStorage = require('../src/services/profileImageStorage');
const chatAttachmentStorage = require('../src/services/chatAttachmentStorage');
const dmAttachmentStorage = require('../src/services/dmAttachmentStorage');

// NOTE - the "refuse without explicit confirmation" check, and the
// `--dry-run` flag it depends on, deliberately do NOT live here at module
// top level. Bug fixed (post-implementation report): this file is
// `require()`-d directly by backend/sprint7.e2e.test.tmp.js (to reuse
// `assertExactlyOneSystemAdmin`/`countAll` as read-only sanity checks) -
// top-level code in a CommonJS module runs the INSTANT it is required,
// regardless of whether the caller ever intends to invoke anything
// destructive. Previously, this exact check (and its `process.exit(1)`)
// sat here at module scope, which meant simply writing
// `require('./scripts/resetTenantData')` anywhere - including from a test
// harness that only wanted the safe helpers - immediately printed
// "Tenant Data Reset - REFUSED" and killed the ENTIRE process via
// `process.exit(1)`, before the test harness ever got to run a single
// assertion. The fix: this whole check now lives INSIDE `main()` (see
// below), which itself only ever runs via the explicit
// `if (require.main === module)` CLI guard at the bottom of this file -
// so requiring this module now has zero side effects (no confirmation
// check, no `process.exit`, no MongoDB connection, no deletion) beyond
// defining functions and exporting them, exactly like every other
// `require('./someModule')` in this codebase.

// The complete, audited inventory of collections this script touches -
// see this file's own top comment. Kept as one explicit list (rather than
// scattered across the function below) so it doubles as living
// documentation of exactly what "tenant data" means for this project.
const TENANT_COLLECTIONS_DELETED = [
  'Organization', 'User (non-system_admin)', 'Request', 'RequestActivity', 'RequestRating',
  'Comment', 'Notification', 'UserSession (non-system_admin)', 'ChatMessage',
  'DirectMessage', 'DirectMessageConversation', 'OrganizationPolicy', 'PolicyAcknowledgement',
  'KnowledgeQuestion', 'KnowledgeAnswer', 'ServiceCategory', 'PasswordResetRequest (retired)',
  'EmailVerificationChallenge (non-system_admin)', 'EmailDelivery (non-system_admin)',
  'AuditLog (tenant-referencing entries only)',
];

// Task spec Phase 2 "RESET SAFETY" - "refuse if zero System Admin users
// exist... refuse if multiple System Admin users exist unless
// architecture explicitly supports that". This project's own
// architecture does NOT support more than one (models/User.js's own
// partial unique index on {role: 'system_admin'}) - so more than one here
// would mean that invariant was somehow bypassed (a manual database edit,
// a bug), and this script refuses rather than guessing which one is
// "real".
async function assertExactlyOneSystemAdmin() {
  const admins = await User.find({ role: 'system_admin' });
  if (admins.length === 0) {
    throw new Error(
      'Refusing to run: no System Admin account was found. This script requires exactly one '
      + 'System Admin to preserve - resolve this manually (e.g. run `npm run seed:system-admin`) before retrying.',
    );
  }
  if (admins.length > 1) {
    throw new Error(
      `Refusing to run: found ${admins.length} System Admin accounts, but this project's own `
      + 'architecture (models/User.js\'s partial unique index) only supports exactly one. '
      + 'Resolve this manually before retrying.',
    );
  }
  return admins[0];
}

async function countAll(admin) {
  const nonAdminUserFilter = { role: { $ne: 'system_admin' } };
  const orgIds = await Organization.distinct('_id');
  const nonAdminUserIds = await User.distinct('_id', nonAdminUserFilter);

  const auditLogTenantFilter = {
    $or: [
      { organizationId: { $ne: null } },
      { actorId: { $in: nonAdminUserIds } },
      { targetId: { $in: nonAdminUserIds } },
      { targetType: 'Organization' },
      { targetType: 'ServiceCategory' },
      { targetType: 'OrganizationPolicy' },
      { targetType: 'KnowledgeQuestion' },
    ],
  };

  const [
    organizationCount, userCount, requestCount, requestActivityCount, requestRatingCount,
    commentCount, notificationCount, sessionCount, chatMessageCount, dmCount, dmConversationCount,
    policyCount, ackCount, questionCount, answerCount, categoryCount, passwordResetRequestCount,
    emailChallengeCount, emailDeliveryCount, auditLogCount,
  ] = await Promise.all([
    Organization.countDocuments({}),
    User.countDocuments(nonAdminUserFilter),
    Request.countDocuments({}),
    RequestActivity.countDocuments({}),
    RequestRating.countDocuments({}),
    Comment.countDocuments({}),
    Notification.countDocuments({}),
    UserSession.countDocuments({ userId: { $in: nonAdminUserIds } }),
    ChatMessage.countDocuments({}),
    DirectMessage.countDocuments({}),
    DirectMessageConversation.countDocuments({}),
    OrganizationPolicy.countDocuments({}),
    PolicyAcknowledgement.countDocuments({}),
    KnowledgeQuestion.countDocuments({}),
    KnowledgeAnswer.countDocuments({}),
    ServiceCategory.countDocuments({}),
    PasswordResetRequest.countDocuments({}),
    EmailVerificationChallenge.countDocuments({ userId: { $in: nonAdminUserIds } }),
    EmailDelivery.countDocuments({ recipientUserId: { $in: nonAdminUserIds } }),
    AuditLog.countDocuments(auditLogTenantFilter),
  ]);

  return {
    orgIds,
    nonAdminUserIds,
    auditLogTenantFilter,
    counts: {
      Organization: organizationCount,
      'User (non-system_admin)': userCount,
      Request: requestCount,
      RequestActivity: requestActivityCount,
      RequestRating: requestRatingCount,
      Comment: commentCount,
      Notification: notificationCount,
      'UserSession (non-system_admin)': sessionCount,
      ChatMessage: chatMessageCount,
      DirectMessage: dmCount,
      DirectMessageConversation: dmConversationCount,
      OrganizationPolicy: policyCount,
      PolicyAcknowledgement: ackCount,
      KnowledgeQuestion: questionCount,
      KnowledgeAnswer: answerCount,
      ServiceCategory: categoryCount,
      'PasswordResetRequest (retired)': passwordResetRequestCount,
      'EmailVerificationChallenge (non-system_admin)': emailChallengeCount,
      'EmailDelivery (non-system_admin)': emailDeliveryCount,
      'AuditLog (tenant-referencing entries only)': auditLogCount,
    },
  };
}

function printSummary({ admin, counts }, mode) {
  console.log(`\n=== Tenant Data Reset - ${mode} SUMMARY ===\n`);
  console.log(`System Admin to PRESERVE: ${admin.email} (id: ${admin._id})\n`);
  console.log('Documents that would be deleted:');
  for (const [name, count] of Object.entries(counts)) {
    console.log(`  ${name.padEnd(48, ' ')} ${count}`);
  }
  console.log('');
}

// Collects every storage reference (Request/completion attachments, chat/
// DM attachments, non-admin profile images) BEFORE any document is
// deleted, paired with the storage-service function that already knows
// how to safely delete it (S3 or GridFS, per IMAGE_STORAGE_PROVIDER) -
// see this file's own top comment.
async function collectStorageReferences(nonAdminUserIds) {
  const jobs = [];

  const requests = await Request.find({}, { attachments: 1, completionAttachments: 1 });
  for (const request of requests) {
    for (const attachment of request.attachments || []) {
      jobs.push(() => requestImageStorage.deleteImage(attachment));
    }
    for (const attachment of request.completionAttachments || []) {
      jobs.push(() => requestImageStorage.deleteImage(attachment));
    }
  }

  const usersWithImages = await User.find(
    { _id: { $in: nonAdminUserIds }, profileImage: { $ne: null } },
    { profileImage: 1 },
  );
  for (const user of usersWithImages) {
    jobs.push(() => profileImageStorage.deleteImage(user.profileImage));
  }

  const chatMessages = await ChatMessage.find({}, { attachments: 1 });
  for (const message of chatMessages) {
    for (const attachment of message.attachments || []) {
      jobs.push(() => chatAttachmentStorage.deleteAttachment(attachment));
    }
  }

  const directMessages = await DirectMessage.find({}, { attachments: 1 });
  for (const message of directMessages) {
    for (const attachment of message.attachments || []) {
      jobs.push(() => dmAttachmentStorage.deleteAttachment(attachment));
    }
  }

  return jobs;
}

async function deleteEverything({
  nonAdminUserIds, auditLogTenantFilter,
}) {
  const nonAdminUserFilter = { role: { $ne: 'system_admin' } };

  // Storage objects FIRST, while the metadata documents that describe them
  // still exist to be read from - see collectStorageReferences's own top
  // comment. Best-effort, one at a time, never aborts the rest of the
  // reset on a single failure (each underlying deleteImage/
  // deleteAttachment already swallows its own errors).
  const storageJobs = await collectStorageReferences(nonAdminUserIds);
  for (const job of storageJobs) {
    // eslint-disable-next-line no-await-in-loop
    await job().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Storage cleanup job failed (non-fatal, continuing):', error.message);
    });
  }
  console.log(`Storage cleanup: attempted ${storageJobs.length} object deletion(s).`);

  await RequestRating.deleteMany({});
  await Comment.deleteMany({});
  await RequestActivity.deleteMany({});
  await Request.deleteMany({});
  await ChatMessage.deleteMany({});
  await DirectMessage.deleteMany({});
  await DirectMessageConversation.deleteMany({});
  await PolicyAcknowledgement.deleteMany({});
  await OrganizationPolicy.deleteMany({});
  await KnowledgeAnswer.deleteMany({});
  await KnowledgeQuestion.deleteMany({});
  await ServiceCategory.deleteMany({});
  await Notification.deleteMany({});
  await UserSession.deleteMany({ userId: { $in: nonAdminUserIds } });
  await EmailVerificationChallenge.deleteMany({ userId: { $in: nonAdminUserIds } });
  await EmailDelivery.deleteMany({ recipientUserId: { $in: nonAdminUserIds } });
  await PasswordResetRequest.deleteMany({});
  await AuditLog.deleteMany(auditLogTenantFilter);
  await User.deleteMany(nonAdminUserFilter);
  await Organization.deleteMany({});
}

async function main() {
  // -----------------------------------------------------------------------
  // REFUSE TO RUN WITHOUT EXPLICIT CONFIRMATION - the very first thing this
  // function does, before even connecting to MongoDB. A dry run never needs
  // this flag at all. Deliberately evaluated HERE (inside main(), which
  // only ever executes via this file's own `require.main === module` CLI
  // guard at the bottom, or a caller that explicitly calls `main()` itself)
  // rather than at module top level - see this file's own top-of-file NOTE
  // for why that distinction matters and what bug it fixes.
  // -----------------------------------------------------------------------
  const isDryRun = process.argv.includes('--dry-run');
  if (!isDryRun && process.env.CONFIRM_TENANT_RESET !== 'YES') {
    console.error('\n=== Tenant Data Reset - REFUSED ===\n');
    console.error('This is a DESTRUCTIVE operation that deletes every Organization and');
    console.error('every non-System-Admin User (plus all data that depends on them).');
    console.error('\nTo preview what would be deleted, without deleting anything:');
    console.error('  npm run reset:tenant-data:dry-run');
    console.error('\nTo actually run the reset, you must explicitly confirm:');
    console.error('  CONFIRM_TENANT_RESET=YES npm run reset:tenant-data\n');
    process.exit(1);
  }

  await connectDB();

  try {
    const admin = await assertExactlyOneSystemAdmin();
    const state = await countAll(admin);

    printSummary({ admin, counts: state.counts }, isDryRun ? 'DRY-RUN' : 'PRE-DELETE');

    if (isDryRun) {
      console.log('Dry run complete. Nothing was deleted.\n');
      console.log('To actually run the reset:');
      console.log('  CONFIRM_TENANT_RESET=YES npm run reset:tenant-data\n');
      return;
    }

    console.log('CONFIRM_TENANT_RESET=YES was set - proceeding with deletion...\n');
    await deleteEverything(state);

    const remainingUserCount = await User.countDocuments({});
    const remainingOrgCount = await Organization.countDocuments({});
    console.log('\n=== Tenant Data Reset - COMPLETE ===\n');
    console.log(`Remaining Users: ${remainingUserCount} (should be exactly 1 - the preserved System Admin)`);
    console.log(`Remaining Organizations: ${remainingOrgCount} (should be exactly 0)`);
    console.log(`System Admin preserved: ${admin.email} (id: ${admin._id})\n`);
  } finally {
    await mongoose.connection.close();
  }
}

module.exports = {
  main, assertExactlyOneSystemAdmin, countAll, TENANT_COLLECTIONS_DELETED,
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\nTenant Data Reset failed: ${error.message}\n`);
      process.exit(1);
    });
}
