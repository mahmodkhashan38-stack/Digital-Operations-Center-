/**
 * DOC EMAIL AUTHENTICATION & NOTIFICATION UPGRADE - Email provider
 * abstraction.
 * -------------------------------------------------------------------------
 *
 * WHY THIS FILE EXISTS
 * The ONE place any code in this project ever sends an email. Every
 * caller (services/emailVerification.service.js, controllers/
 * auth.controller.js's forgotPassword, controllers/user.controller.js's
 * resetUserPassword, services/notification.service.js's central
 * email-mirroring hook) calls the exact same
 * `sendEmail({ to, subject, text, html, type })` signature regardless of
 * which real provider is configured or whether a provider is configured
 * at all. REPLACES services/sms.service.js (retired - see that file's own
 * former header comment / git history) - same shape, same guarantees,
 * only the channel changed.
 *
 * PROVIDER SELECTION (env-driven, never hardcoded):
 *   EMAIL_PROVIDER=mock   (default) - logs safe metadata only, never sends
 *     a real email. Always "succeeds" - this is what every local-dev/test
 *     run uses with zero configuration.
 *   EMAIL_PROVIDER=brevo  - a real, working implementation using Brevo's
 *     plain REST transactional-email API over HTTPS (no SDK dependency
 *     added - Brevo's API is a single POST endpoint, simple enough to
 *     call directly with Node's built-in `https`, keeping this project's
 *     existing "no new dependency for a single API call" discipline - the
 *     exact same reasoning the retired sms.service.js already applied to
 *     Twilio, and services/*AttachmentStorage.js apply to
 *     `@aws-sdk/client-s3` (added only because S3's protocol genuinely
 *     needs it) - Brevo's does not).
 *   Any other value - a clear configuration error (never silently falls
 *     back to mock in production - an operator who intentionally set
 *     EMAIL_PROVIDER to a real value and misspelled it should find out
 *     immediately, not discover months later that every "sent" email was
 *     actually a silent no-op).
 *
 * FAILURE SHAPE - NEVER THROWS
 * `sendEmail` always resolves to `{ success: boolean, provider,
 * failureCode }` - it never throws. This lets the TWO different failure
 * policies this project needs live entirely in the CALLER, not here:
 *   - ordinary notification-mirror sends (services/notification.service.js)
 *     check `.success` and, if false, simply log and move on (email is
 *     best-effort for these).
 *   - security-critical sends (email verification, Forgot Password/Manager
 *     emergency-reset temp password) check `.success` and, if false,
 *     ABORT the entire operation before any state-changing write happens
 *     ("Do not create a temporary password the user cannot receive").
 * This one function, one contract, two caller-side policies design is
 * exactly the same shape createNotification's own "never throws, caller
 * decides what a null result means" contract already established in this
 * project.
 *
 * NEVER LOGS SENSITIVE CONTENT ("Do NOT log... OTPs, temporary
 * passwords... full email body"). `text`/`html` (which MAY contain a live
 * OTP or a plaintext temporary password, depending on `type`) are NEVER
 * written to console.log/console.error, NEVER persisted to EmailDelivery
 * (see that model's own top comment - it stores no body at all, for any
 * type), and NEVER included in the object this function resolves to. Only
 * `to` (never fully redacted - unlike a phone number, an email address on
 * its own is not usually treated as a sensitive value in this project's
 * existing logs, e.g. AuditLog/console error messages already reference
 * emails elsewhere - but is still not logged here beyond what the mock
 * provider's own single debug line below shows), `type`, and the body's
 * `.length` are ever used for the mock provider's own safe debug line.
 */

const https = require('https');
const EmailDelivery = require('../models/EmailDelivery');

const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'mock').trim().toLowerCase();

const FAILURE_CODES = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNRECOGNIZED_PROVIDER: 'UNRECOGNIZED_PROVIDER',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
};

