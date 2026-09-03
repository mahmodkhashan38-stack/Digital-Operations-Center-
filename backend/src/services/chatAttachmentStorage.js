/**
 * Chat Attachment Storage Abstraction - S3 / GridFS
 * -------------------------------------------------------------------------
 *
 * AUDIT (task spec's own standing instruction: "Do NOT reuse Request-
 * specific storage directly if it hardcodes requestId/attachmentType" -
 * this comment IS that audit, not a rubber stamp, mirroring
 * services/profileImageStorage.js's own DOC-71 audit for the identical
 * reason). services/requestImageStorage.js's `uploadImage`/
 * `getImageStream`/`deleteImage` are Request-shaped: `buildObjectKey`
 * hardcodes `organizations/{orgId}/requests/{requestId}/before|completion/
 * {uuid}.ext`, and every signature requires a `requestId`/`attachmentType`
 * that a chat attachment simply does not have (a chat attachment belongs
 * to a ChatMessage, not a Request, and has no "before/completion"
 * concept). Forcing a fake `requestId` through that module would be
 * exactly the "blind reuse" the task spec warns against.
 *
 * WHAT IS ACTUALLY SHARED, AND HOW: exactly like profileImageStorage.js,
 * the lazy S3 client/bucket construction pattern and a MIME-to-extension
 * map are duplicated in miniature here (a handful of lines) rather than
 * imported, keeping this module fully independent and readable on its
 * own - requestImageStorage.js and profileImageStorage.js remain
 * completely unmodified and unaffected by anything in this file. The one
 * genuinely SHARED, safely-generalized piece is services/gridFsStorage.js,
 * which DOC-71 already extended with an optional `bucketName` parameter
 * (defaulting to the original 'requestImages' bucket for every existing
 * caller, zero behavior change there) - this module is the SECOND caller
 * to use that parameter with its own value, exactly as DOC-71 anticipated
 * ("a future caller... requesting its own dedicated bucket").
 *
 * STORAGE NAMESPACE (task spec section 9 - "Use a dedicated namespace...
 * Do not mix with: requestImages, profileImages")
 *   - S3 key prefix: `chat/{organizationId}/{userId}/{uuid}.ext` - unlike
 *     profileImageStorage.js's userId-only scheme (which exists
 *     specifically to accommodate System Admin's null organizationId),
 *     every chat participant is guaranteed to have a real, non-null
 *     organizationId (System Admin never participates in Organization
 *     Chat at all - routes/chat.routes.js's own `requireRole('manager',
 *     'operator', 'employee')` structurally excludes it, unchanged by
 *     this ticket), so including `organizationId` in the prefix is both
 *     safe and useful (task spec's own suggested shape:
 *     "chat/<org>/<user>/<file>"), giving every attachment an
 *     Organization-scoped storage path that mirrors the Organization
 *     isolation already enforced at the database-query level.
 *   - GridFS bucket: `'chatAttachments'` (-> chatAttachments.files/
 *     chatAttachments.chunks) - a DEDICATED bucket, deliberately separate
 *     from both `'requestImages'` and `'profileImages'`, so a chat
 *     attachment can never be mixed, listed together, or accidentally
 *     cross-referenced with either of those.
 *
 * DIRECT-MESSAGE READINESS (task spec section 40 - "Design attachment
 * metadata/storage so it can later support... private conversation
 * without duplicating storage architecture. Do NOT implement Direct
 * Messages now."). This module's public functions
 * (`uploadAttachment`/`getAttachmentStream`/`deleteAttachment`) take only
 * `{ organizationId, userId, mimeType }` - no ChatMessage-specific field
 * (no `chatMessageId`, no "channel" concept) is baked into the storage
 * key or the function signatures. A future DOC-73 Direct Message feature
 * could call these exact same functions unchanged for a private
 * conversation's attachments (the same `organizationId`/`userId`-scoped
 * prefix remains meaningful - a DM is still between two members of the
 * same Organization), needing at most a distinct GridFS bucket constant
 * of its own if isolation from Organization Chat's own attachments is
 * later desired - no redesign of this module would be required.
 *
 * AUTHORIZATION
 * This module performs NONE, exactly like requestImageStorage.js/
 * profileImageStorage.js/gridFsStorage.js - controllers/chat.controller.js
 * is always responsible for verifying the caller may act on the specific
 * message/attachment (same-Organization message lookup FIRST, task spec
 * section 17) BEFORE calling into this module.
 */

const crypto = require('crypto');
const gridFsStorage = require('./gridFsStorage');

const CHAT_ATTACHMENT_BUCKET = 'chatAttachments';

const EXTENSION_BY_MIME_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

