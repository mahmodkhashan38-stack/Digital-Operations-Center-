const mongoose = require('mongoose');

/**
 * DOC EMAIL AUTHENTICATION & NOTIFICATION UPGRADE - "EMAIL DELIVERY LOG".
 * -------------------------------------------------------------------------
 *
 * REPLACES SmsDelivery (retired - see that model's own former header
 * comment / git history). DECISION: minimal by design, unchanged from the
 * retired model's own reasoning - this collection NEVER stores the email
 * body/subject for ANY type, not just password/OTP messages: no
 * notification-mirror email body is sensitive enough to need its own
 * historical record either (the corresponding in-app Notification
 * document already durably records the safe title/message for those), so
 * a single, uniform "never store body" rule is simpler than a per-type
 * allowlist that could accidentally admit a sensitive type later.
 *
 * WRITTEN FROM EXACTLY ONE PLACE
 * services/email.service.js's own `sendEmail` creates one of these after
 * every single send attempt (success or failure) - callers never create
 * this document themselves, the same "one owner of write logic" pattern
 * notification.service.js/requestActivity.service.js already establish
 * in this project.
 *
 * SCHEMA
 *   recipientUserId - the User this email was ultimately for, when known
 *     (every call site in this project always knows this - email
 *     verification, temp-password delivery, and every notification-mirror
 *     send are all keyed by a real User). `null` only as defensive
 *     schema-level allowance, never actually written as null today.
 *   organizationId - the tenant boundary, when one exists (`null` for
 *     system_admin-targeted sends, which do not occur in this version but
 *     are not schema-prevented either).
 *   notificationType - a short label naming WHAT this email was about
 *     (reuses models/Notification.js's own NOTIFICATION_TYPES values for
 *     a notification-mirror send, or one of the two security-flow labels
 *     used by auth.controller.js/user.controller.js) - never a free-text
 *     event.
 *   provider - which EMAIL_PROVIDER handled this attempt ('mock', 'brevo',
 *     ...) - useful for debugging without needing to correlate against
 *     server logs/environment history.
 *   status - 'sent' | 'failed'. This project has no delivery-receipt
 *     webhook integration, so 'sent' means "the provider accepted the
 *     request", not "confirmed delivered to the inbox" - `deliveredAt`
 *     below is therefore always equal to `createdAt` for a 'sent' record
 *     in this version, kept as a distinct field only so a future
 *     webhook-based confirmation could populate it independently without
 *     a schema change.
 *   failureCode - a short, safe machine-readable reason (e.g.
 *     'PROVIDER_ERROR', 'INVALID_RECIPIENT', 'NOT_CONFIGURED') for a
 *     'failed' record - never a raw provider error message/stack trace,
 *     which could itself leak request details.
 *
 * IMMUTABLE, NO EDIT/DELETE ENDPOINT - same "immutable by omission"
 * pattern as AuditLog/RequestActivity/Notification.
 */
const EMAIL_STATUS_VALUES = ['sent', 'failed'];

const emailDeliverySchema = new mongoose.Schema(
  {
    recipientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    notificationType: {
      type: String,
      required: true,
      trim: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: EMAIL_STATUS_VALUES,
      required: true,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    failureCode: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

emailDeliverySchema.index({ recipientUserId: 1, createdAt: -1 });

module.exports = mongoose.model('EmailDelivery', emailDeliverySchema);
module.exports.EMAIL_STATUS_VALUES = EMAIL_STATUS_VALUES;
