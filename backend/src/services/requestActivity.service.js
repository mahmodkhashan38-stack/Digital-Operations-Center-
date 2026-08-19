/**
 * Request Activity Timeline - recording service (DOC-17)
 * -------------------------------------------------------------------------
 *
 * WHY THIS FILE EXISTS
 * The sole owner of all RequestActivity writes in this project - every
 * controller function that mutates a Request calls `recordRequestActivity`
 * here instead of calling `RequestActivity.create(...)` directly. This is
 * the same "one owner of storage/write logic" discipline
 * services/gridFsStorage.js and services/requestImageStorage.js already
 * established for image storage - it keeps activity-recording logic (what
 * gets derived server-side, what happens on failure) in exactly one place
 * instead of duplicated across a dozen controller functions.
 *
 * WHAT THIS SERVICE DERIVES SERVER-SIDE (never trusted from a caller)
 *   - `organizationId` - always `request.organizationId`, the Request
 *     document's OWN trusted field (task spec section 7: "organizationId
 *     must be derived server-side from the Request, NOT from req.body/
 *     req.query/frontend state").
 *   - `requestId` - always `request._id`.
 *   - `createdAt` - never client-suppliable at all (task spec section 34:
 *     "Client cannot forge createdAt") - Mongoose's own `timestamps` option
 *     on the RequestActivity schema sets it from server time the moment
 *     the document is actually written; nothing in this service or its
 *     callers ever passes a `createdAt` value in.
 * Callers only ever provide the EVENT-SPECIFIC information: which Request,
 * who did it (`actorId`, always `req.user.userId` - a trusted, DB-backed
 * value from middleware/auth.js, never `req.body.actorId`), what kind of
 * event, and the (optional) old/new values and metadata for that specific
 * event type.
 *
 * FAILURE / CONSISTENCY STRATEGY (task spec section 10 - "think carefully
 * about transactional consistency")
 * The Request document write is always the PRIMARY business action and
 * must never be made conditional on activity-log success (task spec: "Do
 * NOT silently create corrupt behavior" - the corrupt-behavior risk here
 * runs the OTHER direction: a Request update that fails or rolls back
 * *because* a secondary audit-log write failed would be the actual bug).
 * `recordRequestActivity` is therefore always called AFTER the
 * corresponding `requestDoc.save()`/`Request.create()` has already
 * succeeded, and it swallows its own errors internally (logs via
 * `console.error`, never throws) - a rare activity-log write failure
 * produces a Request whose business state is fully correct but has one
 * gap in its displayed timeline, never a Request whose real update was
 * rolled back or blocked by a logging failure.
 *
 * A real multi-document MongoDB transaction (`session.withTransaction()`)
 * was deliberately NOT used to make the Request-write-plus-activity-write
 * pair atomic. Multi-document transactions require the target MongoDB
 * deployment to be a replica set (or a mongos in front of a sharded
 * cluster) - a standalone `mongod`, which is a completely normal and
 * common local/development configuration (and this project's own prior
 * tickets have repeatedly disclosed having no outbound network access to
 * even confirm what the real deployment target is), throws immediately on
 * `session.startTransaction()` with "Transaction numbers are only allowed
 * on a replica set member or mongos." Wiring in transactions unconditionally
 * would risk breaking Request creation/editing/status changes entirely on
 * such a deployment - a MUCH worse outcome than the accepted best-effort
 * gap this design has instead (task spec's own explicit warning: "Do not
 * introduce a fragile transaction architecture that breaks standalone/
 * local MongoDB unnecessarily"). This is a deliberate, documented trade-off,
 * not an oversight - if a future deployment is confirmed to run as a
 * replica set, this function's internals (and only this function's
 * internals - no caller would need to change) could be upgraded to open a
 * session and wrap both writes, without changing this module's public
 * contract at all.
 */

const RequestActivity = require('../models/RequestActivity');

const ACTIVITY_TYPES = RequestActivity.ACTIVITY_TYPES;

// Records one Request lifecycle event. Never throws - every failure
// (a bad `type`, a database error, anything) is caught, logged, and
// resolved to `null` rather than propagated, per this file's own
// documented failure strategy above. Callers therefore never need their
// own try/catch around this call.
//
// `request` - the ALREADY-SAVED Mongoose Request document (or any object
//   with `_id`/`organizationId`, which is all this function actually
//   reads) - organizationId/requestId are derived from it, never passed
//   in separately by the caller.
// `actorId` - required; always the caller's own trusted `req.user.userId`.
// `type` - required; must be one of RequestActivity.ACTIVITY_TYPES (task
//   spec section 4: "Do not use arbitrary free-text event types" - a
//   caller passing anything else is a programming error, logged and
//   dropped rather than silently coerced into something else).
// `oldValue`/`newValue` - optional, default `null`. See
//   models/RequestActivity.js's own comment for what kind of value each
//   `type` expects here.
// `metadata` - optional, default `{}`. Always a plain structured object -
//   never a pre-rendered sentence (task spec section 28).
async function recordRequestActivity({
  request, actorId, type, oldValue = null, newValue = null, metadata = {},
}) {
  try {
    if (!request || !request._id || !request.organizationId) {
      throw new Error('recordRequestActivity requires a saved Request document (with _id and organizationId).');
    }
    if (!actorId) {
      throw new Error('recordRequestActivity requires actorId.');
    }
    if (!ACTIVITY_TYPES.includes(type)) {
      throw new Error(`recordRequestActivity received an unrecognized activity type: "${type}".`);
    }

    return await RequestActivity.create({
      organizationId: request.organizationId,
      requestId: request._id,
      actorId,
      type,
      oldValue,
      newValue,
      metadata: metadata || {},
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to record Request activity (type=${type}, requestId=${request && request._id}):`, error.message);
    return null;
  }
}

module.exports = {
  recordRequestActivity,
  ACTIVITY_TYPES,
};
