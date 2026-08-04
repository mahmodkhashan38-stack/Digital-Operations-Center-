const express = require('express');
const {
  register, login, getMe, changePassword,
} = require('../controllers/auth.controller');
const verifyToken = require('../middleware/auth');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', verifyToken, getMe);
// DOC-57 - deliberately NOT composed with requirePasswordChangeCompleted
// (unlike every other protected route in this project) - see that
// middleware's own comment, and changePassword's own comment in
// controllers/auth.controller.js, for why this route and GET /me above
// are the two explicit exceptions.
router.patch('/change-password', verifyToken, changePassword);

module.exports = router;
