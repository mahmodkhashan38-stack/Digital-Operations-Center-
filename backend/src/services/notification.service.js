/**
 * In-App Notifications - creation/read-state service (DOC-18)
 * -------------------------------------------------------------------------
 *
 * WHY THIS FILE EXISTS
 * The sole owner of all Notification writes and read-state changes in this
 * project - callers never call `Notification.create(...)` or mutate
 * `readAt` directly. Mirrors the exact "one owner of write logic"
 * discipline requestActivity.service.js (DOC-17) already established.
 *
 * WHAT THIS SERVICE DELIBERATELY DOES NOT DO
 * It does not decide WHO should be notified about WHAT, and it does not
 * build human-readable title/message text - those are business decisions
 * that belong where the business context (old/new values, resolved
 * User/Category documents) already lives: the calling controller (see
 * request.controller.js's own DOC-18 call sites, placed immediately next
 * to each corresponding DOC-17 `recordRequestActivity` call). This file
 * only knows how to safely WRITE a notification a caller has already fully
 * decided on, and how to safely change its own read state - task spec
 * section 6: "The service should handle: recipientId, organizationId,
 * actorId, requestId, type, safe metadata" (transport mechanics), not
 * "the service decides recipients or wording".
 *
 * ACTOR-EXCLUSION SAFETY NET (task spec section 9: "Do NOT notify a user
 * about an action they themselves performed unless there is a strong
 * reason"). Every call site in this project is already written to never
 * pass a recipient equal to the actor (e.g. a Manager assigning an
 * Operator never receives their own "you assigned..." notification) - but
 * `createNotification` ALSO enforces this centrally, as defense in depth:
 * if `actorId` and `recipientId` ever resolve to the same user (a future
 * call site bug, or a edge case no one anticipated), the notification is
 * silently skipped (returns `null`, not an error) rather than ever
 * delivering a "you did this" notification to the person who did it.
 *
 * FAILURE / CONSISTENCY STRATEGY (task spec section 33, mirrors DOC-17's
 * own documented choice in requestActivity.service.js): the underlying
 * Request/User business operation is always the PRIMARY action and must
 * never be made conditional on notification-creation success. Every
 * function here is called AFTER the corresponding business write has
 * already succeeded, and swallows its own errors internally (logs via
 * `console.error`, never throws) - a rare notification-write failure
 * produces a fully correct business outcome with one missing notification,
 * never a Request update that gets rolled back or blocked by a
 * notification failure. The same rejection of MongoDB multi-document
 * transactions applies here for the same reason (standalone `mongod`
 * compatibility) - see requestActivity.service.js's own longer writeup,
 * not repeated here.
 */

const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendSms } = require('./sms.service');

const NOTIFICATION_TYPES = Notification.NOTIFICATION_TYPES;

// Sprint 7 - "SMS + Phone Authentication Upgrade" - Phase 6, "MIRROR
// IN-APP NOTIFICATIONS TO SMS" / "CENTRALIZE MIRRORING". Task spec: "Do
// NOT add sendSms() separately to every controller if avoidable. Prefer
// central integration inside Notification service... This makes new
// Notification types automatically SMS-enabled." This is that one
// integration point - every existing call site (request/policy/knowledge/
// directMessage/chat/auth controllers, confirmed by this ticket's own
// Phase 1 audit to be the complete list) already funnels through
// `createNotification` below, so none of them needed any change at all.
//
// SMS BODY = "DOC: " + the notification's own already-safe `message`
// (task spec's own examples - "DOC: Request REQ-000123 was assigned to
// you." - are exactly this shape). `message` is ALREADY guaranteed safe
// by models/Notification.js's own documented contract (never sensitive
// DM content, never full policy/answer text, never a password/token) -
// reusing it verbatim, rather than building a second, parallel per-type
// SMS template, is what makes every CURRENT and FUTURE Notification type
// automatically SMS-enabled with zero additional code, exactly as task
// spec Phase 6 asks for. Truncated defensively to SMS_MAX_MESSAGE_LENGTH
// even though Notification.message is already schema-capped at 500 chars,
// purely to bound real-world SMS segment/cost concerns (see backend/
// README.md's own "SMS cost considerations" section).
const SMS_MAX_MESSAGE_LENGTH = 300;

function buildSmsBodyForNotification(notification) {
  const raw = `DOC: ${notification.message}`;
  return raw.length > SMS_MAX_MESSAGE_LENGTH
    ? `${raw.slice(0, SMS_MAX_MESSAGE_LENGTH - 1)}…`
    : raw;
}

