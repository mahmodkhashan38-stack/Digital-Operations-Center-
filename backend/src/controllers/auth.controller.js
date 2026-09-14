const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { normalizeCompanyCode, isValidCompanyCode } = require('../utils/companyCode');
const { validatePassword, MIN_PASSWORD_LENGTH } = require('../utils/passwordPolicy');
// DOC-69 - "Login History & Active Sessions".
const {
  generateTokenId, createSession, revokeSession, revokeAllSessionsForUser,
} = require('../services/userSession.service');
// Sprint 7 - "SMS + Phone Authentication Upgrade". Replaces DOC-70's old
// PasswordResetRequest/Manager-approval flow (see models/
// PasswordResetRequest.js's own retirement notice) with phone
// verification (registration) and a self-service, SMS-delivered
// temporary password (forgotPassword).
const { normalizePhoneNumber, isValidE164, maskPhoneNumber } = require('../utils/phoneNumber');
const { generateTempPassword } = require('../utils/tempPassword');
const phoneVerificationService = require('../services/phoneVerification.service');
const { sendSms } = require('../services/sms.service');
const { recordAuditLog } = require('../services/auditLog.service');

const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Strips sensitive fields (passwordHash) before sending a user back to the client.
// organizationId is included as-is (an id, or null) - it is not sensitive, and
// exposing it lets the frontend know which organization the user belongs to.
// For employees registered since DOC-33 this is always a real Organization
// id; system_admin is always null; legacy pre-DOC-30 accounts and any
// account not yet migrated (DOC-39) may still show null.
//
// DOC-57 - `mustChangePassword` is now always included (never
// conditional): every existing pre-DOC-57 account simply has it default
// to `false` (see models/User.js), so this is a harmless, uniform
// addition to every existing response shape, never a breaking change.
// The frontend uses this one field to decide whether to redirect to
// /change-password - see ProtectedRoute.jsx. Never returns passwordHash,
// a raw/new/reset password, a bcrypt salt, or any other internal
// Mongoose metadata - exactly the same guarantee this function already
// made before DOC-57.
// DOC-71 - "Enhanced User Profile: Profile Picture + Bio". `bio` is
// included as-is (already plain text only by construction - see
// utils/userFieldValidation.js's own `validateBio` - never HTML, never
// re-sanitized here since there is nothing to strip). `profileImage` is
// NEVER the raw subdocument (which would expose `objectKey`/`fileId` -
// internal storage references, not something a client ever needs) - only
// a safe `{ url, updatedAt }` shape, `url` being the authenticated
// content-proxy endpoint (see routes/user.routes.js's own
// GET /:userId/profile-image, the exact same "stream through Node, never
// a raw storage URL" pattern AuthenticatedRequestImage.jsx/
// getRequestAttachmentContent already established for Request images) -
// `null` when the user has no profile image set. The query string's `v=`
// value is the image's own `updatedAt` timestamp - a cheap, effective
// cache-busting version per task spec section 28, changing exactly when
// (and only when) the image itself actually changes.
function sanitizeProfileImage(user) {
  if (!user.profileImage) {
    return null;
  }
  const version = user.profileImage.updatedAt ? new Date(user.profileImage.updatedAt).getTime() : Date.now();
  return {
    url: `/users/${user._id}/profile-image?v=${version}`,
    updatedAt: user.profileImage.updatedAt || null,
  };
}

// Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec Phase 3
// "PHONE PRIVACY" - "Do not expose full phone numbers unnecessarily").
// The raw E.164 `phoneNumber` is NEVER included in any API response, not
// even to the account's own owner - `phoneNumberMasked` (task spec's own
// example shape: "+972 5X XXX 1234") is sufficient for every existing UX
// need (Profile's own "is my phone verified" display, the registration/
// Manager-creation OTP step's "we sent a code to ...1234" confirmation -
// both of which already know the full number from the form the caller
// themselves just typed it into, so the server never needs to echo it
// back in full).
const sanitizeUser = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email,
  role: user.role,
  organizationId: user.organizationId,
  isActive: user.isActive,
  mustChangePassword: !!user.mustChangePassword,
  createdAt: user.createdAt,
  bio: user.bio || null,
  hasProfileImage: !!user.profileImage,
  profileImage: sanitizeProfileImage(user),
  phoneNumberMasked: maskPhoneNumber(user.phoneNumber),
  phoneVerificationStatus: user.phoneVerificationStatus,
});

