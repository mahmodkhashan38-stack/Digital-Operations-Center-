/**
 * Sprint 7 - "SMS + Phone Authentication Upgrade". Generates the
 * server-side, cryptographically random temporary password used by the
 * new SMS-delivered Forgot Password flow (controllers/auth.controller.js's
 * `forgotPassword`) and the Manager emergency reset flow (controllers/
 * user.controller.js's `resetUserPassword`) - see this project's own
 * standing constraint: "never supplied by Manager... never accepted from
 * frontend... only bcrypt hash stored... never logged".
 *
 * WHY NOT JUST crypto.randomBytes(N).toString('base64')
 * Would satisfy "cryptographically secure" but can produce characters
 * (`/`, `+`, `=`) that are awkward to read aloud/re-type from an SMS on a
 * phone keypad, and can produce runs that look ambiguous at a glance
 * (`l`/`1`, `O`/`0`). This generator draws from a fixed alphabet that
 * deliberately excludes visually-ambiguous characters (the same UX
 * reasoning utils/companyCode.js's own GENERATION_ALPHABET already
 * documents), while still using `crypto.randomInt` (cryptographically
 * strong, no extra dependency) for every character choice - this is a
 * usability improvement over raw base64, not a security downgrade.
 *
 * LENGTH / STRENGTH
 * 12 characters from a 57-character alphabet is ~70 bits of entropy
 * (57^12 ≈ 2^70) - comfortably "sufficiently strong" (task spec) for a
 * short-lived credential that also satisfies this project's own
 * validatePassword() format rules (length between MIN_PASSWORD_LENGTH and
 * MAX_PASSWORD_LENGTH - see utils/passwordPolicy.js) by construction, so
 * it is never rejected by the same validator every self-chosen password
 * must pass.
 */

const crypto = require('crypto');

const TEMP_PASSWORD_LENGTH = 12;
// Excludes 0/O, 1/I/l, and all punctuation - readable from an SMS, safe to
// read aloud, and never confused with a "the SMS truncated/corrupted this"
// symptom the way a stray `+`/`/`/`=` from raw base64 output might be.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * Generates one cryptographically random temporary password. Always
 * satisfies utils/passwordPolicy.js's validatePassword() by construction
 * (fixed length well within MIN/MAX). Returns the PLAINTEXT value - the
 * caller is responsible for hashing it before persistence and sending it
 * exactly once, over SMS only, and NEVER logging/persisting/echoing it in
 * any response, AuditLog entry, or Notification document.
 */
function generateTempPassword() {
  let password = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i += 1) {
    const index = crypto.randomInt(TEMP_PASSWORD_ALPHABET.length);
    password += TEMP_PASSWORD_ALPHABET[index];
  }
  return password;
}

module.exports = { generateTempPassword, TEMP_PASSWORD_LENGTH };
