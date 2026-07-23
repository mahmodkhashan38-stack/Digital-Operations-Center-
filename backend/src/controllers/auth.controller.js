const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { normalizeCompanyCode, isValidCompanyCode } = require('../utils/companyCode');

const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

// Strips sensitive fields (passwordHash) before sending a user back to the client.
// organizationId is included as-is (an id, or null) - it is not sensitive, and
// exposing it lets the frontend know which organization the user belongs to.
// For employees registered since DOC-33 this is always a real Organization
// id; system_admin is always null; legacy pre-DOC-30 accounts and any
// account not yet migrated (DOC-39) may still show null.
const sanitizeUser = (user) => ({
  id: user._id,
  fullName: user.fullName,
  email: user.email,
  role: user.role,
  organizationId: user.organizationId,
  isActive: user.isActive,
  createdAt: user.createdAt,
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

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        status: 'error',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      });
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

    // Token payload contains only non-sensitive identifiers. `role` is
    // included for debuggability only - it is never trusted on its own.
    // organizationId is deliberately NOT put in the token at all: DOC-38
    // made middleware/auth.js re-read role/organizationId/isActive from
    // the database on every request instead of trusting the JWT payload
    // for them, so a token cannot go stale if the user's role, Organization,
    // or active status changes after it was issued. Only userId (the
    // caller's identity) is actually read out of the verified token.
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

// SALT_ROUNDS / EMAIL_REGEX / MIN_PASSWORD_LENGTH are exported so other
// trusted server-side entry points (scripts/seedSystemAdmin.js,
// controllers/organization.controller.js) validate email/password and hash
// passwords the exact same way as public registration, instead of
// duplicating these rules in a second place.
module.exports = { register, login, getMe, sanitizeUser, SALT_ROUNDS, EMAIL_REGEX, MIN_PASSWORD_LENGTH };
