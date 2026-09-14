const mongoose = require('mongoose');

/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade" - Phase 14, "SMS
 * DELIVERY LOG" (task spec: "Optional but useful... Do NOT store sensitive
 * SMS body for password/OTP messages... If unnecessary, keep logging
 * minimal").
 * -------------------------------------------------------------------------
 *
 * DECISION: minimal by design. This collection NEVER stores the SMS
 * message body for ANY type, not just password/OTP messages - task spec's
 * own "if unnecessary, keep logging minimal" is taken at face value: no
 * notification-mirror SMS body is sensitive enough to need its own
 * historical record either (the corresponding in-app Notification
 * document already durably records the safe title/message for those), so
 * a single, uniform "never store body" rule is simpler than a per-type
 * allowlist that could accidentally admit a sensitive type later.
 *
 * WRITTEN FROM EXACTLY ONE PLACE
 * services/sms.service.js's own `sendSms` creates one of these after
 * every single send attempt (success or failure) - callers never create
 * this document themselves, the same "one owner of write logic" pattern
 * notification.service.js/requestActivity.service.js already establish
 * in this project.
 *
 * SCHEMA
 *   recipientUserId - the User this SMS was ultimately for, when known
 *     (every call site in this project always knows this - phone
 *     verification, temp-password delivery, and every notification-mirror
 *     send are all keyed by a real User). `null` only as defensive
 *     schema-level allowance, never actually written as null today.
 *   organizationId - the tenant boundary, when one exists (`null` for
 *     system_admin-targeted sends, which do not occur in this version but
 *     are not schema-prevented either).
 *   notificationType - a short label naming WHAT this SMS was about
 *     (reuses models/Notification.js's own NOTIFICATION_TYPES values for
 *     a notification-mirror send, or one of the two security-flow labels
 *     below for a security-critical send) - never a free-text event.
 *   provider - which SMS_PROVIDER handled this attempt ('mock', 'twilio',
 *     ...) - useful for debugging without needing to correlate against
 *     server logs/environment history.
 *   status - 'sent' | 'failed'. This project has no delivery-receipt
 *     webhook integration (task spec does not require one), so 'sent'
 *     means "the provider accepted the request", not "confirmed delivered
 *     to the handset" - `deliveredAt` below is therefore always equal to
 *     `createdAt` for a 'sent' record in this version, kept as a distinct
 *     field only so a future webhook-based confirmation could populate it
 *     independently without a schema change.
 *   failureCode - a short, safe machine-readable reason (e.g.
 *     'PROVIDER_ERROR', 'INVALID_NUMBER', 'NOT_CONFIGURED') for a
 *     'failed' record - never a raw provider error message/stack trace,
 *     which could itself leak request details.
 *
 * IMMUTABLE, NO EDIT/DELETE ENDPOINT - same "immutable by omission"
 * pattern as AuditLog/RequestActivity/Notification.
 */
const SMS_STATUS_VALUES = ['sent', 'failed'];

const smsDeliverySchema = new mongoose.Schema(
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
      enum: SMS_STATUS_VALUES,
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

smsDeliverySchema.index({ recipientUserId: 1, createdAt: -1 });

module.exports = mongoose.model('SmsDelivery', smsDeliverySchema);
module.exports.SMS_STATUS_VALUES = SMS_STATUS_VALUES;
