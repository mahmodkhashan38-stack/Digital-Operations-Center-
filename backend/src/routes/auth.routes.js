const express = require('express');
const {
  register, login, getMe, changePassword, forgotPassword, logout, verifyPhone, resendPhoneOtp,
} = require('../controllers/auth.controller');
const {
  listMySessions, logoutOtherSessions, logoutAllSessions, revokeMySession,
} = require('../controllers/userSession.controller');
const verifyToken = require('../middleware/auth');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');
// Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec Phase 8 -
// "PASSWORD RESET RATE LIMITING" / "SMS COST ABUSE").
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Sprint 7 - rate-limit key builders. Combine IP + a normalized identifier
// from the body (task spec Phase 8: "Rate-limit by suitable combination:
// IP, account/email hash, time window") - never the raw email/userId
// itself as the key (a light SHA-256-free `String(...).toLowerCase()`
// combination is sufficient here since these keys are only ever used as
// in-memory Map keys, never persisted or exposed - see middleware/
// rateLimit.js's own top comment on why no hashing library is added for
// this).
function forgotPasswordKey(req) {
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  return `forgot-password:${req.ip}:${email}`;
}
function resendOtpKey(req) {
  const userId = String((req.body || {}).userId || '').trim();
  return `resend-otp:${req.ip}:${userId}`;
}
function verifyPhoneKey(req) {
  const userId = String((req.body || {}).userId || '').trim();
  return `verify-phone:${req.ip}:${userId}`;
}

router.post('/register', register);
router.post('/login', login);
// Sprint 7 - "SMS + Phone Authentication Upgrade" (task spec Phase 7).
// REPLACES DOC-70's Manager-approval flow - see forgotPassword's own
// header comment in auth.controller.js for the full replacement
// rationale. PUBLIC, like /register and /login above - no verifyToken.
// Rate-limited: max 5 requests per 15 minutes per IP+email combination
// (task spec Phase 8 - "max several requests per 15 minutes... Do not
// allow unlimited SMS cost generation").
router.post('/forgot-password', rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, keyFn: forgotPasswordKey, message: 'Too many password reset requests. Please try again later.',
}), forgotPassword);
// Sprint 7 - phone verification (task spec Phase 4). Both PUBLIC (see
// verifyPhone/resendPhoneOtp's own header comments in auth.controller.js
// for why - the account cannot authenticate yet). Rate-limited
// independently from forgot-password and from each other: OTP verify
// attempts and OTP resends are two different abuse vectors (guessing vs.
// SMS-cost exhaustion) with two different, appropriately-sized budgets.
router.post('/verify-phone', rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, keyFn: verifyPhoneKey, message: 'Too many verification attempts. Please try again later.',
}), verifyPhone);
router.post('/resend-phone-otp', rateLimit({
  windowMs: 15 * 60 * 1000, max: 3, keyFn: resendOtpKey, message: 'Too many code requests. Please try again later.',
}), resendPhoneOtp);
router.get('/me', verifyToken, getMe);
// DOC-57 - deliberately NOT composed with requirePasswordChangeCompleted
// (unlike every other protected route in this project) - see that
// middleware's own comment, and changePassword's own comment in
// controllers/auth.controller.js, for why this route and GET /me above
// are the two explicit exceptions.
router.patch('/change-password', verifyToken, changePassword);
// DOC-69 - "Login History & Active Sessions". `logout` is a THIRD explicit
// exception to requirePasswordChangeCompleted, for the same underlying
// reason as the two above: a user whose password was just reset (and who
// is therefore mid-forced-change) must still always be able to log out
// cleanly - blocking this endpoint on that flag would leave such a user
// with no way to end their own session short of letting the token expire
// naturally.
router.post('/logout', verifyToken, logout);

// DOC-69 - session management (Active Sessions / Login History). Treated
// as an ordinary protected business feature (like Profile - DOC-62), so
// these DO carry requirePasswordChangeCompleted, unlike the three
// exceptions above.
router.get('/sessions', verifyToken, requirePasswordChangeCompleted, listMySessions);
// Static, literal sub-paths registered BEFORE the dynamic '/sessions/:sessionId'
// below - Express matches path segments literally, so 'logout-others' and
// 'logout-all' must never be reachable through a route pattern that would
// otherwise treat them as a `:sessionId` value. Both are POST, and the
// single-session revoke below is DELETE, so there is in fact zero
// HTTP-method overlap between them regardless of order - this ordering is
// kept anyway for the same defense-in-depth clarity this project's other
// pre-gate/static-before-dynamic route orderings already follow (see
// routes/request.routes.js's own DOC-68 comment on this exact pattern).
router.post('/sessions/logout-others', verifyToken, requirePasswordChangeCompleted, logoutOtherSessions);
router.post('/sessions/logout-all', verifyToken, requirePasswordChangeCompleted, logoutAllSessions);
router.delete('/sessions/:sessionId', verifyToken, requirePasswordChangeCompleted, revokeMySession);

module.exports = router;
