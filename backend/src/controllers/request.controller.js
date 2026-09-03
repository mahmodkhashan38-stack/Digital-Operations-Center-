const mongoose = require('mongoose');
const Request = require('../models/Request');
const ServiceCategory = require('../models/ServiceCategory');
const User = require('../models/User');
const { canTransitionRequestStatus } = require('../utils/requestStatusTransitions');
const {
  validateTitle, validateDescription, validatePriority, validateCancelReason, validateAssignmentReason,
} = require('../utils/requestFieldValidation');
const { cleanupUploadedFiles } = require('../middleware/upload');
const requestImageStorage = require('../services/requestImageStorage');
const { recordRequestActivity } = require('../services/requestActivity.service');
const RequestActivity = require('../models/RequestActivity');
const { createRequestNotification } = require('../services/notification.service');
const { buildRequestQuery, sortRequestDocs, buildCreatedAtRangeFilter } = require('../utils/requestQueryBuilder');
const { computeRequestStatistics, computeOperatorWorkload, computeSlaStatistics } = require('../utils/requestStatistics');
const { findDuplicateRequests } = require('../utils/duplicateRequestDetection');
const {
  SLA_HOURS_BY_PRIORITY, calculateSlaDueAt, computeSlaSummary, classifyExportSlaStatus,
} = require('../utils/slaPolicy');
// DOC-67 - "Request Reports & CSV Export". The one place CSV
// escaping/formula-injection protection is implemented - see
// utils/csvExport.js's own header comment for the full rationale.
const { buildCsv } = require('../utils/csvExport');
// DOC-16 - "Request Number / Human-Friendly ID". The sole entry point for
// atomically allocating a new `REQ-000001`-style identifier at creation
// time - see services/requestNumber.service.js's own comment for the full
// concurrency/format rationale. Never read/written anywhere else in this
// controller.
const { getNextRequestNumber } = require('../services/requestNumber.service');
// DOC-68 - "Employee Satisfaction Rating". Only the statistics helpers are
// needed here - the create/read rating endpoints themselves live in their
// own dedicated controllers/requestRating.controller.js (task spec's own
// audit question 6 decided a separate model/controller is cleaner; the
// Manager satisfaction NUMBERS are the one thing added to this existing
// statistics endpoint, mirroring how DOC-55's `sla` block was added here).
const { computeSatisfactionStatistics, computeOperatorRatingBreakdown } = require('../utils/requestRatingStatistics');
const RequestRating = require('../models/RequestRating');

// DOC-10 - Create a New Request. DOC-11 - View Request Details and
// Status (Employee's own Requests only). DOC-12 - Update Request
// Information and Status (the controlled status workflow). DOC-46 -
// Edit/Cancel Own Request. DOC-45 - Image Attachments. DOC-52 - Complete
// Operator Request Workflow (Manager assignment + Manager/Operator
// Request listing).
// -----------------------------------------------------------------
// This controller implements creation (DOC-10, now multipart-capable),
// Employee-scoped read access (DOC-11), status transitions (DOC-12),
// Employee edit/cancel of their own Request (DOC-46), Employee add/remove
// of image attachments on their own Request (DOC-45), and now (DOC-52)
// Manager assignment of a Request to an Operator plus the two listing
// endpoints that make the rest of the workflow reachable: the Manager's
// whole-Organization Request list and the Operator's own assigned-only
// list. Comments live in their own comment.controller.js (DOC-13) and are
// unchanged - Manager/Operator comment access was already implemented
// there, it was just unreachable until this task.

const PRIORITY_VALUES = Request.PRIORITY_VALUES;
const STATUS_VALUES = Request.STATUS_VALUES;
const MAX_ATTACHMENTS_PER_REQUEST = Request.MAX_ATTACHMENTS_PER_REQUEST;
const MAX_ORIGINAL_NAME_LENGTH = 255;

// Strips a Request document down to a safe, stable response shape shared
// by create/list/detail. `category` and `assignedOperator` are populated
// from documents already resolved by the caller (never a second query per
// Request - see the batched lookups in listMyRequests below) - never
// normalizedName/organizationId of the Category, never a raw User
// document. `organizationId`/`createdBy` are deliberately omitted: the
// frontend never needs them (it's always "my own Organization" / "me"),
// and DOC-11 explicitly calls out not exposing organizationId
// unnecessarily.
//
// `category` may be null only in the defensive/should-never-happen case
// where a Category document could not be resolved (Categories are never
// hard-deleted, DOC-43) - this never throws, it just reports null rather
// than crashing the response.
// DOC-45 - `attachments` is mapped from `request.attachments` (already on
// the document, no extra lookup needed) into the safe shape the frontend
// needs: `id`/`originalName`/`mimeType`/`size`/`url`/`uploadedAt`.
// `storedName` is deliberately never included - it is an internal
// filesystem detail the frontend has no use for (task spec section 11).
// `(request.attachments || [])` defensively handles a pre-DOC-45 mocked/
// legacy document that has no `attachments` field at all.
//
// DOC-52 - `createdByUser` is a new, OPTIONAL fifth parameter. Every
// existing caller (listMyRequests, getMyRequestById, createRequest,
// updateRequestStatus, updateMyRequest, cancelMyRequest,
// addRequestAttachments, removeRequestAttachment) keeps calling this with
// only four arguments, so `createdByUser` is always `undefined` for them
// and the `employee` key below is simply never present in that JSON
// response (JSON.stringify drops `undefined`-valued keys) - none of those
// existing response shapes change in any way. Only the two new DOC-52
// listing endpoints (listOrganizationRequests for Manager,
// listAssignedRequests for Operator) ever pass a resolved creator
// User document, since only they need to show "which Employee opened
// this" (task spec sections 1 and 9). Never a raw User document - only
// `id`/`fullName`, the same minimal shape `assignedOperator` already uses.
//
// Sprint 4 (DOC-59) - `cancelledByUser` is a new, OPTIONAL sixth
// parameter, following the exact same "undefined for every existing
// caller, response shape unaffected" contract as `createdByUser` above.
// Only managerCancelRequest ever passes it (the one place a resolved
// canceller is freshly available with no extra query). `cancelledAt`/
// `cancelReason` are read directly off the document (no lookup needed)
// and are ALWAYS included, defaulting to `null` for every Request that
// was never Manager-cancelled - this is a cheap, harmless addition to
// every existing response shape (an extra `null`-valued key, never a
// breaking change).
// DOC-56 - `completionAttachments` is ALWAYS included (like `attachments`
// above, never conditional like `employee`/`cancelledBy`) - the frontend
// needs it in every response shape uniformly (Employee/Operator/Manager
// all view it). `uploadedBy` is resolved WITHOUT a separate query: DOC-59
// already locked `assignedOperatorId` from being changed once a Request
// leaves 'open' (managerUpdateRequest only allows reassignment while
// status === 'open'), and completion images can only ever be uploaded
// while status === 'in_progress' (DOC-56's own upload eligibility) - so
// for the entire lifetime a completionAttachments entry can exist, its
// `uploadedBy` is guaranteed to equal the Request's CURRENT
// assignedOperatorId, meaning the SAME `assignedOperator` document this
// function already receives can resolve every entry's display name. The
// `String(...) === String(...)` guard is defensive only (should always be
// true by the invariant above) - if it somehow does not hold, this falls
// back to the id alone with a generic label rather than crashing or
// silently mis-attributing the image to the wrong person.
// GRIDFS MIGRATION - the outward `url` for every attachment (Before AND
// Completion Images alike, legacy local-disk AND GridFS alike) is now
// ALWAYS computed dynamically here, pointing at the authenticated
// content-delivery endpoint (getRequestAttachmentContent above) - never
// the attachment's own stored `url` field (which legacy attachments
// still have, but which is no longer read for this purpose at all, and
// which new attachments do not even populate). This is what lets
// legacy and GridFS-backed attachments share one identical outward
// contract - the frontend never needs to know or care which storage
// backend produced a given image (task spec: "prefer url as the stable
// abstraction"). Root-relative, matching every other requestApi path
// (frontend prepends API_BASE_URL, which already includes `/api`).
const buildAttachmentContentUrl = (requestId, attachmentId) => `/requests/${requestId}/attachments/${attachmentId}/content`;

const sanitizeRequest = (request, category, assignedOperator, createdByUser, cancelledByUser) => ({
  id: request._id,
  // DOC-16 - human-facing identifier. `id` above (the raw ObjectId) is
  // deliberately still included and unchanged - the frontend still needs
  // it for API routing/internal behavior (task spec section 13) - this is
  // purely an ADDITION, never a replacement. `null` for a historical,
  // pre-DOC-16 Request that hasn't been migrated yet (the same documented
  // "not available yet" shape already used for `sla` below) - the
  // frontend is expected to fall back to showing the title in that case,
  // never a raw ObjectId (task spec section 14).
  requestNumber: request.requestNumber || null,
  title: request.title,
  description: request.description,
  category: category ? { id: category._id, name: category.name } : null,
  priority: request.priority,
  status: request.status,
  assignedOperator: assignedOperator ? { id: assignedOperator._id, fullName: assignedOperator.fullName } : null,
  employee: createdByUser ? { id: createdByUser._id, fullName: createdByUser.fullName } : undefined,
  attachments: (request.attachments || []).map((attachment) => ({
    id: attachment._id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    url: buildAttachmentContentUrl(request._id, attachment._id),
    uploadedAt: attachment.uploadedAt,
  })),
  completionAttachments: (request.completionAttachments || []).map((attachment) => ({
    id: attachment._id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    url: buildAttachmentContentUrl(request._id, attachment._id),
    uploadedAt: attachment.uploadedAt,
    uploadedBy: (assignedOperator && String(assignedOperator._id) === String(attachment.uploadedBy))
      ? { id: assignedOperator._id, fullName: assignedOperator.fullName }
      : { id: attachment.uploadedBy, fullName: 'Unknown Operator' },
  })),
  cancelledBy: cancelledByUser ? { id: cancelledByUser._id, fullName: cancelledByUser.fullName } : null,
  cancelledAt: request.cancelledAt || null,
  cancelReason: request.cancelReason || null,
  // DOC-55 - "Request SLA and Due Dates". `null` for a historical,
  // pre-DOC-55 Request with no `slaDueAt` at all (the documented "SLA not
  // available" safe shape - see utils/slaPolicy.js's own comment); never
  // trusts anything from the client, always computed fresh from server
  // time. Included on every response shape uniformly (like
  // `completionAttachments` above), never conditional on the caller's
  // role - every role is allowed to see a Request's own SLA data.
  sla: computeSlaSummary(request),
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

// DOC-16 (task spec section 15) - "DOC-18 notifications should now use
// requestNumber where appropriate, e.g. 'Request REQ-000123 was assigned to
// you.'" One small, shared helper (not fourteen separate inline
// conditionals) so every DOC-18 notification message below quotes a
// Request the exact same way. Prefers `Request REQ-000123` (no quotes -
// matches the task spec's own example verbatim) when a requestNumber is
// present; falls back to the pre-DOC-16 quoted-title shape (`"${title}"`)
// for a historical Request that has not been migrated yet (task spec:
// requestNumber is presentation metadata only - a Request missing one must
// still be describable). This ONLY affects notification message text -
// notification.service.js's own `requestId` field (used for navigation/
// authorization) is completely untouched, still always the internal
// ObjectId (task spec: "Do NOT replace requestId foreign-key behavior.").
function requestNotificationLabel(requestDoc) {
  return requestDoc.requestNumber ? `Request ${requestDoc.requestNumber}` : `"${requestDoc.title}"`;
}

// S3 MIGRATION - best-effort deletion of one or more newly-uploaded
// attachments' underlying storage objects, used ONLY as failure-path
// rollback (task spec: "If S3 upload succeeds but Request save fails,
// delete the newly-created S3 object. No orphans." - the same rule this
// controller already applied to GridFS, now generalized across all three
// backends via requestImageStorage.deleteImage). Never touches any
// attachment other than the exact ones passed in - a previously-existing,
// already-saved attachment on this or any other Request is never in this
// list, so this can never delete anything but what THIS failed operation
// itself just created. Errors are logged, never thrown - a cleanup
// failure must never mask the original error that triggered it. Accepts
// full attachment objects (not just ids) because which storage backend
// each one used is determined by requestImageStorage.deleteImage from the
// attachment's own objectKey/fileId/storedName - a bare id alone would
// not be enough to know which backend to delete from.
async function cleanupNewlyUploadedAttachments(attachments) {
  await Promise.all((attachments || []).filter(Boolean).map((attachment) => requestImageStorage.deleteImage(attachment)));
}

// S3 MIGRATION - deletes a single attachment's underlying stored bytes.
// Delegates entirely to requestImageStorage.deleteImage, which branches on
// whichever storage reference the attachment actually has - `objectKey`
// (S3, every new attachment while IMAGE_STORAGE_PROVIDER=s3), `fileId`
// (GridFS, every new attachment before this task, or while
// IMAGE_STORAGE_PROVIDER=gridfs), or `storedName` (legacy local disk,
// pre-GridFS-migration attachments only). Always called with an
// attachment subdocument that was ALREADY found on the AUTHORIZED
// Request's own `attachments`/`completionAttachments` array
// (removeRequestAttachment/removeCompletionImage below) - never with a
// client-supplied objectKey/fileId/storedName directly, so this can never
// be used to delete storage belonging to a different Request.
async function deleteAttachmentStorage(attachment) {
  await requestImageStorage.deleteImage(attachment);
}

// Uploads each file's buffer (Multer memoryStorage's `req.files` - never
// a filesystem path, never base64) to the "requestImages" GridFS bucket
// and builds trusted attachment metadata referencing the new `fileId` -
// never from anything in `req.body` (task spec section 7: "Do not
// accept attachment metadata directly from req.body. The server
// generates trusted metadata."). `originalName` is truncated defensively
// (schema caps it at 255 characters) but is otherwise only ever used for
// display - it never touches the filesystem or GridFS storage
// identifier. `_id` is generated explicitly here (rather than relying on
// Mongoose's own subdocument auto-_id behavior) so
// `removeRequestAttachment`'s find-by-id lookup is deterministic and
// independent of the underlying persistence layer.
//
// GridFS file metadata (`organizationId`/`requestId`/`attachmentType`/
// `uploadedBy`) is always the trusted server-side context passed in by
// the caller - never read from req.body (task spec: "always derived
// server-side, never trusted from frontend").
//
// FAILURE CLEANUP: if any file in a multi-file batch fails to upload,
// every file THIS call already uploaded successfully is deleted before
// the error propagates - never left orphaned, and this never touches
// any attachment from a different, already-completed call (task spec's
// failure-cleanup section: "If multiple files uploaded and one fails,
// clean up only the newly-created GridFS files from THAT failed
// operation").
async function buildAttachmentMetadata(files, { organizationId, requestId, uploadedBy }) {
  const built = [];
  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const file of (files || [])) {
      const originalName = file.originalname.slice(0, MAX_ORIGINAL_NAME_LENGTH);
      // eslint-disable-next-line no-await-in-loop
      const storageReference = await requestImageStorage.uploadImage(file.buffer, {
        organizationId,
        requestId,
        attachmentType: 'before',
        mimeType: file.mimetype,
        originalName,
        uploadedBy,
      });
      built.push({
        _id: new mongoose.Types.ObjectId(),
        originalName,
        ...storageReference,
        mimeType: file.mimetype,
        size: file.size,
      });
    }
    return built;
  } catch (error) {
    await cleanupNewlyUploadedAttachments(built);
    throw error;
  }
}

// DOC-56 - identical shape/behavior to buildAttachmentMetadata above
// (including its own GridFS failure-cleanup), PLUS `uploadedBy` on each
// returned attachment - always the calling Operator's own
// `req.user.userId` (task spec: "uploadedBy must always equal the
// assigned Operator"), never anything read from req.body
// (protected-field-injection is structurally impossible here - this
// function does not accept a body at all, only `files` and the trusted
// server-side `organizationId`/`requestId`/`uploadedByUserId`).
async function buildCompletionAttachmentMetadata(files, { organizationId, requestId, uploadedByUserId }) {
  const built = [];
  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const file of (files || [])) {
      const originalName = file.originalname.slice(0, MAX_ORIGINAL_NAME_LENGTH);
      // eslint-disable-next-line no-await-in-loop
      const storageReference = await requestImageStorage.uploadImage(file.buffer, {
        organizationId,
        requestId,
        attachmentType: 'completion',
        mimeType: file.mimetype,
        originalName,
        uploadedBy: uploadedByUserId,
      });
      built.push({
        _id: new mongoose.Types.ObjectId(),
        originalName,
        ...storageReference,
        mimeType: file.mimetype,
        size: file.size,
        uploadedBy: uploadedByUserId,
      });
    }
    return built;
  } catch (error) {
    await cleanupNewlyUploadedAttachments(built);
    throw error;
  }
}

// POST /api/requests (employee only)
//
// Now multipart/form-data-capable (DOC-45) - `middleware/upload.js`'s
// `handleUpload(upload.array('attachments', ...))` runs BEFORE this
// handler (see routes/request.routes.js) and populates `req.files` with
// any uploaded images; Multer also puts every text field onto `req.body`
// as a plain string, so the four text fields below are read exactly the
// same way whether the request was JSON (no images) or multipart (with
// images) - creating a Request with zero images still works unchanged.
//
// Reads exactly four TEXT fields from the request body: title,
// description, categoryId, priority - plus the `attachments` FILE field.
// Everything else that determines WHO owns this Request and WHAT its
// initial state is comes from req.user or a server-side constant - never
// from req.body. A payload like { "title": "...", "organizationId":
// "OTHER_ORG", "createdBy": "OTHER_USER", "assignedOperatorId":
// "ATTACKER", "status": "closed" } still only ever produces a Request
// owned by the authenticated Employee's own Organization, with status
// 'open' and no assigned Operator - the extra fields are simply never
// read (explicit allowlist construction, not req.body spread - see the
// object passed to Request.create below).
//
// If ANY validation fails after Multer has already written files to disk
// (invalid title/description/priority/Category), or if Request.create()
// itself fails, every newly uploaded file for THIS request is deleted
// before responding - never left orphaned (task spec section 9).
// `rejectWithCleanup` is the one choke point that guarantees this for
// every early-return path below.
function rejectWithCleanup(req, res, statusCode, message) {
  cleanupUploadedFiles(req.files);
  return res.status(statusCode).json({ status: 'error', message });
}