// POST /api/auth/register
//
// Public registration (DOC-33): every new account is an 'employee' that
// joins an existing, active Organization identified by its Company Code.
// role and organizationId are never read from the request body - role is
// simply never set here (the schema default, 'employee', applies), and
// organizationId always comes from the Organization document resolved by
// companyCode, never from req.body.organizationId. A request like
// { "role": "system_admin", "organizationId": "...", "companyCode": "ABC123" }
// still only ever produces an employee in the Organization that
// "ABC123" actually resolves to - the extra fields are simply never read.
const register = async (req, res, next) => {
  try {
    const {
      fullName, email, password, companyCode, phoneNumber,
    } = req.body || {};

    // Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec Phase 3/9
    // "REGISTRATION DECISION" - "Employee registration: Email, Password,
    // Full Name, Company Code, Phone Number"). Required alongside the
    // four pre-existing fields, never optional - task spec's own standing
    // goal is "every new Employee/Operator/Manager account must have a
    // real, verified phone number".
    if (!fullName || !email || !password || !companyCode || !phoneNumber) {
      return res.status(400).json({
        status: 'error',
        message: 'fullName, email, password, companyCode and phoneNumber are all required.',
      });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ status: 'error', message: 'Please provide a valid email address.' });
    }

    // DOC-57 - reuses the one shared password-format validator (utils/
    // passwordPolicy.js) instead of an inline length check - see that
    // file's own comment for why MIN_PASSWORD_LENGTH is unchanged (still
    // 6) and why a MAX_PASSWORD_LENGTH is now also enforced here for the
    // first time.
    const passwordFormatError = validatePassword(password);
    if (passwordFormatError) {
      return res.status(400).json({ status: 'error', message: passwordFormatError });
    }

    // Reuses DOC-41's exact normalization/validation - "abc123", "ABC123"
    // and " AbC123 " are all the same code, and this is the one place that
    // decides what counts as a well-formed one. A malformed code (wrong
    // length/characters) is a pure input-shape problem, so it's safe to be
    // specific about - unlike "does this code actually exist", handled
    // further down.
    const normalizedCompanyCode = normalizeCompanyCode(companyCode);
    if (!isValidCompanyCode(normalizedCompanyCode)) {
      return res.status(400).json({ status: 'error', message: 'Please provide a valid company code.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ status: 'error', message: 'An account with this email already exists.' });
    }

    // Sprint 7 - phone format + uniqueness, checked BEFORE the Organization
    // lookup below purely so an obviously-malformed number is rejected
    // with the cheapest possible check first (no different in outcome -
    // every check here is independent and short-circuits on its own).
    // normalizePhoneNumber never throws (see utils/phoneNumber.js) - a
    // `null` result means "could not be confidently normalized to E.164",
    // treated as a plain input-format error, the same as an invalid email.
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    if (!isValidE164(normalizedPhoneNumber)) {
      return res.status(400).json({ status: 'error', message: 'Please provide a valid phone number.' });
    }
    // Application-level check for a clear, specific 409 (task spec Phase 3
    // "PHONE UNIQUENESS" - "Handle duplicates cleanly") - the partial
    // unique index on User.phoneNumber (models/User.js) is the database-
    // level backstop against the narrow race window between this check
    // and the insert below, exactly the same two-layer defense
    // utils/companyCode.js's own generateUniqueCompanyCode +
    // Organization.companyCode's unique index already establish.
    const existingPhoneUser = await User.findOne({ phoneNumber: normalizedPhoneNumber });
    if (existingPhoneUser) {
      return res.status(409).json({ status: 'error', message: 'An account with this phone number already exists.' });
    }

    // A code that doesn't resolve to any Organization, and a code that
    // resolves to an inactive one, return the exact same generic message
    // and status - the same anti-enumeration principle already used by
    // Login's "Invalid email or password." This deliberately does not tell
    // the client whether a company code exists but is disabled versus never
    // having existed at all.
    const organization = await Organization.findOne({ companyCode: normalizedCompanyCode });
    if (!organization || !organization.isActive) {
      return res.status(400).json({
        status: 'error',
        message: 'No active organization was found for that company code.',
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // organizationId comes only from the Organization resolved above -
    // never from req.body. companyCode itself is never stored on the User;
    // only organization._id is. role is left unset so the schema default
    // ('employee') applies - it is never read from the client.
    //
    // Note on timing: the Organization is looked up, then the User is
    // created as two separate steps (this project does not use MongoDB
    // transactions - see DOC-34 for why). In the extremely narrow window
    // between those two steps, the Organization could theoretically be
    // deactivated by a System Admin. This is an accepted, documented
    // limitation: the resulting user would simply belong to an Organization
    // that is now inactive, the same state DOC-38 will already need to
    // handle for any Organization deactivated after it has active members.
    //
    // Sprint 7 - the account is created HERE, already carrying
    // `phoneNumber` and the schema default `phoneVerificationStatus:
    // 'pending'` - task spec Phase 4's own flow ("Registration -> enter
    // phone number -> backend creates verification challenge -> SMS OTP
    // sent -> user enters OTP -> backend verifies -> account becomes
    // phone-verified") is deliberately implemented as "create the real
    // account now, gate LOGIN on verification" rather than a separate
    // "pending registration" side-table - see services/
    // phoneVerification.service.js's own top comment and this project's
    // established "do not build a second X engine" precedent for why this
    // is the simpler, equally-safe design: an unverified account cannot
    // authenticate at all (see `login` below), so it can never "fully use
    // the account" (task spec) regardless of the fact that a User document
    // already exists for it.
    const user = await User.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash,
      organizationId: organization._id,
      phoneNumber: normalizedPhoneNumber,
      phoneVerificationStatus: 'pending',
    });

    // SECURITY-CRITICAL SMS FAILURE (task spec Phase 5 - "SMS delivery
    // failure should cause the security operation to fail safely"). If the
    // OTP could not be sent, this entire registration is rolled back
    // (compensating delete, not a transaction - see this project's
    // established reasoning for why) rather than leaving behind an account
    // that can never complete phone verification and therefore can NEVER
    // log in through any path this project exposes.
    const challengeResult = await phoneVerificationService.issueChallenge({
      userId: user._id,
      phoneNumber: normalizedPhoneNumber,
      organizationId: organization._id,
    });
    if (!challengeResult.success) {
      await User.deleteOne({ _id: user._id }).catch((cleanupError) => {
        // eslint-disable-next-line no-console
        console.error('Failed to roll back user after phone verification SMS failure:', cleanupError.message);
      });
      return res.status(502).json({ status: 'error', message: challengeResult.error });
    }

    return res.status(201).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    if (error.code === 11000) {
      // Sprint 7 - the duplicate-key backstop can now fire for either the
      // email OR the phoneNumber partial unique index (models/User.js) -
      // `error.keyPattern` names which one actually collided, so this
      // never misreports a phone collision as an email collision or vice
      // versa (both are already checked explicitly above; this branch is
      // only ever reached via the narrow race window neither check can
      // fully close on its own).
      if (error.keyPattern && error.keyPattern.phoneNumber) {
        return res.status(409).json({ status: 'error', message: 'An account with this phone number already exists.' });
      }
      return res.status(409).json({ status: 'error', message: 'An account with this email already exists.' });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// POST /api/auth/login
//
// Unchanged by DOC-33: Email + Password only. A request body containing a
// companyCode field is simply never read here - Company Code is a
// registration-time concept only. Once a user exists, their role and
// organizationId already live on their User document.
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ status: 'error', message: 'Email and password are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ status: 'error', message: 'This account has been deactivated.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password.' });
    }

    // Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec: "Do not
    // allow an unverified phone to become a fully active account"). This
    // is the ONE place that gate is actually enforced - a correct
    // email/password is no longer sufficient by itself for any
    // employee/manager/operator account. system_admin is structurally
    // exempt (DOC-31's global account never collects a phone number at
    // all - see models/User.js's own `phoneVerificationStatus` default
    // and scripts/seedSystemAdmin.js, which explicitly sets
    // 'not_required'). Checked AFTER the password match above (never
    // before) so a wrong-password attempt against an unverified account
    // still reveals nothing beyond the existing "Invalid email or
    // password." - only a caller who has already proven they know the
    // correct password learns that phone verification is what's blocking
    // them, which is not a meaningful account-existence leak (they have
    // already proven the account exists and is theirs).
    if (user.role !== 'system_admin' && user.phoneVerificationStatus !== 'verified') {
      return res.status(403).json({
        status: 'error',
        message: 'Please verify your phone number before signing in. Check your SMS messages for a verification code.',
        data: { userId: user._id, phoneVerificationRequired: true },
      });
    }

    // DOC-69 - "Login History & Active Sessions". Every successful login
    // now mints a fresh, random `jti` (task spec section 30 - "Every
    // successful login must create a NEW session id... Never reuse a
    // client-provided session identifier") and creates the matching
    // UserSession BEFORE signing the token that references it, so a token
    // can never be issued for a session that does not yet exist.
    const tokenId = generateTokenId();

    // Token payload contains only non-sensitive identifiers. `role` is
    // included for debuggability only - it is never trusted on its own.
    // organizationId is deliberately NOT put in the token at all: DOC-38
    // made middleware/auth.js re-read role/organizationId/isActive from
    // the database on every request instead of trusting the JWT payload
    // for them, so a token cannot go stale if the user's role, Organization,
    // or active status changes after it was issued. Only userId (the
    // caller's identity) is actually read out of the verified token.
    // `jti` (DOC-69) is the one addition - a bare random identifier, never
    // anything sensitive on its own (see models/UserSession.js's own
    // header comment on why a leaked tokenId alone grants no access).
    const token = jwt.sign(
      { userId: user._id, role: user.role, jti: tokenId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' },
    );

    // The session's own `expiresAt` is decoded from the JUST-SIGNED token's
    // real `exp` claim (seconds since epoch) - never a second, independent
    // parse of JWT_EXPIRES_IN - so it can never drift out of sync with the
    // token it represents (task spec section 9).
    const { exp } = jwt.decode(token);
    await createSession({
      userId: user._id,
      organizationId: user.organizationId,
      tokenId,
      req,
      jwtExpiresAt: new Date(exp * 1000),
    });

    return res.status(200).json({
      status: 'success',
      data: { token, user: sanitizeUser(user) },
    });
  } catch (error) {
    return next(error);
  }
};

// GET /api/auth/me (protected)
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    return res.status(200).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    return next(error);
  }
};

