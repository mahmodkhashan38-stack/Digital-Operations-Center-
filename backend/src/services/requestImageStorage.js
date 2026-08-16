/**
 * Request Image Storage Abstraction - S3 / GridFS / Legacy Local Disk
 * -------------------------------------------------------------------------
 *
 * WHY THIS FILE EXISTS
 * The S3 migration task explicitly requires that controllers never call an
 * AWS SDK (or GridFS, or `fs`) directly - they call three generic
 * operations (`uploadImage`, `getImageStream`, `deleteImage`) and this
 * module alone decides which actual backend handles them. This is the same
 * "one owner of storage logic" discipline services/gridFsStorage.js already
 * established for GridFS specifically; this module sits one layer above
 * it, choosing between S3 (new uploads, by default from this task onward),
 * GridFS (still fully supported, both for existing images and as an
 * explicit fallback provider), and legacy local disk (read/delete only -
 * nothing new is ever written there again, exactly as before this task).
 *
 * WHICH PROVIDER A GIVEN ATTACHMENT USES IS NEVER STORED AS ITS OWN FIELD.
 * It is derived, every time, from which storage-reference field is
 * actually populated on the attachment subdocument - exactly the same
 * dynamic-branching philosophy the GridFS migration already used to
 * distinguish `fileId` (GridFS) from `storedName` (legacy local disk).
 * This migration adds a third reference, `objectKey` (S3), rather than a
 * redundant `storageProvider` string that could theoretically drift out of
 * sync with the reference fields themselves:
 *   - `objectKey` present -> S3
 *   - `fileId` present (no objectKey) -> GridFS
 *   - `storedName` present (no objectKey/fileId) -> legacy local disk
 * See models/Request.js's own attachmentSchema/completionAttachmentSchema
 * comments for the full field-level writeup.
 *
 * WHICH PROVIDER *NEW* UPLOADS USE
 * Controlled by the optional `IMAGE_STORAGE_PROVIDER` environment variable
 * (`"s3"` or `"gridfs"`). Defaults to `"gridfs"` when unset - deliberately
 * NOT defaulting to `"s3"` even though S3 is this task's whole point,
 * because a working deployment that has not yet configured
 * S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY must keep
 * working with zero new configuration (compatibility-first, task spec's
 * own top constraint: "the project is currently working... do not break
 * anything"). Once an operator deliberately sets
 * `IMAGE_STORAGE_PROVIDER=s3` in their own backend/.env (see
 * .env.example), new uploads switch to S3 - existing GridFS/local images
 * are completely unaffected either way, since reads/deletes always follow
 * the attachment's own stored reference, never the current env setting.
 *
 * S3 CLIENT CONSTRUCTION
 * Lazy and cached, mirroring gridFsStorage.js's own `getBucket()` pattern -
 * the AWS SDK client is only ever constructed the first time a real S3
 * operation is attempted, not at module load (this module is required by
 * request.controller.js at process start, well before any request has
 * happened). This also means a deployment that never actually uses S3
 * (IMAGE_STORAGE_PROVIDER left at its "gridfs" default, no attachment ever
 * has an objectKey) never even attempts to read S3 env vars, so leaving
 * them unset causes no startup error at all.
 *
 * S3-COMPATIBLE PROVIDERS
 * `S3_ENDPOINT` is optional - when set (MinIO, Cloudflare R2, Backblaze
 * B2, or any other S3-compatible provider), the client is built with that
 * custom endpoint AND `forcePathStyle: true` (virtual-hosted-style bucket
 * URLs generally do not work against non-AWS endpoints; path-style is the
 * safe default for every non-AWS provider and is harmless against real AWS
 * S3 too). No provider URL or credential is ever hardcoded here - every
 * one of these values comes exclusively from the environment.
 *
 * AUTHORIZATION
 * This module performs NONE, exactly like gridFsStorage.js. Every
 * function here trusts its caller completely - request.controller.js is
 * always responsible for verifying the requester may act on the specific
 * Request/attachment BEFORE calling into this module.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gridFsStorage = require('./gridFsStorage');
const { UPLOAD_ROOT } = require('../middleware/upload');

// Kept as a small local constant (not imported from middleware/upload.js
// or models/Request.js) so this module stays self-contained, mirroring
// models/Request.js's own documented reason for keeping its own copy of
// the same three-entry map. Must stay in sync with both of those files'
// copies - all three intentionally list the exact same three image types.
const EXTENSION_BY_MIME_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const VALID_PROVIDERS = ['s3', 'gridfs'];
let warnedAboutInvalidProvider = false;

// Reads the currently-configured provider for NEW uploads only - never
// consulted for reads/deletes of an already-existing attachment (those
// always follow the attachment's own stored reference field, see this
// file's own top comment). Falls back to "gridfs" - the pre-S3-migration
// behavior - for both an unset value and an unrecognized one, so a typo
// in this optional env var can never crash the server or silently write
// to the wrong place; it is only ever logged once, defensively.
function getConfiguredProvider() {
  const raw = (process.env.IMAGE_STORAGE_PROVIDER || 'gridfs').trim().toLowerCase();
  if (VALID_PROVIDERS.includes(raw)) {
    return raw;
  }
  if (!warnedAboutInvalidProvider) {
    warnedAboutInvalidProvider = true;
    // eslint-disable-next-line no-console
    console.error(
      `IMAGE_STORAGE_PROVIDER="${raw}" is not recognized (expected "s3" or "gridfs") - `
      + 'falling back to "gridfs" for new uploads.',
    );
  }
  return 'gridfs';
}

// True only when every required S3 env var is present - never throws,
// used both by getS3Client()/getS3Bucket() (which DO throw, once actually
// needed) and by callers that want to check availability first without
// triggering an error (the migration script, and the optional real-S3
// smoke test).
function isS3Configured() {
  return Boolean(
    process.env.S3_BUCKET
    && process.env.S3_REGION
    && process.env.S3_ACCESS_KEY_ID
    && process.env.S3_SECRET_ACCESS_KEY,
  );
}

let cachedS3Client = null;

// Lazily creates (and caches) the AWS SDK v3 S3Client. Never logs
// credential values, never includes them in a thrown error message -
// only ever states WHICH env vars are missing, never their values (which
// would be `undefined` anyway in that case, but this stays defensive
// regardless).
function getS3Client() {
  if (cachedS3Client) return cachedS3Client;

  if (!isS3Configured()) {
    throw new Error(
      'S3 image storage is not configured. Set S3_BUCKET, S3_REGION, '
      + 'S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (see backend/.env.example).',
    );
  }

  // Required lazily, not at module top-level, so a deployment that never
  // actually uses S3 (IMAGE_STORAGE_PROVIDER left at its "gridfs"
  // default) never even needs @aws-sdk/client-s3 to be resolvable at
  // require-time of this file - only at the moment it is genuinely used.
  // eslint-disable-next-line global-require
  const { S3Client } = require('@aws-sdk/client-s3');

  const clientConfig = {
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  };

  if (process.env.S3_ENDPOINT) {
    clientConfig.endpoint = process.env.S3_ENDPOINT;
    clientConfig.forcePathStyle = true;
  }

  cachedS3Client = new S3Client(clientConfig);
  return cachedS3Client;
}

function getS3Bucket() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('S3 image storage is not configured: S3_BUCKET is not set.');
  }
  return bucket;
}

// Builds a safe, unique, server-derived S3 object key - NEVER built from
// any client-supplied value (task spec: "Never use user-controlled
// filenames as the storage key"). `organizationId`/`requestId` are always
// the trusted server-side context the caller already resolved (the same
// values gridFsStorage.js's callers already pass as GridFS `metadata`),
// never anything read from req.body. The extension comes only from this
// file's own EXTENSION_BY_MIME_TYPE map, keyed by the ALREADY-VALIDATED
// mimeType (Multer's fileFilter has already rejected anything outside the
// three supported types by the time this is ever called) - never from the
// client's original filename/extension.
function buildObjectKey({
  organizationId, requestId, attachmentType, mimeType,
}) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType] || '';
  const folder = attachmentType === 'completion' ? 'completion' : 'before';
  return `organizations/${organizationId}/requests/${requestId}/${folder}/${crypto.randomUUID()}${extension}`;
}

// Low-level: uploads one in-memory buffer to S3 under a freshly-built
// object key and returns that key. Used both by uploadImage() below (the
// live "s3" provider path) AND by the optional GridFS->S3 migration
// script, which always targets S3 regardless of the current
// IMAGE_STORAGE_PROVIDER setting - the migration script's whole purpose is
// moving existing GridFS bytes to S3, independent of what new uploads are
// currently configured to do.
async function uploadBufferToS3(buffer, {
  organizationId, requestId, attachmentType, mimeType,
}) {
  const objectKey = buildObjectKey({
    organizationId, requestId, attachmentType, mimeType,
  });
  const client = getS3Client();
  const bucket = getS3Bucket();

  // eslint-disable-next-line global-require
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: buffer,
    ContentType: mimeType,
  }));

  return objectKey;
}

// GENERIC OPERATION 1 of 3: uploads one in-memory buffer (Multer
// memoryStorage's `file.buffer` - never a filesystem path, never base64)
// through whichever provider is currently configured for new uploads
// (getConfiguredProvider() above), and returns exactly the storage
// reference field(s) the caller should attach to the new attachment
// subdocument - `{ objectKey }` for S3, `{ fileId }` for GridFS. The
// caller (request.controller.js) never needs to know which one it got
// back beyond spreading it onto the attachment it is building; every
// other field (originalName, mimeType, size, ...) is unaffected either
// way, and the resulting attachment is transparently readable through
// getImageStream() below regardless of which branch produced it.
async function uploadImage(buffer, {
  organizationId, requestId, attachmentType, mimeType, originalName, uploadedBy,
}) {
  const provider = getConfiguredProvider();

  if (provider === 's3') {
    const objectKey = await uploadBufferToS3(buffer, {
      organizationId, requestId, attachmentType, mimeType,
    });
    return { objectKey };
  }

  // provider === 'gridfs' - unchanged behavior from before this task.
  const fileId = await gridFsStorage.uploadBuffer(buffer, {
    filename: originalName,
    contentType: mimeType,
    metadata: {
      organizationId, requestId, attachmentType, uploadedBy,
    },
  });
  return { fileId };
}

// GENERIC OPERATION 2 of 3: given an ALREADY-AUTHORIZED attachment
// subdocument (the caller - getRequestAttachmentContent - is always
// responsible for authorization before this is ever called, exactly like
// gridFsStorage.js's own documented division of responsibility), returns
// `{ stream, contentType, contentLength }` for whichever storage backend
// this specific attachment actually uses, or `null` if the underlying
// bytes cannot be found (deleted out from under a still-referenced
// attachment, a data-integrity edge case - never throws for this, the
// caller turns `null` into a plain 404). `contentLength` may be `null`
// when the backend does not cheaply expose it (legacy local disk) - the
// caller only sets the response header when it is present, exactly as
// the pre-S3 code already did per-branch.
async function getImageStream(attachment) {
  if (!attachment) return null;

  if (attachment.objectKey) {
    const client = getS3Client();
    const bucket = getS3Bucket();
    // eslint-disable-next-line global-require
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    let result;
    try {
      result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: attachment.objectKey }));
    } catch (error) {
      const statusCode = error && error.$metadata && error.$metadata.httpStatusCode;
      if ((error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) || statusCode === 404) {
        return null;
      }
      throw error;
    }
    return {
      stream: result.Body,
      contentType: attachment.mimeType || result.ContentType || 'application/octet-stream',
      contentLength: typeof result.ContentLength === 'number' ? result.ContentLength : null,
    };
  }

  if (attachment.fileId) {
    const fileDoc = await gridFsStorage.findFile(attachment.fileId);
    if (!fileDoc) return null;
    return {
      stream: gridFsStorage.openDownloadStream(attachment.fileId),
      contentType: attachment.mimeType || fileDoc.contentType || 'application/octet-stream',
      contentLength: fileDoc.length || null,
    };
  }

  if (attachment.storedName) {
    const safeFileName = path.basename(attachment.storedName);
    const filePath = path.join(UPLOAD_ROOT, safeFileName);
    if (!fs.existsSync(filePath)) return null;
    return {
      stream: fs.createReadStream(filePath),
      contentType: attachment.mimeType || 'application/octet-stream',
      contentLength: null,
    };
  }

  // Defense in depth only - the model's own pre('validate') hook already
  // guarantees every SAVED attachment has at least one storage reference,
  // so this should be unreachable in practice.
  return null;
}

// GENERIC OPERATION 3 of 3: deletes an attachment's underlying stored
// bytes, branching on which reference it actually has - S3 (`objectKey`),
// GridFS (`fileId`), or legacy local disk (`storedName`). Always called
// with an attachment subdocument that was already found on the
// AUTHORIZED Request's own `attachments`/`completionAttachments` array -
// never with a client-supplied objectKey/fileId/storedName directly, so
// this can never be used to delete storage belonging to a different
// Request (task spec: "Never accept arbitrary S3 objectKey from client as
// authorization"). Best-effort for every branch, exactly like the pre-S3
// code: a file/object that is somehow already missing is not itself a
// failure - the caller's own metadata removal (requestDoc.save()) is what
// actually matters to the Request's stored state, and has already
// succeeded by the time this runs.
async function deleteImage(attachment) {
  if (!attachment) return;

  if (attachment.objectKey) {
    try {
      const client = getS3Client();
      const bucket = getS3Bucket();
      // eslint-disable-next-line global-require
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: attachment.objectKey }));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to delete S3 object ${attachment.objectKey}:`, error.message);
    }
    return;
  }

  if (attachment.fileId) {
    try {
      await gridFsStorage.deleteFile(attachment.fileId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to delete GridFS file ${attachment.fileId}:`, error.message);
    }
    return;
  }

  if (attachment.storedName) {
    const safeFileName = path.basename(attachment.storedName);
    fs.unlink(path.join(UPLOAD_ROOT, safeFileName), () => {});
  }
}

module.exports = {
  getConfiguredProvider,
  isS3Configured,
  buildObjectKey,
  uploadBufferToS3,
  uploadImage,
  getImageStream,
  deleteImage,
  // Exposed for the optional real-S3 infrastructure smoke test
  // (scripts/migrateRequestImagesToS3.js and the test suite's own
  // structural-vs-real check) - never used against real Request images.
  getS3Client,
  getS3Bucket,
};
