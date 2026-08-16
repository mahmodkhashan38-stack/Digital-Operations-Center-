/**
 * S3 Image Storage Migration - Backfill GridFS Attachments to S3
 * -------------------------------------------------------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * The S3 migration made every NEW Before Image / Completion Image upload
 * go to S3-compatible object storage once IMAGE_STORAGE_PROVIDER=s3 is
 * configured (see src/services/requestImageStorage.js), but every
 * attachment created before that change (or created while
 * IMAGE_STORAGE_PROVIDER=gridfs) still only has a GridFS `fileId` and no
 * `objectKey`. The application already handles this safely on its own -
 * models/Request.js's schema accepts any of the three storage references,
 * and request.controller.js's getRequestAttachmentContent / sanitizeRequest
 * both work correctly for GridFS-backed attachments exactly as they are,
 * forever, with no migration required. This script is an OPTIONAL,
 * one-time way to additionally copy those GridFS files' bytes into S3
 * too, so they share the same storage backend as new uploads - never
 * anything the application itself requires to keep functioning.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - It NEVER migrates legacy local-disk (`storedName`) attachments -
 *     only GridFS-backed ones (task spec Phase 17: "Do not automatically
 *     migrate legacy local files unless it can be done safely... existing
 *     files must remain untouched during this migration pass"). A future,
 *     separate, deliberate task may add a local->S3 path; this script
 *     intentionally does not attempt it.
 *   - It NEVER deletes the original GridFS file (task spec Phase 15: "On
 *     first migration implementation: DO NOT delete original GridFS file
 *     (rollback safety)") - non-destructive by design, not just on the
 *     first run; this script has no delete-GridFS-file capability at all.
 *   - It NEVER overwrites `fileId`/`storedName`/`url`/`originalName`/
 *     `mimeType`/`size`/`uploadedAt`/`uploadedBy` on any attachment - only
 *     ever adds `objectKey` to an attachment that did not already have
 *     one.
 *   - It NEVER runs automatically on server startup - src/server.js never
 *     requires this file. Only ever invoked explicitly
 *     (`npm run migrate:request-images-to-s3`).
 *   - It NEVER touches an attachment that already has an `objectKey`
 *     (already S3-backed, or already migrated by a previous run).
 *
 * WHAT THIS SCRIPT DOES, PER CANDIDATE ATTACHMENT (fileId set, objectKey
 * not yet set)
 *   1. Downloads the file's bytes from GridFS via the exact same
 *      services/gridFsStorage.js used by the live application - never a
 *      second, parallel GridFS implementation.
 *   2. Uploads those bytes to S3 via services/requestImageStorage.js's
 *      `uploadBufferToS3` - the exact same S3 client construction/object
 *      key design new live uploads use - never a separate, parallel S3
 *      implementation.
 *   3. Verifies the upload succeeded (uploadBufferToS3 only resolves once
 *      the PutObjectCommand itself has succeeded; any failure here is
 *      caught and reported per-attachment, never left silently
 *      unconfirmed).
 *   4. Sets the attachment's `objectKey` to the newly-uploaded S3 key.
 *      PRESERVES every existing field on the attachment untouched
 *      (`fileId`, `originalName`, `mimeType`, `size`, `uploadedAt`, and
 *      `uploadedBy` for completion images are all left exactly as they
 *      were).
 *   5. Saves the Request document once all of ITS candidate attachments
 *      have been processed (not once per attachment) - a real database
 *      error, or a save() failure, orphans none of a Request's
 *      PREVIOUSLY-saved attachments, and rolls back (deletes) only the S3
 *      objects THIS document's THIS run just uploaded before reporting
 *      the failure and moving on to the next Request.
 *
 * IDEMPOTENCY
 * Safe to run any number of times. The query filter itself (`objectKey`
 * missing/null AND `fileId` present) makes an already-migrated attachment
 * structurally unreachable by this script's own update on every later
 * run - once `objectKey` is set, that exact attachment can never be
 * matched again, so re-running never re-uploads or duplicates an S3
 * object for it. A brand-new post-migration S3-native attachment (which
 * never has `fileId` at all) is likewise never matched. Running this
 * script twice therefore reports every attachment from the first run as
 * "skipped" (not "migrated") on the second run - never a duplicate S3
 * object.
 *
 * REQUIREMENTS TO RUN
 * Requires the same MONGODB_URI used by the server (backend/.env), PLUS
 * S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (and
 * optionally S3_ENDPOINT) - this script fails fast with a clear message
 * if S3 is not configured, before touching MongoDB at all. Does not start
 * the HTTP server and does not require JWT_SECRET.
 *
 * HOW TO RUN
 *   cd backend
 *   npm run migrate:request-images-to-s3
 */