// DOC-18 - "In-App Notifications". Resolves the single active Manager of
// an Organization, used ONLY by the two call sites below that notify "the
// Manager" of an organization-level event (Request reopened). Mirrors the
// same `{organizationId, role: 'manager'}` shape organization.controller.js
// already uses to resolve a Manager from an Organization's own
// `managerId` - here queried directly by `organizationId` instead (every
// User document, Manager included, already carries its own
// `organizationId` - DOC-32/34's own creation flow sets it), which avoids
// this controller needing to import the Organization model just for this.
// Returns `null` (never throws) for an Organization with no active Manager
// yet - a real, normal state (DOC-32: an Organization can exist before a
// Manager is assigned) - callers simply skip the Manager notification in
// that case, exactly like every other "recipient could not be resolved"
// case in this file.
async function findOrganizationManager(organizationId) {
  return User.findOne({ organizationId, role: 'manager', isActive: true });
}

const createRequest = async (req, res, next) => {
  try {
    const body = req.body || {};

    const titleError = validateTitle(body.title);
    if (titleError) {
      return rejectWithCleanup(req, res, 400, titleError);
    }

    const descriptionError = validateDescription(body.description);
    if (descriptionError) {
      return rejectWithCleanup(req, res, 400, descriptionError);
    }

    if (typeof body.categoryId !== 'string' || !mongoose.Types.ObjectId.isValid(body.categoryId)) {
      return rejectWithCleanup(req, res, 400, 'A valid service category is required.');
    }

    let priority = 'medium';
    if (Object.prototype.hasOwnProperty.call(body, 'priority') && body.priority !== undefined) {
      if (!PRIORITY_VALUES.includes(body.priority)) {
        return rejectWithCleanup(req, res, 400, `priority must be one of: ${PRIORITY_VALUES.join(', ')}.`);
      }
      priority = body.priority;
    }

    // Scoped, active-only lookup - not findById() + a manual comparison
    // afterward. A categoryId that belongs to another Organization, is
    // currently inactive, or does not exist at all are all
    // indistinguishable via this single query result (DOC-38
    // anti-enumeration convention) - the response below never reveals
    // which of those three actually happened.
    const category = await ServiceCategory.findOne({
      _id: body.categoryId,
      organizationId: req.user.organizationId,
      isActive: true,
    });

    if (!category) {
      return rejectWithCleanup(
        req,
        res,
        400,
        'The selected service category is unavailable. Please choose an active category from your organization.',
      );
    }

    // DOC-58 - "Duplicate Request Detection". Runs ONLY here (task spec:
    // "Only during: POST /api/requests. Never during edit.") - AFTER
    // every other validation above has already passed (task spec:
    // "Validation remains identical" - duplicate detection is a
    // completely separate, later concern, never a substitute for or
    // shortcut around title/description/category/priority validation),
    // and BEFORE Request.create() actually runs, so a detected duplicate
    // never creates anything.
    //
    // `forceCreate` is the ONE thing this endpoint reads that can skip a
    // check (task spec: "Only duplicate detection may be skipped.") -
    // read defensively as either a real boolean (a JSON request) or the
    // string `"true"` (multipart/form-data always sends text fields as
    // strings, and this endpoint is multipart-capable - DOC-45). Any
    // other value (including the string `"false"`, absent, or garbage)
    // leaves duplicate detection fully active - this can never be
    // accidentally bypassed by anything other than an explicit,
    // deliberate `forceCreate: true`/`"true"`.
    const forceCreate = body.forceCreate === true || body.forceCreate === 'true';

    if (!forceCreate) {
      // Scoped to this Employee's own Organization AND this exact
      // Category, active statuses only (open/in_progress/reopened) - see
      // utils/duplicateRequestDetection.js's own top comment for the full
      // scope/algorithm writeup.
      const duplicateMatches = await findDuplicateRequests({
        organizationId: req.user.organizationId,
        categoryId: category._id,
        title: body.title.trim(),
      });

      if (duplicateMatches.length > 0) {
        // Never rejects silently with an orphaned upload - any images
        // Multer already wrote to disk for this blocked attempt are
        // cleaned up exactly like every other rejection path above.
        cleanupUploadedFiles(req.files);

        // Reuses buildCreatorMap (below) rather than a second, separate
        // creator-lookup implementation - one batched query, not one per
        // duplicate candidate.
        const creatorMap = await buildCreatorMap(
          duplicateMatches.map((match) => match.request),
          req.user.organizationId,
        );

        // Task spec's exact example shape: id/title/status/createdAt/
        // createdBy.fullName - nothing else about the candidate Request
        // (never its description, attachments, or any other field) is
        // exposed here.
        const duplicates = duplicateMatches.map(({ request: candidate }) => ({
          id: candidate._id,
          // DOC-16 - shown alongside `id` so the frontend can display
          // "REQ-000123" for the candidate the same way it does everywhere
          // else a Request is shown to a user; `null` for a not-yet-
          // migrated historical candidate (see sanitizeRequest's own
          // comment).
          requestNumber: candidate.requestNumber || null,
          title: candidate.title,
          status: candidate.status,
          createdAt: candidate.createdAt,
          createdBy: {
            fullName: creatorMap.get(String(candidate.createdBy))?.fullName || 'Unknown User',
          },
        }));

        // DOC-58 "Option A" (recommended, and the one implemented here):
        // 409 Conflict - this Request is NOT created. The frontend is
        // the one that decides what happens next (task spec: "The
        // frontend decides.") - shows the candidate(s), and only THIS
        // exact same request, resubmitted with `forceCreate: true`, can
        // actually create it.
        return res.status(409).json({
          status: 'error',
          message: 'A similar open request already exists in this category.',
          duplicateDetected: true,
          duplicates,
        });
      }
    }

    // DOC-55 - "Request SLA and Due Dates". The SLA clock starts at
    // creation (task spec) - `createdAt` is computed explicitly here
    // (rather than left to Mongoose's automatic timestamp) so the exact
    // same instant is used both as the document's own `createdAt` AND as
    // the base `calculateSlaDueAt` computes `slaDueAt` from - the two can
    // never silently disagree. `slaPolicyHours`/`slaDueAt` are never read
    // from `body` - the client cannot control either (task spec: "Client
    // must not control: slaDueAt, slaPolicyHours, slaBreachedAt,
    // resolvedAt, closedAt").
    const createdAt = new Date();
    const slaDueAt = calculateSlaDueAt({ priority, createdAt });

    // GRIDFS MIGRATION - the Request's own _id is generated up front
    // (rather than left to Mongoose's default) so it can be included in
    // each uploaded file's GridFS metadata (`requestId`) even though the
    // Request document itself does not exist yet at upload time. This is
    // the ONLY reason this id is pre-generated - Request.create below is
    // told to use this exact _id via an explicit `_id` field, so the
    // final document's id is unaffected either way.
    const requestId = new mongoose.Types.ObjectId();

    // Uploads run AFTER every validation/duplicate-detection check above
    // has already passed - deliberately deferred this late (vs. the
    // legacy disk-storage flow, where Multer had already written files
    // before the controller even started) so a validation failure or a
    // detected duplicate above never touches GridFS at all, and needs no
    // cleanup. `attachments` comes exclusively from Multer's
    // memoryStorage `req.files` (buildAttachmentMetadata) - never from
    // req.body.
    let attachments;
    try {
      attachments = await buildAttachmentMetadata(req.files, {
        organizationId: req.user.organizationId,
        requestId,
        uploadedBy: req.user.userId,
      });
    } catch (error) {
      return next(error);
    }

    // DOC-16 - "Request Number / Human-Friendly ID". Allocated AFTER every
    // validation/duplicate-detection check above has already passed (task
    // spec section 8: "Do not consume numbers unnecessarily before
    // validation") but BEFORE Request.create() - if this fails, no number
    // has been wasted on a Request that was never going to be created
    // anyway, and if Request.create() itself fails afterward, this
    // specific number is simply never reused (documented policy: sequence
    // gaps are acceptable, duplicates are not - see
    // requestNumber.service.js). Unlike DOC-17/DOC-18's best-effort
    // writes, a failure here MUST abort creation entirely (task spec
    // section 26) - a Request silently created without a requestNumber
    // would be a permanent data-integrity gap on a field this project's
    // schema also treats as unique.
    let requestNumber;
    try {
      requestNumber = await getNextRequestNumber();
    } catch (error) {
      // Matches the exact same rollback used in the Request.create()
      // failure handler just below - by this point attachments were
      // already uploaded to GridFS/S3 (memoryStorage, not local disk -
      // see the GRIDFS MIGRATION comment above), so the correct cleanup
      // is the storage-object rollback, not cleanupUploadedFiles (which
      // only ever applies to pre-upload Multer state).
      await cleanupNewlyUploadedAttachments(attachments);
      return next(error);
    }

    // Explicit server-side construction (GOOD pattern from the task spec) -
    // never `Request.create({ ...req.body })`. organizationId and
    // createdBy come exclusively from req.user (DOC-38's fresh per-request
    // context); status and assignedOperatorId are hardcoded to their
    // initial values and cannot be influenced by the request body at all,
    // regardless of what it contains. requestNumber is likewise never
    // read from `body` - the frontend cannot supply or influence it (task
    // spec section 3).
    let request;
    try {
      request = await Request.create({
        _id: requestId,
        requestNumber,
        title: body.title.trim(),
        description: body.description.trim(),
        categoryId: category._id,
        priority,
        status: 'open',
        organizationId: req.user.organizationId,
        createdBy: req.user.userId,
        assignedOperatorId: null,
        attachments,
        createdAt,
        slaDueAt,
        slaPolicyHours: SLA_HOURS_BY_PRIORITY[priority],
        slaBreachedAt: null,
        resolvedAt: null,
        closedAt: null,
      });
    } catch (error) {
      // Request.create() itself failed (e.g. a database error, or a
      // schema validator rejecting something not already caught above) -
      // every storage object just uploaded for this attempt (S3 or
      // GridFS) must not be left orphaned (task spec's rollback/failure-
      // handling section).
      await cleanupNewlyUploadedAttachments(attachments);
      if (error.name === 'ValidationError') {
        return res.status(400).json({ status: 'error', message: error.message });
      }
      // DOC-16 task spec section 26 - "If a generated requestNumber
      // collides unexpectedly, handle duplicate-key failure safely. Do
      // not expose raw MongoDB errors to frontend." A code-11000 error on
      // this specific unique index should never happen in practice (the
      // counter is atomic and monotonically increasing), but is handled
      // defensively rather than leaking a raw driver error message/stack
      // to the client.
      if (error.code === 11000 && error.keyPattern && error.keyPattern.requestNumber) {
        return res.status(500).json({
          status: 'error',
          message: 'Could not generate a unique request number. Please try again.',
        });
      }
      return next(error);
    }

    // DOC-17 - "Request Activity Timeline". Recorded AFTER Request.create()
    // has already succeeded (this service never blocks or rolls back the
    // primary business action - see requestActivity.service.js's own
    // documented failure strategy). metadata snapshots the initial
    // priority/category/status at creation time - never the full
    // description or any sensitive/heavy field (task spec section 11).
    await recordRequestActivity({
      request,
      actorId: req.user.userId,
      type: 'REQUEST_CREATED',
      metadata: {
        initialPriority: priority,
        initialCategoryId: category._id,
        initialCategoryName: category.name,
        initialStatus: 'open',
      },
    });

    // assignedOperatorId is always null at creation - no lookup needed.
    return res.status(201).json({ status: 'success', data: sanitizeRequest(request, category, null) });
  } catch (error) {
    return next(error);
  }
};

// Builds { categoryMap, operatorMap } for a batch of Request documents in
// at most two additional queries total - never one query per Request
// (N+1). Both lookups are scoped to req.user.organizationId as defense in
// depth, even though every categoryId/assignedOperatorId on a Request
// already belongs to that same Organization by construction (DOC-10's
// creation-time validation, and DOC-12's future assignment logic will need
// to preserve the same invariant).
//
// Categories are looked up WITHOUT an isActive filter - DOC-11 explicitly
// requires that a Request opened against a Category that has since been
// deactivated must still display that Category's historical name. Only
// NEW Request creation (DOC-10) restricts to active Categories.
async function buildRequestEnrichmentMaps(requestDocs, organizationId) {
  const categoryIds = new Set();
  const operatorIds = new Set();
  requestDocs.forEach((doc) => {
    if (doc.categoryId) categoryIds.add(String(doc.categoryId));
    if (doc.assignedOperatorId) operatorIds.add(String(doc.assignedOperatorId));
  });

  const [categories, operators] = await Promise.all([
    categoryIds.size > 0
      ? ServiceCategory.find({ _id: { $in: Array.from(categoryIds) }, organizationId })
      : Promise.resolve([]),
    operatorIds.size > 0
      ? User.find({ _id: { $in: Array.from(operatorIds) }, organizationId })
      : Promise.resolve([]),
  ]);

  return {
    categoryMap: new Map(categories.map((category) => [String(category._id), category])),
    operatorMap: new Map(operators.map((operator) => [String(operator._id), operator])),
  };
}

// DOC-54 - "Request Search, Filters and Sorting". Shared by all three list
// endpoints below (listMyRequests, listOrganizationRequests,
// listAssignedRequests) so none of them duplicate the "priority/status
// need an in-memory business-order sort, everything else can sort at the
// database level" branch. `query` has already been fully built and
// validated by buildRequestQuery (utils/requestQueryBuilder.js) by the
// time this runs - this function only executes it.
async function fetchSortedRequests(query, sortBy, sortOrder) {
  // DOC-55 - `slaDueAt` joins `priority`/`status` in the in-memory sort
  // branch - see requestQueryBuilder.js's own sortRequestDocs comment for
  // why (missing-field documents must always sort last, in either
  // direction, which a plain `.sort()` cannot express).
  if (sortBy === 'priority' || sortBy === 'status' || sortBy === 'slaDueAt') {
    const requestDocs = await Request.find(query);
    return sortRequestDocs(requestDocs, sortBy, sortOrder);
  }
  return Request.find(query).sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 });
}

// GET /api/requests (employee only)
//
// "My Requests" - returns ONLY this Employee's own Requests. Scoped by
// BOTH createdBy AND organizationId at the database query level (defense
// in depth - organizationId is redundant given createdBy alone already
// identifies a single User, but costs nothing and matches DOC-38's
// convention of never relying on a single field for a tenant boundary).
//
// DOC-54 - now also supports search (q), filters (status/priority/
// categoryId - createdBy/assignedOperatorId are Manager-only and simply
// never read for this role, see buildRequestQuery), a date range
// (createdFrom/createdTo), and sorting (sortBy/sortOrder, default
// createdAt desc - unchanged from DOC-11's original "newest first"
// default). `baseQuery` below is the one and only place this endpoint's
// trusted scope is established - buildRequestQuery only ever ADDS
// restrictions on top of it, per its own contract.
const listMyRequests = async (req, res, next) => {
  try {
    const baseQuery = { createdBy: req.user.userId, organizationId: req.user.organizationId };
    const {
      query, sortBy, sortOrder, error,
    } = await buildRequestQuery({
      baseQuery,
      queryParams: req.query,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const requestDocs = await fetchSortedRequests(query, sortBy, sortOrder);

    const { categoryMap, operatorMap } = await buildRequestEnrichmentMaps(requestDocs, req.user.organizationId);

    const data = requestDocs.map((doc) => sanitizeRequest(
      doc,
      categoryMap.get(String(doc.categoryId)) || null,
      doc.assignedOperatorId ? (operatorMap.get(String(doc.assignedOperatorId)) || null) : null,
    ));

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// GET /api/requests/:id (employee only)
//
// A single scoped query - not Request.findById(id) followed by an
// ownership check afterward. `{ _id, createdBy: req.user.userId,
// organizationId: req.user.organizationId }` makes "this Request does not
// exist", "this Request belongs to another Employee in the same
// Organization", and "this Request belongs to another Organization
// entirely" all collapse into the exact same 404 - this endpoint never
// reveals which of those three actually happened (DOC-38 anti-
// enumeration convention, the same shape every other Employee-facing
// scoped lookup in this project already uses).
const getMyRequestById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    const requestDoc = await Request.findOne({
      _id: id,
      createdBy: req.user.userId,
      organizationId: req.user.organizationId,
    });

    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    // Category lookup is NOT restricted to isActive - a since-deactivated
    // Category must still display its historical name on an existing
    // Request (see buildRequestEnrichmentMaps's own comment).
    const [category, assignedOperator] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      requestDoc.assignedOperatorId
        ? User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId })
        : Promise.resolve(null),
    ]);

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, assignedOperator) });
  } catch (error) {
    return next(error);
  }
};

// DOC-52 - Builds a Map of Request.createdBy (as a string) -> the
// resolved creator User document, in ONE batched query (never one query
// per Request) - the same N+1-avoiding shape buildRequestEnrichmentMaps
// already established for category/operator lookups. Scoped to
// `organizationId` exactly like every other lookup in this controller
// (DOC-38); every `createdBy` on a Request already belongs to that same
// Organization by construction, this is defense in depth, not the only
// isolation boundary. Used only by the two new listing endpoints below -
// listMyRequests/getMyRequestById never need this, since an Employee
// viewing their OWN Requests already knows who created them.
async function buildCreatorMap(requestDocs, organizationId) {
  const creatorIds = new Set(requestDocs.map((doc) => String(doc.createdBy)));
  if (creatorIds.size === 0) {
    return new Map();
  }
  const creators = await User.find({ _id: { $in: Array.from(creatorIds) }, organizationId });
  return new Map(creators.map((creator) => [String(creator._id), creator]));
}

