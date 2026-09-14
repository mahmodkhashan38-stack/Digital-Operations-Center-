/**
 * One-Time-Password generation - a tiny, dependency-free helper shared by
 * services/emailVerification.service.js's registration/Manager-creation
 * OTP flow (originally written for the now-retired Sprint 7 phone/SMS
 * verification - see git history - and reused as-is for email
 * verification, since a 6-digit numeric code is exactly as appropriate
 * typed from an email as it was from an SMS). Kept separate from that
 * service (rather than inlined) purely so the generation algorithm itself
 * has a single, obvious home, the same "one small utility, one job" shape
 * utils/tempPassword.js/utils/companyCode.js already establish.
 *
 * FORMAT ("cryptographically secure, recommended 6 digits"): a 6-digit
 * numeric string, zero-padded (e.g. "004821"), generated with
 * crypto.randomInt - never Math.random(). Numeric-only (not the
 * letter/digit alphabet utils/companyCode.js or utils/tempPassword.js
 * use) is a deliberate UX choice for THIS value specifically: an OTP is
 * meant to be typed on a numeric keypad/an `inputMode="numeric"` field,
 * unlike a Company Code or temporary password which are typed on a full
 * keyboard.
 */

const crypto = require('crypto');

const OTP_LENGTH = 6;
const OTP_MIN = 0;
const OTP_MAX = 10 ** OTP_LENGTH; // exclusive upper bound for crypto.randomInt

/**
 * Generates one cryptographically random 6-digit OTP as a zero-padded
 * string (e.g. "004821", never a Number - a Number would silently drop a
 * leading zero and change the OTP's own effective value on the way to
 * being stored/compared).
 */
function generateOtp() {
  const value = crypto.randomInt(OTP_MIN, OTP_MAX);
  return String(value).padStart(OTP_LENGTH, '0');
}

module.exports = { generateOtp, OTP_LENGTH };
