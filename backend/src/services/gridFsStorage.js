/**
 * GridFS storage service for Request image attachments (Before Images /
 * Completion Images).
 *
 * WHY THIS FILE EXISTS
 * The sole owner of all GridFS access in this project - every controller
 * that needs to store, read, or delete a Request image byte-stream goes
 * through the functions exported here, never through a raw GridFSBucket
 * of its own. This keeps GridFS logic in one place instead of scattered
 * across request.controller.js (the migration task's own explicit
 * requirement).
 *
 * CONNECTION
 * Uses `mongoose.mongo.GridFSBucket` - the exact MongoDB Node.js driver
 * class Mongoose itself bundles and re-exports - reached through the
 * ALREADY-OPEN Mongoose connection (`mongoose.connection.db`). This
 * project's package.json does not (and does not need to) list `mongodb`
 * as a direct dependency; `mongoose.mongo` is the supported way to reach
 * it without adding one. No second MongoDB connection is ever opened -
 * connectDB() (src/config/db.js) remains the one and only place this
 * app connects to MongoDB.
 *
 * BUCKET
 * One bucket, "requestImages" (-> requestImages.files / requestImages.
 * chunks collections). No per-Organization or per-Request buckets - the
 * per-Request/per-Organization/per-attachment-type boundary lives in
 * each file's `metadata` field instead (organizationId, requestId,
 * attachmentType, uploadedBy - always set by the caller from trusted
 * server-side values, never from req.body).
 *
 * AUTHORIZATION
 * This module performs NONE. Every function here trusts its caller
 * completely - the caller (request.controller.js's endpoints) is always
 * responsible for verifying the requester may act on the specific
 * Request/attachment BEFORE calling into this module, exactly the same
 * division of responsibility the legacy local-disk path already has
 * between middleware/upload.js (pure file I/O) and the controller (all
 * authorization).
 */

const mongoose = require('mongoose');

const BUCKET_NAME = 'requestImages';

let cachedBucket = null;

// Lazily creates (and caches) the GridFSBucket. Lazy on purpose: this
// module is required at process start (via request.controller.js), well
// before connectDB() has necessarily finished - the bucket itself is
// only actually constructed the first time a caller performs a real
// GridFS operation, by which point the app has always already connected
// (every route handler runs after server.js's connectDB() -> app.listen()
// sequence). Cached afterwards so repeated calls reuse the same bucket
// instance rather than re-deriving it from mongoose.connection on every
// upload/download/delete.
function getBucket() {
  if (cachedBucket) return cachedBucket;

  const { db } = mongoose.connection;
  if (!db) {
    throw new Error('GridFS storage is unavailable: the Mongoose connection is not established yet.');
  }

  cachedBucket = new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
  return cachedBucket;
}

// Uploads a single in-memory buffer (Multer memoryStorage's
// `req.file(s).buffer` - never a filesystem path, never base64) to
// GridFS. `filename` is used only for GridFS's own informational
// `filename` field (never trusted as a storage identifier - the
// returned ObjectId is); `contentType` and `metadata` are always
// server-derived trusted values, never anything read from req.body.
//
// Resolves with the new file's ObjectId once the write is fully durable
// (the upload stream's 'finish' event) - a caller can safely treat a
// resolved promise as "this file now exists in GridFS, safe to
// reference from a Request document".
function uploadBuffer(buffer, { filename, contentType, metadata } = {}) {
  return new Promise((resolve, reject) => {
    let bucket;
    try {
      bucket = getBucket();
    } catch (error) {
      reject(error);
      return;
    }

    const uploadStream = bucket.openUploadStream(filename, { contentType, metadata });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });
}

// Opens a readable stream for a stored file's bytes. The caller (the
// authenticated content-delivery endpoint - never anything else) is
// responsible for authorization BEFORE calling this; this function
// performs no access control of its own. Streams directly to the HTTP
// response - never buffers the whole file into memory.
function openDownloadStream(fileId) {
  return getBucket().openDownloadStream(fileId);
}

// Looks up a single file's own GridFS-level metadata (contentType,
// length, filename, uploadDate, metadata) without downloading its
// bytes - used by the content-delivery endpoint to set
// Content-Type/Content-Length before streaming, and by the migration
// script to check "does this fileId already exist" for idempotency.
// Returns null (never throws) when the file does not exist.
async function findFile(fileId) {
  const bucket = getBucket();
  const docs = await bucket.find({ _id: fileId }).toArray();
  return docs[0] || null;
}

// Deletes exactly one stored file. A file that no longer exists
// (already deleted, or never existed) does NOT throw - GridFSBucket's
// own delete() throws a "FileNotFound"-shaped error in that case, which
// is treated here as already-achieved-the-goal rather than a real
// failure, mirroring middleware/upload.js's own cleanupUploadedFiles
// "missing file is fine" philosophy for the legacy local-disk path. Any
// OTHER error (a real database error, connection failure, etc.) still
// rejects - this is not a blanket try/catch-and-ignore.
async function deleteFile(fileId) {
  try {
    await getBucket().delete(fileId);
  } catch (error) {
    if (error && /FileNotFound/i.test(error.message || '')) {
      return;
    }
    throw error;
  }
}

module.exports = {
  BUCKET_NAME,
  getBucket,
  uploadBuffer,
  openDownloadStream,
  findFile,
  deleteFile,
};