// GET /api/requests/organization (manager only)
//
// DOC-52 - "Manager sees Organization Requests": every Request in the
// Manager's own Organization, regardless of who created it or who (if
// anyone) it is assigned to - unlike listMyRequests, this is NOT scoped
// by createdBy. Still always scoped by organizationId, never a global
// `Request.find({})` filtered client-side afterward (task spec section
// 17). Registered on a separate route (see routes/request.routes.js)
// ahead of this router's blanket Employee-only gate, since a Manager
// token would otherwise never reach it. Reuses the exact same
// sanitizeRequest shape every other Request response uses, with the new
// optional `employee` field populated this time (task spec section 1).
//
// DOC-54 - now also supports search/filter/date-range/sort, INCLUDING the
// two Manager-only filters (assignedOperatorId, with the special
// "unassigned" value, and createdBy) - buildRequestQuery only reads those
// two because `req.user.role === 'manager'` here.
const listOrganizationRequests = async (req, res, next) => {
  try {
    const baseQuery = { organizationId: req.user.organizationId };
    const {
      query, sortBy, sortOrder, error,
    } = await buildRequestQuery({
      baseQuery,
      queryParams: req.query,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const requestDocs = await fetchSortedRequests(query, sortBy, sortOrder);

    const [{ categoryMap, operatorMap }, creatorMap] = await Promise.all([
      buildRequestEnrichmentMaps(requestDocs, req.user.organizationId),
      buildCreatorMap(requestDocs, req.user.organizationId),
    ]);

    const data = requestDocs.map((doc) => sanitizeRequest(
      doc,
      categoryMap.get(String(doc.categoryId)) || null,
      doc.assignedOperatorId ? (operatorMap.get(String(doc.assignedOperatorId)) || null) : null,
      creatorMap.get(String(doc.createdBy)) || null,
    ));

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// GET /api/requests/organization/export (manager only)
//
// DOC-67 - "Request Reports & CSV Export". Manager-only CSV export of the
// EXACT SAME logical Request set `listOrganizationRequests` above would
// return for the same query string - this handler deliberately reuses
// `buildRequestQuery`/`fetchSortedRequests`/`buildRequestEnrichmentMaps`/
// `buildCreatorMap` (the identical helpers, called the identical way,
// with the identical `baseQuery = { organizationId: req.user.organizationId }`)
// rather than building any second, independent filter/query implementation
// (task spec section 4/23: "Do NOT implement a second independent filter
// system... The normal Manager list and exported CSV should return the
// same logical Request set given the same filters."). Authorization is
// the router's job (see routes/request.routes.js - the exact same
// requireRole('manager') + requireOrganizationMembership +
// requireActiveOrganization chain as listOrganizationRequests, registered
// as a distinct route so Employee/Operator/System Admin tokens never reach
// this function at all); `organizationId` is never read from the request
// body or query string here either - only from `req.user.organizationId`
// (the authenticated Manager's own, DB-verified Organization - DOC-38),
// exactly like every other Manager-scoped endpoint in this controller.
//
// EXPORT SIZE POLICY (task spec section 15, a documented, deliberate
// choice): `listOrganizationRequests` itself has no result-count ceiling
// today (consistent with this project's existing, documented "acceptable
// at this project's scale" precedent - see requestQueryBuilder.js's own
// header comment) - but an unbounded CSV export is a different risk
// profile (a single large response held fully in memory - see "STREAMING
// VS MEMORY" below). `MAX_EXPORT_ROWS` below is DELIBERATELY the
// documented safety ceiling: rather than silently truncating a report to
// the first N rows (which would look complete but quietly omit data - the
// task spec explicitly warns against exactly this: "report clearly rather
// than silently truncating if practical"), a matched-count that exceeds
// the ceiling is rejected up front, before any row is ever fetched or
// formatted, with a clear, actionable error message asking the Manager to
// narrow their filters - never a partial file.
const MAX_EXPORT_ROWS = 5000;

// Safe, deterministic per-cell fallbacks for the CSV export - never a raw
// MongoDB ObjectId as the primary visible value for any of these (task
// spec section 6/7/8/9), and never a crash if a referenced User/Category
// cannot be resolved (task spec: "Do not crash export."). Mirrors the
// exact same "historical, since-deleted/deactivated reference" tolerance
// `sanitizeRequest`/`buildRequestEnrichmentMaps` already have elsewhere in
// this controller - Categories/Users are never hard-deleted in this
// project, so an unresolved reference here is a defensive fallback for an
// edge case, not an expected everyday occurrence.
function exportRequestNumberCell(requestDoc) {
  return requestDoc.requestNumber || 'N/A';
}

function exportEmployeeNameCell(createdByUser) {
  if (!createdByUser) return 'Unknown User';
  return createdByUser.fullName || 'Unknown User';
}

function exportOperatorNameCell(requestDoc, assignedOperator) {
  if (!requestDoc.assignedOperatorId) return 'Unassigned';
  if (!assignedOperator) return 'Unknown User';
  return assignedOperator.fullName || 'Unknown User';
}

function exportCategoryNameCell(category) {
  if (!category) return 'Unknown Category';
  return category.name || 'Unknown Category';
}

// DOC-67 (task spec section 10) - ISO 8601 throughout, deliberately - a
// CSV is a machine-friendly export format first; the frontend/Manager may
// open it in Excel/Sheets, which both parse a `2026-08-16T14:25:00.000Z`
// string correctly on their own. No locale-specific or human-phrased
// formatting is ever applied here (that is a presentation choice this
// project already reserves for the frontend elsewhere, e.g.
// `toLocaleString()` in RequestActivityTimeline.jsx - never the backend).
// `null`/`undefined` becomes the same neutral `'N/A'` fallback text used
// for every other missing value in this export, never an empty Date or a
// crash.
function exportDateCell(value) {
  if (!value) return 'N/A';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toISOString();
}

const CSV_HEADERS = [
  'Request Number', 'Title', 'Employee', 'Operator', 'Category', 'Priority', 'Status',
  'Created At', 'Updated At', 'SLA Due At', 'SLA Status', 'Resolved At', 'Closed At',
  'Cancellation Reason',
  // DOC-68 - "Employee Satisfaction Rating" (task spec section 38 -
  // implemented, not deferred: reuses csvExport.js's own RFC4180/
  // formula-injection escaping unchanged, own Organization only, plain
  // text only - the exact same guarantees every other column here already
  // has). Empty string (never 'N/A') for an unrated Request, matching
  // this file's own existing "Cancellation Reason" convention for "nothing
  // to say" above.
  'Satisfaction Score', 'Satisfaction Comment',
];

// Builds one CSV row per Request, in the exact same column order as
// CSV_HEADERS above. Deliberately excludes anything the task spec calls
// out as out-of-scope for this report (section 6/26/27): no raw
// ObjectId as a primary identifier, no password/passwordHash/JWT, no
// organization internal id, no S3 objectKey/GridFS fileId/image binary,
// no Comments, no full RequestActivity history - this is a high-level
// Request report, not an attachment or audit-log export. "Cancellation
// Reason" is included because it is already visible to a Manager on every
// existing Request response (`sanitizeRequest`'s own `cancelReason`
// field, task spec section 6's own "only if currently visible to
// Manager" condition) - empty string (never 'N/A') for a Request that was
// never cancelled, matching this column's own natural "nothing to say"
// state rather than implying "unknown".
function buildExportRow(requestDoc, category, assignedOperator, createdByUser, rating) {
  return [
    exportRequestNumberCell(requestDoc),
    requestDoc.title,
    exportEmployeeNameCell(createdByUser),
    exportOperatorNameCell(requestDoc, assignedOperator),
    exportCategoryNameCell(category),
    requestDoc.priority,
    requestDoc.status,
    exportDateCell(requestDoc.createdAt),
    exportDateCell(requestDoc.updatedAt),
    exportDateCell(requestDoc.slaDueAt),
    classifyExportSlaStatus(requestDoc),
    exportDateCell(requestDoc.resolvedAt),
    exportDateCell(requestDoc.closedAt),
    requestDoc.cancelReason || '',
    rating ? String(rating.score) : '',
    rating && rating.comment ? rating.comment : '',
  ];
}

// STREAMING VS MEMORY (task spec section 16, a documented, deliberate
// choice): this project's expected scale (a university graduation project,
// not a production multi-tenant SaaS) plus the MAX_EXPORT_ROWS ceiling
// above together bound this endpoint's worst case to a few thousand short
// text rows - comfortably small enough to build as one in-memory string
// and send in a single response, exactly like every other JSON list
// endpoint in this controller already does (listOrganizationRequests
// itself has no streaming infrastructure either). A dedicated CSV
// streaming pipeline (chunked transfer-encoding, a Node Transform stream,
// etc.) was deliberately NOT introduced - it would be meaningfully more
// implementation/testing surface for a project at this scale, matching
// this project's own established "keep it simple" precedent (see
// requestQueryBuilder.js's own header comment on avoiding an aggregation
// pipeline for the same reason). No temporary file is ever written to
// disk - the CSV is generated as a string in memory and sent directly as
// the HTTP response body (task spec section 40: "Prefer direct CSV
// response rather than creating server-side permanent files.").
const exportOrganizationRequestsCsv = async (req, res, next) => {
  try {
    const baseQuery = { organizationId: req.user.organizationId };
    const {
      query, sortBy, sortOrder, error,
    } = await buildRequestQuery({
      baseQuery,
      queryParams: req.query,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const totalMatched = await Request.countDocuments(query);
    if (totalMatched > MAX_EXPORT_ROWS) {
      return res.status(400).json({
        status: 'error',
        message: `Too many requests match the current filters (${totalMatched}). Please narrow your filters - CSV export supports at most ${MAX_EXPORT_ROWS} requests at a time.`,
      });
    }

    // DOC-67 (task spec section 21, a documented, deliberate choice): a
    // filter combination that matches zero Requests still produces a
    // valid, headers-only CSV (HTTP 200), never a 404/empty-body response.
    // This is the cleaner of the two options the task spec itself offers
    // for a reporting endpoint - a Manager who exports an intentionally
    // narrow (or genuinely empty) filter combination gets a real,
    // openable CSV file with the correct column headers and zero data
    // rows, rather than an error to interpret or an empty file with no
    // indication of what columns they would have gotten.
    const requestDocs = totalMatched === 0 ? [] : await fetchSortedRequests(query, sortBy, sortOrder);

    const [{ categoryMap, operatorMap }, creatorMap, ratings] = await Promise.all([
      buildRequestEnrichmentMaps(requestDocs, req.user.organizationId),
      buildCreatorMap(requestDocs, req.user.organizationId),
      // DOC-68 - one batched fetch, own Organization only, never one
      // query per row (N+1) - the same discipline every other enrichment
      // map on this endpoint already follows.
      requestDocs.length > 0
        ? RequestRating.find({ requestId: { $in: requestDocs.map((doc) => doc._id) }, organizationId: req.user.organizationId })
        : [],
    ]);
    const ratingMap = new Map(ratings.map((rating) => [String(rating.requestId), rating]));

    const rows = requestDocs.map((doc) => buildExportRow(
      doc,
      categoryMap.get(String(doc.categoryId)) || null,
      doc.assignedOperatorId ? (operatorMap.get(String(doc.assignedOperatorId)) || null) : null,
      creatorMap.get(String(doc.createdBy)) || null,
      ratingMap.get(String(doc._id)) || null,
    ));

    const csvBody = buildCsv(CSV_HEADERS, rows);

    // UTF-8 / HEBREW-ARABIC SUPPORT (task spec section 14): a leading
    // UTF-8 BOM ('\uFEFF') is prepended so Microsoft Excel - which does
    // NOT reliably auto-detect a BOM-less UTF-8 CSV and will otherwise
    // often mis-render non-ASCII text (Hebrew/Arabic full names, Category
    // names, reassignment reasons, etc.) - opens this file correctly.
    // Every other modern CSV consumer (Google Sheets, LibreOffice, a
    // second read by this same project) tolerates a leading BOM without
    // issue, so this is a strict compatibility improvement, never a
    // regression for a non-Excel consumer. Written as the explicit
    // `'\uFEFF'` escape (not a literal pasted character) so this file's
    // own on-disk encoding can never accidentally corrupt or drop it.
    const csvWithBom = `\uFEFF${csvBody}`;

    // Safe, non-user-controlled filename (task spec section 5: "Use a
    // safe filename.") - built entirely from the server's own current UTC
    // date, never from any request input (title, filters, Manager name,
    // etc.), so there is no path-traversal or header-injection surface
    // here at all.
    const dateStamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="requests-${dateStamp}.csv"`);
    return res.status(200).send(csvWithBom);
  } catch (error) {
    return next(error);
  }
};

// GET /api/requests/assigned (operator only)
//
// DOC-52 - "Operator sees only assigned Requests": scoped by BOTH
// `assignedOperatorId: req.user.userId` AND `organizationId` at the
// database query level (task spec sections 8/16/17) - never a broader
// list filtered client-side. An Operator with nothing currently assigned
// simply gets an empty array, exactly like an Employee with no Requests
// yet. Registered ahead of this router's blanket Employee-only gate, same
// reason as listOrganizationRequests above. Reuses sanitizeRequest with
// the `employee` field populated too (task spec section 9: Operator must
// see which Employee opened the Request).
//
// DOC-54 - now also supports search/filter/date-range/sort - but NEVER
// assignedOperatorId or createdBy (buildRequestQuery only reads those two
// when `role === 'manager'`), so an Operator can never widen this list
// beyond their own assigned Requests via the query string, and can never
// filter by a specific creator either.
const listAssignedRequests = async (req, res, next) => {
  try {
    const baseQuery = { assignedOperatorId: req.user.userId, organizationId: req.user.organizationId };
    const {
      query, sortBy, sortOrder, error,
    } = await buildRequestQuery({
      baseQuery,
      queryParams: req.query,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const requestDocs = await fetchSortedRequests(query, sortBy, sortOrder);

    const [{ categoryMap, operatorMap }, creatorMap] = await Promise.all([
      buildRequestEnrichmentMaps(requestDocs, req.user.organizationId),
      buildCreatorMap(requestDocs, req.user.organizationId),
    ]);

    const data = requestDocs.map((doc) => sanitizeRequest(
      doc,
      categoryMap.get(String(doc.categoryId)) || null,
      operatorMap.get(String(doc.assignedOperatorId)) || null,
      creatorMap.get(String(doc.createdBy)) || null,
    ));

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/requests/:id/status (employee, operator, or manager - NOT
// system_admin)
//
// DOC-12 - the one dedicated endpoint for changing a Request's status.
// Deliberately NOT combined with a generic "edit Request" endpoint (none
// exists - DOC-46 owns Employee edit, and this task does not build one
// either) so workflow security stays explicit and auditable in one place.
//
// Unlike DOC-10/11 (Employee-only routers), this endpoint is reachable by
// three different roles with three different, role-specific rulesets -
// see routes/request.routes.js for why this route is registered BEFORE
// the blanket requireRole('employee') gate, with its own smaller chain
// (verifyToken, requireOrganizationMembership, requireActiveOrganization,
// no requireRole). All role-specific authorization happens here, via the
// single shared canTransitionRequestStatus helper - never scattered
// inline role checks.
const updateRequestStatus = async (req, res, next) => {
  try {
    // organizationScope.js's requireOrganizationMembership/
    // requireActiveOrganization both deliberately bypass system_admin
    // (it is a global, non-organization-scoped role, DOC-31/38) - so a
    // system_admin token WOULD otherwise reach this far. System Admin
    // manages the platform, not day-to-day Organization workflow (DOC-12
    // section 8), so this is rejected explicitly here, not just left to
    // canTransitionRequestStatus returning false.
    if (req.user.role === 'system_admin') {
      return res.status(403).json({
        status: 'error',
        message: 'System Admin cannot manage Request status.',
      });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    const body = req.body || {};
    if (typeof body.status !== 'string') {
      return res.status(400).json({ status: 'error', message: 'status is required and must be a string.' });
    }
    if (!STATUS_VALUES.includes(body.status)) {
      return res.status(400).json({
        status: 'error',
        message: `status must be one of: ${STATUS_VALUES.join(', ')}.`,
      });
    }
    const nextStatus = body.status;

    // Scoped by Organization FIRST, exactly like every other org-scoped
    // lookup in this project (DOC-38) - never Request.findById(id)
    // followed by a manual organizationId comparison. A Request that does
    // not exist and one that belongs to another Organization are both
    // indistinguishable via this single query result (anti-enumeration) -
    // this is what makes Manager A -> Organization B's Request, and any
    // cross-org attempt from any role, collapse into the same 404.
    //
    // Ownership fields (assignedOperatorId/createdBy) are read from THIS
    // freshly-fetched document only - never from req.body. A payload like
    // { "status": "closed", "assignedOperatorId": "...", "organizationId":
    // "...", "createdBy": "..." } has zero effect on anything except
    // `status`, and only if the transition below is actually authorized.
    const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });

    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    if (requestDoc.status === nextStatus) {
      return res.status(400).json({
        status: 'error',
        message: `Request is already '${nextStatus}'.`,
      });
    }

    const isCreator = String(requestDoc.createdBy) === String(req.user.userId);
    // Being relevant to this Request's Category via Operator specialties
    // (DOC-44) is NEVER checked here and never sufficient - only actual
    // assignment (assignedOperatorId matching the caller's own id, read
    // from the DB document above, never from req.body) counts. There is
    // currently no legitimate flow that ever sets assignedOperatorId to a
    // real Operator (no Manager-assignment endpoint exists yet - see the
    // model/controller's own top comments) - this check is structurally
    // correct and ready for that future task, but is unreachable in
    // today's data until that assignment flow exists.
    const isAssignedOperator = !!requestDoc.assignedOperatorId
      && String(requestDoc.assignedOperatorId) === String(req.user.userId);

    const authorized = canTransitionRequestStatus({
      role: req.user.role,
      currentStatus: requestDoc.status,
      nextStatus,
      isCreator,
      isAssignedOperator,
    });

    if (!authorized) {
      return res.status(403).json({
        status: 'error',
        message: 'You are not authorized to perform this status change.',
      });
    }

    // DOC-56 - "Operator should not be able to resolve a Request unless
    // completionAttachments.length > 0." Gated simply on
    // `nextStatus === 'resolved'`, with no additional role check needed:
    // OPERATOR_TRANSITIONS (utils/requestStatusTransitions.js) is the ONLY
    // map in this project that ever lists 'resolved' as a reachable
    // target (in_progress -> resolved), so `authorized === true` with
    // `nextStatus === 'resolved'` already guarantees this branch is only
    // ever reached by the Request's own assigned Operator. A 409 Conflict
    // - the caller IS authorized to resolve this Request in general, it
    // just cannot happen yet (the same "right person, wrong resource
    // state" shape DOC-46's updateMyRequest/cancelMyRequest already use).
    if (nextStatus === 'resolved' && requestDoc.completionAttachments.length === 0) {
      return res.status(409).json({
        status: 'error',
        message: 'At least one completion image is required before this request can be resolved.',
      });
    }

    // DOC-55 - "Request SLA and Due Dates" status-transition side effects.
    // Captured before overwriting `status` below so both branches can
    // still tell what the Request was transitioning FROM.
    const previousStatus = requestDoc.status;
    requestDoc.status = nextStatus;

    // "When Request becomes resolved: set resolvedAt to server time if
    // not already set" - the "if not already set" guard is defensive only
    // (the only path that ever reaches 'resolved' is in_progress ->
    // resolved, which by definition means resolvedAt was null going in),
    // but costs nothing and protects against ever silently overwriting a
    // real historical timestamp.
    if (nextStatus === 'resolved' && !requestDoc.resolvedAt) {
      requestDoc.resolvedAt = new Date();
    }
    // "When resolved -> reopened: clear resolvedAt; the original SLA
    // deadline remains unchanged; if current time is already past
    // slaDueAt, the Request becomes overdue immediately." Only
    // `resolvedAt` is touched here - `slaDueAt`/`slaPolicyHours` are never
    // recalculated by a status change, and `isOverdue` recomputes itself
    // automatically the moment `status` becomes 'reopened' again (an
    // ACTIVE_SLA_STATUSES member - see utils/slaPolicy.js), with zero
    // extra code needed here.
    if (previousStatus === 'resolved' && nextStatus === 'reopened') {
      requestDoc.resolvedAt = null;
    }
    // "When Request becomes closed: set closedAt to server time; preserve
    // resolvedAt if it exists." resolvedAt is simply never touched in this
    // branch, so it is preserved automatically.
    if (nextStatus === 'closed' && !requestDoc.closedAt) {
      requestDoc.closedAt = new Date();
    }

    await requestDoc.save();

    // DOC-17 - one meaningful timeline event per status-changing action,
    // never two for the same transition (task spec section 18: "avoid
    // duplicate timeline entries... prefer one meaningful event per user
    // action"). 'closed' and 'reopened' are meaningful enough business
    // milestones to get their own specialized type (matching
    // managerCloseRequest's own REQUEST_CLOSED below, and the fact that
    // this is the ONLY code path that can ever reach 'reopened' at all -
    // there is no separate dedicated reopen endpoint); every other
    // transition (open->in_progress, in_progress->resolved,
    // reopened->in_progress) records the generic STATUS_CHANGED.
    // 'cancelled' can never be reached through this endpoint at all (see
    // canTransitionRequestStatus's own top comment), so it is never a
    // possible `nextStatus` here.
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: nextStatus === 'closed' ? 'REQUEST_CLOSED' : nextStatus === 'reopened' ? 'REQUEST_REOPENED' : 'STATUS_CHANGED',
      oldValue: previousStatus,
      newValue: nextStatus,
    });

    // DOC-18 - "In-App Notifications". Reuses this same successful
    // transition path (task spec section 34: "Prefer directly calling
    // recordRequestActivity(...) createNotification(...) from the same
    // successful transition path" - never a second pass that reads the
    // Timeline back to decide notifications). Only three of this
    // endpoint's transitions notify anyone at all (task spec section 5:
    // "Do NOT automatically convert every activity event into a
    // notification" - the other reachable transition here,
    // reopened->in_progress, is deliberately silent, same as 'closed'
    // below):
    //   in_progress (open/reopened -> in_progress): Employee only - "Work
    //     started on your request" (task spec section 21: useful, and
    //     only once, on the actual transition - this whole endpoint
    //     already rejects a same-status no-op above with 400, so this
    //     code can never run for a repeated/no-op status write). The actor
    //     is always the assigned Operator (the only role
    //     OPERATOR_TRANSITIONS ever allows into 'in_progress'), which can
    //     never equal the Employee recipient.
    //   resolved: Employee only - REQUIRED (task spec section 22). Actor
    //     is always the assigned Operator. Manager notification on
    //     resolve is deliberately NOT implemented (task spec: "optional;
    //     implement only if the existing dashboard workflow benefits" -
    //     the Manager Dashboard's own DOC-53 statistics already surface
    //     resolved-request counts, so a Manager does not need a push-style
    //     notification for every individual resolution too).
    //   reopened: assigned Operator (REQUIRED, task spec section 23) AND
    //     the Organization's Manager (task spec section 8: "good
    //     candidate" - a request regressing after being marked resolved is
    //     a meaningful organization-level event). The Employee who
    //     performed this action is deliberately NOT notified about their
    //     own reopen (task spec: "Do not notify the Employee about their
    //     own action").
    // 'closed' is deliberately silent here (and in managerCloseRequest
    // below) - task spec section 24 asks this rule to be documented: by
    // the time a Request reaches 'closed', both the Employee (who chose to
    // close it, or already saw it resolved) and the Operator (who already
    // received the resolved-time notification) already know the Request's
    // lifecycle is complete: a further notification would be redundant
    // noise, not new information.
    if (nextStatus === 'in_progress') {
      await createRequestNotification({
        request: requestDoc,
        recipientId: requestDoc.createdBy,
        actorId: req.user.userId,
        type: 'REQUEST_STATUS_CHANGED',
        title: 'Work started on your request',
        message: `Work has started on ${requestNotificationLabel(requestDoc)}.`,
        metadata: { requestTitle: requestDoc.title, newStatus: nextStatus },
      });
    } else if (nextStatus === 'resolved') {
      await createRequestNotification({
        request: requestDoc,
        recipientId: requestDoc.createdBy,
        actorId: req.user.userId,
        type: 'REQUEST_RESOLVED',
        title: 'Your request was resolved',
        message: `${requestNotificationLabel(requestDoc)} has been marked as Resolved. Review it and confirm or reopen if needed.`,
        metadata: { requestTitle: requestDoc.title },
      });
    } else if (nextStatus === 'reopened') {
      if (requestDoc.assignedOperatorId) {
        await createRequestNotification({
          request: requestDoc,
          recipientId: requestDoc.assignedOperatorId,
          actorId: req.user.userId,
          type: 'REQUEST_REOPENED',
          title: 'A request was reopened',
          message: `${requestNotificationLabel(requestDoc)} was reopened by the Employee.`,
          metadata: { requestTitle: requestDoc.title },
        });
      }
      const manager = await findOrganizationManager(req.user.organizationId);
      if (manager) {
        await createRequestNotification({
          request: requestDoc,
          recipientId: manager._id,
          actorId: req.user.userId,
          type: 'REQUEST_REOPENED',
          title: 'A request was reopened',
          message: `${requestNotificationLabel(requestDoc)} was reopened after being marked resolved.`,
          metadata: { requestTitle: requestDoc.title },
        });
      }
    }

    // Same enrichment/response shape DOC-11 already established - no
    // separate response shape for a status-changed Request.
    const [category, assignedOperator] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      requestDoc.assignedOperatorId
        ? User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId })
        : Promise.resolve(null),
    ]);

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, assignedOperator) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// Fields an Employee may ever edit on their own Request (DOC-46, task
// spec section 1) - an explicit allowlist, never `{ ...req.body }` and
// never `Request.findByIdAndUpdate(id, req.body)`.
const EDITABLE_FIELDS = ['title', 'description', 'categoryId', 'priority'];

// Trusted/server-only fields that must NEVER be settable through this
// endpoint. Task spec section 8 recommends explicitly REJECTING a payload
// that contains any of these (400) rather than silently ignoring them -
// chosen here because it is the clearer, safer signal to a caller (an
// honest client would simply never send these; a client that does send
// one is either buggy or attacking, and either way deserves a loud,
// specific error rather than a silent partial success). This policy is
// applied identically to every field below, and is the ONLY handling
// DOC-46 gives them - none of them are ever read, not even to validate
// their shape.
const FORBIDDEN_EDIT_FIELDS = ['status', 'organizationId', 'createdBy', 'assignedOperatorId', 'createdAt', 'updatedAt', '_id', 'id'];

// PATCH /api/requests/:id (employee only - see routes/request.routes.js,
// this shares the router's blanket Employee-only chain, not a broadened
// one)
//
// Edit eligibility (task spec sections 2-3): an Employee may edit their
// own Request ONLY while `status === 'open'` AND `assignedOperatorId ===
// null`. Once work has started (any other status) or an Operator has been
// assigned (even if still technically 'open' - a future-proofing rule,
// since Manager->Operator assignment does not exist yet but may set this
// field before advancing status later), the creator can no longer rewrite
// what was asked for. Both cases are rejected with 409 Conflict - not a
// permissions problem (the Employee DOES own this Request), but a
// resource-state conflict: the action is incompatible with the Request's
// current state. This is deliberately a different HTTP status than the
// 403s DOC-12 uses for "you are not the right role/assignee" - here the
// caller IS the right person, the request just cannot be edited right now.
const updateMyRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    // Scoped by createdBy AND organizationId in the query itself - never
    // findById() followed by a manual ownership check. A nonexistent
    // Request, another Employee's Request, and another Organization's
    // Request are all indistinguishable via this single query result and
    // produce the exact same 404 (DOC-38 anti-enumeration convention) -
    // this endpoint never reveals "you do not own this Request."
    const requestDoc = await Request.findOne({
      _id: id,
      createdBy: req.user.userId,
      organizationId: req.user.organizationId,
    });

    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    if (requestDoc.status !== 'open') {
      return res.status(409).json({ status: 'error', message: 'Only an open request can be edited.' });
    }

    if (requestDoc.assignedOperatorId) {
      return res.status(409).json({
        status: 'error',
        message: 'This request already has an assigned operator and can no longer be edited.',
      });
    }

    const body = req.body || {};

    const forbiddenFieldsPresent = FORBIDDEN_EDIT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (forbiddenFieldsPresent.length > 0) {
      return res.status(400).json({
        status: 'error',
        message: `The following fields cannot be edited: ${forbiddenFieldsPresent.join(', ')}.`,
      });
    }

    const suppliedEditableFields = EDITABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (suppliedEditableFields.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'At least one of title, description, categoryId, or priority must be provided.',
      });
    }

    // Reuses the exact same validators createRequest uses (utils/
    // requestFieldValidation.js) - create and edit can never quietly
    // drift into two different rule sets for the same fields.
    const updates = {};

    if (suppliedEditableFields.includes('title')) {
      const titleError = validateTitle(body.title);
      if (titleError) {
        return res.status(400).json({ status: 'error', message: titleError });
      }
      updates.title = body.title.trim();
    }

    if (suppliedEditableFields.includes('description')) {
      const descriptionError = validateDescription(body.description);
      if (descriptionError) {
        return res.status(400).json({ status: 'error', message: descriptionError });
      }
      updates.description = body.description.trim();
    }

    if (suppliedEditableFields.includes('priority')) {
      const priorityError = validatePriority(body.priority, PRIORITY_VALUES);
      if (priorityError) {
        return res.status(400).json({ status: 'error', message: priorityError });
      }
      updates.priority = body.priority;
      // DOC-55 - this endpoint is Employee-only and only ever reachable
      // while the Request is 'open' (this function's own eligibility
      // check above), so recalculating here can never touch a resolved/
      // closed/cancelled Request - but the underlying rule is identical to
      // managerUpdateRequest's own priority-change handling: recalculate
      // from the Request's own ORIGINAL createdAt, never from "now", so
      // repeatedly editing priority can never grant extra SLA time.
      updates.slaPolicyHours = SLA_HOURS_BY_PRIORITY[body.priority];
      updates.slaDueAt = calculateSlaDueAt({ priority: body.priority, createdAt: requestDoc.createdAt });
    }

    // Only validated/looked up when categoryId is actually being changed
    // (task spec section 21) - an Employee editing only title/description
    // on a Request whose historical Category has since gone inactive must
    // not be blocked or forced to pick a new, still-active Category.
    let newCategory = null;
    if (suppliedEditableFields.includes('categoryId')) {
      if (typeof body.categoryId !== 'string' || !mongoose.Types.ObjectId.isValid(body.categoryId)) {
        return res.status(400).json({ status: 'error', message: 'A valid service category is required.' });
      }

      // Same scoped, active-only, anti-enumeration query createRequest
      // uses - cross-org, inactive, and nonexistent categoryId are all
      // indistinguishable via this one generic error (task spec section 9).
      newCategory = await ServiceCategory.findOne({
        _id: body.categoryId,
        organizationId: req.user.organizationId,
        isActive: true,
      });

      if (!newCategory) {
        return res.status(400).json({
          status: 'error',
          message: 'The selected service category is unavailable. Please choose an active category from your organization.',
        });
      }

      updates.categoryId = newCategory._id;
    }

    // DOC-17 - captured BEFORE Object.assign overwrites requestDoc's own
    // fields below, so every "did this actually change" comparison has a
    // true original value to compare against - never re-derived after the
    // fact.
    const previousValues = {
      title: requestDoc.title,
      description: requestDoc.description,
      priority: requestDoc.priority,
      categoryId: requestDoc.categoryId,
    };

    Object.assign(requestDoc, updates);
    await requestDoc.save();

    // DOC-17 - up to three independent timeline events from this single
    // call, each only ever recorded if that specific field's value
    // actually changed (task spec section 12: "Only create the activity
    // if the value actually changed... Do NOT create medium -> medium
    // activities" - applied here to title/description/category too, for
    // the same reason: resubmitting an unchanged field must not add noise
    // to the timeline).
    const fieldsChanged = [];
    if (Object.prototype.hasOwnProperty.call(updates, 'title') && updates.title !== previousValues.title) {
      fieldsChanged.push('title');
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'description') && updates.description !== previousValues.description) {
      fieldsChanged.push('description');
    }
    if (fieldsChanged.length > 0) {
      // Deliberately does NOT store the full previous/next text bodies
      // (task spec section 14: "This prevents unnecessary duplication") -
      // only WHICH fields changed.
      await recordRequestActivity({
        request: requestDoc,
        actorId: req.user.userId,
        type: 'REQUEST_UPDATED',
        metadata: { fieldsChanged },
      });
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'priority') && updates.priority !== previousValues.priority) {
      await recordRequestActivity({
        request: requestDoc,
        actorId: req.user.userId,
        type: 'PRIORITY_CHANGED',
        oldValue: previousValues.priority,
        newValue: updates.priority,
      });
    }

    if (newCategory && String(newCategory._id) !== String(previousValues.categoryId)) {
      // Old category name resolved for the timeline's own display
      // purposes (task spec section 13: "Prefer displaying category names
      // rather than raw ObjectIds") - NOT restricted to isActive, since
      // the previous category may since have been deactivated; a
      // since-deactivated category must still show its real historical
      // name here, the same rule buildRequestEnrichmentMaps already
      // documents for the Request's own category display.
      const previousCategory = await ServiceCategory.findOne({
        _id: previousValues.categoryId,
        organizationId: req.user.organizationId,
      });
      await recordRequestActivity({
        request: requestDoc,
        actorId: req.user.userId,
        type: 'CATEGORY_CHANGED',
        oldValue: previousValues.categoryId,
        newValue: newCategory._id,
        metadata: {
          oldCategoryName: previousCategory ? previousCategory.name : 'Unknown Category',
          newCategoryName: newCategory.name,
        },
      });
    }

    // DOC-46 never touches Comment documents - editing title/description/
    // category/priority has zero effect on any existing comment (task
    // spec section 10).
    const category = newCategory
      || await ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId });

    // Edit eligibility already required assignedOperatorId === null above,
    // and this endpoint never writes to that field - always null here.
    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, null) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/requests/:id/cancel (employee only)
//
// A dedicated, deliberately body-less endpoint (task spec section 14) -
// cancellation is a distinct business action, not a generic status write.
// No request body is ever read here, so a payload like
// { "status": "cancelled" } or any other injected field has literally no
// code path that could act on it. DOC-12's generic PATCH
// /api/requests/:id/status endpoint is NOT expanded to allow this - see
// utils/requestStatusTransitions.js, which now explicitly refuses
// 'cancelled' as a transition target regardless of role.
//
// Eligibility mirrors updateMyRequest's (task spec section 13): only an
// Employee's own Request, only while `status === 'open'` AND
// `assignedOperatorId === null`. Once assigned or once work has started,
// cancellation through this Employee-only action is no longer available
// (a future Manager/Operator-facing action may exist later, but is not
// part of DOC-46).
const cancelMyRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    const requestDoc = await Request.findOne({
      _id: id,
      createdBy: req.user.userId,
      organizationId: req.user.organizationId,
    });

    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    if (requestDoc.status !== 'open') {
      return res.status(409).json({ status: 'error', message: 'Only an open request can be cancelled.' });
    }

    if (requestDoc.assignedOperatorId) {
      return res.status(409).json({
        status: 'error',
        message: 'This request already has an assigned operator and can no longer be cancelled.',
      });
    }

    // Server decides the value entirely - never read from req.body.
    const previousStatus = requestDoc.status;
    requestDoc.status = 'cancelled';
    await requestDoc.save();

    // DOC-17 - this Employee-only cancel path never reads a `reason`
    // (task spec: "a dedicated, deliberately body-less endpoint" - see
    // this function's own top comment), so no `cancelReason` exists here
    // to include in metadata, unlike managerCancelRequest below.
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'REQUEST_CANCELLED',
      oldValue: previousStatus,
      newValue: 'cancelled',
    });

    const category = await ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId });

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, null) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// Shared ownership/eligibility lookup for both attachment endpoints below -
// identical shape and identical rule to DOC-46's updateMyRequest/
// cancelMyRequest (task spec section 6: "Integrate with the existing
// DOC-46 edit rules"). Returns the Request document on success, or `null`
// after already sending a 400/404/409 response itself (and cleaning up
// any files Multer already wrote for this request, since every caller of
// this helper runs after upload middleware).
async function loadEditableRequestOrRespond(req, res) {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    cleanupUploadedFiles(req.files);
    res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    return null;
  }

  // Scoped by createdBy AND organizationId - never findById() + a manual
  // check. Nonexistent, another Employee's, and another Organization's
  // Request are all indistinguishable via this single query result and
  // produce the exact same 404 (DOC-38 anti-enumeration convention).
  const requestDoc = await Request.findOne({
    _id: id,
    createdBy: req.user.userId,
    organizationId: req.user.organizationId,
  });

  if (!requestDoc) {
    cleanupUploadedFiles(req.files);
    res.status(404).json({ status: 'error', message: 'Request not found.' });
    return null;
  }

  if (requestDoc.status !== 'open') {
    cleanupUploadedFiles(req.files);
    res.status(409).json({ status: 'error', message: 'Only an open request can have its attachments changed.' });
    return null;
  }

  if (requestDoc.assignedOperatorId) {
    cleanupUploadedFiles(req.files);
    res.status(409).json({
      status: 'error',
      message: 'This request already has an assigned operator and can no longer have its attachments changed.',
    });
    return null;
  }

  return requestDoc;
}

