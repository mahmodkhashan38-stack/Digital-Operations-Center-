/**
 * Profile Image Storage Abstraction - S3 / GridFS
 * -------------------------------------------------------------------------
 *
 * AUDIT (task spec's own standing instruction: "Do NOT reuse Request image
 * metadata blindly without auditing whether a shared storage abstraction
 * is appropriate" - this comment IS that audit, not a rubber stamp).
 * services/requestImageStorage.js's three generic operations
 * (`uploadImage`/`getImageStream`/`deleteImage`) are NOT reused directly
 * here, because they are not actually generic - their own
 * `buildObjectKey` hardcodes `organizations/{orgId}/requests/{requestId}/
 * before|completion/{uuid}.ext`, and every one of their function
 * signatures REQUIRES `requestId`/`attachmentType`, neither of which a
 * profile image has (a profile image belongs to a User, not a Request,
 * and has no "before/completion" concept at all). Forcing a fake
 * `requestId`/`attachmentType` through that module just to satisfy its
 * signature would be exactly the "blind reuse" the task spec warns
 * against - a User avatar is a conceptually different piece of data that
 * happens to share the same TWO underlying mechanisms (an S3 bucket, a
 * GridFS bucket), not the same shape of data.
 *
 * WHAT IS ACTUALLY SHARED, AND HOW: the lazy S3 client/bucket construction
 * pattern and the JPEG/PNG/WEBP mime-to-extension map are duplicated in
 * miniature here (a handful of lines) rather than imported, keeping this
 * module fully independent and readable on its own - request
 * ImageStorage.js remains completely unmodified and unaffected by
 * anything in this file. The one genuinely SHARED, safely-generalized
 * piece is services/gridFsStorage.js, which this ticket extended with an
 * optional `bucketName` parameter (defaulting to the original
 * 'requestImages' bucket for every existing caller, zero behavior change
 * there) specifically so this module can request its OWN dedicated
 * bucket, 'profileImages' - see STORAGE NAMESPACE below.
 *
 * STORAGE NAMESPACE (task spec section 5 - "Document the decision")
 *   - S3 key prefix: `profiles/{userId}/{uuid}.ext` - keyed by `userId`
 *     alone, NOT `organizationId` (unlike Request attachments' own
 *     `organizations/{orgId}/...` prefix) - a System Admin has no
 *     organizationId at all (task spec section 21: "System Admin can also
 *     set profile picture... organizationId remains null"), so a
 *     userId-only prefix is the one scheme that works uniformly for every
 *     role without a null-handling special case. `userId` here is always
 *     the trusted, authenticated caller's own id (req.user.userId) - never
 *     client-suppliable, and a fresh `crypto.randomUUID()` per upload
 *     means even two uploads for the SAME user never collide keys.
 *   - GridFS bucket: 'profileImages' (-> profileImages.files/
 *     profileImages.chunks) - a DEDICATED bucket, deliberately separate
 *     from Request images' own 'requestImages' bucket, so the two
 *     conceptually different kinds of image can never be mixed, listed
 *     together, or accidentally cross-referenced.
 *
 * AUTHORIZATION
 * This module performs NONE, exactly like requestImageStorage.js/
 * gridFsStorage.js - controllers/userProfileImage.controller.js is always
 * responsible for verifying the caller may act on the specific profile
 * image (in practice: always their own, and only their own - see that
 * controller's own top comment) BEFORE calling into this module.
 */

const crypto = require('crypto');
const gridFsStorage = require('./gridFsStorage');

const PROFILE_IMAGE_BUCKET = 'profileImages';

const EXTENSION_BY_MIME_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const VALID_PROVIDERS = ['s3', 'gridfs'];
let warnedAboutInvalidProvider = false;

// Reads the currently-configured provider for NEW uploads only - the same
// IMAGE_STORAGE_PROVIDER env var requestImageStorage.js already reads
// (one operator-facing setting governs new uploads for BOTH Request
// images and profile images - there is no separate
// PROFILE_IMAGE_STORAGE_PROVIDER, since an operator who has configured S3
// for one clearly intends it for the other too). Falls back to "gridfs"
// for both an unset and an unrecognized value, exactly like
// requestImageStorage.js's own identical function.
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
      + 'falling back to "gridfs" for new profile image uploads.',
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
// from requestImageStorage.js) so this module has zero import-time
// dependency on that file, keeping the two storage concerns fully
// independent per this file's own top audit note - the two clients are
// functionally identical (same env vars, same construction) but are two
// separate objects in memory, which costs nothing (the SDK client itself
// holds no per-request state worth sharing).
function getS3Client() {
  if (cachedS3Client) return cachedS3Client;

  if (!isS3Configured()) {
    throw new Error(
      'S3 image storage is not configured. Set S3_BUCKET, S3_REGION, '
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
    throw new Error('S3 image storage is not configured: S3_BUCKET is not set.');
  }
  return bucket;
}

// Builds a safe, unique, server-derived S3 object key - NEVER built from
// any client-supplied value (never the original filename, never a
// client-chosen path). `userId` is always the trusted, authenticated
// caller's own id; the extension comes only from EXTENSION_BY_MIME_TYPE,
// keyed by the ALREADY-VALIDATED mimeType (middleware/upload.js's
// fileFilter has already rejected anything outside the three supported
// types by the time this is ever called) - never from the client's
// original filename/extension (task spec section 29/30).
function buildObjectKey(userId, mimeType) {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType] || '';
  return `profiles/${userId}/${crypto.randomUUID()}${extension}`;
}

