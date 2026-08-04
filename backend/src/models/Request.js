const mongoose = require('mongoose');

// DOC-10 - the first real Request/Ticket model in this project. An
// Employee opens a Request against one Service Category (DOC-43) inside
// their own Organization; a Manager will later decide which Operator (from
// DOC-44's specialties) actually works it. This schema is deliberately
// small - it only defines what DOC-10 (creation) needs, plus the status
// enum's full future shape so later tasks do not need a breaking schema
// migration:
//   DOC-11 will read/list Requests.
//   DOC-12 will own status transitions (open -> in_progress -> resolved ->
//     closed, with a reopened branch) - this schema only stores `status`,
//     it does not implement or validate any transition rule.
//   DOC-13 added comments (a separate, referencing collection - not a
//     field on this document).
//   DOC-46 added Employee edit (title/description/categoryId/priority,
//     only while status === 'open' and unassigned) and Employee cancel
//     (a dedicated 'cancelled' status, terminal, reachable only through
//     PATCH /api/requests/:id/cancel - never through DOC-12's generic
//     status endpoint).
//   DOC-45 added image attachments (see `attachments` below) - metadata
//     only, the actual files live on local disk under
//     middleware/upload.js's UPLOAD_ROOT, never as base64 in MongoDB.
const MIN_TITLE_LENGTH = 5;
const MAX_TITLE_LENGTH = 150;
const MIN_DESCRIPTION_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 2000;

const PRIORITY_VALUES = ['low', 'medium', 'high'];

// The full planned workflow shape (see DOC-12's own future ownership
// note above) - DOC-10 only ever writes 'open', but the enum is defined
// with all five values now so this field never needs a schema migration
// when DOC-12 lands.
//
// DOC-46 adds the sixth and final value, 'cancelled' - the Employee's own
// "I no longer need this" action (PATCH /api/requests/:id/cancel), kept
// entirely separate from DOC-12's open->in_progress->resolved->closed(/
// reopened) workflow. 'cancelled' is terminal: it has no outbound
// transitions in either direction (see utils/requestStatusTransitions.js)
// and can only ever be reached through the dedicated cancel endpoint -
// never through DOC-12's generic PATCH /api/requests/:id/status.
const STATUS_VALUES = ['open', 'in_progress', 'resolved', 'closed', 'reopened', 'cancelled'];

// DOC-45 - kept as a small local constant (not imported from
// middleware/upload.js) so this model stays self-contained and never
// pulls in Multer/filesystem setup (upload.js's fs.mkdirSync side effect)
// just by being required - e.g. by a future migration script. Must stay
// in sync with middleware/upload.js's own ALLOWED_MIME_TYPES keys; both
// intentionally list the exact same three image types (task spec
// section 1 - JPEG/PNG/WEBP only, never PDF/SVG/GIF/ZIP/DOCX/executables).
const ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_ATTACHMENTS_PER_REQUEST = 5;
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;

// One attachment's metadata only - never the image bytes themselves
// (task spec section 3: "Do not store raw image base64 data in
// MongoDB"). `storedName` is the generated-UUID filename actually on
// disk (middleware/upload.js) - never the client's original filename,
// which is preserved separately as `originalName` purely for display.
// `url` is always a safe, root-relative path under the controlled static
// route (app.js's `/api/uploads/requests`) - never an absolute
// filesystem path (task spec section 3/10).
const attachmentSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [255, 'File name is too long.'],
    },
    storedName: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      required: true,
      enum: ATTACHMENT_MIME_TYPES,
    },
    size: {
      type: Number,
      required: true,
      min: [1, 'File size must be greater than zero.'],
      max: [MAX_ATTACHMENT_SIZE_BYTES, 'File exceeds the maximum allowed size.'],
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

// DOC-56 - "Operator Completion Proof Images". A completely SEPARATE
// attachment collection from `attachments` above - never the same array,
// never merged, never reused (task spec: "Do NOT reuse the employee
// attachments array."). Shares the exact same MIME/size/count limits
// (ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_SIZE_BYTES,
// MAX_ATTACHMENTS_PER_REQUEST - task spec: "Same Multer configuration as
// DOC-45") but adds one field the Employee-facing schema never needed:
// `uploadedBy`, always the assigned Operator's own User _id (task spec:
// "uploadedBy must always equal the assigned Operator") - required,
// unlike every other field on this subdocument, since a completion image
// with no known uploader would be a data-integrity bug, not a normal
// historical state.
const completionAttachmentSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [255, 'File name is too long.'],
    },
    storedName: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      required: true,
      enum: ATTACHMENT_MIME_TYPES,
    },
    size: {
      type: Number,
      required: true,
      min: [1, 'File size must be greater than zero.'],
      max: [MAX_ATTACHMENT_SIZE_BYTES, 'File exceeds the maximum allowed size.'],
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { _id: true },
);

const requestSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: [MIN_TITLE_LENGTH, `Title must be at least ${MIN_TITLE_LENGTH} characters.`],
      maxlength: [MAX_TITLE_LENGTH, `Title must be at most ${MAX_TITLE_LENGTH} characters.`],
    },
    description: {
      type: String,
      required: true,
      trim: true,
      minlength: [MIN_DESCRIPTION_LENGTH, `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters.`],
      maxlength: [MAX_DESCRIPTION_LENGTH, `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`],
    },
    // Always resolved server-side against a scoped, active-only query
    // (see controllers/request.controller.js) - never trusted as-is from
    // the client beyond "this looks like an id worth looking up".
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceCategory',
      required: true,
    },
    priority: {
      type: String,
      enum: PRIORITY_VALUES,
      default: 'medium',
    },
    // Always 'open' at creation (DOC-10) - never set from req.body.status.
    // See the controller for why this is enforced in two places (schema
    // default AND explicit server-side construction), the same
    // defense-in-depth pattern already used for ServiceCategory.isActive
    // and Organization.isActive.
    status: {
      type: String,
      enum: STATUS_VALUES,
      default: 'open',
    },
    // Always req.user.organizationId - the tenant boundary for every
    // future Request-scoped query (DOC-11/12/13), identical in spirit to
    // every other organizationId field in this project (DOC-38).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Always req.user.userId - who opened this Request. Indexed because
    // DOC-11's "My Requests" will query by this field.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Null until a Manager assigns an Operator - NOT implemented by
    // DOC-10 (see the model file's own top comment). A future task owns
    // writing to this field; DOC-10 only ever sets it to null.
    assignedOperatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // DOC-45 - defaults to `[]`, never required (task spec section 4).
    // Every Request created before this task simply has no `attachments`
    // field yet, which Mongoose treats as `[]` (the schema default) the
    // first time that document is loaded and saved - no migration is
    // required, exactly the same "empty array is a valid pre-existing
    // state" pattern DOC-44's `specialties` field already established on
    // User. The 5-item cap is enforced primarily in the controller (which
    // can return a clear, specific error before ever attempting a write),
    // but is also validated here as defense in depth.
    attachments: {
      type: [attachmentSchema],
      default: [],
      validate: {
        validator: (value) => !Array.isArray(value) || value.length <= MAX_ATTACHMENTS_PER_REQUEST,
        message: `A Request may have at most ${MAX_ATTACHMENTS_PER_REQUEST} attachments.`,
      },
    },
    // DOC-56 - "Operator Completion Proof Images". Defaults to `[]`, never
    // required, exactly like `attachments` above - every Request created
    // before this task simply has no `completionAttachments` field yet,
    // which Mongoose treats as `[]` the first time that document is
    // loaded and saved (no migration required). Shares the same 5-item
    // cap, enforced primarily in the controller (clear, specific error
    // before ever attempting a write) and here as defense in depth.
    completionAttachments: {
      type: [completionAttachmentSchema],
      default: [],
      validate: {
        validator: (value) => !Array.isArray(value) || value.length <= MAX_ATTACHMENTS_PER_REQUEST,
        message: `A Request may have at most ${MAX_ATTACHMENTS_PER_REQUEST} completion images.`,
      },
    },
    // Sprint 4 (DOC-59) - "Manager Request Administration". Populated only
    // by the dedicated Manager-cancellation endpoint (PATCH
    // /api/requests/:id/manager/cancel) - Employee's own pre-existing
    // cancel action (DOC-46, PATCH /api/requests/:id/cancel) is completely
    // unchanged and never touches these three fields, so every Request
    // cancelled before this task, or cancelled by its own Employee, simply
    // has them at their default null. `cancelledBy` deliberately stores
    // the Manager's User `_id` only, never a denormalized name/email -
    // resolved for display the same way `assignedOperatorId` already is,
    // via a scoped lookup in the controller.
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      default: null,
      maxlength: [500, 'Cancellation reason must be at most 500 characters.'],
    },
    // DOC-55 - "Request SLA and Due Dates". See utils/slaPolicy.js for the
    // full policy/calculation writeup - this schema only stores the
    // result.
    //
    // COMPATIBILITY POLICY (documented choice, task spec's own
    // recommended option): `slaDueAt`/`slaPolicyHours` are `required` for
    // every NEW Request from this task onward (createRequest always
    // computes and sets both - see request.controller.js), but Mongoose's
    // `required` validator only runs when a document is actually SAVED,
    // never retroactively against documents already persisted before this
    // field existed. Every Request created before DOC-55 therefore simply
    // has no `slaDueAt`/`slaPolicyHours` at all (`undefined`, not `null`)
    // and remains perfectly readable - it is never rejected, migrated, or
    // patched automatically. `sanitizeRequest`'s `sla` field reports a
    // safe `null` ("SLA not available") for exactly this case (see
    // computeSlaSummary), until the optional one-time migration script
    // (scripts/migrateRequestSla.js) is deliberately run against it.
    slaDueAt: {
      type: Date,
      required: true,
    },
    // Reserved for a LATER scheduled-job/notification task (task spec:
    // "Do not add background schedulers" here) - this version never
    // writes to this field at all; `isOverdue`/`overdueByMinutes` are
    // instead computed dynamically on every read (see
    // utils/slaPolicy.js's own documented decision). Kept on the schema
    // now so that future task does not need its own schema migration.
    slaBreachedAt: {
      type: Date,
      default: null,
    },
    slaPolicyHours: {
      type: Number,
      required: true,
    },
    // Set once, the first time status becomes 'resolved' (any path) -
    // cleared back to null if a Manager/Employee later reopens the
    // Request (resolved -> reopened), and never re-set by anything other
    // than a fresh in_progress -> resolved transition. See
    // updateRequestStatus's own comment in request.controller.js for the
    // exact rules.
    resolvedAt: {
      type: Date,
      default: null,
    },
    // Set once, the first time status becomes 'closed' (either the
    // generic status endpoint or the dedicated Manager close endpoint) -
    // 'closed' is terminal (DOC-12/DOC-59), so this is never cleared once
    // set.
    closedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// categoryId is indexed for later Manager/Operator filtering by Category
// (e.g. "show me all open Electricity requests") - not needed by DOC-10
// itself, which only ever writes one Request at a time, but cheap to add
// now and avoids a later migration.
requestSchema.index({ categoryId: 1 });

module.exports = mongoose.model('Request', requestSchema);
module.exports.PRIORITY_VALUES = PRIORITY_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;
module.exports.ATTACHMENT_MIME_TYPES = ATTACHMENT_MIME_TYPES;
module.exports.MAX_ATTACHMENTS_PER_REQUEST = MAX_ATTACHMENTS_PER_REQUEST;
module.exports.MAX_ATTACHMENT_SIZE_BYTES = MAX_ATTACHMENT_SIZE_BYTES;