// POST /api/requests/:id/attachments (employee only)
//
// Adds one or more images to an already-existing Request the caller owns.
// Eligibility is identical to DOC-46 edit: `status === 'open'` AND
// `assignedOperatorId === null` (task spec section 6). The Request's
// existing attachment count plus this upload's file count must not exceed
// MAX_ATTACHMENTS_PER_REQUEST (task spec section 2's "3 existing + up to
// 2 more" example) - Multer's own per-call limit (middleware/upload.js)
// only caps a single request's file count, it has no notion of how many
// images this specific Request already has, so that check happens here.
const addRequestAttachments = async (req, res, next) => {
  try {
    const requestDoc = await loadEditableRequestOrRespond(req, res);
    if (!requestDoc) return undefined; // response already sent

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'At least one image is required.' });
    }

    const remainingSlots = MAX_ATTACHMENTS_PER_REQUEST - requestDoc.attachments.length;
    if (files.length > remainingSlots) {
      cleanupUploadedFiles(req.files);
      const message = remainingSlots <= 0
        ? `This request already has the maximum of ${MAX_ATTACHMENTS_PER_REQUEST} images.`
        : `Only ${remainingSlots} more image(s) may be added to this request.`;
      return res.status(400).json({ status: 'error', message });
    }

    const newAttachments = await buildAttachmentMetadata(req.files, {
      organizationId: req.user.organizationId,
      requestId: requestDoc._id,
      uploadedBy: req.user.userId,
    });

    requestDoc.attachments.push(...newAttachments);
    try {
      await requestDoc.save();
    } catch (error) {
      // S3 MIGRATION - requestDoc.save() failed AFTER the storage uploads
      // above already succeeded (e.g. a schema validation error from
      // pushing past this point) - only the objects THIS call just
      // uploaded are cleaned up (S3 or GridFS, whichever this call used),
      // never any of this Request's already-existing attachments.
      await cleanupNewlyUploadedAttachments(newAttachments);
      throw error;
    }

    // DOC-17 - one event per upload ACTION (not one per file - task spec's
    // own timeline example shows "Completion image uploaded" as a single
    // line even though DOC-56 already allows multi-file uploads). Never
    // stores raw image bytes, a GridFS id, an S3 objectKey, or a local
    // filesystem path (task spec section 22) - only the safe, already-
    // response-visible `attachmentId`/`originalName` pair per file.
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'BEFORE_IMAGE_ADDED',
      metadata: {
        count: newAttachments.length,
        attachments: newAttachments.map((attachment) => ({ attachmentId: attachment._id, originalName: attachment.originalName })),
      },
    });

    const category = await ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId });

    return res.status(201).json({ status: 'success', data: sanitizeRequest(requestDoc, category, null) });
  } catch (error) {
    cleanupUploadedFiles(req.files);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// DELETE /api/requests/:id/attachments/:attachmentId (employee only)
//
// Removes exactly one attachment's metadata AND its stored file - never
// the Request itself (task spec section 8/28: no hard delete anywhere).
// Same ownership/eligibility rule as addRequestAttachments. The client
// never supplies a filesystem path - only `attachmentId`, an ObjectId
// that must already exist on THIS Request's own `attachments` array;
// `storedName` (the only thing ever used to build a filesystem path) is
// always read back from the already-stored, server-generated metadata,
// and is defensively reduced to `path.basename(...)` before being joined
// with UPLOAD_ROOT - even though it is already a plain generated UUID
// filename with no path separators, this makes path traversal
// structurally impossible regardless (task spec section 8/19).
const removeRequestAttachment = async (req, res, next) => {
  try {
    const { attachmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid attachment id.' });
    }

    // No files are ever uploaded on this route (no upload middleware is
    // wired for DELETE - see routes/request.routes.js), so
    // loadEditableRequestOrRespond's cleanupUploadedFiles calls are
    // harmless no-ops here (req.files is always undefined).
    const requestDoc = await loadEditableRequestOrRespond(req, res);
    if (!requestDoc) return undefined; // response already sent

    const attachmentIndex = requestDoc.attachments.findIndex((attachment) => String(attachment._id) === String(attachmentId));
    if (attachmentIndex === -1) {
      return res.status(404).json({ status: 'error', message: 'Attachment not found.' });
    }

    const [removedAttachment] = requestDoc.attachments.splice(attachmentIndex, 1);
    await requestDoc.save();

    // GRIDFS MIGRATION - deletes from GridFS or local disk depending on
    // which storage reference this specific attachment has (see
    // deleteAttachmentStorage's own comment). Uses ONLY the fileId/
    // storedName already stored on THIS Request's own, already-authorized
    // attachment - never a client-supplied identifier - so this can never
    // delete a file belonging to another Request.
    await deleteAttachmentStorage(removedAttachment);

    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'BEFORE_IMAGE_REMOVED',
      metadata: { attachmentId: removedAttachment._id, originalName: removedAttachment.originalName },
    });

    const category = await ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId });

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, null) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// DOC-56 - "Operator Completion Proof Images". Shared ownership/
// eligibility lookup for both completion-image endpoints below - a
// deliberately DIFFERENT shape from loadEditableRequestOrRespond (DOC-45),
// which is Employee-only and open-and-unassigned-only. This one is
// Operator-only and in_progress-only, and returns a DIFFERENT HTTP status
// for each of its two distinct failure kinds rather than collapsing them:
//
//   1. Nonexistent / cross-organization Request -> 404. Scoped by
//      organizationId ONLY (never findById() + a manual check) - the same
//      DOC-38 anti-enumeration convention every other lookup in this
//      controller already uses.
//   2. Right Organization, but this Request is NOT assigned to the
//      calling Operator (unassigned, removed, or assigned to someone
//      else) -> 403, not a second 404. The caller's own token already
//      proves Organization membership (verifyToken + requireOrganization-
//      Membership), so there is no cross-tenant enumeration risk left to
//      protect against here - only an honest "this is not your Request"
//      answer, mirroring utils/commentAccess.js's identical "right org,
//      wrong assignee -> 403" precedent (DOC-13's
//      canReadRequestComments/canWriteRequestComments), not DOC-38's
//      broader cross-org-404 convention (which exists specifically to
//      prevent leaking WHICH Organization a resource belongs to - not
//      applicable once Organization membership is already established).
//   3. Right Organization, right assigned Operator, but the Request is
//      not currently 'in_progress' -> 409 Conflict, the same "you ARE
//      allowed to act on this resource in general, just not while it is
//      in this state" shape loadEditableRequestOrRespond already uses for
//      its own status-based checks (task spec: "Only while: status ==
//      in_progress. After resolved: read-only forever.").
//
// `cleanupUploadedFiles(req.files)` runs on every failure path here too -
// every caller of this helper runs after the completion-images upload
// middleware, so any files Multer already wrote must never be orphaned.
async function loadOperatorOwnedInProgressRequestOrRespond(req, res) {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    cleanupUploadedFiles(req.files);
    res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    return null;
  }

  const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });

  if (!requestDoc) {
    cleanupUploadedFiles(req.files);
    res.status(404).json({ status: 'error', message: 'Request not found.' });
    return null;
  }

  // Ownership is read from THIS freshly-fetched document only - never
  // from req.body. An inactive Operator, or one whose assignment was
  // since removed by a Manager (DOC-59's managerUpdateRequest, while
  // status was still 'open'), both simply fail this same check - there is
  // no separate "inactive operator" or "removed assignment" code path,
  // both collapse into the same honest 403 a wrong-operator attempt gets.
  const isAssignedOperator = !!requestDoc.assignedOperatorId
    && String(requestDoc.assignedOperatorId) === String(req.user.userId);
  if (!isAssignedOperator) {
    cleanupUploadedFiles(req.files);
    res.status(403).json({ status: 'error', message: 'You are not the operator assigned to this request.' });
    return null;
  }

  if (requestDoc.status !== 'in_progress') {
    cleanupUploadedFiles(req.files);
    res.status(409).json({
      status: 'error',
      message: 'Completion images can only be added or removed while this request is in progress.',
    });
    return null;
  }

  return requestDoc;
}

