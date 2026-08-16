require('dotenv').config();
const fs = require('fs');
const http = require('http');
const https = require('https');
const app = require('./app');
const connectDB = require('./config/db');

const PORT = process.env.PORT || 5000;

// JWT_SECRET is required to sign and verify authentication tokens.
// Validated the same way MONGODB_URI is in config/db.js: fail fast with a
// clear message instead of letting login fail mysteriously later.
if (!process.env.JWT_SECRET) {
  console.error('Server startup failed: JWT_SECRET is not defined in the environment.');
  process.exit(1);
}

// SECURITY HARDENING (passwords/HTTPS) - optional direct-Node HTTPS
// support, OFF by default. This is deliberately opt-in and additive:
// every existing local-dev workflow (`npm start` with no HTTPS_ENABLED
// set) continues to serve plain HTTP on PORT exactly as before - nothing
// about this changes unless HTTPS_ENABLED is explicitly set to "true".
//
// This exists for two cases: (1) local HTTPS development/LAN testing
// with a self-signed or mkcert-issued certificate, and (2) a production
// deployment that has no reverse proxy / TLS terminator in front of it
// and needs Express itself to speak TLS. If the deployment DOES sit
// behind a reverse proxy or hosting platform that already terminates
// HTTPS (nginx, Render, Railway, etc.), leave HTTPS_ENABLED unset/false -
// Express keeps speaking plain HTTP to the proxy on its own internal
// network, which is the standard, safer architecture (see backend
// README's "GridFS"-adjacent new "Security & HTTPS" section for the full
// writeup of both architectures).
//
// No certificate or private key is ever hardcoded in source. Only a
// local file PATH is read from the environment - the actual cert/key
// files themselves must be gitignored (*.pem/*.key/*.p12/*.pfx already
// are, see .gitignore) and are never committed.
const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';

function buildHttpsCredentialsOrExit() {
  const certPath = process.env.SSL_CERT_PATH;
  const keyPath = process.env.SSL_KEY_PATH;

  if (!certPath || !keyPath) {
    console.error(
      'Server startup failed: HTTPS_ENABLED=true requires both SSL_CERT_PATH and SSL_KEY_PATH to be set.',
    );
    process.exit(1);
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error(
      `Server startup failed: certificate or key file not found. `
      + `SSL_CERT_PATH="${certPath}", SSL_KEY_PATH="${keyPath}".`,
    );
    process.exit(1);
  }

  // File CONTENTS are read here, at startup, into memory only - never
  // logged, never included in any response, never re-exported from this
  // module.
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

// Validate the HTTPS configuration (if enabled) BEFORE ever attempting a
// MongoDB connection - a misconfigured/missing certificate should fail
// in milliseconds, not after waiting out Mongoose's own connection
// timeout first. The certificate/key are read into memory now but the
// server itself is not created/bound to a port until after connectDB()
// resolves, preserving the existing "connect to MongoDB before accepting
// any traffic" guarantee unchanged.
const httpsCredentials = HTTPS_ENABLED ? buildHttpsCredentialsOrExit() : null;

// Connect to MongoDB before accepting HTTP/HTTPS traffic.
const startServer = async () => {
  await connectDB();

  const server = HTTPS_ENABLED
    ? https.createServer(httpsCredentials, app)
    : http.createServer(app);

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (${HTTPS_ENABLED ? 'HTTPS' : 'HTTP'})`);
  });
};

startServer();