// Best-effort, fire-and-forget mirror - task spec Phase 6 "SMS FAILURE
// POLICY": "In-app Notification is PRIMARY... if SMS fails: keep in-app
// Notification, log safe delivery failure, do not roll back application
// operation." Called AFTER the Notification document has already been
// durably created (see createNotification below) - never awaited by the
// caller in a way that could make a slow/failed SMS delay or fail the
// underlying business response, mirroring this file's own existing
// "notification creation never blocks the business operation" contract.
async function mirrorNotificationToSms(notification) {
  try {
    const recipient = await User.findById(notification.recipientId);
    // No recipient, no verified phone (task spec Phase 6 "PHONE NOT
    // VERIFIED" - "If recipient has no verified phone: in-app
    // Notification still works. SMS is skipped safely"), or system_admin
    // (never collects a phone number - see models/User.js) - a silent,
    // safe no-op, never an error surfaced to the caller.
    if (!recipient || recipient.phoneVerificationStatus !== 'verified' || !recipient.phoneNumber) {
      return;
    }

    await sendSms({
      to: recipient.phoneNumber,
      message: buildSmsBodyForNotification(notification),
      type: notification.type,
      recipientUserId: recipient._id,
      organizationId: notification.organizationId,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to mirror notification to SMS (type=${notification.type}, recipientId=${notification.recipientId}):`, error.message);
  }
}

// Creates one notification for one recipient. Never throws - every
// failure (a bad `type`, a missing required field, a database error, a
// self-notification attempt) is caught, logged (or silently skipped, for
// the deliberate self-notification case), and resolved to `null` rather
// than propagated - callers never need their own try/catch.
//
// `organizationId`/`recipientId`/`type`/`title`/`message` are required.
// `actorId`/`requestId` are optional (`null`) - see models/Notification.js
// for why. `metadata` defaults to `{}` and must always be a plain,
// already-safe structured object - never a password/token/S3 objectKey/
// GridFS internal/MongoDB credential (task spec section 3/37).
async function createNotification({
  organizationId, recipientId, actorId = null, requestId = null, type, title, message, metadata = {},
}) {
  try {
    if (!organizationId || !recipientId) {
      throw new Error('createNotification requires organizationId and recipientId.');
    }
    if (!NOTIFICATION_TYPES.includes(type)) {
      throw new Error(`createNotification received an unrecognized notification type: "${type}".`);
    }
    if (typeof title !== 'string' || !title.trim() || typeof message !== 'string' || !message.trim()) {
      throw new Error('createNotification requires a non-empty title and message.');
    }

    // Actor-exclusion safety net - see this file's own top comment. A
    // deliberate, silent no-op (not an error): a caller passing the same
    // id for both is either an intentional "system-generated, no actor"
    // call (actorId is null in that case, so this never triggers) or a
    // bug that would otherwise self-notify - either way, returning `null`
    // here is the correct, safe outcome.
    if (actorId && String(actorId) === String(recipientId)) {
      return null;
    }

    const notification = await Notification.create({
      organizationId,
      recipientId,
      actorId,
      requestId,
      type,
      title: title.trim(),
      message: message.trim(),
      metadata: metadata || {},
    });

    // Sprint 7 - fire-and-forget, never awaited into the caller's own
    // response latency/error path (task spec: SMS is best-effort for
    // ordinary notifications - see mirrorNotificationToSms's own top
    // comment). The in-app Notification above has already been durably
    // created regardless of what happens here.
    mirrorNotificationToSms(notification).catch(() => {});

    return notification;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to create notification (type=${type}, recipientId=${recipientId}):`, error.message);
    return null;
  }
}

// Convenience wrapper mirroring requestActivity.service.js's own
// `recordRequestActivity` ergonomics - derives `organizationId`/
// `requestId` from an already-saved Request document instead of requiring
// the caller to pass them separately (and therefore risk them ever
// silently disagreeing with the Request they are actually about).
async function createRequestNotification({
  request, recipientId, actorId = null, type, title, message, metadata = {},
}) {
  if (!request || !request._id || !request.organizationId) {
    // eslint-disable-next-line no-console
    console.error('createRequestNotification requires a saved Request document (with _id and organizationId).');
    return null;
  }
  return createNotification({
    organizationId: request.organizationId,
    recipientId,
    actorId,
    requestId: request._id,
    type,
    title,
    message,
    metadata,
  });
}

// Marks exactly one notification read - ONLY if it belongs to
// `recipientId` (task spec section 16: "Only recipient may mark it
// read... Another user must not be able to mark it read"). Returns the
// (possibly already-read) notification on success, or `null` if no
// matching notification exists for this recipient (the caller maps that
// to a 404 - this service never distinguishes "does not exist" from
// "belongs to someone else", the same anti-enumeration shape this project
// already uses elsewhere).
//
// IDEMPOTENT (task spec: "If already read: return success without
// changing readAt unnecessarily") - a second call for an already-read
// notification returns it unchanged, never overwriting a real historical
// `readAt` with a new timestamp.
async function markNotificationRead({ notificationId, recipientId, organizationId }) {
  const query = { _id: notificationId, recipientId };
  // Defense in depth only - recipientId alone already fully scopes this
  // to one user's own notifications; organizationId is optional here and,
  // when provided, adds one more independent check that can never widen
  // access, only narrow it further.
  if (organizationId) {
    query.organizationId = organizationId;
  }
  const notification = await Notification.findOne(query);
  if (!notification) {
    return null;
  }
  if (notification.readAt) {
    return notification;
  }
  notification.readAt = new Date();
  await notification.save();
  return notification;
}

// Marks every currently-unread notification belonging to `recipientId` as
// read, in one operation - NEVER touches another user's notifications,
// even one in the same Organization (task spec section 17: "Do not affect
// another user in same Organization"). Returns `{modifiedCount}` (task
// spec: "Return useful count if easy").
async function markAllNotificationsRead({ recipientId, organizationId }) {
  const query = { recipientId, readAt: null };
  if (organizationId) {
    query.organizationId = organizationId;
  }
  const result = await Notification.updateMany(query, { $set: { readAt: new Date() } });
  // Mongoose's updateMany result shape (`modifiedCount`) is used directly -
  // this service never recomputes it via a second query.
  return { modifiedCount: result.modifiedCount || 0 };
}

module.exports = {
  createNotification,
  createRequestNotification,
  markNotificationRead,
  markAllNotificationsRead,
  NOTIFICATION_TYPES,
};
