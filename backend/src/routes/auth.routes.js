const express = require('express');
const {
  register, login, getMe, changePassword, forgotPassword, logout,
} = require('../controllers/auth.controller');
const {
  listMySessions, logoutOtherSessions, logoutAllSessions, revokeMySession,
} = require('../controllers/userSession.controller');
const verifyToken = require('../middleware/auth');
const requirePasswordChangeCompleted = require('../middleware/requirePasswordChangeCompleted');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
// DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
// PUBLIC, like /register and /login above - no verifyToken. See
// forgotPassword's own header comment in auth.controller.js for the full
// enumeration-resistance/organization-isolation/inactive-user contract.
router.post('/forgot-password', forgotPassword);
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
