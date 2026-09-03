const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { normalizeCompanyCode, isValidCompanyCode } = require('../utils/companyCode');
const { validatePassword, MIN_PASSWORD_LENGTH } = require('../utils/passwordPolicy');
// DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
const PasswordResetRequest = require('../models/PasswordResetRequest');
const { createNotification } = require('../services/notification.service');
// DOC-69 - "Login History & Active Sessions".
const {
  generateTokenId, createSession, revokeSession, revokeAllSessionsForUser,
} = require('../services/userSession.service');

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
    const { fullName, email, password, companyCode } = req.body || {};

    if (!fullName || !email || !password || !companyCode) {
      return res.status(400).json({
        status: 'error',
        message: 'fullName, email, password and companyCode are all required.',
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
    const user = await User.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash,
      organizationId: organization._id,
    });

    return res.status(201).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    if (error.code === 11000) {
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

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    // Self-change always clears the forced-change flag, regardless of
    // whatever it was before - this is the ONLY way (besides a fresh
    // Manager reset re-setting it) this field ever changes value.
    user.mustChangePassword = false;
    await user.save();

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
// DOC-70 - "Forgot Password / Password Recovery via Manager Approval". This
// project has no email delivery (task spec's own standing constraint: no
// SMTP, no third-party provider, no public reset links) - recovery is
// instead routed through the requesting User's own Organization Manager,
// who reviews and (if legitimate) resets the password through the
// existing, unchanged Manager Reset Password mechanism (see
// controllers/user.controller.js's `performPasswordReset`). This endpoint
// only ever CREATES a review request - it never itself touches a password.
//
// ACCEPTS ONLY email + companyCode (task spec section 5) - userId,
// organizationId, role, and password are never read from the body even if
// present, the same explicit-read discipline `register` above already
// uses. companyCode normalization/validation is reused verbatim from
// utils/companyCode.js (task spec section 7) - no second implementation.
//
// ACCOUNT-ENUMERATION DECISION (task spec section 6 - "choose a reasonable
// balance... document the decision"):
//   - A malformed email/companyCode (wrong shape) is a pure input-format
//     problem, not an enumeration risk - rejected with a specific 400,
//     mirroring `register`'s own existing behavior for the same fields.
//   - An unknown/inactive companyCode returns the same specific 400
//     `register` already returns for it ("No active organization was found
//     for that company code."). A Company Code is NOT a secret (task spec
//     itself, and utils/companyCode.js's own header comment: "it is just a
//     random-looking label" shared openly with every employee for
//     registration) - `register` already reveals company-code validity via
//     an identical lookup, so keeping that one signal consistent between
//     the two endpoints adds no new exposure.
//   - Once a valid, active Organization is identified, whether a SPECIFIC
//     EMAIL belongs to an account in it is the genuinely sensitive fact -
//     "no matching account", "this account belongs to a Manager" (see
//     below), and "a request was successfully created" all return the
//     EXACT SAME generic 200 message, byte-for-byte, so none of the three
//     can be distinguished from one another.
//   - Two narrow, DELIBERATE exceptions to that generic-message rule,
//     each directed by the task spec itself and documented in
//     backend/README.md: an INACTIVE account gets a distinct, honest
//     message (task spec section 9 explicitly requires this rather than
//     folding it into the generic case), and an ALREADY-PENDING request
//     gets the task spec's own literal example message (section 4). Both
//     are accepted, intentional, minimal trade-offs against pure
//     enumeration-resistance in exchange for clearer UX, exactly as the
//     task spec invites ("choose a reasonable balance").
//
// SYSTEM ADMIN (task spec section 23): structurally excluded, not
// special-cased - system_admin.organizationId is always `null` (DOC-31),
// so the `User.findOne({ email, organizationId: organization._id })` query
// below can never match one, regardless of email. Documented, not coded.
//
// MANAGER ACCOUNTS (task spec section 26 item 13 - "decided/documented"):
// excluded here, folded into the generic "no matching account" response
// (never a distinguishing message - see the enumeration decision above).
// This is a direct consequence of reusing the existing Manager Reset
// Password mechanism unchanged for approval (task spec section 12): that
// mechanism's own `resolveManageableTarget` (user.controller.js) already
// refuses to let a Manager reset ANOTHER Manager's password ("Managers
// cannot modify another Manager.") - so a pending request targeting a
// Manager could never be fulfilled by any Manager in the Organization
// through this feature. Rather than create a request that can only ever
// sit unapproved forever, or reveal "this email belongs to a Manager" to
// an unauthenticated caller, this endpoint takes no action for a Manager
// target at all. A Manager who is locked out is expected to contact their
// System Administrator instead (System Admin already owns Manager account
// creation/replacement - DOC-34/DOC-49).
//
// INACTIVE USERS (task spec section 9): never allowed to create a
// request - deactivation must never be bypassable through this flow. No
// PasswordResetRequest is created for one.
//
// DUPLICATE PROTECTION (task spec section 4): checked here first (clear,
// fast message) AND enforced at the database level by a partial unique
// index (see models/PasswordResetRequest.js) as defense in depth against
// a race between two near-simultaneous submissions.
const GENERIC_FORGOT_PASSWORD_MESSAGE = 'If the account information is valid, a password reset request has been submitted for manager review.';

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

    // Organization-scoped by construction (task spec section 8) - this is
    // the ONE lookup that decides "does this email belong to THIS
    // Organization", and it is never widened or re-run without the
    // organizationId filter. A system_admin can never match (see header
    // comment); a manager can (handled explicitly below, folded into the
    // generic response).
    const user = await User.findOne({ email: normalizedEmail, organizationId: organization._id });

    if (!user || user.role === 'manager') {
      return res.status(200).json({ status: 'success', message: GENERIC_FORGOT_PASSWORD_MESSAGE });
    }

    if (!user.isActive) {
      return res.status(200).json({
        status: 'success',
        message: 'This account is currently deactivated. Please contact your Organization Manager for assistance.',
      });
    }

    const existingPending = await PasswordResetRequest.findOne({ userId: user._id, status: 'pending' });
    if (existingPending) {
      return res.status(200).json({
        status: 'success',
        message: 'A password reset request is already pending review.',
      });
    }

    const passwordResetRequest = await PasswordResetRequest.create({
      organizationId: organization._id,
      userId: user._id,
      requestedEmail: normalizedEmail,
    });

    // DOC-18 - notify every Manager in this Organization (task spec
    // section 17). System-generated (no authenticated actor exists at
    // this point in the flow) - `actorId` is deliberately `null`, never
    // the requesting user's own id (they are not authenticated, and even
    // if they were, they are not the "actor" of a notification sent TO
    // someone else). Best-effort and non-blocking, exactly like every
    // other notification call site in this project: a notification
    // failure never affects the success response already being prepared
    // above, and the request has already been durably created regardless.
    const managers = await User.find({ organizationId: organization._id, role: 'manager', isActive: true });
    await Promise.all(managers.map((manager) => createNotification({
      organizationId: organization._id,
      recipientId: manager._id,
      actorId: null,
      type: 'PASSWORD_RESET_REQUESTED',
      title: 'Password Reset Request',
      message: `${user.fullName} has requested a password reset.`,
      metadata: {
        passwordResetRequestId: passwordResetRequest._id,
        requestedUserId: user._id,
        requestedUserName: user.fullName,
      },
    })));

    return res.status(200).json({ status: 'success', message: GENERIC_FORGOT_PASSWORD_MESSAGE });
  } catch (error) {
    // A duplicate-key error from the partial unique index (the narrow
    // race window the controller-level check above already mostly closes)
    // is treated identically to the "already pending" case above - never
    // exposed as a raw 500/database error.
    if (error.code === 11000) {
      return res.status(200).json({
        status: 'success',
        message: 'A password reset request is already pending review.',
      });
    }
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

// SALT_ROUNDS / EMAIL_REGEX / MIN_PASSWORD_LENGTH are exported so other
// trusted server-side entry points (scripts/seedSystemAdmin.js,
// controllers/organization.controller.js) validate email/password and hash
// passwords the exact same way as public registration, instead of
// duplicating these rules in a second place. DOC-57 adds `validatePassword`
// itself to this same export list, for the same reason.
module.exports = {
  register, login, getMe, changePassword, forgotPassword, logout, sanitizeUser, SALT_ROUNDS, EMAIL_REGEX, MIN_PASSWORD_LENGTH, validatePassword,
};