// POST /api/requests/:id/completion-images (operator only)
//
// DOC-56 - adds one or more completion-proof images to a Request the
// caller is the assigned Operator of, while it is 'in_progress'. Same
// remaining-slots arithmetic addRequestAttachments already uses, applied
// to the separate `completionAttachments` array instead - the two counts
// (`attachments.length` and `completionAttachments.length`) are entirely
// independent of each other (task spec: "This is a completely separate
// attachment collection").
const addCompletionImages = async (req, res, next) => {
  try {
    const requestDoc = await loadOperatorOwnedInProgressRequestOrRespond(req, res);
    if (!requestDoc) return undefined; // response already sent

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'At least one image is required.' });
    }

    const remainingSlots = MAX_ATTACHMENTS_PER_REQUEST - requestDoc.completionAttachments.length;
    if (files.length > remainingSlots) {
      cleanupUploadedFiles(req.files);
      const message = remainingSlots <= 0
        ? `This request already has the maximum of ${MAX_ATTACHMENTS_PER_REQUEST} completion images.`
        : `Only ${remainingSlots} more completion image(s) may be added to this request.`;
      return res.status(400).json({ status: 'error', message });
    }

    const newAttachments = await buildCompletionAttachmentMetadata(req.files, {
      organizationId: req.user.organizationId,
      requestId: requestDoc._id,
      uploadedByUserId: req.user.userId,
    });

    requestDoc.completionAttachments.push(...newAttachments);
    try {
      await requestDoc.save();
    } catch (error) {
      // S3 MIGRATION - same rollback shape as addRequestAttachments: only
      // the objects THIS call just uploaded are cleaned up, never any of
      // this Request's already-existing completion images.
      await cleanupNewlyUploadedAttachments(newAttachments);
      throw error;
    }

    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'COMPLETION_IMAGE_ADDED',
      metadata: {
        count: newAttachments.length,
        attachments: newAttachments.map((attachment) => ({ attachmentId: attachment._id, originalName: attachment.originalName })),
      },
    });

    const [category, assignedOperator] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId }),
    ]);

    return res.status(201).json({ status: 'success', data: sanitizeRequest(requestDoc, category, assignedOperator) });
  } catch (error) {
    cleanupUploadedFiles(req.files);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// DELETE /api/requests/:id/completion-images/:attachmentId (operator only)
//
// DOC-56 - removes exactly one completion image's metadata AND its stored
// file - never the Request itself. Same ownership/eligibility rule as
// addCompletionImages (must still be 'in_progress' - "After resolved:
// read-only forever" - once the Operator resolves the Request, this
// endpoint's own loadOperatorOwnedInProgressRequestOrRespond call already
// starts rejecting with 409, no separate "is it resolved yet" check is
// needed). Same path-traversal defense as removeRequestAttachment:
// `storedName` is always read back from the already-stored, server-
// generated metadata, never from the client, and is reduced to
// `path.basename(...)` before being joined with UPLOAD_ROOT.
const removeCompletionImage = async (req, res, next) => {
  try {
    const { attachmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid attachment id.' });
    }

    // No files are ever uploaded on this route (no upload middleware is
    // wired for DELETE - see routes/request.routes.js), so
    // loadOperatorOwnedInProgressRequestOrRespond's cleanupUploadedFiles
    // calls are harmless no-ops here (req.files is always undefined).
    const requestDoc = await loadOperatorOwnedInProgressRequestOrRespond(req, res);
    if (!requestDoc) return undefined; // response already sent

    const attachmentIndex = requestDoc.completionAttachments.findIndex(
      (attachment) => String(attachment._id) === String(attachmentId),
    );
    if (attachmentIndex === -1) {
      return res.status(404).json({ status: 'error', message: 'Completion image not found.' });
    }

    const [removedAttachment] = requestDoc.completionAttachments.splice(attachmentIndex, 1);
    await requestDoc.save();

    // GRIDFS MIGRATION - see deleteAttachmentStorage's own comment;
    // branches on fileId (GridFS) vs storedName (legacy local disk),
    // using only this already-authorized attachment's own stored
    // reference.
    await deleteAttachmentStorage(removedAttachment);

    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'COMPLETION_IMAGE_REMOVED',
      metadata: { attachmentId: removedAttachment._id, originalName: removedAttachment.originalName },
    });

    const [category, assignedOperator] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId }),
    ]);

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, assignedOperator) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// GRIDFS MIGRATION - "who may view this Request's image attachments" -
// deliberately re-expressed here (not imported from
// utils/commentAccess.js) even though it matches that file's own
// hasRequestCommentAccess rule exactly today: viewing a Request's images
// and viewing a Request's comments are two conceptually different
// permissions that happen to share identical rules right now - keeping
// them as two small, independent functions means a FUTURE change to one
// (e.g. a role gaining comment access but not image access) never
// silently changes the other's behavior too.
//   employee  -> only the Request's own creator
//   operator  -> only the Operator actually assigned to this Request
//   manager   -> any Request inside their own Organization
//   anything else (system_admin, or an unrecognized role) -> never -
//     System Admin has no operational Request image access at all (task
//     spec: "System Admin NO operational Request image access").
function canViewRequestImages({
  role, userId, requestCreatedBy, assignedOperatorId,
}) {
  if (role === 'employee') {
    return String(requestCreatedBy) === String(userId);
  }
  if (role === 'operator') {
    return !!assignedOperatorId && String(assignedOperatorId) === String(userId);
  }
  if (role === 'manager') {
    return true;
  }
  return false;
}

// GET /api/requests/:requestId/attachments/:attachmentId/content
// (Employee/Operator/Manager - NOT System Admin)
//
// GRIDFS MIGRATION - the ONE authenticated, authorized route through
// which any Request image's actual bytes are ever streamed - the
// replacement for app.js's old unauthenticated `/api/uploads/requests`
// static mount for every NEW response `url` (see sanitizeRequest below).
// That old static mount is deliberately left in place, unused by any
// current response - removing it is a separate, later cleanup, not part
// of this compatibility-first migration.
//
// Reachable by Employee (own Request only), Operator (assigned Request
// only), Manager (any Request in their Organization) - never System
// Admin, checked first and unconditionally, before any Request lookup
// even runs (System Admin is org-less by design - task spec section 9's
// established convention, same as listComments above).
//
// Looks for `attachmentId` in EITHER `attachments` (Before Images) or
// `completionAttachments` (Completion Images) on the SAME authorized
// Request - a caller does not need to know (and this response never
// reveals) which collection a given id actually belongs to; both
// "does not exist" and "belongs to a different Request" collapse into
// the same generic 404, the same DOC-38 anti-enumeration convention
// every other cross-role Request lookup in this controller already
// uses for the Request document itself.
//
// S3 MIGRATION - streams from S3, GridFS, or the legacy local disk,
// depending on which storage reference this specific attachment actually
// has - never more than one, never buffers the whole file into memory
// first (task spec's streaming/performance section) - delegated entirely
// to requestImageStorage.getImageStream, the ONE place that knows how to
// read from all three backends (Phase 13's "one stable frontend contract"
// requirement: this endpoint's own request/response shape is completely
// unaffected by which backend actually served a given image). Only ever
// sets Content-Type/Content-Length/Content-Disposition from trusted,
// already-validated metadata - never exposes an S3 bucket name, GridFS
// chunk ids, a local filesystem path, or the client's own original
// filename in any response header (task spec: "Do not use originalName
// as an unsanitized response header").
const getRequestAttachmentContent = async (req, res, next) => {
  try {
    if (req.user.role === 'system_admin') {
      return res.status(403).json({ status: 'error', message: 'System Admin cannot access Request images.' });
    }

    const { requestId, attachmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId) || !mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid id.' });
    }

    // Organization-scoped first - never findById() + a manual comparison
    // - a nonexistent Request and one belonging to another Organization
    // both produce the exact same 404.
    const requestDoc = await Request.findOne({ _id: requestId, organizationId: req.user.organizationId });
    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request or image not found.' });
    }

    const authorized = canViewRequestImages({
      role: req.user.role,
      userId: req.user.userId,
      requestCreatedBy: requestDoc.createdBy,
      assignedOperatorId: requestDoc.assignedOperatorId,
    });
    if (!authorized) {
      // Right Organization, wrong role/assignment - an honest 403, the
      // same "right org, wrong assignee" shape commentAccess.js's own
      // convention already documents (not a second 404 - Organization
      // membership is already established by this point, so there is no
      // cross-tenant enumeration risk left to protect against here).
      return res.status(403).json({ status: 'error', message: 'You are not authorized to view this image.' });
    }

    const attachment = requestDoc.attachments.id(attachmentId) || requestDoc.completionAttachments.id(attachmentId);
    if (!attachment) {
      return res.status(404).json({ status: 'error', message: 'Request or image not found.' });
    }

    const imageStream = await requestImageStorage.getImageStream(attachment);
    if (!imageStream) {
      // Covers every "bytes not found" case uniformly - a missing S3
      // object, a missing GridFS file, a missing local-disk file, or the
      // defensive fallback for an attachment with no storage reference at
      // all (should be unreachable given the model's own pre('validate')
      // hook, but never trusted blindly here either).
      return res.status(404).json({ status: 'error', message: 'Request or image not found.' });
    }

    res.setHeader('Content-Type', imageStream.contentType);
    if (imageStream.contentLength) {
      res.setHeader('Content-Length', String(imageStream.contentLength));
    }
    // Renders inline in the browser (the frontend already fetches this as
    // a Blob and builds its own object URL - see
    // AuthenticatedRequestImage.jsx) rather than forcing a download, and
    // never derives this header from the client-supplied originalName.
    res.setHeader('Content-Disposition', 'inline');

    imageStream.stream.on('error', (error) => next(error));
    return imageStream.stream.pipe(res);
  } catch (error) {
    return next(error);
  }
};