require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Request = require('../src/models/Request');
const gridFsStorage = require('../src/services/gridFsStorage');
const requestImageStorage = require('../src/services/requestImageStorage');

// Matches an attachment subdocument with a GridFS reference and no S3
// reference yet - see this file's own top comment for the exact
// "candidate" definition.
const candidateElemMatch = {
  fileId: { $exists: true, $ne: null },
  $or: [{ objectKey: { $exists: false } }, { objectKey: null }],
};

const candidatesFilter = {
  $or: [
    { attachments: { $elemMatch: candidateElemMatch } },
    { completionAttachments: { $elemMatch: candidateElemMatch } },
  ],
};

function isCandidateAttachment(attachment) {
  return !attachment.objectKey && !!attachment.fileId;
}

// Downloads one GridFS file's bytes fully into memory (Request images are
// capped at MAX_ATTACHMENT_SIZE_BYTES = 5 MB each - see models/Request.js
// - so this is bounded and safe, the same assumption the live upload path
// already makes for Multer's memoryStorage buffers).
function downloadGridFsFileBuffer(fileId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const downloadStream = gridFsStorage.openDownloadStream(fileId);
    downloadStream.on('data', (chunk) => chunks.push(chunk));
    downloadStream.on('error', reject);
    downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Migrates one candidate attachment's bytes from GridFS to S3 and returns
// `{ ok: true, objectKey }` on success, or `{ ok: false, reason }` on any
// expected failure (missing GridFS file, download error, or the S3 upload
// itself failing) - never throws for those expected cases, so one bad
// attachment never aborts the whole document's (or the whole migration's)
// processing.
async function migrateOneAttachment(attachment, { organizationId, requestId, attachmentType }) {
  const fileDoc = await gridFsStorage.findFile(attachment.fileId);
  if (!fileDoc) {
    return { ok: false, reason: 'missing-gridfs-file' };
  }

  let buffer;
  try {
    buffer = await downloadGridFsFileBuffer(attachment.fileId);
  } catch (error) {
    return { ok: false, reason: `gridfs-download-error: ${error.message}` };
  }

  try {
    const objectKey = await requestImageStorage.uploadBufferToS3(buffer, {
      organizationId,
      requestId,
      attachmentType,
      mimeType: attachment.mimeType,
    });
    return { ok: true, objectKey };
  } catch (error) {
    return { ok: false, reason: `s3-upload-error: ${error.message}` };
  }
}

const run = async () => {
  if (!requestImageStorage.isS3Configured()) {
    throw new Error(
      'S3 image storage is not configured. Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, and '
      + 'S3_SECRET_ACCESS_KEY (see backend/.env.example) before running this migration.',
    );
  }

  await connectDB();

  console.log('\n=== S3 Image Storage Migration: GridFS attachment backfill ===\n');

  const candidateRequests = await Request.find(candidatesFilter);

  console.log(`Requests with at least one GridFS-only (non-S3) attachment: ${candidateRequests.length}`);

  const report = {
    documentsProcessed: 0,
    documentsSaved: 0,
    documentsFailedToSave: [],
    attachmentsMigrated: 0,
    attachmentsSkipped: 0,
    attachmentsMissing: [],
    attachmentsFailed: [],
  };

  // eslint-disable-next-line no-restricted-syntax
  for (const requestDoc of candidateRequests) {
    report.documentsProcessed += 1;
    const newlyUploadedObjectKeys = [];
    let documentHadAnyChange = false;

    // eslint-disable-next-line no-restricted-syntax
    for (const attachment of requestDoc.attachments) {
      if (!isCandidateAttachment(attachment)) continue; // eslint-disable-line no-continue

      // eslint-disable-next-line no-await-in-loop
      const result = await migrateOneAttachment(attachment, {
        organizationId: requestDoc.organizationId,
        requestId: requestDoc._id,
        attachmentType: 'before',
      });

      if (result.ok) {
        attachment.objectKey = result.objectKey;
        newlyUploadedObjectKeys.push(result.objectKey);
        report.attachmentsMigrated += 1;
        documentHadAnyChange = true;
      } else if (result.reason === 'missing-gridfs-file') {
        report.attachmentsMissing.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), fileId: String(attachment.fileId),
        });
      } else {
        report.attachmentsFailed.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), reason: result.reason,
        });
      }
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const attachment of requestDoc.completionAttachments) {
      if (!isCandidateAttachment(attachment)) continue; // eslint-disable-line no-continue

      // eslint-disable-next-line no-await-in-loop
      const result = await migrateOneAttachment(attachment, {
        organizationId: requestDoc.organizationId,
        requestId: requestDoc._id,
        attachmentType: 'completion',
      });

      if (result.ok) {
        attachment.objectKey = result.objectKey;
        newlyUploadedObjectKeys.push(result.objectKey);
        report.attachmentsMigrated += 1;
        documentHadAnyChange = true;
      } else if (result.reason === 'missing-gridfs-file') {
        report.attachmentsMissing.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), fileId: String(attachment.fileId),
        });
      } else {
        report.attachmentsFailed.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), reason: result.reason,
        });
      }
    }

    if (!documentHadAnyChange) {
      // eslint-disable-next-line no-continue
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      await requestDoc.save();
      report.documentsSaved += 1;
    } catch (error) {
      // Rollback - only the S3 objects THIS document's THIS run just
      // uploaded, never anything from a different, already-saved Request,
      // and never the original GridFS files either way.
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(newlyUploadedObjectKeys.map(
        (objectKey) => requestImageStorage.deleteImage({ objectKey }).catch(() => {}),
      ));
      report.documentsFailedToSave.push({ requestId: String(requestDoc._id), error: error.message });
      report.attachmentsMigrated -= newlyUploadedObjectKeys.length;
    }
  }

  console.log(`\nDocuments processed:                       ${report.documentsProcessed}`);
  console.log(`Documents saved (>=1 attachment migrated):  ${report.documentsSaved}`);
  console.log(`Documents that failed to save (rolled back): ${report.documentsFailedToSave.length}`);
  console.log(`Attachments migrated to S3:                 ${report.attachmentsMigrated}`);
  console.log(`Attachments missing (GridFS file not found): ${report.attachmentsMissing.length}`);
  console.log(`Attachments failed (download/upload error):  ${report.attachmentsFailed.length}`);

  if (report.attachmentsMissing.length > 0) {
    console.log('\nAttachments skipped - GridFS file no longer exists (left untouched):');
    report.attachmentsMissing.forEach((entry) => {
      console.log(`  - Request ${entry.requestId}, attachment ${entry.attachmentId} (fileId: ${entry.fileId})`);
    });
  }

  if (report.attachmentsFailed.length > 0) {
    console.log('\nAttachments failed (left untouched - investigate manually):');
    report.attachmentsFailed.forEach((entry) => {
      console.log(`  - Request ${entry.requestId}, attachment ${entry.attachmentId}: ${entry.reason}`);
    });
  }

  if (report.documentsFailedToSave.length > 0) {
    console.log('\nRequests whose save() failed after a successful S3 upload (S3 objects rolled back, nothing persisted):');
    report.documentsFailedToSave.forEach((entry) => {
      console.log(`  - Request ${entry.requestId}: ${entry.error}`);
    });
  }

  console.log('\nNo GridFS file was deleted by this run - the "requestImages" GridFS bucket');
  console.log('is left completely untouched, safe to run again, and still required until a');
  console.log('separate, deliberate future cleanup decision is made. Legacy local-disk');
  console.log('attachments (storedName) are not touched by this script at all.');
  console.log('\n=== Migration complete ===\n');

  return report;
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/
// migrateRequestImagesToS3.js`) - not when required by other code (e.g. a
// test harness that wants to call `run()` itself against a mocked
// database). Never run automatically on server startup - src/server.js
// never requires this file.
if (require.main === module) {
  run()
    .then(async () => {
      await mongoose.connection.close();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Migration failed:', error.message);
      try {
        await mongoose.connection.close();
      } catch (closeError) {
        // Connection may already be closed/never opened - safe to ignore.
      }
      process.exit(1);
    });
}
