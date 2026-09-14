/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade" - SMS provider
 * abstraction (task spec Phase 5).
 * -------------------------------------------------------------------------
 *
 * WHY THIS FILE EXISTS
 * The ONE place any code in this project ever sends an SMS. Task spec:
 * "Do not spread provider-specific SDK calls through controllers." Every
 * caller (services/phoneVerification.service.js, controllers/
 * auth.controller.js's forgotPassword, controllers/user.controller.js's
 * resetUserPassword, services/notification.service.js's central
 * SMS-mirroring hook) calls the exact same `sendSms({ to, message, type })`
 * signature regardless of which real provider is configured or whether a
 * provider is configured at all.
 *
 * PROVIDER SELECTION (env-driven, never hardcoded - task spec: "Do not
 * hardcode SMS provider credentials"):
 *   SMS_PROVIDER=mock    (default) - logs safe metadata only, never sends
 *     a real SMS. Always "succeeds" (task spec: "may record safe delivery
 *     metadata") - this is what every local-dev/test run uses with zero
 *     configuration.
 *   SMS_PROVIDER=twilio  - a real, working implementation using Twilio's
 *     plain REST API over HTTPS Basic Auth (no @twilio SDK dependency
 *     added - Twilio's Messages API is a single POST endpoint, simple
 *     enough to call directly with Node's built-in `https`, keeping this
 *     project's existing "no new dependency for a single API call"
 *     discipline, the same reasoning services/*AttachmentStorage.js
 *     already apply to `@aws-sdk/client-s3` (added only because S3's
 *     protocol genuinely needs it) - Twilio's does not). Requires
 *     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and SMS_FROM (the Twilio
 *     phone number/alphanumeric sender id to send from), all read from
 *     environment variables only.
 *   Any other value - a clear configuration error (never silently falls
 *     back to mock in production - an operator who intentionally set
 *     SMS_PROVIDER to a real value and misspelled it should find out
 *     immediately, not discover months later that every "sent" SMS was
 *     actually a silent no-op).
 *
 * FAILURE SHAPE - NEVER THROWS
 * `sendSms` always resolves to `{ success: boolean, provider, failureCode }`
 * - it never throws. This lets the TWO different failure policies task
 * spec Phases 5-6 require live entirely in the CALLER, not here:
 *   - ordinary notification-mirror sends (services/notification.service.js)
 *     check `.success` and, if false, simply log and move on (SMS is
 *     best-effort for these - task spec Phase 6 "SMS FAILURE POLICY").
 *   - security-critical sends (phone verification, Forgot Password/
 *     Manager-emergency-reset temp password) check `.success` and, if
 *     false, ABORT the entire operation before any state-changing write
 *     happens (task spec Phase 5 "SECURITY SMS FAILURE" - "Do not create
 *     a temporary password the user cannot receive").
 * This one function, one contract, two caller-side policies design is
 * exactly the same shape createNotification's own "never throws, caller
 * decides what a null result means" contract already established in this
 * project (services/notification.service.js).
 *
 * NEVER LOGS SENSITIVE CONTENT (task spec, repeated across every phase of
 * this ticket - "Do NOT log... OTPs, temporary passwords... full SMS
 * message"). `message` (which MAY contain a live OTP or a plaintext
 * temporary password, depending on `type`) is NEVER written to
 * console.log/console.error, NEVER persisted to SmsDelivery (see that
 * model's own top comment - it stores no body at all, for any type), and
 * NEVER included in the object this function resolves to. Only `to`
 * (masked), `type`, and `message.length` are ever used for the mock
 * provider's own safe debug line.
 */

const https = require('https');
const SmsDelivery = require('../models/SmsDelivery');
const { maskPhoneNumber } = require('../utils/phoneNumber');

const SMS_PROVIDER = (process.env.SMS_PROVIDER || 'mock').trim().toLowerCase();

const FAILURE_CODES = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNRECOGNIZED_PROVIDER: 'UNRECOGNIZED_PROVIDER',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
};

// Best-effort, never blocks/fails the actual send outcome that already
// happened - a logging failure must never be mistaken for (or cause) an
// SMS-send failure. Mirrors notification.service.js's own
// "swallow-and-log, never throw" discipline for exactly the same reason.
async function recordDelivery({
  recipientUserId, organizationId, notificationType, provider, status, failureCode,
}) {
  try {
    await SmsDelivery.create({
      recipientUserId: recipientUserId || null,
      organizationId: organizationId || null,
      notificationType: notificationType || 'UNKNOWN',
      provider,
      status,
      deliveredAt: status === 'sent' ? new Date() : null,
      failureCode: failureCode || null,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to record SmsDelivery entry (non-fatal):', error.message);
  }
}

// Mock provider - task spec Phase 5 "MOCK MODE". Always succeeds. Logs
// ONLY safe metadata, exactly as this file's own top comment requires -
// `message` itself is deliberately never referenced here beyond its
// `.length`.
function sendViaMock({ to, message, type }) {
  // eslint-disable-next-line no-console
  console.log(
    `[sms:mock] to=${maskPhoneNumber(to) || '(invalid number)'} type=${type} length=${message.length}`,
  );
  return { success: true, failureCode: null };
}

// Real provider - Twilio REST API, called directly over HTTPS (no SDK).
// Credentials come ONLY from environment variables (task spec: "Do not
// hardcode SMS provider credentials... Credentials must come only from
// environment variables"). Never logs TWILIO_AUTH_TOKEN, the request
// body (which contains `message`), or the raw response body (which could
// echo the message back).
function sendViaTwilio({ to, message }) {
  return new Promise((resolve) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.SMS_FROM;

    if (!accountSid || !authToken || !from) {
      // eslint-disable-next-line no-console
      console.error('[sms:twilio] Not configured - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and SMS_FROM are all required.');
      resolve({ success: false, failureCode: FAILURE_CODES.NOT_CONFIGURED });
      return;
    }

    const body = new URLSearchParams({ To: to, From: from, Body: message }).toString();
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // The response body is drained but never logged/inspected beyond
        // its status code - it may echo the message body back, which this
        // function must never surface into a log line.
        res.on('data', () => {});
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            // eslint-disable-next-line no-console
            console.error(`[sms:twilio] Provider returned HTTP ${res.statusCode}.`);
          }
          resolve({ success: ok, failureCode: ok ? null : FAILURE_CODES.PROVIDER_ERROR });
        });
      },
    );

    req.on('error', (error) => {
      // eslint-disable-next-line no-console
      console.error('[sms:twilio] Request failed:', error.message);
      resolve({ success: false, failureCode: FAILURE_CODES.PROVIDER_ERROR });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Sends one SMS. Never throws.
 *
 * @param {object} params
 * @param {string} params.to - E.164 recipient number.
 * @param {string} params.message - Plaintext SMS body. MAY contain an OTP
 *   or a temporary password depending on `type` - never logged/persisted
 *   by this function.
 * @param {string} params.type - A short label (a Notification type, or
 *   'PHONE_VERIFICATION' / 'PASSWORD_RESET_TEMP_PASSWORD') identifying
 *   what this SMS is about, for SmsDelivery logging only.
 * @param {string|null} [params.recipientUserId] - for SmsDelivery logging.
 * @param {string|null} [params.organizationId] - for SmsDelivery logging.
 * @returns {Promise<{success: boolean, provider: string, failureCode: string|null}>}
 */
async function sendSms({
  to, message, type, recipientUserId = null, organizationId = null,
}) {
  if (typeof to !== 'string' || !to.trim() || typeof message !== 'string' || !message.trim()) {
    await recordDelivery({
      recipientUserId, organizationId, notificationType: type, provider: SMS_PROVIDER, status: 'failed', failureCode: FAILURE_CODES.INVALID_RECIPIENT,
    });
    return { success: false, provider: SMS_PROVIDER, failureCode: FAILURE_CODES.INVALID_RECIPIENT };
  }

  let result;
  if (SMS_PROVIDER === 'mock') {
    result = sendViaMock({ to, message, type });
  } else if (SMS_PROVIDER === 'twilio') {
    // eslint-disable-next-line no-await-in-loop
    result = await sendViaTwilio({ to, message });
  } else {
    // eslint-disable-next-line no-console
    console.error(`[sms] Unrecognized SMS_PROVIDER="${SMS_PROVIDER}" (expected "mock" or "twilio").`);
    result = { success: false, failureCode: FAILURE_CODES.UNRECOGNIZED_PROVIDER };
  }

  await recordDelivery({
    recipientUserId,
    organizationId,
    notificationType: type,
    provider: SMS_PROVIDER,
    status: result.success ? 'sent' : 'failed',
    failureCode: result.failureCode,
  });

  return { success: result.success, provider: SMS_PROVIDER, failureCode: result.failureCode };
}

module.exports = { sendSms, SMS_PROVIDER, FAILURE_CODES };
