/**
 * "PASSWORD RESET RATE LIMITING" / "EMAIL ABUSE PREVENTION" (originally
 * built for the now-retired Sprint 7 "SMS COST ABUSE" rate limiting - see
 * git history - this module itself needed no changes for the DOC Email
 * Authentication & Notification Upgrade, only the callers' key
 * builders/budgets did).
 * -------------------------------------------------------------------------
 *
 * WHY A SIMPLE IN-MEMORY LIMITER, NOT REDIS
 * This project has no cache/queue infrastructure anywhere else in its
 * stack (see backend/package.json's own dependency list - Mongoose,
 * Express, and a small, deliberately minimal set of others). Introducing
 * Redis (or any other external store) for rate limiting alone would be
 * exactly the kind of "heavy new dependency for one feature" this
 * project's own established conventions avoid (see, e.g., services/
 * email.service.js's own choice to call Brevo's REST API directly rather
 * than add an SDK). A plain in-memory sliding-window counter, keyed by a
 * caller-supplied string, is sufficient for this project's actual
 * deployment shape (a single Node process - see backend/src/server.js,
 * no cluster/multi-instance mode anywhere in this codebase) and is
 * documented here as a KNOWN, ACCEPTED LIMITATION for a future
 * multi-instance deployment (each instance would enforce its own
 * independent limit rather than a shared one - see backend/README.md's
 * own Email Authentication & Notification Upgrade section for the same
 * note).
 *
 * USAGE
 *   const { rateLimit } = require('../middleware/rateLimit');
 *   router.post('/forgot-password', rateLimit({ windowMs: 15*60*1000, max: 5, keyFn: forgotPasswordKey }), forgotPassword);
 *
 * `keyFn(req)` builds the bucket key - callers combine whatever signals
 * make sense for that endpoint (task spec: "Rate-limit by suitable
 * combination: IP, account/email hash, time window"). This module never
 * assumes a specific key shape.
 */

// Map<key, { count, windowStart }>. A single process-lifetime Map is
// intentionally unbounded-but-self-pruning: `sweepExpired` (called
// opportunistically on every request, never on its own timer/interval -
// this project starts no background timers anywhere else either) removes
// any bucket whose window has already elapsed, so memory does not grow
// without bound across a long-running process.
const buckets = new Map();

function sweepExpired(now) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > bucket.windowMs) {
      buckets.delete(key);
    }
  }
}

/**
 * Returns true (and records the hit) if `key` is still within its
 * `max`-per-`windowMs` budget; returns false (without recording) once the
 * budget is exhausted for the remainder of the current window. Exported
 * directly (not just as Express middleware) so services that are not
 * themselves an Express route handler - e.g. services/
 * emailVerification.service.js's own resend cooldown, if it ever needs a
 * non-HTTP check - can reuse the exact same counting logic.
 */
function checkAndRecord(key, { windowMs, max }) {
  const now = Date.now();
  sweepExpired(now);

  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now, windowMs });
    return true;
  }

  if (existing.count >= max) {
    return false;
  }

  existing.count += 1;
  return true;
}

/**
 * Express middleware factory. `keyFn(req)` must return a non-empty string
 * (a bad/missing key fails CLOSED - the request is rejected rather than
 * silently exempted from rate limiting, since a missing key most likely
 * means the key derivation itself is broken, not that this caller is
 * exempt).
 */
function rateLimit({
  windowMs, max, keyFn, message = 'Too many requests. Please try again later.',
}) {
  return (req, res, next) => {
    let key;
    try {
      key = keyFn(req);
    } catch (error) {
      key = null;
    }
    if (!key || typeof key !== 'string') {
      return res.status(429).json({ status: 'error', message });
    }

    const allowed = checkAndRecord(key, { windowMs, max });
    if (!allowed) {
      return res.status(429).json({ status: 'error', message });
    }
    return next();
  };
}

// Test-only reset hook (mirrors this project's other test-harness-support
// exports, e.g. ThemeContext.jsx's additive test exports from a prior
// ticket) - never called from any production code path.
function _resetForTests() {
  buckets.clear();
}

module.exports = { rateLimit, checkAndRecord, _resetForTests };