const VALID_PROVIDERS = ['s3', 'gridfs'];
let warnedAboutInvalidProvider = false;

// Reads the SAME `IMAGE_STORAGE_PROVIDER` env var requestImageStorage.js/
// profileImageStorage.js already read - one operator-facing setting
// governs new uploads for every storage-backed feature in this project;
// there is no separate `CHAT_ATTACHMENT_STORAGE_PROVIDER`. Falls back to
// "gridfs" for both an unset and an unrecognized value, exactly like both
// of those modules' own identical function.
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
      + 'falling back to "gridfs" for new chat attachment uploads.',
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

// Lazily creates (and caches) the AWS SDK v3 S3Client - never logs
// credential values. Deliberately its OWN cached client (not imported
// from requestImageStorage.js/profileImageStorage.js) so this module has
// zero import-time dependency on either file, keeping all three storage
// concerns fully independent per this file's own top audit note.
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
// any client-supplied value (never the original filename, never a
// client-chosen path - task spec section 19/29's own "do not trust
// original filename" requirement, and section 33's "never persist a
// filesystem path"). `organizationId`/`userId` are always the trusted,
// authenticated caller's own values; the extension comes only from
// EXTENSION_BY_MIME_TYPE, keyed by the ALREADY-VALIDATED mimeType
// (middleware/chatUpload.js's fileFilter has already rejected anything
// outside the five supported types by the time this is ever called).
function buildObjectKey(organizationId, userId, mimeType) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType] || '';
  return `chat/${organizationId}/${userId}/${crypto.randomUUID()}${extension}`;
}

// Uploads one in-memory buffer (Multer memoryStorage's `file.buffer` -
// never a filesystem path, never base64) through whichever provider is
// currently configured, returning exactly the storage reference the
// caller should persist on one ChatMessage.attachments entry - `{
// objectKey }` for S3, `{ fileId }` for GridFS. Mirrors
// profileImageStorage.js's own `uploadImage` shape so the calling
// controller's own "spread this onto the attachment subdocument" logic
// reads identically, without actually importing/depending on that module.
async function uploadAttachment(buffer, { organizationId, userId, mimeType }) {
  const provider = getConfiguredProvider();

  if (provider === 's3') {
    const objectKey = buildObjectKey(organizationId, userId, mimeType);
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
  // top "STORAGE NAMESPACE" note), never the Request-image or
  // profile-image bucket.
  const fileId = await gridFsStorage.uploadBuffer(buffer, {
    filename: `chat-attachment-${userId}`,
    contentType: mimeType,
    metadata: { organizationId, userId },
    bucketName: CHAT_ATTACHMENT_BUCKET,
  });
  return { fileId };
}

// Given an ALREADY-AUTHORIZED attachment reference (the caller -
// chat.controller.js - is always responsible for authorization before
// this is ever called, task spec section 16/17), returns `{ stream,
// contentType, contentLength }`, or `null` if the underlying bytes cannot
// be found (a data-integrity edge case, never thrown, the caller turns
// this into a plain 404).
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
    const fileDoc = await gridFsStorage.findFile(attachment.fileId, CHAT_ATTACHMENT_BUCKET);
    if (!fileDoc) return null;
    return {
      stream: gridFsStorage.openDownloadStream(attachment.fileId, CHAT_ATTACHMENT_BUCKET),
      contentType: attachment.mimeType || fileDoc.contentType || 'application/octet-stream',
      contentLength: fileDoc.length || null,
    };
  }

  return null;
}

// Deletes an attachment's underlying stored bytes - best-effort, exactly
// like requestImageStorage.js's/profileImageStorage.js's own
// `deleteImage`: a failure here is logged, never thrown (task spec
// section 31: "If storage cleanup fails: log safely server-side, do not
// expose storage details"). Used ONLY for the failed-DB-save cleanup path
// (chat.controller.js's createMessage) - a successfully-saved
// ChatMessage's attachments are never deleted, since messages are
// immutable and there is no delete endpoint (task spec section 32).
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
      console.error(`Failed to delete orphaned S3 chat attachment ${attachment.objectKey}:`, error.message);
    }
    return;
  }

  if (attachment.fileId) {
    try {
      await gridFsStorage.deleteFile(attachment.fileId, CHAT_ATTACHMENT_BUCKET);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to delete orphaned GridFS chat attachment ${attachment.fileId}:`, error.message);
    }
  }
}

module.exports = {
  CHAT_ATTACHMENT_BUCKET,
  getConfiguredProvider,
  isS3Configured,
  buildObjectKey,
  uploadAttachment,
  getAttachmentStream,
  deleteAttachment,
};
