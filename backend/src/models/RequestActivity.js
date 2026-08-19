const mongoose = require('mongoose');

// DOC-17 - "Request Activity Timeline". A separate, append-only collection
// (never an ever-growing embedded array on Request.js) that records every
// meaningful lifecycle event a Request goes through: who did what, when,
// and what changed. This is deliberately NOT a general-purpose audit log
// for the whole application - it only ever records Request lifecycle
// events, written exclusively through services/requestActivity.service.js
// (see that file's own top comment for why controllers never call
// `RequestActivity.create(...)` directly).
//
// WHY A SEPARATE MODEL INSTEAD OF AN EMBEDDED ARRAY ON REQUEST
// A Request's own document already carries attachments, completionAttachments,
// and a growing set of workflow fields - adding an ever-growing `activity`
// array on top would (a) make every single Request read pull the ENTIRE
// history along with it even when nobody asked for it, (b) push documents
// toward MongoDB's 16 MB BSON size ceiling for a long-lived, frequently-
// touched Request, and (c) make simple, cheap operations like "how many
// activity events does this Request have" or "give me the last 20 events"
// require loading and slicing the whole Request document instead of a
// small, indexed, independently-queryable collection. A separate
// collection with `requestId`/`organizationId` references (never one
// collection per Organization - see the indexes below) is the standard,
// scalable shape for this kind of append-only historical data, the same
// pattern this project already uses for Comment.js (DOC-13) and
// ChatMessage.js (DOC-60) rather than embedding either of those either.
//
// IMMUTABILITY
// Activity records are audit-like historical data (task spec section 33):
// there is no update endpoint and no delete endpoint for a normal user -
// once written, a record is never edited or removed by anything in this
// project. Deactivating or (hypothetically) removing the acting User never
// deletes their historical activity records either (task spec section 6) -
// `actorId` is simply resolved defensively at read time (see
// controllers/request.controller.js's getRequestActivities), falling back
// to a safe "Unknown user" display when the referenced account can no
// longer be found.
const ACTIVITY_TYPES = [
  'REQUEST_CREATED',
  'REQUEST_UPDATED',
  'PRIORITY_CHANGED',
  'CATEGORY_CHANGED',
  'ASSIGNED',
  'REASSIGNED',
  'UNASSIGNED',
  'STATUS_CHANGED',
  'REQUEST_CANCELLED',
  'REQUEST_REOPENED',
  'REQUEST_CLOSED',
  'BEFORE_IMAGE_ADDED',
  'BEFORE_IMAGE_REMOVED',
  'COMPLETION_IMAGE_ADDED',
  'COMPLETION_IMAGE_REMOVED',
];

// `oldValue`/`newValue` deliberately hold different KINDS of value
// depending on `type` (documented per-type in requestActivity.service.js):
// a plain enum string for PRIORITY_CHANGED/STATUS_CHANGED/REQUEST_CANCELLED/
// REQUEST_REOPENED/REQUEST_CLOSED (display-ready as-is, no lookup needed),
// or an ObjectId-shaped string for CATEGORY_CHANGED/ASSIGNED/REASSIGNED/
// UNASSIGNED (a category/operator id, resolved to a safe display name only
// at response-serialization time - see getRequestActivities - never stored
// pre-resolved, so a category rename or operator name change is always
// reflected correctly on every future read). `Mixed` is used rather than a
// strict `String` type so `null` (very common - e.g. ASSIGNED's oldValue,
// UNASSIGNED's newValue) round-trips cleanly without becoming the string
// `"null"`.
const requestActivitySchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
      index: true,
    },
    // Who performed the action - always req.user.userId from a fresh,
    // DB-backed auth context (middleware/auth.js), never anything read
    // from req.body. Required: every event in this project has a real
    // human actor (there is no scheduled-job/system-initiated event type
    // in this task's scope). Only the id is stored - never a copy of the
    // User's fullName/role/email/etc. (task spec section 6: "Do NOT copy
    // sensitive User data into every activity").
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ACTIVITY_TYPES,
      required: true,
    },
    oldValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Free-form but ALWAYS structured (task spec section 28: "Do NOT store
    // finished English UI sentences in MongoDB. Store structured event
    // data.") - never a pre-rendered sentence like "Priority changed from
    // Medium to High by Mahmoud". The frontend maps `type` + `oldValue`/
    // `newValue` + `metadata` to human-readable text itself, which is what
    // keeps future localization/formatting possible without a data
    // migration. Shape varies by `type` - see
    // requestActivity.service.js's own per-type documentation.
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    // `createdAt` is the one timestamp this whole feature is built around
    // (task spec: "WHEN did it happen?") - Mongoose's own `timestamps`
    // option is reused rather than a hand-rolled `createdAt: Date.now`
    // field, exactly like every other timestamped model in this project.
    // `updatedAt` is also added by this option but is never meaningfully
    // used (records are immutable - see this file's own top comment) and
    // is never exposed in the API response (getRequestActivities' safe
    // response shape only ever includes `createdAt`).
    timestamps: true,
  },
);

// DOC-17 task spec section 32 - sensible indexes only, nothing
// speculative:
//   - `{ requestId: 1, createdAt: 1 }` - the ONE query this whole feature
//     exists to serve: "give me this Request's activity, in order."
//   - `{ organizationId: 1, requestId: 1, createdAt: 1 }` - the same
//     query, but matching the exact compound scope
//     getRequestActivities actually filters by (organizationId AND
//     requestId together, the same anti-enumeration double-scoped query
//     shape every other Request-scoped lookup in this controller already
//     uses) - lets that specific query use a single, fully-covering index
//     rather than falling back to the narrower `requestId`-only one above
//     plus an in-memory organizationId filter.
requestActivitySchema.index({ requestId: 1, createdAt: 1 });
requestActivitySchema.index({ organizationId: 1, requestId: 1, createdAt: 1 });

module.exports = mongoose.model('RequestActivity', requestActivitySchema);
module.exports.ACTIVITY_TYPES = ACTIVITY_TYPES;
