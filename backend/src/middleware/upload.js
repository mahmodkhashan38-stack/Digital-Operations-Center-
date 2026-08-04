const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// DOC-45 - the one place image-upload storage/validation is configured.
// Multer is the only new dependency this task adds (task spec section 21
// explicitly rules out Cloudinary/AWS/Firebase/Sharp or any image
// transformation - this project stores files on the local disk and keeps
// only metadata in MongoDB, the simplest safe approach for an academic/
// local deployment).
//
// UPLOAD_ROOT is resolvable via an optional UPLOAD_DIR env var (documented
// in .env.example only, per task spec section 22 - the real .env is never
// touched) with a sensible local default, so nothing requires external
// cloud credentials. Created automatically on module load if missing
// (task spec section 3) - `recursive: true` also creates any missing
// parent directories, and is a no-op if the directory already exists.
const UPLOAD_ROOT = path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads/requests');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Images only (task spec section 1) - PDF/SVG/GIF/ZIP/DOCX/executables are
// all deliberately absent. SVG is excluded even though it can render as an
// image, because it can embed script content - a real security
// consideration, not an oversight. The extension used for each generated
// filename comes from THIS map, never from the client's original
// filename/extension - a file named "virus.exe.jpg" sent with
// Content-Type: image/png is stored as "<uuid>.png", never trusted by its
// name at any point.
const ALLOWED_MIME_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per image (task spec section 2)
const MAX_FILES_PER_REQUEST = 5; // Multer's own per-call ceiling - the
// dynamic "how many MORE may this specific Request accept" remaining-slot
// check (existing + new <= 5) happens in the controller, which knows the
// Request's current attachment count; Multer itself has no notion of that.

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  // Generated, unguessable filenames only (task spec sections 1/19) -
  // crypto.randomUUID() plus an extension derived from the validated MIME
  // type, never the client-supplied original filename. This is also what
  // makes path traversal via a crafted filename structurally impossible:
  // nothing about `file.originalname` ever reaches the filesystem path.
  filename(req, file, cb) {
    const extension = ALLOWED_MIME_TYPES[file.mimetype] || '';
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

// Rejects anything outside the three supported MIME types before Multer
// even writes the file to disk. This checks the multipart part's declared
// Content-Type (what the browser sends for a real image input), NOT the
// original filename/extension (task spec section 1: "Do not trust only
// the filename extension"). It cannot single-handedly prove the bytes are
// a genuine image (that would need a content-sniffing library, which this
// task explicitly says not to add - section 21) but combined with the
// generated-filename policy above, a rejected/renamed file can never be
// executed as anything by virtue of its name or extension.
function fileFilter(req, file, cb) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TYPES, file.mimetype)) {
    const error = new Error('Only JPEG, PNG, and WEBP images are supported.');
    error.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(error);
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_REQUEST,
  },
});

// Deletes files Multer already wrote to disk for a request - used both by
// the error-wrapper below (a rejected upload) and by controllers after a
// LATER failure (invalid title/description/Category, a database error, or
// the Request's remaining-slot limit) - task spec sections 9/20 are both
// explicit that no orphaned file may ever be left behind. Best-effort and
// silent: a failed cleanup must never mask the original error being
// handled, and a file that is already gone is not itself a problem.
function cleanupUploadedFiles(files) {
  (files || []).forEach((file) => {
    fs.unlink(file.path, () => {});
  });
}

// Wraps a configured Multer middleware (e.g. `upload.array('attachments',
// MAX_FILES_PER_REQUEST)`) so that:
//   1. Any MulterError (oversized file, too many files) or fileFilter
//      rejection (unsupported MIME type) is translated into a clean,
//      client-safe JSON response - never Multer's raw error reaching the
//      generic error handler with an internal message/stack.
//   2. Any files Multer already wrote to disk before the error occurred
//      are deleted immediately (see cleanupUploadedFiles) - this matters
//      because Multer streams multipart parts one at a time, so an error
//      on the 3rd file in a 5-file upload can still leave the first two
//      already saved unless explicitly cleaned up here.
function handleUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();

      cleanupUploadedFiles(req.files);

      if (err.code === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(400).json({ status: 'error', message: err.message });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ status: 'error', message: 'Each image must be 5 MB or smaller.' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ status: 'error', message: `A maximum of ${MAX_FILES_PER_REQUEST} images may be uploaded at once.` });
      }
      return res.status(400).json({ status: 'error', message: 'Image upload failed. Please try again.' });
    });
  };
}

module.exports = {
  upload,
  handleUpload,
  cleanupUploadedFiles,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_REQUEST,
  UPLOAD_ROOT,
};
