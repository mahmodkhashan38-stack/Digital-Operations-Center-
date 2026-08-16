import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';

// SECURITY HARDENING (passwords/HTTPS) - optional HTTPS for the Vite DEV
// server only, for LAN testing over TLS. OFF by default - a plain
// `npm run dev` continues to serve http://localhost:5173 exactly as
// before, with zero configuration required.
//
// Deliberately NOT VITE_-prefixed: DEV_HTTPS_ENABLED/DEV_SSL_CERT_PATH/
// DEV_SSL_KEY_PATH are dev-server-only configuration, read here in this
// file's own Node/config context via `loadEnv()` - never bundled into
// client code or exposed through `import.meta.env` (VITE_-prefixed
// variables are the ONLY ones Vite ever exposes to the browser bundle -
// see frontend/README.md's Security & HTTPS section). No certificate or
// private key content is ever hardcoded here - only a local, gitignored
// file PATH, read from a `.env` file that is itself gitignored.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devHttpsEnabled = env.DEV_HTTPS_ENABLED === 'true';

  let httpsOption;
  if (devHttpsEnabled) {
    if (!env.DEV_SSL_CERT_PATH || !env.DEV_SSL_KEY_PATH) {
      throw new Error(
        'DEV_HTTPS_ENABLED=true requires both DEV_SSL_CERT_PATH and DEV_SSL_KEY_PATH to be set in frontend/.env.',
      );
    }
    httpsOption = {
      cert: fs.readFileSync(env.DEV_SSL_CERT_PATH),
      key: fs.readFileSync(env.DEV_SSL_KEY_PATH),
    };
  }

  return {
    plugins: [react()],
    server: devHttpsEnabled ? { https: httpsOption } : {},
  };
});
