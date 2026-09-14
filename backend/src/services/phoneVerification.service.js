/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade" - Phone Verification
 * service (task spec Phase 4).
 * -------------------------------------------------------------------------
 *
 * THE ONE OWNER of PhoneVerificationChallenge writes and of
 * User.phoneVerifiedAt/phoneVerificationStatus transitions - the same
 * "one owner of write logic" discipline notification.service.js/
 * requestActivity.service.js already establish. Callers (controllers/
 * auth.controller.js's register/verifyPhone/resendPhoneOtp, controllers/
 * organization.controller.js's createAndLinkManager) never touch
 * PhoneVerificationChallenge or these two User fields directly.
 *
 * SHARED BY TWO FLOWS
 * `issueChallenge` and `verifyChallenge` are used identically by both
 * public registration (a brand-new employee) and System-Admin-initiated
 * Manager creation (task spec Phase 4 "MANAGER CREATION" - "Do not bypass
 * verification simply because System Admin created the user"). Neither
 * flow gets its own bespoke OTP implementation.
 *
 * SECURITY-CRITICAL SMS FAILURE (task spec Phase 5 "SECURITY SMS
 * FAILURE"): `issueChallenge` deletes the just-created challenge and
 * returns `{ error }` if the SMS could not be sent, rather than leaving a
 * live, unusable challenge (and, for registration, an account that can
 * never complete verification) behind. The calling controller is
 * responsible for rolling back the User document it just created in that
 * case (see auth.controller.js's `register` - this project does not use
 * MongoDB multi-document transactions, the same documented reason
 * requestActivity.service.js/notification.service.js already give, so
 * this is an explicit compensating rollback, not an atomic transaction).
 */

const bcrypt = require('bcryptjs');
const PhoneVerificationChallenge = require('../models/PhoneVerificationChallenge');
const User = require('../models/User');
const { generateOtp, OTP_LENGTH } = require('../utils/otp');
const { sendSms } = require('./sms.service');

const OTP_EXPIRES_IN_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const OTP_BCRYPT_SALT_ROUNDS = 10;

/**
 * Issues a brand-new OTP challenge for `userId`/`phoneNumber`, invalidates
 * any still-live prior challenge for the same user (task spec: "one-time
 * use" - extended to "at most one live code outstanding"), and sends it
 * by SMS.
 *
 * Returns `{ success: true }` once the SMS has been confirmed sent, or
 * `{ success: false, error }` if the SMS could not be sent - in the
 * latter case, the challenge this call created has already been deleted,
 * so there is no dangling/unusable record left behind.
 */
async function issueChallenge({
  userId, phoneNumber, organizationId = null,
}) {
  // Invalidate any prior still-live challenge for this user FIRST, before
  // creating the new one - guarantees at most one live challenge can ever
  // exist for a given user, even under a rapid double-submit of
  // "resend code".
  await PhoneVerificationChallenge.updateMany(
    { userId, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, OTP_BCRYPT_SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

  const challenge = await PhoneVerificationChallenge.create({
    userId, phoneNumber, codeHash, expiresAt,
  });

  const smsResult = await sendSms({
    to: phoneNumber,
    message: `DOC: Your verification code is ${code}. It expires in ${OTP_EXPIRES_IN_MINUTES} minutes. Do not share this code.`,
    type: 'PHONE_VERIFICATION',
    recipientUserId: userId,
    organizationId,
  });

  if (!smsResult.success) {
    // Compensating rollback - see this file's own top comment on why this
    // project does not use a transaction here.
    await PhoneVerificationChallenge.deleteOne({ _id: challenge._id }).catch(() => {});
    return {
      success: false,
      error: 'Unable to send a verification code to that phone number right now. Please try again shortly.',
    };
  }

  return { success: true };
}

/**
 * Verifies a submitted OTP against the current live challenge for
 * `userId`. On success, marks the challenge consumed and updates the
 * User's own phoneVerifiedAt/phoneVerificationStatus in the same call -
 * callers never need a second step to "apply" a successful verification.
 *
 * Returns `{ success: true }` or `{ success: false, error }` (a
 * client-safe message - never reveals whether the issue was "no such
 * challenge" vs "wrong code" vs "expired" beyond what task spec Phase 16
 * itself asks to be independently testable, which are all safe,
 * non-enumerating facts about the CALLER'S OWN account, not another
 * user's).
 */
async function verifyChallenge({ userId, code }) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    return { success: false, error: `Please enter the ${OTP_LENGTH}-digit verification code.` };
  }

  const challenge = await PhoneVerificationChallenge.findOne({ userId, consumedAt: null }).sort({ createdAt: -1 });
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
    { $set: { phoneVerifiedAt: new Date(), phoneVerificationStatus: 'verified' } },
  );

  return { success: true };
}

module.exports = {
  issueChallenge,
  verifyChallenge,
  OTP_EXPIRES_IN_MINUTES,
  MAX_OTP_ATTEMPTS,
};
