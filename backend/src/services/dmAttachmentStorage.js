/**
 * Direct Message Attachment Storage Abstraction - S3 / GridFS
 * -------------------------------------------------------------------------
 *
 * AUDIT (task spec section 17: "Reuse the generic chat attachment storage
 * architecture if it was intentionally made DM-ready. Do NOT duplicate
 * storage code unnecessarily."). services/chatAttachmentStorage.js's own
 * top comment explicitly anticipated this exact ticket: its public
 * functions (`uploadAttachment`/`getAttachmentStream`/`deleteAttachment`)
 * already take only `{ organizationId, userId, mimeType }` - no
 * ChatMessage-specific concept baked in - so the underlying MECHANISM
 * (upload/read/delete a buffer through whichever provider is configured)
 * is already fully DM-ready and genuinely reusable. What is NOT reusable
 * as-is is the NAMESPACE: chat.controller.js's own IDOR-protection
 * writeup and task spec section 9 (DOC-70) both establish "a dedicated
 * namespace, never mixed with other features' storage" as a hard rule -
 * task spec section 17 of THIS ticket repeats that same rule for DMs
 * ("Storage namespace may be dm/<org>/<conversation>/<file>"). Calling
 * chatAttachmentStorage.js directly for a DM attachment would put DM
 * bytes in the SAME `chatAttachments` GridFS bucket / `chat/...` S3 prefix
 * as Organization Chat's own attachments - i.e. exactly the "do not mix
 * with requestImages/profileImages" mistake DOC-70 itself warns against,
 * just one feature further along.
 *
 * THE RESOLUTION: keep the exact same "each feature gets its own tiny
 * storage module, all built on gridFsStorage.js's shared, already-
 * generalized `bucketName` parameter" pattern
 * requestImageStorage.js/profileImageStorage.js/chatAttachmentStorage.js
 * already established, rather than adding a `bucketName`/`namespace`
 * parameter onto chatAttachmentStorage.js's own exported functions (which
 * would blur that module's single-purpose contract and risk a future bug
 * where a caller forgets to pass the right namespace). This is the THIRD
 * caller of gridFsStorage.js's `bucketName` option, exactly as DOC-71's
 * own comment on that parameter anticipated.
 *
 * STORAGE NAMESPACE (task spec section 17)
 *   - S3 key prefix: `dm/{organizationId}/{conversationId}/{uuid}.ext` -
 *     scoped by conversationId (not userId, unlike chatAttachmentStorage.js)
 *     because a DM attachment conceptually belongs to the CONVERSATION
 *     (either participant may later need to fetch it, not just whoever
 *     uploaded it), the same reasoning chatAttachmentStorage.js used for
 *     scoping by organizationId+userId in its own single-shared-channel
 *     context.
 *   - GridFS bucket: `'directMessageAttachments'` - a DEDICATED bucket,
 *     separate from `'chatAttachments'`, `'requestImages'`, and
 *     `'profileImages'`, so a DM attachment can never be mixed, listed
 *     together, or accidentally cross-referenced with any of those.
 *
 * AUTHORIZATION
 * This module performs NONE, exactly like every other storage module in
 * this project - controllers/directMessage.controller.js is always
 * responsible for verifying the caller is an authorized PARTICIPANT of the
 * specific conversation/message (task spec section 18's own explicit
 * authorization chain) BEFORE calling into this module.
 */

const crypto = require('crypto');
const gridFsStorage = require('./gridFsStorage');

const DM_ATTACHMENT_BUCKET = 'directMessageAttachments';

// Task spec section 19 - "Prefer matching DOC-70": the identical five
// supported types chatUpload.js/chatAttachmentStorage.js already
// established - no independent decision needed here (this module reuses
// middleware/chatUpload.js's own Multer instance unchanged for the exact
// same reason - see routes/directMessage.routes.js).
const EXTENSION_BY_MIME_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

const VALID_PROVIDERS = ['s3', 'gridfs'];
let warnedAboutInvalidProvider = false;

// Reads the SAME `IMAGE_STORAGE_PROVIDER` env var every other storage
// module in this project already reads - one operator-facing setting
// governs new uploads for every storage-backed feature; there is no
// separate `DM_ATTACHMENT_STORAGE_PROVIDER`.
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
      + 'falling back to "gridfs" for new direct message attachment uploads.',
    );
  }
  return 'gridfs';
}

