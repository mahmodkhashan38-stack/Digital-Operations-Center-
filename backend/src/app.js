const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organization.routes');
const userRoutes = require('./routes/user.routes');
const serviceCategoryRoutes = require('./routes/serviceCategory.routes');
const requestRoutes = require('./routes/request.routes');
const chatRoutes = require('./routes/chat.routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { UPLOAD_ROOT } = require('./middleware/upload');

const app = express();

// Core middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/service-categories', serviceCategoryRoutes);
app.use('/api/requests', requestRoutes);
// DOC-60 - "Organization Chat" - a separate, organization-wide
// communication feature, never mounted under /api/requests (it is not
// tied to any single Request - see models/ChatMessage.js's own top
// comment for why this is a genuinely separate collection/route, not a
// reuse of DOC-13's Request Comments system).
app.use('/api/chat', chatRoutes);

// DOC-45 - controlled static serving of uploaded Request image
// attachments, mounted under the same /api namespace as everything else
// so the frontend can build a full URL with the same VITE_API_BASE_URL it
// already uses for every other call (`${API_BASE_URL}${attachment.url}`).
// ONLY this one configured directory (UPLOAD_ROOT, backend/uploads/
// requests by default) is ever served - `express.static` never walks
// outside it, and generated filenames (see middleware/upload.js) are
// unguessable UUIDs, so this is acceptable unauthenticated static serving
// for this academic/local project (no sensitive data lives in an image
// filename, and nothing else in this directory is ever anything but a
// Request image). `dotfiles: 'deny'` and `index: false` are explicit
// defense in depth - the backend's own `.env`/source files live entirely
// outside this directory regardless.
app.use(
  '/api/uploads/requests',
  express.static(UPLOAD_ROOT, { dotfiles: 'deny', index: false, redirect: false }),
);

// 404 handler for unknown routes
app.use(notFound);

// Centralized error handler (must be last)
app.use(errorHandler);

module.exports = app;
