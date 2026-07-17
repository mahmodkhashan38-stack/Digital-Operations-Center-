const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

// Strips sensitive fields (passwordHash) before sending a user back to the client.
const sanitizeUser = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email,
  role: user.role,
  isActive: user.isActive,
  createdAt: user.createdAt,
});

// POST /api/auth/register
const register = async (req, res, next) => {
  try {
    const { fullName, email, password } = req.body || {};

    if (!fullName || !email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'fullName, email and password are all required.',
      });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ status: 'error', message: 'Please provide a valid email address.' });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        status: 'error',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ status: 'error', message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Role is always assigned by the server. Clients can never choose their own role.
    const user = await User.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      passwordHash,
    });

    return res.status(201).json({ status: 'success', data: sanitizeUser(user) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: 'An account with this email already exists.' });
    }
    return next(error);
  }
};

// POST /api/auth/login
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

    // Token payload contains only non-sensitive identifiers.
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' },
    );

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

module.exports = { register, login, getMe, sanitizeUser };
