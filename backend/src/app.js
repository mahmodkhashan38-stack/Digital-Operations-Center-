const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organization.routes');
const userRoutes = require('./routes/user.routes');
const serviceCategoryRoutes = require('./routes/serviceCategory.routes');
const requestRoutes = require('./routes/request.routes');
const chatRoutes = require('./routes/chat.routes');
const notificationRoutes = require('./routes/notification.routes');
// DOC-64 - "Audit Log" - a separate, administrative-only collection, never
// mounted under /api/requests or merged with DOC-17's RequestActivity -
// see models/AuditLog.js's own top comment for the full distinction.
const auditLogRoutes = require('./routes/auditLog.routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { UPLOAD_ROOT } = require('./middleware/upload');

const app = express();

// SECURITY HARDENING (passwords/HTTPS) - `trust proxy` is OFF (Express's
// own default) unless TRUST_PROXY is explicitly set. Only set this when
// the deployment genuinely sits behind a reverse proxy/load balancer that
// itself sets X-Forwarded-* headers (nginx, a cloud platform's edge,
// etc.) - blindly trusting X-Forwarded-For/X-Forwarded-Proto when there
// is no real proxy in front would let any client spoof its own IP/
// protocol. Accepts the same values Express itself documents for this
// setting (a number of hops, e.g. "1"; a specific IP/CIDR; "loopback";
// or "true"/"false") - passed straight through, never reinterpreted.
if (process.env.TRUST_PROXY) {
  const trustProxyValue = process.env.TRUST_PROXY === 'true'
    ? true
    : process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxyValue);
}

// SECURITY HARDENING (passwords/HTTPS) - Helmet sets a set of safe
// default response headers (X-Content-Type-Options: nosniff,
// Referrer-Policy, X-Frame-Options/frameguard, X-DNS-Prefetch-Control,
// etc.) with two deliberate exceptions, both OFF by default and each
// independently opt-in:
//   - contentSecurityPolicy: this backend serves JSON plus one static
//     image-content route (GET .../content and the legacy
//     /api/uploads/requests mount) - it never serves HTML, so a CSP
//     tuned for an HTML-rendering server would add complexity with no
//     real protective effect here, and risks breaking the one binary
//     image response if misconfigured. Left disabled - a documented
//     choice, not an oversight.
//   - hsts (Strict-Transport-Security): NEVER enabled automatically.
//     HSTS is sticky in the browser (it can lock a visitor out of a
//     domain that later stops serving HTTPS, including during local
//     development against a HTTPS_ENABLED=false server) - task spec is
//     explicit that it must never be turned on "blindly". Only enabled
//     when the operator explicitly sets HSTS_ENABLED=true, which should
//     only happen once HTTPS has been confirmed to work for every
//     visitor (see README's Security & HTTPS section).
const hstsExplicitlyEnabled = process.env.HSTS_ENABLED === 'true';
app.use(helmet({
  contentSecurityPolicy: false,
  hsts: hstsExplicitlyEnabled,
}));

// SECURITY HARDENING (passwords/HTTPS) - for a production/network
// deployment where plain HTTP can reach this app (FORCE_HTTPS=true),
// redirect it to HTTPS. Deliberately environment-aware and OFF by
// default so it can never affect local development, automated tests, or
// a plain health check: FORCE_HTTPS is unset/false in every existing
// workflow, so this middleware is a pure no-op unless an operator
// explicitly opts in AFTER confirming (a) HTTPS_ENABLED=true (Express
// itself terminates TLS), or (b) a reverse proxy in front already
// terminates TLS AND TRUST_PROXY is configured correctly so
// `req.secure`/`x-forwarded-proto` reflects the real client protocol -
// enabling this without one of those two being true first would either
// do nothing useful or (behind a misconfigured proxy that never sets
// X-Forwarded-Proto) create a redirect loop. `req.secure` already
// accounts for Express's own `trust proxy` setting above, so this never
// needs to re-parse forwarded headers itself.
const forceHttpsEnabled = process.env.FORCE_HTTPS === 'true';
if (forceHttpsEnabled) {
  app.use((req, res, next) => {
    if (req.secure) {
      return next();
    }
    // Health checks must keep working over plain HTTP even when
    // FORCE_HTTPS is on, so an uptime monitor or orchestrator probing
    // the app before/without TLS is never redirected into a failure.
    if (req.path === '/api/health') {
      return next();
    }
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  });
}

// Core middleware
//
// SECURITY HARDENING (passwords/HTTPS) - CORS now allows only explicitly
// configured origins instead of the previous fully-permissive default
// (`cors()` with no options reflects every Origin). FRONTEND_ORIGIN is a
// comma-separated allowlist of exact origins (scheme + host + port); it
// defaults to this project's own local Vite dev origins so `npm run dev`
// keeps working unchanged with zero configuration. A request with no
// Origin header at all (server-to-server calls, curl, the health check)
// is still allowed through - CORS is a browser-enforced mechanism and
// has nothing to check when there is no browser Origin. `credentials` is
// left at its default `false`: this project authenticates via a
// manually-attached `Authorization: Bearer <token>` header (never
// cookies), so the CORS "credentials" flag - which governs cookies/HTTP
// auth dialogs/TLS client certs - does not apply here.
const DEFAULT_DEV_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
const allowedOrigins = (process.env.FRONTEND_ORIGIN || DEFAULT_DEV_ORIGINS)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    const corsError = new Error('This origin is not permitted to access this API.');
    corsError.statusCode = 403;
    return callback(corsError);
  },
}));
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
// DOC-18 - "In-App Notifications" - a separate, per-recipient inbox, never
// mounted under /api/requests (a notification is about a Request but is
// not itself Request-scoped data the way DOC-17's Timeline is - see
// models/Notification.js's own top comment for the full distinction).
app.use('/api/notifications', notificationRoutes);
// DOC-64 - "Audit Log" - Manager (own Organization) / System Admin
// (platform-wide) read access only; see routes/auditLog.routes.js for the
// full authorization chain.
app.use('/api/audit-logs', auditLogRoutes);

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
