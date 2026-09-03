const multer = require('multer');

/**
 * DOC-70 - "Organization Chat Attachments" - upload middleware.
 * -------------------------------------------------------------------------
 *
 * AUDIT (task spec's own standing instruction to audit before reuse):
 * middleware/upload.js's existing `uploadMemory` instance is images-only
 * (`ALLOWED_MIME_TYPES` there is exactly `{jpeg, png, webp}`, `MAX_FILE_
 * SIZE_BYTES` is 5 MB, `MAX_FILES_PER_REQUEST` is 5) - built specifically
 * for Request/Profile images (task spec section 4: "Recommended file
 * types include images. Do NOT allow: PDFs..." was that ticket's own
 * scope, not this one's). DOC-70 explicitly ALSO needs PDF (and,
 * optionally, plain text) support with a DIFFERENT size ceiling (10 MB)
 * and a DIFFERENT per-item ceiling (3), so reusing `uploadMemory` directly
 * would either silently loosen Request/Profile image uploads to accept
 * PDFs (never intended there) or require bolting an per-call MIME
 * override onto a shared instance - Multer instances are configured once
 * at construction, not per-request. A small, independent, fully
 * self-contained Multer configuration (mirroring `middleware/upload.js`'s
 * own memoryStorage + fileFilter + `handleUpload`-style error-translation
 * shape) is cleaner and lower-risk than adding chat-specific conditionals
 * into a file three OTHER features already depend on.
 *
 * MEMORYSTORAGE ONLY (task spec's own standing constraint: "Do NOT store
 * file binaries directly inside ChatMessage documents" / "Do NOT use
 * Base64 for file persistence") - exactly like `uploadMemory`, bytes are
 * held in memory only long enough to hand to
 * `services/chatAttachmentStorage.js`, which streams them to GridFS/S3;
 * nothing here ever touches local disk.
 */

// Conservative, useful set (task spec section 4): the three image types
// every other upload feature in this project already supports, plus PDF
// (the ticket's own primary non-image example, "network-plan.pdf") and
// plain text (explicitly called out as "optional if clearly useful" - a
// short text file, e.g. a config snippet or log excerpt, is a genuinely
// common, low-risk thing to share in a chat). Deliberately excludes
// executables, scripts, HTML, SVG (this project has no established SVG-
// sanitization policy to point to), and archives (zip/tar could
// themselves contain anything) - task spec section 4's own explicit
// "do NOT allow" list.
const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

// Task spec section 5 - "max 10 MB per attachment... choose based on
// current storage/deployment constraints" - deliberately larger than the
// 5 MB Request/Profile image ceiling (a PDF document is often bigger than
// a compressed photo) but still a conservative, explicit cap, never
// unlimited.
const MAX_CHAT_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per attachment

// Task spec section 6 - "Keep it controlled... max 3 attachments per chat
// message. Do not allow unlimited uploads."
const MAX_ATTACHMENTS_PER_MESSAGE = 3;

// Same "declared Content-Type only, never the original filename/
// extension" policy `middleware/upload.js`'s own `fileFilter` already
// documents (task spec section 34: "validate declared MIME type" - this
// project does not add a magic-byte/file-signature library, an honestly
// documented limitation, not an oversight - see this file's own README
// section for the full writeup).
function chatAttachmentFileFilter(req, file, cb) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_CHAT_ATTACHMENT_MIME_TYPES, file.mimetype)) {
    const error = new Error('Only JPEG, PNG, WEBP, PDF, or plain text files are supported.');
    error.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(error);
  }
  return cb(null, true);
}

// memoryStorage only - see this file's own top comment.
const uploadChatAttachments = multer({
  storage: multer.memoryStorage(),
  fileFilter: chatAttachmentFileFilter,
  limits: {
    fileSize: MAX_CHAT_ATTACHMENT_SIZE_BYTES,
    files: MAX_ATTACHMENTS_PER_MESSAGE,
  },
});

// Mirrors middleware/upload.js's own `handleUpload` shape exactly (task
// spec section 29: "Use DOC-65 safe errors. Never raw Multer/S3/GridFS
// errors.") but with chat-specific wording, since `upload.js`'s own
// version hardcodes "image"/"images" language that would be misleading
// for a PDF/text attachment. There is nothing to clean up on a rejected
// chat upload (memoryStorage never wrote anything to disk in the first
// place - unlike the legacy disk-storage path `upload.js`'s own
// `cleanupUploadedFiles` exists for), so this wrapper is intentionally
// simpler than that one.
function handleChatUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();

      if (err.code === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(400).json({ status: 'error', message: err.message });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ status: 'error', message: 'Each attachment must be 10 MB or smaller.' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ status: 'error', message: `A maximum of ${MAX_ATTACHMENTS_PER_MESSAGE} attachments may be sent per message.` });
      }
      return res.status(400).json({ status: 'error', message: 'Unable to upload attachment. Please try again.' });
    });
  };
}

module.exports = {
  uploadChatAttachments,
  handleChatUpload,
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
};