// DOC-17 - "who may view this Request's activity timeline" - deliberately
// re-expressed here (not imported from utils/commentAccess.js, and not
// reused from canViewRequestImages above either) even though it matches
// both of those exactly today: viewing a Request's comments, viewing its
// images, and viewing its activity timeline are three conceptually
// different permissions that happen to share identical rules right now -
// keeping this as its own small, independent function means a FUTURE
// change to any one of them never silently changes the other two (task
// spec section 8: "Preserve current Request visibility rules" - Employee
// own-Request-only, Operator assigned-Request-only, Manager any-Request-
// in-Organization, System Admin never - "Do not create new operational
// System Admin permissions").
function canViewRequestActivities({
  role, userId, requestCreatedBy, assignedOperatorId,
}) {
  if (role === 'employee') {
    return String(requestCreatedBy) === String(userId);
  }
  if (role === 'operator') {
    return !!assignedOperatorId && String(assignedOperatorId) === String(userId);
  }
  if (role === 'manager') {
    return true;
  }
  return false;
}

// Every RequestActivity `type` whose stored oldValue/newValue are already
// safe, display-ready scalars (a plain status/priority enum string) -
// passed straight through to the response with no transformation at all.
// Every OTHER type (CATEGORY_CHANGED, ASSIGNED, REASSIGNED, UNASSIGNED)
// instead reads its display value out of `metadata` (a name snapshotted at
// write time - see models/RequestActivity.js's own comment on why this
// project resolves reference-typed display names once, at write time,
// rather than re-resolving them live on every future read); every other
// type (REQUEST_CREATED, REQUEST_UPDATED, image events) never has a
// meaningful oldValue/newValue at all and always reports both as `null`.
const SCALAR_ACTIVITY_TYPES = new Set([
  'STATUS_CHANGED', 'PRIORITY_CHANGED', 'REQUEST_CANCELLED', 'REQUEST_REOPENED', 'REQUEST_CLOSED',
]);

// Builds the safe, frontend-ready `oldValue`/`newValue` pair for one
// activity record - see this function's own inline comments per `type`.
// Never returns a raw Mongo ObjectId to the client for a reference-typed
// event (task spec section 26: never expose internal Mongo fields) - only
// ever a display-ready string or `null`.
function buildActivityDisplayValues(activity) {
  if (SCALAR_ACTIVITY_TYPES.has(activity.type)) {
    return { oldValue: activity.oldValue, newValue: activity.newValue };
  }
  const metadata = activity.metadata || {};
  if (activity.type === 'CATEGORY_CHANGED') {
    return { oldValue: metadata.oldCategoryName || null, newValue: metadata.newCategoryName || null };
  }
  if (activity.type === 'ASSIGNED') {
    return { oldValue: null, newValue: metadata.newOperatorName || null };
  }
  if (activity.type === 'REASSIGNED') {
    return { oldValue: metadata.previousOperatorName || null, newValue: metadata.newOperatorName || null };
  }
  if (activity.type === 'UNASSIGNED') {
    return { oldValue: metadata.previousOperatorName || null, newValue: null };
  }
  // REQUEST_CREATED, REQUEST_UPDATED, and every image event - all of
  // their meaningful information lives in `metadata`, never oldValue/
  // newValue (see requestActivity.service.js's own per-type
  // documentation).
  return { oldValue: null, newValue: null };
}

const DEFAULT_ACTIVITY_PAGE_SIZE = 100;
const MAX_ACTIVITY_PAGE_SIZE = 200;

// GET /api/requests/:requestId/activities
// (Employee/Operator/Manager - NOT System Admin)
//
// DOC-17 - "Request Activity Timeline". Returns this Request's own
// chronological history, OLDEST FIRST (task spec section 25's own worked
// example reads top-to-bottom, oldest event first - "Request created ->
// Priority changed -> Assigned -> ..." - this endpoint's response order
// matches that reading order exactly, so the frontend can render the
// array directly with no client-side re-sorting).
//
// Reachable by Employee (own Request only), Operator (assigned Request
// only), Manager (any Request in their Organization) - never System
// Admin (task spec section 8: "System Admin should NOT gain day-to-day
// operational Request access just because timeline exists" - rejected
// first and unconditionally, before any Request lookup even runs, the
// same convention getRequestAttachmentContent above already uses).
//
// PAGINATION (task spec section 25 - "avoid overengineering"): an
// optional `limit` (1-200, default 100) caps how many events come back;
// an optional `before` (an activity id already returned by a previous
// call) fetches the next OLDER page - the same "id you already have as a
// cursor" shape a `before`/`limit` pair is meant to express, without a
// second opaque cursor-token format to invent or document. Internally
// this queries newest-first (so `limit` naturally keeps the most RECENT
// N events of whichever window `before` selects) and reverses the page
// back to oldest-first immediately before returning it, so the response
// contract is always "oldest -> newest", regardless of pagination.
const getRequestActivities = async (req, res, next) => {
  try {
    if (req.user.role === 'system_admin') {
      return res.status(403).json({ status: 'error', message: 'System Admin cannot access Request activity.' });
    }

    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    // Organization-scoped first - a nonexistent Request and one belonging
    // to another Organization both produce the exact same 404 (DOC-38
    // anti-enumeration convention, identical to every other Request
    // lookup in this controller).
    const requestDoc = await Request.findOne({ _id: requestId, organizationId: req.user.organizationId });
    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    const authorized = canViewRequestActivities({
      role: req.user.role,
      userId: req.user.userId,
      requestCreatedBy: requestDoc.createdBy,
      assignedOperatorId: requestDoc.assignedOperatorId,
    });
    if (!authorized) {
      // Right Organization, wrong role/assignment - an honest 403, same
      // shape as getRequestAttachmentContent's own identical case.
      return res.status(403).json({ status: 'error', message: 'You are not authorized to view this request\'s activity.' });
    }

    let limit = DEFAULT_ACTIVITY_PAGE_SIZE;
    if (req.query.limit !== undefined) {
      const parsedLimit = Number.parseInt(req.query.limit, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_ACTIVITY_PAGE_SIZE) {
        return res.status(400).json({
          status: 'error',
          message: `limit must be an integer between 1 and ${MAX_ACTIVITY_PAGE_SIZE}.`,
        });
      }
      limit = parsedLimit;
    }

    // `requestId`/`organizationId` scope this query exactly like every
    // other Request-scoped lookup here - a client can never widen this
    // beyond the one already-authorized Request by supplying any query
    // parameter (task spec section 25: "Do not allow arbitrary
    // organization filtering").
    const activityQuery = { requestId: requestDoc._id, organizationId: req.user.organizationId };

    if (req.query.before !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(req.query.before)) {
        return res.status(400).json({ status: 'error', message: 'before must be a valid activity id.' });
      }
      // The cursor activity must itself belong to THIS Request - never
      // trusted as a bare timestamp/offset supplied directly by the
      // client, which could otherwise be used to probe for the existence/
      // timing of another Request's activity.
      const cursorActivity = await RequestActivity.findOne({
        _id: req.query.before, requestId: requestDoc._id, organizationId: req.user.organizationId,
      });
      if (!cursorActivity) {
        return res.status(400).json({ status: 'error', message: 'before does not reference a known activity on this request.' });
      }
      activityQuery.createdAt = { $lt: cursorActivity.createdAt };
    }

    const newestFirstPage = await RequestActivity
      .find(activityQuery)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
    const activityDocs = newestFirstPage.slice().reverse();

    // Batch-resolve every distinct actor in this page in ONE query (never
    // one query per activity - the same N+1-avoiding shape
    // buildRequestEnrichmentMaps/buildCreatorMap already establish
    // elsewhere in this controller). Scoped by organizationId as defense
    // in depth, exactly like those. A deactivated actor is still found
    // (isActive is never part of this query) and still displayed by real
    // name - task spec section 6: "If the actor no longer exists or is
    // inactive, historical activity must still remain readable." Only an
    // actor that cannot be found AT ALL (hypothetical - this project never
    // hard-deletes a User) falls back to "Unknown user".
    const actorIds = Array.from(new Set(activityDocs.map((activity) => String(activity.actorId))));
    const actors = actorIds.length > 0
      ? await User.find({ _id: { $in: actorIds }, organizationId: req.user.organizationId })
      : [];
    const actorMap = new Map(actors.map((actor) => [String(actor._id), actor]));

    const data = activityDocs.map((activity) => {
      const actor = actorMap.get(String(activity.actorId));
      const { oldValue, newValue } = buildActivityDisplayValues(activity);
      return {
        id: activity._id,
        type: activity.type,
        actor: actor
          ? { id: actor._id, fullName: actor.fullName, role: actor.role }
          : { id: activity.actorId, fullName: 'Unknown user', role: null },
        oldValue,
        newValue,
        // `metadata` is passed straight through - task spec's own response
        // shape includes it verbatim. Every value ever placed into it by
        // requestActivity.service.js's callers is already safe by
        // construction (attachment id/originalName, category/operator
        // display names, fieldsChanged, cancelReason - see each call
        // site's own comment) - never a GridFS id, S3 objectKey, local
        // filesystem path, password, or JWT.
        metadata: activity.metadata || {},
        createdAt: activity.createdAt,
      };
    });

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/requests/:id/assign (manager only)
//
// DOC-52 - "Manager assigns Request to a suitable Operator", the one
// missing piece that makes the rest of the Operator workflow reachable at
// all. DOC-15 - "Advanced Request History & Reassignment" - extended this
// SAME endpoint (task spec section 15: "Prefer extending the current
// endpoint rather than creating unnecessary new overlapping endpoints")
// rather than adding a second one, and gave it the exact body shape the
// task spec itself describes: `{ operatorId, reason }`.
//   - `operatorId` a valid Operator id -> ASSIGN (if currently unassigned)
//     or REASSIGN (if replacing a DIFFERENT operator).
//   - `operatorId` explicit `null` -> UNASSIGN (removes the current
//     assignment) - this is NEW in DOC-15; the pre-DOC-15 version of this
//     endpoint only ever accepted a real operator id and had no
//     unassignment capability at all (a Manager had to use the separate
//     PATCH /:id/manager endpoint's own assignedOperatorId: null branch
//     for that - see managerUpdateRequest below, which keeps working
//     completely unchanged).
//   - `operatorId` absent entirely -> 400 (this field must always be
//     present, either as a real id or explicit null - task spec section
//     16: the caller states its own intent via `operatorId`, never a
//     separate "which operation is this" flag).
// `reason` is read ONLY when it actually matters (reassignment/
// unassignment) - a first assignment never even looks at it (task spec
// section 5). The backend alone decides ASSIGNED vs REASSIGNED vs
// UNASSIGNED from the Request's OWN current `assignedOperatorId` compared
// against the requested `operatorId` - task spec section 15's own
// explicit rule: "Do not trust frontend to tell backend which operation
// this is."
//
// Order of checks (mirrors the state-eligibility-before-field-validation
// order updateMyRequest/cancelMyRequest already established in DOC-46):
//   1. :id well-formed (400)
//   2. Request lookup, scoped by organizationId ONLY - not createdBy,
//      since the Manager is never the creator (404 if not found; a
//      nonexistent Request and one belonging to another Organization are
//      indistinguishable, DOC-38 anti-enumeration convention)
//   3. status === 'open' (409 otherwise) - task spec section 7: this
//      project's existing architecture already restricts assignment/
//      reassignment/unassignment to 'open' Requests only (see the DOC-15
//      audit notes in this ticket's final report) - DOC-15 preserves this
//      exactly, it does not invent a new transition or extend eligibility
//      to in_progress/resolved/closed/cancelled.
//   4. operatorId present (400 if the key itself is missing from the body)
//   5. Operator lookup (when operatorId is a real id), scoped by
//      organizationId AND role: 'operator' AND isActive: true AND
//      specialties containing this Request's own categoryId, all in ONE
//      query (400, one generic message, if it resolves to nothing - task
//      spec section 15/8: cross-organization, wrong-role [employee/
//      manager/system_admin], inactive, and wrong-specialty are all
//      indistinguishable via this single query result, the same
//      anti-enumeration shape createRequest already uses for an invalid
//      categoryId)
//   6. Sprint 4 (DOC-22, preserved unchanged by DOC-15) - reassigning the
//      SAME Operator this Request is already assigned to is rejected as a
//      no-op (400), not silently re-saved, and never reaches reason
//      validation, activity recording, or notifications at all (task spec
//      section 6). A Manager genuinely replacing the Operator with a
//      DIFFERENT one, or removing the current one, is unaffected by this
//      check.
//   7. DOC-15 - reason required ONLY for a genuine reassignment/
//      unassignment (400, generic validation message, never a raw
//      Mongoose/Mongo error - task spec section 3).
//
// On success, only `assignedOperatorId` is written - "nothing else
// changes" (task spec section 6). Status is deliberately NOT touched here
// (assignment and status are different concerns, exactly like DOC-46 kept
// edit/cancel separate from DOC-12's status endpoint) - the Request stays
// 'open' until the newly assigned Operator explicitly starts work via the
// existing PATCH /api/requests/:id/status endpoint (DOC-12, reused
// unchanged).
const assignRequestOperator = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    // Scoped by organizationId only - a Manager assigns any Request in
    // their own Organization, not just ones they personally created (they
    // never create Requests at all). Nonexistent and cross-organization
    // both collapse into the same 404.
    const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });

    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    if (requestDoc.status !== 'open') {
      return res.status(409).json({
        status: 'error',
        message: 'Only an open request can be assigned, reassigned, or unassigned.',
      });
    }

    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'operatorId')) {
      return res.status(400).json({
        status: 'error',
        message: 'operatorId is required - a valid operator id to assign/reassign, or null to unassign.',
      });
    }
    const { operatorId } = body;

    // DOC-17 - captured up front, before any write - by this point the
    // no-op "same operator" case has not yet been rejected, so this value
    // alone is not yet enough to classify ASSIGNED vs REASSIGNED; it is
    // re-checked against the resolved operator/null branch below.
    const previousOperatorId = requestDoc.assignedOperatorId;

    // DOC-15 - "Advanced Request History & Reassignment": explicit `null`
    // (the key IS present, its value IS null) means UNASSIGN. This is
    // deliberately the same convention managerUpdateRequest's own
    // assignedOperatorId field already uses - not a second, differently-
    // spelled convention.
    if (operatorId === null) {
      if (!previousOperatorId) {
        return res.status(400).json({ status: 'error', message: 'This request has no assigned operator to remove.' });
      }

      const reasonError = validateAssignmentReason(body.reason);
      if (reasonError) {
        return res.status(400).json({ status: 'error', message: reasonError });
      }
      const reason = body.reason.trim();

      // Resolved BEFORE the write, exactly like every other "previous
      // operator" lookup in this controller - snapshotted into metadata at
      // write time so a later name change/deactivation never rewrites this
      // historical event's display.
      const previousOperator = await User.findOne({ _id: previousOperatorId, organizationId: req.user.organizationId });

      requestDoc.assignedOperatorId = null;
      await requestDoc.save();

      // DOC-17 - task spec section 9's preferred UNASSIGNED metadata
      // shape: `{previousOperatorId, previousOperatorName, reason}`.
      await recordRequestActivity({
        request: requestDoc,
        actorId: req.user.userId,
        type: 'UNASSIGNED',
        oldValue: previousOperatorId,
        newValue: null,
        metadata: {
          previousOperatorId,
          previousOperatorName: previousOperator ? previousOperator.fullName : 'Unknown Operator',
          reason,
        },
      });

      // DOC-18 - identical recipient rules to managerUpdateRequest's own
      // UNASSIGNED branch: Employee + the removed Operator, never every
      // Operator in the Organization. Task spec section 11 - the reason is
      // deliberately NOT included in notification text by default (see
      // this function's own top comment / the final report's documented
      // decision) - it remains primarily an internal Request-history
      // field, visible via the Timeline (DOC-17), not pushed into a
      // notification message.
      await createRequestNotification({
        request: requestDoc,
        recipientId: requestDoc.createdBy,
        actorId: req.user.userId,
        type: 'REQUEST_UNASSIGNED',
        title: 'Your request was unassigned',
        message: `${requestNotificationLabel(requestDoc)} no longer has an assigned operator.`,
        metadata: { requestTitle: requestDoc.title },
      });
      if (previousOperator) {
        await createRequestNotification({
          request: requestDoc,
          recipientId: previousOperator._id,
          actorId: req.user.userId,
          type: 'REQUEST_UNASSIGNED',
          title: 'You were removed from a request',
          message: `You were removed from ${requestNotificationLabel(requestDoc)}.`,
          metadata: { requestTitle: requestDoc.title },
        });
      }

      const category = await ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId });
      return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, null) });
    }

    if (typeof operatorId !== 'string' || !mongoose.Types.ObjectId.isValid(operatorId)) {
      return res.status(400).json({ status: 'error', message: 'A valid operatorId is required.' });
    }

    // The one query that enforces every DOC-52 security rule at once
    // (task spec sections 4/15): same Organization, role === 'operator',
    // currently active, AND this Request's own categoryId is present in
    // the Operator's specialties array. An id that resolves to an
    // Employee, a Manager, a System Admin, an inactive Operator, a
    // cross-organization Operator, or an Operator without the matching
    // specialty are all indistinguishable via this single "not found"
    // result - the response below never reveals which of those it was.
    const operator = await User.findOne({
      _id: operatorId,
      organizationId: req.user.organizationId,
      role: 'operator',
      isActive: true,
      specialties: requestDoc.categoryId,
    });

    if (!operator) {
      return res.status(400).json({
        status: 'error',
        message: 'The selected operator is unavailable. Choose an active operator in your organization whose specialties include this request\'s category.',
      });
    }

    // Sprint 4 (DOC-22, preserved unchanged) - "reassigning the same
    // Operator" is a no-op, not a meaningful state change. Rejected
    // explicitly (400) rather than silently re-saving the identical value,
    // the same "no-op is its own kind of rejection" pattern DOC-12's
    // updateRequestStatus already uses for `requestDoc.status ===
    // nextStatus`. DOC-15 task spec section 6 - never reaches reason
    // validation, RequestActivity, or Notification creation; `updatedAt`
    // is never touched (the document is never saved on this path).
    if (previousOperatorId && String(previousOperatorId) === String(operator._id)) {
      return res.status(400).json({
        status: 'error',
        message: 'This request is already assigned to this operator.',
      });
    }

    // DOC-15 - reason required ONLY for a genuine REASSIGNMENT (replacing
    // a DIFFERENT operator) - task spec section 5's explicit carve-out
    // means a first assignment (previousOperatorId falsy) never validates
    // or reads `reason` at all, even if the client sent one.
    let reason = null;
    if (previousOperatorId) {
      const reasonError = validateAssignmentReason(body.reason);
      if (reasonError) {
        return res.status(400).json({ status: 'error', message: reasonError });
      }
      reason = body.reason.trim();
    }

    // Nothing else changes (task spec section 6) - status, title,
    // description, category, priority, attachments, and every other field
    // are left exactly as they were.
    requestDoc.assignedOperatorId = operator._id;
    await requestDoc.save();

    // Display name of the PREVIOUS operator, only resolved when this is a
    // genuine reassignment (previousOperatorId truthy) - snapshotted into
    // metadata at write time, exactly like `newOperatorName` below, so a
    // later name change or deactivation never rewrites this historical
    // event's display (see models/RequestActivity.js's own comment on why
    // oldValue/newValue for reference-typed events are resolved once,
    // here, rather than re-resolved live on every future read).
    const previousOperatorName = previousOperatorId
      ? (await User.findOne({ _id: previousOperatorId, organizationId: req.user.organizationId }))?.fullName || 'Unknown Operator'
      : null;

    // DOC-17 - DOC-15 extends this event's metadata with the task spec's
    // own preferred REASSIGNED shape (`previousOperatorId`,
    // `previousOperatorName`, `newOperatorId`, `newOperatorName`,
    // `reason`) - ASSIGNED (a genuine first assignment, no previous
    // operator, no reason) keeps the smaller, previously-established
    // `{newOperatorId, newOperatorName}` shape; there is no previous
    // operator or reason to record for it.
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: previousOperatorId ? 'REASSIGNED' : 'ASSIGNED',
      oldValue: previousOperatorId,
      newValue: operator._id,
      metadata: previousOperatorId
        ? {
          previousOperatorId,
          previousOperatorName,
          newOperatorId: operator._id,
          newOperatorName: operator.fullName,
          reason,
        }
        : { newOperatorId: operator._id, newOperatorName: operator.fullName },
    });

    // DOC-18 - "In-App Notifications". Task spec sections 18-19: the
    // Employee and the newly-assigned Operator are ALWAYS notified (first
    // assignment or reassignment alike); the previous Operator is notified
    // ONLY on a genuine reassignment (previousOperatorId truthy). The
    // Manager who performed this action never receives a self-notification
    // - `createNotification`'s own actor-exclusion check would already
    // skip it even without this, but the Manager is also structurally
    // never one of these three recipients (Employee/previous Operator/new
    // Operator) in the first place. Unrelated Operators are never notified
    // - only the two operator ids actually involved in this transition are
    // ever a recipient here. DOC-15 task spec section 11 - the
    // reassignment reason is deliberately NOT included in any of these
    // three notification messages by default (documented decision, final
    // report) - it is primarily internal Request-history, fully visible
    // via the Timeline (DOC-17) to anyone authorized to view this Request.
    const notificationType = previousOperatorId ? 'REQUEST_REASSIGNED' : 'REQUEST_ASSIGNED';
    await createRequestNotification({
      request: requestDoc,
      recipientId: requestDoc.createdBy,
      actorId: req.user.userId,
      type: notificationType,
      title: previousOperatorId ? 'Your request was reassigned' : 'Your request was assigned',
      message: previousOperatorId
        ? `${requestNotificationLabel(requestDoc)} was reassigned to ${operator.fullName}.`
        : `${requestNotificationLabel(requestDoc)} was assigned to ${operator.fullName}.`,
      metadata: { requestTitle: requestDoc.title, operatorName: operator.fullName },
    });
    await createRequestNotification({
      request: requestDoc,
      recipientId: operator._id,
      actorId: req.user.userId,
      type: notificationType,
      title: 'A request was assigned to you',
      message: `${requestNotificationLabel(requestDoc)} was assigned to you.`,
      metadata: { requestTitle: requestDoc.title },
    });
    if (previousOperatorId) {
      await createRequestNotification({
        request: requestDoc,
        recipientId: previousOperatorId,
        actorId: req.user.userId,
        type: notificationType,
        title: 'You were removed from a request',
        message: `You were removed from ${requestNotificationLabel(requestDoc)}.`,
        metadata: { requestTitle: requestDoc.title },
      });
    }

    const category = await ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId });

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, operator) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// Fields this endpoint ever reads from the request body - an explicit
// allowlist, exactly like EDITABLE_FIELDS/FORBIDDEN_EDIT_FIELDS above.
// `status`, `organizationId`, `createdBy`, `attachments`, and anything
// else are simply never read here, regardless of what a payload contains
// - the same silent-ignore shape assignRequestOperator already uses for
// `operatorId`, not a loud rejection (task spec: "Manager may never
// change createdBy / change organizationId / change attachments directly
// / change comments / delete Requests / force illegal status transitions"
// - all satisfied structurally by this endpoint never reading any of
// those fields, not by validating and rejecting them).
const MANAGER_EDITABLE_FIELDS = ['priority', 'categoryId', 'assignedOperatorId'];