// Best-effort, never blocks/fails the actual send outcome that already
// happened - a logging failure must never be mistaken for (or cause) an
// email-send failure. Mirrors the retired sms.service.js's own
// "swallow-and-log, never throw" discipline for exactly the same reason.
async function recordDelivery({
  recipientUserId, organizationId, notificationType, provider, status, failureCode,
}) {
  try {
    await EmailDelivery.create({
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
    console.error('Failed to record EmailDelivery entry (non-fatal):', error.message);
  }
}

// Mock provider - always succeeds. Logs ONLY safe metadata, exactly as
// this file's own top comment requires - `text`/`html` themselves are
// deliberately never referenced here beyond their `.length`.
function sendViaMock({
  to, subject, text, html,
}) {
  const bodyLength = (text || html || '').length;
  // eslint-disable-next-line no-console
  console.log(`[email:mock] to=${to} subject="${subject}" length=${bodyLength}`);
  return { success: true, failureCode: null };
}

// Real provider - Brevo transactional email REST API, called directly
// over HTTPS (no SDK). Credentials come ONLY from environment variables.
// Never logs BREVO_API_KEY, the request body (which contains
// `text`/`html`), or the raw response body.
function sendViaBrevo({
  to, subject, text, html,
}) {
  return new Promise((resolve) => {
    const apiKey = process.env.BREVO_API_KEY;
    const fromAddress = process.env.EMAIL_FROM_ADDRESS;
    const fromName = process.env.EMAIL_FROM_NAME || 'Digital Operations Center';

    if (!apiKey || !fromAddress) {
      // eslint-disable-next-line no-console
      console.error('[email:brevo] Not configured - BREVO_API_KEY and EMAIL_FROM_ADDRESS are both required.');
      resolve({ success: false, failureCode: FAILURE_CODES.NOT_CONFIGURED });
      return;
    }

    const payload = JSON.stringify({
      sender: { email: fromAddress, name: fromName },
      to: [{ email: to }],
      subject,
      textContent: text || undefined,
      htmlContent: html || undefined,
    });

    const req = https.request(
      {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        // The response body is drained but never logged/inspected beyond
        // its status code - it could echo request details back, which
        // this function must never surface into a log line.
        res.on('data', () => {});
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            // eslint-disable-next-line no-console
            console.error(`[email:brevo] Provider returned HTTP ${res.statusCode}.`);
          }
          resolve({ success: ok, failureCode: ok ? null : FAILURE_CODES.PROVIDER_ERROR });
        });
      },
    );

    req.on('error', (error) => {
      // eslint-disable-next-line no-console
      console.error('[email:brevo] Request failed:', error.message);
      resolve({ success: false, failureCode: FAILURE_CODES.PROVIDER_ERROR });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Sends one email. Never throws.
 *
 * @param {object} params
 * @param {string} params.to - recipient email address.
 * @param {string} params.subject - short, already-safe subject line.
 * @param {string} [params.text] - plaintext body. MAY contain an OTP or a
 *   temporary password depending on `type` - never logged/persisted by
 *   this function.
 * @param {string} [params.html] - optional HTML body, same sensitivity
 *   rules as `text`. At least one of `text`/`html` must be provided.
 * @param {string} params.type - a short label (a Notification type, or
 *   'EMAIL_VERIFICATION' / 'PASSWORD_RESET_TEMP_PASSWORD') identifying
 *   what this email was about, for EmailDelivery logging only.
 * @param {string|null} [params.recipientUserId] - for EmailDelivery logging.
 * @param {string|null} [params.organizationId] - for EmailDelivery logging.
 * @returns {Promise<{success: boolean, provider: string, failureCode: string|null}>}
 */
async function sendEmail({
  to, subject, text, html, type, recipientUserId = null, organizationId = null,
}) {
  const body = text || html;
  if (typeof to !== 'string' || !to.trim() || typeof subject !== 'string' || !subject.trim() || typeof body !== 'string' || !body.trim()) {
    await recordDelivery({
      recipientUserId, organizationId, notificationType: type, provider: EMAIL_PROVIDER, status: 'failed', failureCode: FAILURE_CODES.INVALID_RECIPIENT,
    });
    return { success: false, provider: EMAIL_PROVIDER, failureCode: FAILURE_CODES.INVALID_RECIPIENT };
  }

  let result;
  if (EMAIL_PROVIDER === 'mock') {
    result = sendViaMock({
      to, subject, text, html,
    });
  } else if (EMAIL_PROVIDER === 'brevo') {
    // eslint-disable-next-line no-await-in-loop
    result = await sendViaBrevo({
      to, subject, text, html,
    });
  } else {
    // eslint-disable-next-line no-console
    console.error(`[email] Unrecognized EMAIL_PROVIDER="${EMAIL_PROVIDER}" (expected "mock" or "brevo").`);
    result = { success: false, failureCode: FAILURE_CODES.UNRECOGNIZED_PROVIDER };
  }

  await recordDelivery({
    recipientUserId,
    organizationId,
    notificationType: type,
    provider: EMAIL_PROVIDER,
    status: result.success ? 'sent' : 'failed',
    failureCode: result.failureCode,
  });

  return { success: result.success, provider: EMAIL_PROVIDER, failureCode: result.failureCode };
}

module.exports = { sendEmail, EMAIL_PROVIDER, FAILURE_CODES };
