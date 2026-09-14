/**
 * DOC EMAIL AUTHENTICATION & NOTIFICATION UPGRADE - Email Verification
 * service.
 * -------------------------------------------------------------------------
 *
 * THE ONE OWNER of EmailVerificationChallenge writes and of
 * User.emailVerifiedAt/emailVerificationStatus transitions - the same
 * "one owner of write logic" discipline notification.service.js/
 * requestActivity.service.js already establish. Callers (controllers/
 * auth.controller.js's register/verifyEmail/resendEmailOtp, controllers/
 * organization.controller.js's createAndLinkManager) never touch
 * EmailVerificationChallenge or these two User fields directly.
 *
 * REPLACES services/phoneVerification.service.js (retired - see that
 * file's own former header comment / git history). Same shape, same
 * guarantees, same shared-by-two-flows design - only the delivery channel
 * (email instead of SMS) changed. The OTP generator itself
 * (utils/otp.js's `generateOtp`/`OTP_LENGTH`) is unchanged and reused
 * as-is - a 6-digit numeric code is exactly as appropriate typed from an
 * email as it was from an SMS.
 *
 * SHARED BY TWO FLOWS
 * `issueChallenge` and `verifyChallenge` are used identically by both
 * public registration (a brand-new employee) and System-Admin-initiated
 * Manager creation ("Do not bypass verification simply because System
 * Admin created the user"). Neither flow gets its own bespoke OTP
 * implementation.
 *
 * SECURITY-CRITICAL EMAIL FAILURE: `issueChallenge` deletes the
 * just-created challenge and returns `{ error }` if the email could not
 * be sent, rather than leaving a live, unusable challenge (and, for
 * registration, an account that can never complete verification) behind.
 * The calling controller is responsible for rolling back the User
 * document it just created in that case (see auth.controller.js's
 * `register` - this project does not use MongoDB multi-document
 * transactions, the same documented reason requestActivity.service.js/
 * notification.service.js already give, so this is an explicit
 * compensating rollback, not an atomic transaction).
 */

const bcrypt = require('bcryptjs');
const EmailVerificationChallenge = require('../models/EmailVerificationChallenge');
const User = require('../models/User');
const { generateOtp, OTP_LENGTH } = require('../utils/otp');
const { sendEmail } = require('./email.service');

const OTP_EXPIRES_IN_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const OTP_BCRYPT_SALT_ROUNDS = 10;

/**
 * Issues a brand-new OTP challenge for `userId`/`email`, invalidates any
 * still-live prior challenge for the same user ("one-time use" - extended
 * to "at most one live code outstanding"), and sends it by email.
 *
 * Returns `{ success: true }` once the email has been confirmed sent, or
 * `{ success: false, error }` if the email could not be sent - in the
 * latter case, the challenge this call created has already been deleted,
 * so there is no dangling/unusable record left behind.
 */
async function issueChallenge({
  userId, email, organizationId = null,
}) {
  // Invalidate any prior still-live challenge for this user FIRST, before
  // creating the new one - guarantees at most one live challenge can ever
  // exist for a given user, even under a rapid double-submit of
  // "resend code".
  await EmailVerificationChallenge.updateMany(
    { userId, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, OTP_BCRYPT_SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

  const challenge = await EmailVerificationChallenge.create({
    userId, email, codeHash, expiresAt,
  });

  const emailResult = await sendEmail({
    to: email,
    subject: 'DOC - Verify Your Email',
    text: `Your Digital Operations Center verification code is ${code}. It expires in ${OTP_EXPIRES_IN_MINUTES} minutes. Do not share this code with anyone.`,
    type: 'EMAIL_VERIFICATION',
    recipientUserId: userId,
    organizationId,
  });

  if (!emailResult.success) {
    // Compensating rollback - see this file's own top comment on why this
    // project does not use a transaction here.
    await EmailVerificationChallenge.deleteOne({ _id: challenge._id }).catch(() => {});
    return {
      success: false,
      error: 'Unable to send a verification code to that email address right now. Please try again shortly.',
    };
  }

  return { success: true };
}

/**
 * Verifies a submitted OTP against the current live challenge for
 * `userId`. On success, marks the challenge consumed and updates the
 * User's own emailVerifiedAt/emailVerificationStatus in the same call -
 * callers never need a second step to "apply" a successful verification.
 *
 * Returns `{ success: true }` or `{ success: false, error }` (a
 * client-safe message - never reveals whether the issue was "no such
 * challenge" vs "wrong code" vs "expired" beyond what is independently
 * testable, which are all safe, non-enumerating facts about the CALLER'S
 * OWN account, not another user's).
 */
async function verifyChallenge({ userId, code }) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return { success: false, error: `Please enter the ${OTP_LENGTH}-digit verification code.` };
  }

  const challenge = await EmailVerificationChallenge.findOne({ userId, consumedAt: null }).sort({ createdAt: -1 });
  if (!challenge) {
    return { success: false, error: 'No active verification code found for this account. Request a new one.' };
  }

  if (challenge.expiresAt.getTime() < Date.now()) {
    challenge.consumedAt = new Date();
    await challenge.save();
    return { success: false, error: 'This verification code has expired. Request a new one.' };
  }

  if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
    challenge.consumedAt = new Date();
    await challenge.save();
    return { success: false, error: 'Too many incorrect attempts. Request a new verification code.' };
  }

  const isMatch = await bcrypt.compare(code.trim(), challenge.codeHash);
  if (!isMatch) {
    challenge.attempts += 1;
    await challenge.save();
    return { success: false, error: 'Incorrect verification code.' };
  }

  challenge.consumedAt = new Date();
  await challenge.save();

  await User.updateOne(
    { _id: userId },
    { $set: { emailVerifiedAt: new Date(), emailVerificationStatus: 'verified' } },
  );

  return { success: true };
}

module.exports = {
  issueChallenge,
  verifyChallenge,
  OTP_EXPIRES_IN_MINUTES,
  MAX_OTP_ATTEMPTS,
};
