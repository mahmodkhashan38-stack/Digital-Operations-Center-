/**
 * GridFS Image Storage Migration - Backfill Legacy Local-Disk Attachments
 * -------------------------------------------------------------------------
 *
 * WHY THIS SCRIPT EXISTS
 * The GridFS migration made every NEW Before Image / Completion Image
 * upload go straight to MongoDB GridFS ("requestImages" bucket - see
 * src/services/gridFsStorage.js), but every Request attachment created
 * BEFORE that change still only has a legacy `storedName` (a filename on
 * local disk, under middleware/upload.js's UPLOAD_ROOT) and no `fileId`.
 * The application already handles this safely on its own - models/
 * Request.js's schema accepts either reference, and
 * request.controller.js's getRequestAttachmentContent / sanitizeRequest
 * both work correctly for legacy attachments exactly as they are, forever,
 * with no migration required. This script is an OPTIONAL, one-time way to
 * additionally copy those legacy files' bytes into GridFS too, so they
 * have the same storage backend as every new upload - never anything the
 * application itself requires to keep functioning.
 *
 * WHAT "LEGACY" MEANS HERE
 * An attachment subdocument (in either `attachments` or
 * `completionAttachments`) with a real `storedName` but no `fileId` yet
 * (missing entirely, or explicitly `null` - both are treated identically).
 *
 * WHAT THIS SCRIPT DOES, PER LEGACY ATTACHMENT
 *   1. Verifies the local file referenced by `storedName` still exists
 *      under UPLOAD_ROOT. If it does not, the attachment is SKIPPED and
 *      reported - never crashes the rest of the migration (task spec:
 *      "don't crash the whole migration because one image is missing").
 *   2. Reads the file's bytes and uploads them to the "requestImages"
 *      GridFS bucket via the exact same services/gridFsStorage.js used by
 *      the live application - never a second, parallel GridFS
 *      implementation. Metadata (organizationId/requestId/attachmentType/
 *      uploadedBy) is derived from the Request document itself, the same
 *      trusted-server-side values the live upload endpoints use.
 *   3. Sets the attachment's `fileId` to the newly-uploaded GridFS file's
 *      id. PRESERVES every existing field on the attachment untouched -
 *      `storedName`, `url`, `originalName`, `mimeType`, `size`,
 *      `uploadedAt` (and `uploadedBy` for completion images) are all left
 *      exactly as they were (task spec: "preserves original metadata").
 *   4. Saves the Request document once all of ITS legacy attachments have
 *      been processed (not once per attachment) - a real database error,
 *      or a save() failure, orphans none of a Request's PREVIOUSLY-saved
 *      attachments, and rolls back (deletes) only the GridFS files THIS
 *      document's THIS run just uploaded before reporting the failure and
 *      moving on to the next Request.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   - It NEVER deletes the original local file (task spec: "Do NOT delete
 *     the original local file during the first migration pass" -
 *     non-destructive by design, not just on the first run - this script
 *     has no delete-local-file capability at all).
 *   - It NEVER deletes `backend/uploads/requests/`, historical images, or
 *     `.gitkeep`.
 *   - It NEVER overwrites `storedName`/`url`/`originalName`/`mimeType`/
 *     `size`/`uploadedAt`/`uploadedBy` on any attachment - only ever adds
 *     `fileId` to an attachment that did not already have one.
 *   - It NEVER runs automatically on server startup - src/server.js never
 *     requires this file. Only ever invoked explicitly.
 *   - It NEVER touches an attachment that already has a `fileId` (already
 *     GridFS-backed, or already migrated by a previous run).
 *
 * IDEMPOTENCY
 * Safe to run any number of times. The query filter itself
 * (`fileId` missing/null AND `storedName` present) makes an
 * already-migrated attachment structurally unreachable by this script's
 * own update on every later run - once `fileId` is set, that exact
 * attachment can never be matched again, so re-running never re-uploads
 * or duplicates a GridFS file for it. A brand-new post-migration
 * attachment (which never has `storedName` at all) is likewise never
 * matched.
 *
 * HOW TO RUN
 *   cd backend
 *   node scripts/migrateRequestImagesToGridFs.js
 *
 * Requires the same MONGODB_URI used by the server (backend/.env). This
 * script does not start the HTTP server and does not require JWT_SECRET.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Request = require('../src/models/Request');
const gridFsStorage = require('../src/services/gridFsStorage');
const { UPLOAD_ROOT } = require('../src/middleware/upload');

// Matches an attachment subdocument with a real legacy local-disk
// reference and no GridFS reference yet - see this file's own "WHAT
// LEGACY MEANS HERE" comment above.
const legacyElemMatch = {
  storedName: { $exists: true, $ne: null },
  $or: [{ fileId: { $exists: false } }, { fileId: null }],
};

const candidatesFilter = {
  $or: [
    { attachments: { $elemMatch: legacyElemMatch } },
    { completionAttachments: { $elemMatch: legacyElemMatch } },
  ],
};

function isLegacyAttachment(attachment) {
  return !attachment.fileId && !!attachment.storedName;
}

// Uploads one legacy attachment's bytes to GridFS and sets its `fileId`
// in-memory (the caller saves the parent Request once, after every
// attachment on it has been processed). Returns `{ ok: true, fileId }` on
// success, or `{ ok: false, reason }` on any expected failure (missing
// local file, or the GridFS upload itself failing) - never throws for
// those two expected cases, so one bad attachment never aborts the whole
// document's (or the whole migration's) processing.
async function migrateOneAttachment(attachment, { organizationId, requestId, attachmentType, uploadedBy }) {
  const safeFileName = path.basename(attachment.storedName);
  const filePath = path.join(UPLOAD_ROOT, safeFileName);

  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'missing-local-file', filePath };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    return { ok: false, reason: `local-file-read-error: ${error.message}` };
  }

  try {
    const fileId = await gridFsStorage.uploadBuffer(buffer, {
      filename: attachment.originalName || safeFileName,
      contentType: attachment.mimeType,
      metadata: {
        organizationId,
        requestId,
        attachmentType,
        uploadedBy,
        migratedFrom: 'local-disk',
        migratedAt: new Date(),
      },
    });
    return { ok: true, fileId };
  } catch (error) {
    return { ok: false, reason: `gridfs-upload-error: ${error.message}` };
  }
}

const run = async () => {
  await connectDB();

  console.log('\n=== GridFS Image Storage Migration: legacy local-disk attachment backfill ===\n');

  const candidateRequests = await Request.find(candidatesFilter);

  console.log(`Requests with at least one legacy (non-GridFS) attachment: ${candidateRequests.length}`);

  const report = {
    documentsProcessed: 0,
    documentsSaved: 0,
    documentsFailedToSave: [],
    attachmentsMigrated: 0,
    attachmentsMissingLocalFile: [],
    attachmentsFailed: [],
  };

  // eslint-disable-next-line no-restricted-syntax
  for (const requestDoc of candidateRequests) {
    report.documentsProcessed += 1;
    const newlyUploadedFileIds = [];
    let documentHadAnyChange = false;

    // eslint-disable-next-line no-restricted-syntax
    for (const attachment of requestDoc.attachments) {
      if (!isLegacyAttachment(attachment)) continue; // eslint-disable-line no-continue

      // eslint-disable-next-line no-await-in-loop
      const result = await migrateOneAttachment(attachment, {
        organizationId: requestDoc.organizationId,
        requestId: requestDoc._id,
        attachmentType: 'before',
        uploadedBy: requestDoc.createdBy,
      });

      if (result.ok) {
        attachment.fileId = result.fileId;
        newlyUploadedFileIds.push(result.fileId);
        report.attachmentsMigrated += 1;
        documentHadAnyChange = true;
      } else if (result.reason === 'missing-local-file') {
        report.attachmentsMissingLocalFile.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), storedName: attachment.storedName,
        });
      } else {
        report.attachmentsFailed.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), reason: result.reason,
        });
      }
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const attachment of requestDoc.completionAttachments) {
      if (!isLegacyAttachment(attachment)) continue; // eslint-disable-line no-continue

      // eslint-disable-next-line no-await-in-loop
      const result = await migrateOneAttachment(attachment, {
        organizationId: requestDoc.organizationId,
        requestId: requestDoc._id,
        attachmentType: 'completion',
        uploadedBy: attachment.uploadedBy,
      });

      if (result.ok) {
        attachment.fileId = result.fileId;
        newlyUploadedFileIds.push(result.fileId);
        report.attachmentsMigrated += 1;
        documentHadAnyChange = true;
      } else if (result.reason === 'missing-local-file') {
        report.attachmentsMissingLocalFile.push({
          requestId: String(requestDoc._id), attachmentId: String(attachment._id), storedName: attachment.storedName,
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
      // Rollback - only the GridFS files THIS document's THIS run just
      // uploaded, never anything from a different, already-saved Request.
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(newlyUploadedFileIds.map((fileId) => gridFsStorage.deleteFile(fileId).catch(() => {})));
      report.documentsFailedToSave.push({ requestId: String(requestDoc._id), error: error.message });
      // Reverse the migrated count for this document's attachments since
      // the save that would have persisted them never actually happened.
      report.attachmentsMigrated -= newlyUploadedFileIds.length;
    }
  }

  console.log(`\nDocuments processed:                      ${report.documentsProcessed}`);
  console.log(`Documents saved (>=1 attachment migrated): ${report.documentsSaved}`);
  console.log(`Documents that failed to save (rolled back): ${report.documentsFailedToSave.length}`);
  console.log(`Attachments migrated to GridFS:            ${report.attachmentsMigrated}`);
  console.log(`Attachments skipped (missing local file):  ${report.attachmentsMissingLocalFile.length}`);
  console.log(`Attachments failed (upload/read error):    ${report.attachmentsFailed.length}`);

  if (report.attachmentsMissingLocalFile.length > 0) {
    console.log('\nAttachments skipped - local file no longer exists (left untouched):');
    report.attachmentsMissingLocalFile.forEach((entry) => {
      console.log(`  - Request ${entry.requestId}, attachment ${entry.attachmentId} (storedName: ${entry.storedName})`);
    });
  }

  if (report.attachmentsFailed.length > 0) {
    console.log('\nAttachments failed (left untouched - investigate manually):');
    report.attachmentsFailed.forEach((entry) => {
      console.log(`  - Request ${entry.requestId}, attachment ${entry.attachmentId}: ${entry.reason}`);
    });
  }

  if (report.documentsFailedToSave.length > 0) {
    console.log('\nRequests whose save() failed after a successful GridFS upload (GridFS files rolled back, nothing persisted):');
    report.documentsFailedToSave.forEach((entry) => {
      console.log(`  - Request ${entry.requestId}: ${entry.error}`);
    });
  }

  console.log('\nNo local file was deleted by this run - backend/uploads/requests/ is left');
  console.log('completely untouched, safe to run again, and still required until a');
  console.log('separate, deliberate future cleanup decision is made.');
  console.log('\n=== Migration complete ===\n');

  return report;
};

module.exports = { run };

// Only execute automatically when run directly (`node scripts/
// migrateRequestImagesToGridFs.js`) - not when required by other code
// (e.g. a test harness that wants to call `run()` itself against a
// mocked database). Never run automatically on server startup -
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