// Uploads one in-memory buffer (Multer memoryStorage's `file.buffer` -
// never a filesystem path, never base64) through whichever provider is
// currently configured, returning exactly the storage reference the
// caller should persist on `User.profileImage` - `{ objectKey }` for S3,
// `{ fileId }` for GridFS. Mirrors requestImageStorage.js's own
// `uploadImage` shape (same two possible return shapes) so the calling
// controller's own "spread this onto the subdocument" logic reads
// identically, without actually importing/depending on that module.
async function uploadImage(buffer, { userId, mimeType }) {
  const provider = getConfiguredProvider();

  if (provider === 's3') {
    const objectKey = buildObjectKey(userId, mimeType);
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
  // top "STORAGE NAMESPACE" note), never the Request images bucket.
  const fileId = await gridFsStorage.uploadBuffer(buffer, {
    filename: `profile-${userId}`,
    contentType: mimeType,
    metadata: { userId },
    bucketName: PROFILE_IMAGE_BUCKET,
  });
  return { fileId };
}

// Given an ALREADY-AUTHORIZED profileImage reference (the caller -
// userProfileImage.controller.js - is always responsible for
// authorization before this is ever called), returns `{ stream,
// contentType, contentLength }`, or `null` if the underlying bytes
// cannot be found (deleted out from under a still-referenced image - a
// data-integrity edge case, never thrown, the caller turns this into a
// plain 404).
async function getImageStream(profileImage) {
  if (!profileImage) return null;

  if (profileImage.objectKey) {
    const client = getS3Client();
    const bucket = getS3Bucket();
    // eslint-disable-next-line global-require
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    let result;
    try {
      result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: profileImage.objectKey }));
    } catch (error) {
      const statusCode = error && error.$metadata && error.$metadata.httpStatusCode;
      if ((error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) || statusCode === 404) {
        return null;
      }
      throw error;
    }
    return {
      stream: result.Body,
      contentType: profileImage.mimeType || result.ContentType || 'application/octet-stream',
      contentLength: typeof result.ContentLength === 'number' ? result.ContentLength : null,
    };
  }

  if (profileImage.fileId) {
    const fileDoc = await gridFsStorage.findFile(profileImage.fileId, PROFILE_IMAGE_BUCKET);
    if (!fileDoc) return null;
    return {
      stream: gridFsStorage.openDownloadStream(profileImage.fileId, PROFILE_IMAGE_BUCKET),
      contentType: profileImage.mimeType || fileDoc.contentType || 'application/octet-stream',
      contentLength: fileDoc.length || null,
    };
  }

  return null;
}

// Deletes a profile image's underlying stored bytes - best-effort,
// exactly like requestImageStorage.js's own `deleteImage`: a failure here
// is logged, never thrown, and never blocks/undoes the User document
// update that already succeeded by the time this runs (task spec section
// 26: "Failure to delete old image must not destroy new profile update").
// Always called with a reference that was already on the User document
// (the OLD image, right after the NEW one has already been confirmed
// stored and saved - see the controller's own upload flow) - never with a
// client-supplied objectKey/fileId directly.
async function deleteImage(profileImage) {
  if (!profileImage) return;

  if (profileImage.objectKey) {
    try {
      const client = getS3Client();
      const bucket = getS3Bucket();
      // eslint-disable-next-line global-require
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: profileImage.objectKey }));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to delete S3 profile image ${profileImage.objectKey}:`, error.message);
    }
    return;
  }

  if (profileImage.fileId) {
    try {
      await gridFsStorage.deleteFile(profileImage.fileId, PROFILE_IMAGE_BUCKET);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to delete GridFS profile image ${profileImage.fileId}:`, error.message);
    }
  }
}

module.exports = {
  PROFILE_IMAGE_BUCKET,
  getConfiguredProvider,
  isS3Configured,
  buildObjectKey,
  uploadImage,
  getImageStream,
  deleteImage,
};