// PATCH /api/auth/change-password (protected - verifyToken only, every
// role: system_admin, manager, operator, employee)
//
// DOC-57 - Flow A, "Self Password Change". Deliberately the ONE endpoint
// this task's forced-change middleware (middleware/
// requirePasswordChangeCompleted.js) never blocks (see routes/
// auth.routes.js - this route never has that middleware composed into
// its chain at all) - a user whose mustChangePassword is true must still
// be able to reach this, or they could never clear that flag.
//
// Only reads currentPassword/newPassword/confirmPassword from the body -
// an explicit, single-purpose read, not an allowlist-filtered spread, so
// a payload containing passwordHash/role/organizationId/mustChangePassword/
// isActive or anything else has structurally zero effect (task spec:
// "Only the explicit password fields may be read"). Every ownership/
// identity fact this endpoint acts on (WHICH user, their CURRENT
// passwordHash) comes from a fresh `User.findById(req.user.userId)` read,
// never from the request body or from req.user itself beyond `userId`.
const changePassword = async (req, res, next) => {
  try {
    const body = req.body || {};
    const { currentPassword, newPassword, confirmPassword } = body;

    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return res.status(400).json({ status: 'error', message: 'currentPassword is required.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      return res.status(400).json({ status: 'error', message: 'newPassword is required.' });
    }
    if (typeof confirmPassword !== 'string' || confirmPassword.length === 0) {
      return res.status(400).json({ status: 'error', message: 'confirmPassword is required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ status: 'error', message: 'newPassword and confirmPassword do not match.' });
    }

    const passwordFormatError = validatePassword(newPassword);
    if (passwordFormatError) {
      return res.status(400).json({ status: 'error', message: passwordFormatError });
    }

    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const currentPasswordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentPasswordMatches) {
      // 401, not 400 - this is genuinely an authentication failure (proving
      // you are still the account owner), the same status Login already
      // uses for "credentials did not match", documented choice per task
      // spec's "document the choice" instruction.
      return res.status(401).json({ status: 'error', message: 'Current password is incorrect.' });
    }

    // task spec: "newPassword must not equal currentPassword" - compared
    // against the real stored hash, never a client-supplied claim about
    // what the old password was.
    const newPasswordMatchesOld = await bcrypt.compare(newPassword, user.passwordHash);
    if (newPasswordMatchesOld) {
      return res.status(400).json({
        status: 'error',
        message: 'New password must be different from your current password.',
      });
    }

    // Sprint 7 - captured BEFORE mutating `mustChangePassword` below, so
    // this reads "was this a forced change (a temporary SMS password or a
    // Manager emergency reset), or a routine voluntary change?" - used
    // only to decide whether to record PASSWORD_RESET_COMPLETED afterward
    // (task spec Phase 13 - "PASSWORD_RESET_COMPLETED"). Never affects the
    // password-change logic itself, which is identical either way.
    const wasForcedPasswordReset = !!user.mustChangePassword;

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    // Self-change always clears the forced-change flag, regardless of
    // whatever it was before - this is the ONLY way (besides a fresh
    // Manager reset re-setting it) this field ever changes value.
    user.mustChangePassword = false;
    await user.save();

    if (wasForcedPasswordReset) {
      // Sprint 7 - task spec Phase 13: "PASSWORD_RESET_COMPLETED". Recorded
      // here (never a new endpoint) because this IS the existing endpoint
      // that completes the forced-change flow, regardless of whether the
      // original reset was the new self-service SMS flow or a Manager
      // emergency reset (controllers/user.controller.js's
      // `resetUserPassword`) - both set `mustChangePassword: true` the
      // same way, so both are closed out identically here. `actorId` is
      // the user themselves (self-action).
      recordAuditLog({
        actorId: user._id,
        organizationId: user.organizationId,
        action: 'PASSWORD_RESET_COMPLETED',
        targetType: 'User',
        targetId: user._id,
        changes: null,
        metadata: { targetUserId: user._id, targetUserName: user.fullName },
      });
    }

    // DOC-69 - "Login History & Active Sessions" (task spec section 18).
    // POLICY: every OTHER active session for this user is revoked - a
    // successful self-service password change is exactly the moment a
    // stolen/left-open session elsewhere should stop working. The CURRENT
    // session (the one that just proved the current password and performed
    // this very change) is deliberately EXCLUDED (`exceptTokenId`) and may
    // remain valid - task spec section 18: "Current session may remain
    // valid after password change" - forcing the person who just correctly
    // authenticated to immediately re-login on the same device would be
    // pure friction with no security benefit. `req.session` is set by
    // middleware/auth.js from the already-verified JWT's own `jti`.
    await revokeAllSessionsForUser(user._id, 'PASSWORD_CHANGED', { exceptTokenId: req.session && req.session.tokenId });

    return res.status(200).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// POST /api/auth/forgot-password (PUBLIC - no verifyToken)
//
// Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec Phase 7 -
// "REPLACE MANAGER-APPROVAL FORGOT PASSWORD"). REPLACES DOC-70's entire
// Manager-approval flow (see models/PasswordResetRequest.js's own
// retirement notice): there is no review step, no Manager involvement, no
// PasswordResetRequest document, and no PASSWORD_RESET_REQUESTED
// notification anymore. New flow: identity validation (email + companyCode
// - task spec Phase 7 "FORGOT PASSWORD INPUT": "Prefer NOT asking the user
// to choose a destination phone... send only to the already-verified
// number already stored for that account" - this endpoint's input shape
// is therefore UNCHANGED from DOC-70's, on purpose, and there is no
// `phoneNumber` field read from the body anywhere in this function) ->
// generate a secure temporary password server-side -> bcrypt hash stored
// -> mustChangePassword=true -> ALL sessions revoked -> the temporary
// password sent by SMS to the account's own stored, verified number only.
//
// MANAGER ACCOUNTS ARE NO LONGER EXCLUDED (a deliberate change from
// DOC-70): the old exclusion existed ONLY because no OTHER Manager could
// ever approve a fellow Manager's reset request (see git history/DOC-70's
// retired comment above, in models/PasswordResetRequest.js). That
// structural reason no longer applies - this flow is fully self-service,
// gated only by "does this account have its own verified phone", so a
// Manager who forgets their password can now use this exact same endpoint
// like anyone else. System Admin remains structurally excluded
// (organizationId is always `null` - the query below can never match one).
//
// ACCOUNT-ENUMERATION (task spec Phase 7 "ACCOUNT ENUMERATION" - "must not
// reveal whether email/phone/org exists... generic response"). This
// version is STRICTER than DOC-70's own documented trade-offs: the exact
// same generic message is returned for every one of "no matching account",
// "account deactivated", "account has no verified phone yet", "SMS
// delivery failed", AND "success" - only a malformed email/companyCode
// SHAPE (not an existence question) or an unknown/inactive companyCode
// (unchanged from `register`'s own identical, pre-existing, non-secret
// company-code signal) are ever distinguished. Whether SMS was actually
// sent is a strictly more sensitive fact than DOC-70's own "is this a
// Manager" question ever was, so this endpoint no longer carves out ANY
// account-state-specific success/failure wording the way DOC-70's
// "already pending"/"deactivated" messages did.
const GENERIC_FORGOT_PASSWORD_MESSAGE = 'If the information you provided matches an eligible account, a temporary password has been sent by SMS to the phone number on file.';

const forgotPassword = async (req, res, next) => {
  try {
    const body = req.body || {};
    const { email, companyCode } = body;

    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ status: 'error', message: 'email is required.' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ status: 'error', message: 'Please provide a valid email address.' });
    }
    if (typeof companyCode !== 'string' || !companyCode.trim()) {
      return res.status(400).json({ status: 'error', message: 'companyCode is required.' });
    }

    const normalizedCompanyCode = normalizeCompanyCode(companyCode);
    if (!isValidCompanyCode(normalizedCompanyCode)) {
      return res.status(400).json({ status: 'error', message: 'Please provide a valid company code.' });
    }

    // Same generic-message precedent `register` already established for
    // "code that doesn't resolve" vs "code that resolves to an inactive
    // Organization" - see this function's own header comment.
    const organization = await Organization.findOne({ companyCode: normalizedCompanyCode });
    if (!organization || !organization.isActive) {
      return res.status(400).json({
        status: 'error',
        message: 'No active organization was found for that company code.',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Organization-scoped by construction (task spec Phase 7's own
    // isolation requirement) - this is the ONE lookup that decides "does
    // this email belong to THIS Organization", never widened or re-run
    // without the organizationId filter. A system_admin can never match
    // (see header comment); a manager now CAN (see header comment on why
    // that exclusion was removed).
    const user = await User.findOne({ email: normalizedEmail, organizationId: organization._id });

    // Silent no-op for every condition that must not itself change the
    // response: no matching account, inactive account, or no verified
    // phone yet to deliver to (task spec: "Do not create a temporary
    // password the user cannot receive" - there is nothing safe to send
    // to, so nothing is generated at all). All three, and genuine
    // success, return the IDENTICAL response below - see this function's
    // own header comment.
    if (user && user.isActive && user.phoneVerificationStatus === 'verified' && user.phoneNumber) {
      // Generate the plaintext temporary password FIRST, and confirm SMS
      // delivery BEFORE ever touching passwordHash/mustChangePassword/
      // sessions (task spec Phase 5 "SECURITY SMS FAILURE" - "SMS
      // delivery failure should cause the security operation to fail
      // safely"). If the SMS cannot be sent, this account's password is
      // left completely untouched - the plaintext value is discarded
      // (never logged, never persisted) and the caller still receives the
      // exact same generic response, so a delivery failure is never
      // distinguishable from "no such account" externally.
      const tempPassword = generateTempPassword();
      const smsResult = await sendSms({
        to: user.phoneNumber,
        message: `DOC: Your temporary password is ${tempPassword}. Sign in and change it immediately. Do not share this password.`,
        type: 'PASSWORD_RESET_TEMP_PASSWORD',
        recipientUserId: user._id,
        organizationId: organization._id,
      });

      if (smsResult.success) {
        user.passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
        user.mustChangePassword = true;
        await user.save();

        // Task spec Phase 7 "SESSION REVOCATION" - "Forgot Password must
        // revoke ALL existing UserSessions... Reactivation does not apply
        // here." Unlike self-service changePassword (which spares the
        // CURRENT session), there is no "current session" here at all -
        // this is an unauthenticated endpoint - so every session is
        // revoked, no `exceptTokenId`.
        await revokeAllSessionsForUser(user._id, 'PASSWORD_RESET');

        // Task spec Phase 13 - "PASSWORD_RESET_SMS_REQUESTED". `actorId`
        // is the account owner themselves (self-directed, pre-
        // authentication action - see models/AuditLog.js's own comment on
        // why this is one of the few entries whose actor is also its own
        // target).
        recordAuditLog({
          actorId: user._id,
          organizationId: organization._id,
          action: 'PASSWORD_RESET_SMS_REQUESTED',
          targetType: 'User',
          targetId: user._id,
          changes: null,
          metadata: { targetUserId: user._id, targetUserName: user.fullName },
        });
      }
      // A failed smsResult intentionally falls through to the exact same
      // generic response below with no further action - see this
      // function's own header comment.
    }

    return res.status(200).json({ status: 'success', message: GENERIC_FORGOT_PASSWORD_MESSAGE });
  } catch (error) {
    return next(error);
  }
};

// POST /api/auth/logout (protected - verifyToken only, EVERY role,
// deliberately never composed with requirePasswordChangeCompleted - see
// routes/auth.routes.js's own comment: a user forced to change password
// must always be able to log out, exactly like the two other explicit
// exceptions on this router, GET /me and PATCH /change-password).
//
// DOC-69 - "Login History & Active Sessions" (task spec section 17).
// Before this ticket, "Logout" was 100% frontend-only (AuthContext.jsx
// simply deleted the token from localStorage) with no server-side effect
// at all - the same JWT would have kept working against the API for the
// rest of its natural lifetime if it were ever reused (e.g. from a stale
// copy, a compromised device, or a browser's "restore tabs"). This
// endpoint revokes the CURRENT session server-side, so that exact JWT
// stops being accepted by verifyToken immediately, even though its `exp`
// has not been reached - the core mechanism this whole ticket exists to
// add. Idempotent: calling this twice with the same (now-revoked) token
// is a safe no-op the second time (see userSession.service.js's own
// `revokeSession`), not an error.
const logout = async (req, res, next) => {
  try {
    if (req.session) {
      await revokeSession(req.session, 'LOGOUT');
    }
    return res.status(200).json({ status: 'success', message: 'Logged out.' });
  } catch (error) {
    return next(error);
  }
};

// POST /api/auth/verify-phone (PUBLIC - no verifyToken)
//
// Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec Phase 4).
// Completes phone verification for a not-yet-verified account -
// registration (a brand-new employee) and System-Admin-created Manager
// accounts (controllers/organization.controller.js's
// `createAndLinkManager`) both use this exact same endpoint; there is no
// separate "verify a Manager's phone" route. PUBLIC on purpose: the whole
// point is that the account CANNOT log in yet (see `login` above), so it
// has no JWT to authenticate with - `userId` (returned by `register`'s own
// 201 response, or known to the Manager from... their own account, which
// they were just told to expect an SMS for) is the only identifier this
// endpoint needs. Rate-limited at the route level (routes/auth.routes.js)
// against brute-force OTP guessing - see services/
// phoneVerification.service.js's own MAX_OTP_ATTEMPTS for the additional,
// independent per-challenge attempt ceiling.
const verifyPhone = async (req, res, next) => {
  try {
    const { userId, code } = req.body || {};
    if (typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ status: 'error', message: 'userId is required.' });
    }

    const user = await User.findById(userId);
    // Never distinguishes "no such user" from "already verified" from
    // "wrong code" beyond phoneVerification.service.js's own client-safe
    // messages - a nonexistent/foreign userId simply never has a live
    // challenge, so it naturally falls into the same "no active
    // verification code found" message a real, already-verified account
    // would also see.
    if (!user) {
      return res.status(400).json({ status: 'error', message: 'No active verification code found for this account. Request a new one.' });
    }

    const result = await phoneVerificationService.verifyChallenge({ userId: user._id, code });
    if (!result.success) {
      return res.status(400).json({ status: 'error', message: result.error });
    }

    // Task spec Phase 13 - "PHONE_VERIFIED".
    recordAuditLog({
      actorId: user._id,
      organizationId: user.organizationId,
      action: 'PHONE_VERIFIED',
      targetType: 'User',
      targetId: user._id,
      changes: null,
      metadata: { targetUserId: user._id, targetUserName: user.fullName },
    });

    return res.status(200).json({ status: 'success', message: 'Phone number verified. You can now sign in.' });
  } catch (error) {
    return next(error);
  }
};

// POST /api/auth/resend-phone-otp (PUBLIC - no verifyToken)
//
// Sprint 7 - re-issues a fresh OTP for an account that has not yet
// completed phone verification (task spec Phase 4/8 - "Resend"). Reuses
// `issueChallenge` exactly as `register`/`createAndLinkManager` already
// do - never a second OTP-issuing implementation. Rate-limited at the
// route level (routes/auth.routes.js) - task spec Phase 8 "Also
// rate-limit: phone verification resend".
const resendPhoneOtp = async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    if (typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ status: 'error', message: 'userId is required.' });
    }

    const user = await User.findById(userId);
    if (!user || user.phoneVerificationStatus === 'verified' || !user.phoneNumber) {
      // Generic - never reveals which of "no such user" / "already
      // verified" / "no phone on file" applies.
      return res.status(400).json({ status: 'error', message: 'Unable to resend a verification code for this account.' });
    }

    const result = await phoneVerificationService.issueChallenge({
      userId: user._id,
      phoneNumber: user.phoneNumber,
      organizationId: user.organizationId,
    });
    if (!result.success) {
      return res.status(502).json({ status: 'error', message: result.error });
    }

    return res.status(200).json({ status: 'success', message: 'A new verification code has been sent.' });
  } catch (error) {
    return next(error);
  }
};

// SALT_ROUNDS / EMAIL_REGEX / MIN_PASSWORD_LENGTH are exported so other
// trusted server-side entry points (scripts/seedSystemAdmin.js,
// controllers/organization.controller.js) validate email/password and hash
// passwords the exact same way as public registration, instead of
// duplicating these rules in a second place. DOC-57 adds `validatePassword`
// itself to this same export list, for the same reason.
module.exports = {
  register,
  login,
  getMe,
  changePassword,
  forgotPassword,
  logout,
  verifyPhone,
  resendPhoneOtp,
  sanitizeUser,
  SALT_ROUNDS,
  EMAIL_REGEX,
  MIN_PASSWORD_LENGTH,
  validatePassword,
};