// Statuses a Manager may never edit priority/category on at all - a
// closed or cancelled Request is administratively finished (task spec's
// broader "After cancellation Request becomes terminal" principle,
// extended here to closed for the same reason: editing a terminal
// Request's priority/category serves no operational purpose and would
// only corrupt historical reporting).
const MANAGER_EDIT_TERMINAL_STATUSES = ['closed', 'cancelled'];

// PATCH /api/requests/:id/manager (manager only)
//
// DOC-59 - the Manager's single combined edit endpoint: priority,
// category, and/or assigned Operator, any subset, in one call. Each field
// is read and applied independently based on whether it is actually
// PRESENT in the body (`Object.prototype.hasOwnProperty`, not just
// truthy) - this is what lets a Manager change only `priority` on a
// Request that is currently NOT 'open' (and therefore not assignment-
// eligible) without that unrelated field ever being touched or validated.
// `assignedOperatorId` supports three distinct intents:
//   - absent entirely: the current assignment is left completely alone.
//   - a valid Operator id: assign (if currently unassigned) or reassign
//     (if replacing a different Operator) - status must be 'open'.
//   - explicit JSON `null`: remove the current assignment - status must
//     be 'open', and there must actually BE an assignment to remove.
// DOC-15 - "Advanced Request History & Reassignment" - added one more
// optional top-level body field, `reason`, read ONLY when
// `assignedOperatorId` represents a genuine reassignment (replacing a
// DIFFERENT operator) or unassignment (explicit `null` with a real
// existing assignment) - required in both of those cases, never read or
// validated for a first assignment (task spec section 5), and never read
// at all when `assignedOperatorId` is absent from the body. This keeps
// this endpoint's reason requirement in exact parity with
// assignRequestOperator's own DOC-15 extension (PATCH /:id/assign) - a
// Manager reassigning/unassigning through EITHER of this project's two
// existing assignment-capable endpoints is held to the identical rule,
// so neither one is a way to bypass the other's audit-trail requirement.
// Every field-level rule below is validated BEFORE anything is written -
// a request that mixes one valid and one invalid field is rejected
// entirely, with no partial write, the same all-or-nothing shape
// updateMyRequest (DOC-46) already uses.
const managerUpdateRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    // Scoped by organizationId only - a Manager administers any Request in
    // their own Organization, not just ones they created (they never
    // create Requests). Nonexistent and cross-organization both collapse
    // into the same 404 (DOC-38 anti-enumeration convention).
    const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });
    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    const body = req.body || {};
    const hasPriority = Object.prototype.hasOwnProperty.call(body, 'priority');
    const hasCategoryId = Object.prototype.hasOwnProperty.call(body, 'categoryId');
    const hasAssignedOperatorId = Object.prototype.hasOwnProperty.call(body, 'assignedOperatorId');

    if (!hasPriority && !hasCategoryId && !hasAssignedOperatorId) {
      return res.status(400).json({
        status: 'error',
        message: `No valid fields to update. Allowed fields: ${MANAGER_EDITABLE_FIELDS.join(', ')}.`,
      });
    }

    if ((hasPriority || hasCategoryId) && MANAGER_EDIT_TERMINAL_STATUSES.includes(requestDoc.status)) {
      return res.status(409).json({
        status: 'error',
        message: `A ${requestDoc.status} request can no longer be edited.`,
      });
    }

    if (hasPriority) {
      const priorityError = validatePriority(body.priority, PRIORITY_VALUES);
      if (priorityError) {
        return res.status(400).json({ status: 'error', message: priorityError });
      }
    }

    // Resolved but not yet applied - only written to requestDoc after
    // every field below has also validated successfully.
    let resolvedCategory = null;
    if (hasCategoryId) {
      if (typeof body.categoryId !== 'string' || !mongoose.Types.ObjectId.isValid(body.categoryId)) {
        return res.status(400).json({ status: 'error', message: 'A valid categoryId is required.' });
      }
      // Active-only, same-Organization - identical shape to createRequest's
      // own categoryId resolution. Inactive, cross-organization, and
      // nonexistent are all indistinguishable via this single result.
      resolvedCategory = await ServiceCategory.findOne({
        _id: body.categoryId,
        organizationId: req.user.organizationId,
        isActive: true,
      });
      if (!resolvedCategory) {
        return res.status(400).json({
          status: 'error',
          message: 'The selected service category is unavailable. Please choose an active category from your organization.',
        });
      }
    }

    // Specialty-matching uses whichever category will actually be in
    // effect once this call completes: the newly-resolved one if
    // categoryId is also being changed in this same request, otherwise
    // the Request's existing category.
    const effectiveCategoryId = resolvedCategory ? resolvedCategory._id : requestDoc.categoryId;

    let resolvedOperator; // undefined = "don't touch assignedOperatorId"; null = "remove"; a User doc = "assign/reassign"
    // DOC-15 - only ever set (non-null) when this specific call is a
    // genuine reassignment/unassignment - a first assignment through this
    // endpoint never validates or reads `reason` either, the exact same
    // carve-out assignRequestOperator's own extension applies.
    let resolvedReason = null;
    if (hasAssignedOperatorId) {
      if (body.assignedOperatorId === null) {
        if (requestDoc.status !== 'open') {
          return res.status(409).json({
            status: 'error',
            message: 'Only an open request\'s assigned operator can be removed.',
          });
        }
        if (!requestDoc.assignedOperatorId) {
          return res.status(400).json({ status: 'error', message: 'This request has no assigned operator to remove.' });
        }
        // DOC-15 - unassignment always requires a reason (task spec
        // section 4), validated with the exact same rules/message shape
        // assignRequestOperator's own extension uses - one shared
        // validator (validateAssignmentReason), never two copies of the
        // same rule.
        const reasonError = validateAssignmentReason(body.reason);
        if (reasonError) {
          return res.status(400).json({ status: 'error', message: reasonError });
        }
        resolvedReason = body.reason.trim();
        resolvedOperator = null;
      } else {
        if (typeof body.assignedOperatorId !== 'string' || !mongoose.Types.ObjectId.isValid(body.assignedOperatorId)) {
          return res.status(400).json({ status: 'error', message: 'A valid assignedOperatorId is required.' });
        }
        if (requestDoc.status !== 'open') {
          return res.status(409).json({
            status: 'error',
            message: 'Only an open request can be assigned or reassigned to an operator.',
          });
        }
        // The same single-query, anti-enumeration shape assignRequestOperator
        // already uses: same Organization, role === 'operator', active,
        // AND the effective Category is in the Operator's specialties.
        const operator = await User.findOne({
          _id: body.assignedOperatorId,
          organizationId: req.user.organizationId,
          role: 'operator',
          isActive: true,
          specialties: effectiveCategoryId,
        });
        if (!operator) {
          return res.status(400).json({
            status: 'error',
            message: 'The selected operator is unavailable. Choose an active operator in your organization whose specialties include this request\'s category.',
          });
        }
        if (requestDoc.assignedOperatorId && String(requestDoc.assignedOperatorId) === String(operator._id)) {
          return res.status(400).json({
            status: 'error',
            message: 'This request is already assigned to this operator.',
          });
        }
        // DOC-15 - reason required ONLY when this is a genuine
        // reassignment (an assignment already exists and is being
        // replaced) - never for a first assignment (task spec section 5).
        if (requestDoc.assignedOperatorId) {
          const reasonError = validateAssignmentReason(body.reason);
          if (reasonError) {
            return res.status(400).json({ status: 'error', message: reasonError });
          }
          resolvedReason = body.reason.trim();
        }
        resolvedOperator = operator;
      }
    }

    // DOC-17 - captured BEFORE any of the three writes below, so each
    // "did this actually change" comparison (and REASSIGNED vs
    // ASSIGNED/UNASSIGNED classification) has a true original value.
    const previousValues = {
      priority: requestDoc.priority,
      categoryId: requestDoc.categoryId,
      assignedOperatorId: requestDoc.assignedOperatorId,
    };

    if (hasPriority) {
      requestDoc.priority = body.priority;
      // DOC-55 - "Priority Changes". Recalculated from the Request's own
      // ORIGINAL createdAt, never from "now" (task spec: "Do not reset the
      // SLA clock from the moment of editing... Managers must not gain
      // extra SLA time by repeatedly changing priority."). This may
      // immediately make the Request overdue (task spec's own worked
      // example) - that is expected and correct, not a bug: `isOverdue` is
      // computed dynamically from status + slaDueAt (utils/slaPolicy.js),
      // so no separate "mark overdue" step is needed here. A historical
      // pre-DOC-55 Request that never had SLA data is opportunistically
      // brought up to date here too - a Manager now has a definite
      // priority and this Request's own real createdAt to compute from,
      // so there is no reason to leave it permanently "SLA not available"
      // once it is touched.
      requestDoc.slaPolicyHours = SLA_HOURS_BY_PRIORITY[body.priority];
      requestDoc.slaDueAt = calculateSlaDueAt({ priority: body.priority, createdAt: requestDoc.createdAt });
    }
    if (resolvedCategory) {
      // DOC-55 - "Category Changes: Changing Category does not change the
      // SLA in this version. SLA depends only on priority." - deliberately
      // no slaDueAt/slaPolicyHours write in this branch.
      requestDoc.categoryId = resolvedCategory._id;
    }
    if (hasAssignedOperatorId) {
      requestDoc.assignedOperatorId = resolvedOperator ? resolvedOperator._id : null;
    }

    await requestDoc.save();

    // DOC-17 - up to three independent timeline events from this single
    // combined-edit call, each only recorded if that specific field's
    // value actually changed (task spec section 12's "only if actually
    // changed" principle, applied uniformly here too).
    if (hasPriority && body.priority !== previousValues.priority) {
      await recordRequestActivity({
        request: requestDoc,
        actorId: req.user.userId,
        type: 'PRIORITY_CHANGED',
        oldValue: previousValues.priority,
        newValue: body.priority,
      });
    }

    if (resolvedCategory && String(resolvedCategory._id) !== String(previousValues.categoryId)) {
      // Old category name resolved for display, exactly like
      // updateMyRequest's own CATEGORY_CHANGED handling above - not
      // restricted to isActive, since the previous category may since
      // have been deactivated.
      const previousCategory = await ServiceCategory.findOne({
        _id: previousValues.categoryId,
        organizationId: req.user.organizationId,
      });
      await recordRequestActivity({
        request: requestDoc,
        actorId: req.user.userId,
        type: 'CATEGORY_CHANGED',
        oldValue: previousValues.categoryId,
        newValue: resolvedCategory._id,
        metadata: {
          oldCategoryName: previousCategory ? previousCategory.name : 'Unknown Category',
          newCategoryName: resolvedCategory.name,
        },
      });
    }

    if (hasAssignedOperatorId) {
      if (resolvedOperator === null) {
        // DOC-17 section 17 - UNASSIGNED. Only ever reachable here when
        // `previousValues.assignedOperatorId` was truthy (this function's
        // own earlier validation already rejects removing a nonexistent
        // assignment with a 400), so a previous-operator lookup for
        // display always resolves a real, previously-assigned Operator.
        const previousOperator = await User.findOne({
          _id: previousValues.assignedOperatorId,
          organizationId: req.user.organizationId,
        });
        // DOC-15 - task spec section 9's preferred UNASSIGNED metadata
        // shape: `{previousOperatorId, previousOperatorName, reason}` -
        // `resolvedReason` was already validated (required, non-empty,
        // <=500 chars) above, before this Request was even saved.
        await recordRequestActivity({
          request: requestDoc,
          actorId: req.user.userId,
          type: 'UNASSIGNED',
          oldValue: previousValues.assignedOperatorId,
          newValue: null,
          metadata: {
            previousOperatorId: previousValues.assignedOperatorId,
            previousOperatorName: previousOperator ? previousOperator.fullName : 'Unknown Operator',
            reason: resolvedReason,
          },
        });
        // DOC-18 - task spec section 20: Employee + the removed Operator,
        // never every Operator in the Organization.
        await createRequestNotification({
          request: requestDoc,
          recipientId: requestDoc.createdBy,
          actorId: req.user.userId,
          type: 'REQUEST_UNASSIGNED',
          title: 'Your request was unassigned',
          message: `${requestNotificationLabel(requestDoc)} no longer has an assigned operator.`,
          metadata: { requestTitle: requestDoc.title },
        });
        if (previousOperator) {
          await createRequestNotification({
            request: requestDoc,
            recipientId: previousOperator._id,
            actorId: req.user.userId,
            type: 'REQUEST_UNASSIGNED',
            title: 'You were removed from a request',
            message: `You were removed from ${requestNotificationLabel(requestDoc)}.`,
            metadata: { requestTitle: requestDoc.title },
          });
        }
      } else if (resolvedOperator) {
        // Display name of the PREVIOUS operator, resolved only for a
        // genuine reassignment - same snapshot-at-write-time rationale as
        // assignRequestOperator's own identical lookup.
        const previousOperatorName = previousValues.assignedOperatorId
          ? (await User.findOne({ _id: previousValues.assignedOperatorId, organizationId: req.user.organizationId }))?.fullName || 'Unknown Operator'
          : null;
        // DOC-15 - see assignRequestOperator's own identical comment: task
        // spec section 9's preferred REASSIGNED metadata shape
        // (`previousOperatorId`, `previousOperatorName`, `newOperatorId`,
        // `newOperatorName`, `reason`) for a genuine reassignment; the
        // smaller, previously-established `{newOperatorId, newOperatorName}`
        // shape for a genuine first ASSIGNED (no previous operator, no
        // reason to record).
        await recordRequestActivity({
          request: requestDoc,
          actorId: req.user.userId,
          type: previousValues.assignedOperatorId ? 'REASSIGNED' : 'ASSIGNED',
          oldValue: previousValues.assignedOperatorId,
          newValue: resolvedOperator._id,
          metadata: previousValues.assignedOperatorId
            ? {
              previousOperatorId: previousValues.assignedOperatorId,
              previousOperatorName,
              newOperatorId: resolvedOperator._id,
              newOperatorName: resolvedOperator.fullName,
              reason: resolvedReason,
            }
            : { newOperatorId: resolvedOperator._id, newOperatorName: resolvedOperator.fullName },
        });
        // DOC-18 - identical recipient rules to assignRequestOperator's own
        // ASSIGNED/REASSIGNED notifications above (this endpoint reaches
        // the exact same underlying business transition through a
        // different route - the combined Manager edit form).
        {
          const managerNotificationType = previousValues.assignedOperatorId ? 'REQUEST_REASSIGNED' : 'REQUEST_ASSIGNED';
          await createRequestNotification({
            request: requestDoc,
            recipientId: requestDoc.createdBy,
            actorId: req.user.userId,
            type: managerNotificationType,
            title: previousValues.assignedOperatorId ? 'Your request was reassigned' : 'Your request was assigned',
            message: previousValues.assignedOperatorId
              ? `${requestNotificationLabel(requestDoc)} was reassigned to ${resolvedOperator.fullName}.`
              : `${requestNotificationLabel(requestDoc)} was assigned to ${resolvedOperator.fullName}.`,
            metadata: { requestTitle: requestDoc.title, operatorName: resolvedOperator.fullName },
          });
          await createRequestNotification({
            request: requestDoc,
            recipientId: resolvedOperator._id,
            actorId: req.user.userId,
            type: managerNotificationType,
            title: 'A request was assigned to you',
            message: `${requestNotificationLabel(requestDoc)} was assigned to you.`,
            metadata: { requestTitle: requestDoc.title },
          });
          if (previousValues.assignedOperatorId) {
            await createRequestNotification({
              request: requestDoc,
              recipientId: previousValues.assignedOperatorId,
              actorId: req.user.userId,
              type: managerNotificationType,
              title: 'You were removed from a request',
              message: `You were removed from ${requestNotificationLabel(requestDoc)}.`,
              metadata: { requestTitle: requestDoc.title },
            });
          }
        }
      }
    }

    const [category, assignedOperator] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      requestDoc.assignedOperatorId
        ? User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId })
        : Promise.resolve(null),
    ]);

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, assignedOperator) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// Statuses a Manager may cancel FROM - anything except the two already-
// terminal ones (task spec: "Manager Cancel: Any status except closed,
// cancelled"). Deliberately much broader than the Employee's own cancel
// action (DOC-46, open-and-unassigned only) - a Manager is administering
// the whole Organization's Requests, not just deciding whether to
// withdraw their own not-yet-started one.
const MANAGER_CANCEL_BLOCKED_STATUSES = ['closed', 'cancelled'];

