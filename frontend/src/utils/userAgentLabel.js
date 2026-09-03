// DOC-69 - "Login History & Active Sessions" (task spec section 22 -
// "Do not overengineer device fingerprinting... If no parser dependency
// is justified, safely display a shortened User-Agent. Avoid adding a
// large unnecessary dependency."). A small, dependency-free, best-effort
// mapping from a raw User-Agent string to a human-readable label like
// "Chrome on Windows" - this is DISPLAY TEXT ONLY, never used for any
// authorization/security decision anywhere in this project (the backend
// never relies on User-Agent for anything beyond storing it - see
// backend/src/services/userSession.service.js's own comment). Order
// matters: Edge/OPR must be checked before Chrome (both include
// "Chrome" in their own UA string), and iPad/iPhone before Safari.
function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return 'Opera';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return 'Safari';
  return null;
}

function detectPlatform(ua) {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

const MAX_FALLBACK_LENGTH = 60;

// Never throws - a `null`/empty/unrecognized User-Agent (a very old
// session, a non-browser API client, a future browser this simple list
// does not yet know) falls back to a safe, short, generic label rather
// than an error or a wall of raw UA text (task spec: "safely display a
// shortened User-Agent").
export function describeUserAgent(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') {
    return 'Unknown device';
  }

  const browser = detectBrowser(userAgent);
  const platform = detectPlatform(userAgent);

  if (browser && platform) {
    return `${browser} on ${platform}`;
  }
  if (browser) {
    return browser;
  }
  if (platform) {
    return platform;
  }

  const trimmed = userAgent.trim();
  return trimmed.length > MAX_FALLBACK_LENGTH ? `${trimmed.slice(0, MAX_FALLBACK_LENGTH)}...` : trimmed;
}

export default describeUserAgent;