function isS3Configured() {
  return Boolean(
    process.env.S3_BUCKET
    && process.env.S3_REGION
    && process.env.S3_ACCESS_KEY_ID
    && process.env.S3_SECRET_ACCESS_KEY,
  );
}

let cachedS3Client = null;

// Its own cached client (not imported from chatAttachmentStorage.js/
// requestImageStorage.js/profileImageStorage.js) - keeps this module fully
// independent of all three, per this file's own top audit note.
function getS3Client() {
  if (cachedS3Client) return cachedS3Client;

  if (!isS3Configured()) {
    throw new Error(
      'S3 storage is not configured. Set S3_BUCKET, S3_REGION, '
      + 'S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY (see backend/.env.example).',
    );
  }

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
    throw new Error('S3 storage is not configured: S3_BUCKET is not set.');
  }
  return bucket;
}

// Builds a safe, unique, server-derived S3 object key - NEVER built from
// any client-supplied value (never the original filename). `organizationId`/
// `conversationId` are always trusted, already-authorized server-side
// values by the time this is called (the controller has already confirmed
// the caller is a participant of this exact conversation).
function buildObjectKey(organizationId, conversationId, mimeType) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType] || '';
  return `dm/${organizationId}/${conversationId}/${crypto.randomUUID()}${extension}`;
}

// Uploads one in-memory buffer (Multer memoryStorage's `file.buffer` -
// never a filesystem path, never base64) through whichever provider is
// currently configured, returning exactly the storage reference the
// caller should persist on one DirectMessage.attachments entry - `{
// objectKey }` for S3, `{ fileId }` for GridFS.
async function uploadAttachment(buffer, { organizationId, conversationId, mimeType }) {
  const provider = getConfiguredProvider();

  if (provider === 's3') {
    const objectKey = buildObjectKey(organizationId, conversationId, mimeType);
    const client = getS3Client();
    const bucket = getS3Bucket();
    // eslint-disable-next-line global-require
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: objectKey, Body: buffer, ContentType: mimeType,
    }));
    return { objectKey };
  }

  // provider === 'gridfs' - its own DEDICATED bucket (see this file's own
  // top "STORAGE NAMESPACE" note), never the chat/Request-image/
  // profile-image bucket.
  const fileId = await gridFsStorage.uploadBuffer(buffer, {
    filename: `dm-attachment-${conversationId}`,
    contentType: mimeType,
    metadata: { organizationId, conversationId },
    bucketName: DM_ATTACHMENT_BUCKET,
  });
  return { fileId };
}

// Given an ALREADY-AUTHORIZED attachment reference (the caller -
// directMessage.controller.js - is always responsible for authorization
// before this is ever called), returns `{ stream, contentType,
// contentLength }`, or `null` if the underlying bytes cannot be found.
async function getAttachmentStream(attachment) {
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
    const fileDoc = await gridFsStorage.findFile(attachment.fileId, DM_ATTACHMENT_BUCKET);
    if (!fileDoc) return null;
    return {
      stream: gridFsStorage.openDownloadStream(attachment.fileId, DM_ATTACHMENT_BUCKET),
      contentType: attachment.mimeType || fileDoc.contentType || 'application/octet-stream',
      contentLength: fileDoc.length || null,
    };
  }

  return null;
}

// Deletes an attachment's underlying stored bytes - best-effort, exactly
// like every other storage module's own `deleteImage`/`deleteAttachment`:
// a failure here is logged, never thrown. Used ONLY for the failed-DB-save
// cleanup path (directMessage.controller.js's sendMessage) - a
// successfully-saved DirectMessage's attachments are never deleted, since
// messages are immutable and there is no delete endpoint (task spec
// section 47/52).
async function deleteAttachment(attachment) {
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
      console.error(`Failed to delete orphaned S3 direct message attachment ${attachment.objectKey}:`, error.message);
    }
    return;
  }

  if (attachment.fileId) {
    try {
      await gridFsStorage.deleteFile(attachment.fileId, DM_ATTACHMENT_BUCKET);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to delete orphaned GridFS direct message attachment ${attachment.fileId}:`, error.message);
    }
  }
}

module.exports = {
  DM_ATTACHMENT_BUCKET,
  getConfiguredProvider,
  isS3Configured,
  buildObjectKey,
  uploadAttachment,
  getAttachmentStream,
  deleteAttachment,
};