// PATCH /api/requests/:id/manager/cancel (manager only)
//
// DOC-59 - "Cancel any Request instead of deleting it." A dedicated
// endpoint, not a reuse of DOC-46's Employee-only cancelMyRequest (task
// spec: "Do NOT overload existing Employee endpoints") - the eligibility
// rule, and what gets recorded, are both different: Employee cancel
// requires open+unassigned and records nothing beyond the status change;
// Manager cancel allows any non-terminal status and always records who
// cancelled it, when, and why.
const managerCancelRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });
    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    if (MANAGER_CANCEL_BLOCKED_STATUSES.includes(requestDoc.status)) {
      return res.status(409).json({
        status: 'error',
        message: `A ${requestDoc.status} request cannot be cancelled.`,
      });
    }

    const body = req.body || {};
    const reasonError = validateCancelReason(body.reason);
    if (reasonError) {
      return res.status(400).json({ status: 'error', message: reasonError });
    }

    // Server decides every one of these values - status, actor, and
    // timestamp are never read from req.body (task spec: never trust
    // client-supplied ownership fields). Only the reason's TEXT comes from
    // the caller.
    const previousStatus = requestDoc.status;
    requestDoc.status = 'cancelled';
    requestDoc.cancelledBy = req.user.userId;
    requestDoc.cancelledAt = new Date();
    requestDoc.cancelReason = body.reason.trim();
    await requestDoc.save();

    // DOC-17 section 19 - `cancelReason` is safe to include here: it is
    // already a normal, non-sensitive part of this exact same Request's
    // own response shape (sanitizeRequest's `cancelReason` field, visible
    // to the same audience that can already view this Request at all), so
    // repeating it in the timeline exposes nothing new.
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'REQUEST_CANCELLED',
      oldValue: previousStatus,
      newValue: 'cancelled',
      metadata: { cancelReason: requestDoc.cancelReason },
    });

    // DOC-18 - task spec section 25: Employee always notified; the
    // assigned Operator too, if one exists at the moment of cancellation.
    // `cancelReason` is included in the notification metadata for the
    // same reason DOC-17's own identical comment above already gives -
    // both recipients can already see this exact same field on this exact
    // same Request's own response shape (sanitizeRequest), so repeating it
    // here exposes nothing new to either of them.
    await createRequestNotification({
      request: requestDoc,
      recipientId: requestDoc.createdBy,
      actorId: req.user.userId,
      type: 'REQUEST_CANCELLED',
      title: 'Your request was cancelled',
      message: `${requestNotificationLabel(requestDoc)} was cancelled by the Manager.`,
      metadata: { requestTitle: requestDoc.title, cancelReason: requestDoc.cancelReason },
    });
    if (requestDoc.assignedOperatorId) {
      await createRequestNotification({
        request: requestDoc,
        recipientId: requestDoc.assignedOperatorId,
        actorId: req.user.userId,
        type: 'REQUEST_CANCELLED',
        title: 'A request was cancelled',
        message: `${requestNotificationLabel(requestDoc)} was cancelled by the Manager.`,
        metadata: { requestTitle: requestDoc.title, cancelReason: requestDoc.cancelReason },
      });
    }

    const [category, assignedOperator, cancelledByUser] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      requestDoc.assignedOperatorId
        ? User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId })
        : Promise.resolve(null),
      User.findById(req.user.userId),
    ]);

    return res.status(200).json({
      status: 'success',
      data: sanitizeRequest(requestDoc, category, assignedOperator, undefined, cancelledByUser),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// PATCH /api/requests/:id/manager/close (manager only)
//
// DOC-59 - "Close a resolved Request: resolved -> closed. Only." Reuses
// the SAME centralized canTransitionRequestStatus helper DOC-12's generic
// status endpoint already uses (task spec principle, applied consistently
// here even though DOC-59 does not explicitly say so: "do not create
// another status system") - this is not a second, parallel transition
// rule, it is the exact rule already encoded in MANAGER_TRANSITIONS =
// { resolved: ['closed'] } (utils/requestStatusTransitions.js), reached
// through a dedicated URL instead of the generic `{ status }` body shape
// (task spec: "Do NOT overload existing Employee endpoints" - this route
// is Manager-only and self-documenting, not a reason to duplicate the
// underlying rule).
const managerCloseRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid request id.' });
    }

    const requestDoc = await Request.findOne({ _id: id, organizationId: req.user.organizationId });
    if (!requestDoc) {
      return res.status(404).json({ status: 'error', message: 'Request not found.' });
    }

    const authorized = canTransitionRequestStatus({
      role: 'manager',
      currentStatus: requestDoc.status,
      nextStatus: 'closed',
      isCreator: false,
      isAssignedOperator: false,
    });

    if (!authorized) {
      return res.status(409).json({
        status: 'error',
        message: 'Only a resolved request can be closed.',
      });
    }

    const previousStatus = requestDoc.status;
    requestDoc.status = 'closed';
    // DOC-55 - same "set once" rule updateRequestStatus's own 'closed'
    // branch uses; resolvedAt is never touched here, so it is preserved
    // automatically (task spec: "preserve resolvedAt if it exists").
    if (!requestDoc.closedAt) {
      requestDoc.closedAt = new Date();
    }
    await requestDoc.save();

    // DOC-17 - the same REQUEST_CLOSED type updateRequestStatus's own
    // 'closed' branch uses, so "closed via the generic status endpoint"
    // and "closed via this dedicated Manager endpoint" are indistinguishable
    // in the timeline - both are simply "the Request was closed" (task
    // spec section 18's "one meaningful event per user action" convention).
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'REQUEST_CLOSED',
      oldValue: previousStatus,
      newValue: 'closed',
    });

    const [category, assignedOperator] = await Promise.all([
      ServiceCategory.findOne({ _id: requestDoc.categoryId, organizationId: req.user.organizationId }),
      requestDoc.assignedOperatorId
        ? User.findOne({ _id: requestDoc.assignedOperatorId, organizationId: req.user.organizationId })
        : Promise.resolve(null),
    ]);

    return res.status(200).json({ status: 'success', data: sanitizeRequest(requestDoc, category, assignedOperator) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// DOC-53 - "Dashboard Statistics". Shared by all three statistics
// endpoints below - validates ONLY the createdFrom/createdTo query
// parameters (reusing DOC-54's exact date-parsing behavior via
// buildCreatedAtRangeFilter, never a second implementation of "what does
// a date range mean") and merges the resulting filter on top of the
// caller's own trusted, already-role-scoped `baseQuery`. Mirrors
// buildRequestQuery's own "query parameters only ever ADD restrictions,
// never remove/override the base scope" contract, just for the one
// parameter family statistics actually supports (task spec explicitly
// does NOT ask for q/status/priority/etc. on these endpoints - "Dashboard
// statistics are based on the role's full authorized scope, optionally
// limited only by createdFrom/createdTo").
function applyStatisticsDateRange(baseQuery, queryParams) {
  const dateRange = buildCreatedAtRangeFilter(queryParams || {});
  if (dateRange.error) {
    return { error: dateRange.error };
  }
  return { query: { ...baseQuery, ...dateRange.filter } };
}

// GET /api/requests/statistics/mine (employee only)
//
// DOC-53 - Employee's own Dashboard statistics: totals/byStatus/
// byPriority/byCategory scoped to `{ organizationId, createdBy:
// req.user.userId }` - identical base scope to listMyRequests (DOC-11),
// completely independent of whatever DOC-54 search/filter state the
// Employee Dashboard's Request list currently has active (task spec:
// "They should NOT automatically change based on every DOC-54 search/
// filter control.").
const getMyRequestStatistics = async (req, res, next) => {
  try {
    const baseQuery = { createdBy: req.user.userId, organizationId: req.user.organizationId };
    const { query, error } = applyStatisticsDateRange(baseQuery, req.query);
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const {
      totals, byStatus, byPriority, byCategory, scopedDocs,
    } = await computeRequestStatistics(
      query,
      req.user.organizationId,
    );

    // DOC-55 - Employee statistics get exactly ONE SLA number (task spec:
    // "Employee: My Overdue Requests") - dueSoonCount/complianceRate/
    // averageResolutionMinutes are computed by the same shared helper but
    // deliberately never included in this response shape.
    const { overdueCount } = computeSlaStatistics(scopedDocs);

    return res.status(200).json({
      status: 'success',
      data: {
        totals, byStatus, byPriority, byCategory, sla: { overdueCount },
      },
    });
  } catch (error) {
    return next(error);
  }
};

// GET /api/requests/statistics/assigned (operator only)
//
// DOC-53 - Operator's own Dashboard statistics: totals/byStatus/
// byPriority/byCategory scoped to `{ organizationId, assignedOperatorId:
// req.user.userId }` - identical base scope to listAssignedRequests
// (DOC-52). Unassigned Requests and another Operator's Requests are
// structurally excluded by this same base scope, exactly like the list
// endpoint - there is no separate "exclusion" logic to keep in sync.
const getAssignedRequestStatistics = async (req, res, next) => {
  try {
    const baseQuery = { assignedOperatorId: req.user.userId, organizationId: req.user.organizationId };
    const { query, error } = applyStatisticsDateRange(baseQuery, req.query);
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const {
      totals, byStatus, byPriority, byCategory, scopedDocs,
    } = await computeRequestStatistics(
      query,
      req.user.organizationId,
    );

    // DOC-55 - Operator statistics get two SLA numbers (task spec:
    // "Operator: My Overdue Requests, My Due Soon Requests"), both already
    // correctly scoped to only THIS Operator's assigned Requests -
    // `scopedDocs` comes from the same `baseQuery` (assignedOperatorId:
    // req.user.userId, organizationId) every other number on this response
    // is scoped by.
    const { overdueCount, dueSoonCount } = computeSlaStatistics(scopedDocs);

    return res.status(200).json({
      status: 'success',
      data: {
        totals, byStatus, byPriority, byCategory, sla: { overdueCount, dueSoonCount },
      },
    });
  } catch (error) {
    return next(error);
  }
};

// GET /api/requests/statistics/organization (manager only)
//
// DOC-53 - Manager's whole-Organization Dashboard statistics: totals/
// byStatus/byPriority/byCategory scoped to `{ organizationId }` only -
// identical base scope to listOrganizationRequests (DOC-52), extended
// with two Manager-only additions the other two roles' statistics never
// have:
//   - `totals.unassigned` - one extra countDocuments call
//     (assignedOperatorId: null) within the same scope.
//   - `byOperator` - "Operator Workload" (computeOperatorWorkload,
//     utils/requestStatistics.js), reusing the SAME `scopedDocs` array
//     computeRequestStatistics already fetched for byCategory - never a
//     second full Request fetch just for this.
// Employee/Operator/Active/Inactive USER counts (Employees/Operators
// required by the task spec's "Manager Statistics" section) are
// deliberately NOT computed here - they are already fully available,
// unfiltered, from the Manager Dashboard's existing `GET /api/users` call
// (ManagerDashboard.jsx already loads the complete Employee/Operator list
// for role management; this endpoint would otherwise duplicate an
// existing calculation, which the task's own audit instructions say not
// to do).
const getOrganizationRequestStatistics = async (req, res, next) => {
  try {
    const baseQuery = { organizationId: req.user.organizationId };
    const { query, error } = applyStatisticsDateRange(baseQuery, req.query);
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const {
      totals, byStatus, byPriority, byCategory, scopedDocs,
    } = await computeRequestStatistics(query, req.user.organizationId);

    const [unassigned, byOperator] = await Promise.all([
      Request.countDocuments({ ...query, assignedOperatorId: null }),
      computeOperatorWorkload(scopedDocs, req.user.organizationId),
    ]);

    totals.unassigned = unassigned;

    // DOC-55 - Manager statistics get all four SLA numbers (task spec:
    // "Manager: Overdue Requests, Due Soon Requests, SLA Compliance Rate,
    // Average Resolution Time") - the only one of the three statistics
    // endpoints that exposes `slaComplianceRate`/`averageResolutionMinutes`
    // at all.
    const {
      overdueCount, dueSoonCount, slaComplianceRate, averageResolutionMinutes,
    } = computeSlaStatistics(scopedDocs);

    // DOC-68 - "Employee Satisfaction Rating" (task spec sections 18/19).
    // Deliberately NOT scoped by the same `query` (date-range/other
    // filters) as the Request statistics above - a satisfaction number is
    // about the Organization's ratings as a whole, not about "Requests
    // matching today's filter", and RequestRating has its own independent
    // organizationId scope (never req.user's Request-list filters).
    const { averageScore, totalRated, distribution, scopedRatings } = await computeSatisfactionStatistics(
      req.user.organizationId,
    );
    const byOperatorRating = await computeOperatorRatingBreakdown(scopedRatings, req.user.organizationId);

    return res.status(200).json({
      status: 'success',
      data: {
        totals,
        byStatus,
        byPriority,
        byCategory,
        byOperator,
        sla: {
          overdueCount, dueSoonCount, slaComplianceRate, averageResolutionMinutes,
        },
        satisfaction: {
          averageScore, totalRated, distribution, byOperator: byOperatorRating,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createRequest,
  listMyRequests,
  getMyRequestById,
  listOrganizationRequests,
  exportOrganizationRequestsCsv,
  listAssignedRequests,
  updateRequestStatus,
  assignRequestOperator,
  updateMyRequest,
  cancelMyRequest,
  addRequestAttachments,
  removeRequestAttachment,
  addCompletionImages,
  removeCompletionImage,
  getRequestAttachmentContent,
  getRequestActivities,
  managerUpdateRequest,
  managerCancelRequest,
  managerCloseRequest,
  getMyRequestStatistics,
  getAssignedRequestStatistics,
  getOrganizationRequestStatistics,
  sanitizeRequest,
  // DOC-16 - exported for the same reason sanitizeRequest already is: a
  // small, pure, easily unit-testable function with no controller-specific
  // req/res/next dependency of its own.
  requestNotificationLabel,
};
