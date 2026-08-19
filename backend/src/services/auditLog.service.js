/**
 * Administrative Audit Log - recording service (DOC-64)
 * -------------------------------------------------------------------------
 *
 * WHY THIS FILE EXISTS
 * The sole owner of all AuditLog writes in this project - controllers never
 * call `AuditLog.create(...)` directly (task spec section 11: "Controllers
 * should not directly call AuditLog.create everywhere if avoidable"). This
 * is the same "one owner of write logic" discipline
 * requestActivity.service.js (DOC-17) and notification.service.js (DOC-18)
 * already established - centralizing action-type validation, sensitive-data
 * sanitization, and safe actor derivation in exactly one place instead of
 * duplicated across every controller that needs to log something.
 *
 * FAILURE / CONSISTENCY STRATEGY (task spec section 12)
 * The underlying administrative business operation (create an Organization,
 * change a role, reset a password, ...) is always the PRIMARY action and is
 * always already fully committed (`.save()`/`.create()` already resolved)
 * BEFORE `recordAuditLog` is ever called. This function never throws - any
 * failure (a bad `action`/`targetType`, a database error) is caught, logged
 * server-side via `console.error` (never leaking the attempted metadata to
 * a client - the caller has already sent its own success response by the
 * time this runs, or is about to, independent of this outcome), and
 * resolved to `null` rather than propagated. A rare audit-write failure
 * therefore produces a fully correct, already-succeeded business outcome
 * with one missing audit entry - never a business operation that gets
 * rolled back, blocked, or reported as failed because logging failed. This
 * mirrors DOC-17/DOC-18's own documented choice not to use MongoDB
 * multi-document transactions for the identical reason (standalone
 * `mongod` compatibility - see requestActivity.service.js's own longer
 * writeup, not repeated here). This is a deliberate, documented trade-off:
 * an audit trail that is "best-effort, extremely reliable in practice" is
 * preferred over one that could ever destabilize a real administrative
 * action a person is waiting on.
 *
 * SENSITIVE-FIELD SANITIZATION (task spec section 10 - CRITICAL)
 * `sanitizeStructuredData` is applied to BOTH `changes` and `metadata`
 * before anything is written, regardless of what a caller passes in. This
 * is defense-in-depth, not the only safeguard: every call site in this
 * project is already written to pass small, hand-curated, already-safe
 * objects (task spec: "Prefer explicit safe metadata over generic req.body
 * logging... NEVER dump req.body into AuditLog" - no call site added by
 * this ticket ever does that), but a future call site making the same
 * mistake other parts of this codebase have been careful never to make
 * would still have any sensitive-looking key stripped here rather than
 * silently persisted.
 */

const AuditLog = require('../models/AuditLog');

const { AUDIT_ACTIONS, TARGET_TYPES } = AuditLog;

// Substring match on the LOWERCASED key name - deliberately broad (matches
// 'password', 'newPassword', 'confirmPassword', 'temporaryPassword',
// 'passwordHash' all via the single 'password' entry) rather than an exact-
// name allowlist, so a key this list's authors did not anticipate but that
// still obviously names a credential/secret (e.g. a future 'apiSecret') is
// still caught by the broader 'secret' entry. Task spec section 10's own
// named examples are all covered: password/passwordHash/currentPassword/
// newPassword/confirmPassword/temporaryPassword (all -> 'password'), JWT/
// JWT_SECRET (-> 'jwt'), MONGODB_URI (-> 'mongodb_uri' / 'mongo_uri'), AWS
// secret/access keys (-> 'aws', 'secret', 'accesskey'), TLS private keys
// (-> 'privatekey', 'tls').
const SENSITIVE_KEY_SUBSTRINGS = [
  'password', 'passwordhash', 'secret', 'jwt', 'token', 'credential',
  'mongodb_uri', 'mongo_uri', 'aws', 'accesskey', 'access_key',
  'privatekey', 'private_key', 'tls', 'apikey', 'api_key',
];

function isSensitiveKey(key) {
  const lowerKey = String(key).toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((pattern) => lowerKey.includes(pattern));
}

// Recursively strips any sensitive-looking key from a plain object/array,
// leaving primitives (string/number/boolean/null), Dates, and ObjectIds
// (routinely stored as-is elsewhere in this project, e.g.
// Notification.metadata) untouched. Depth-limited (task spec: audit
// metadata is meant to be small, curated, structured context - never a
// deeply nested arbitrary blob) - anything past MAX_DEPTH is dropped
// rather than walked indefinitely, a defensive bound against a caller
// accidentally passing a full Mongoose document (which self-references and
// could otherwise recurse forever).
const MAX_SANITIZE_DEPTH = 4;

function sanitizeStructuredData(value, depth = 0) {
  if (value === null || value === undefined) {
    return value === undefined ? undefined : null;
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeStructuredData(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  // Mongoose ObjectId (and anything else with its own toString-based id
  // shape) - stored as-is, the same way every other model in this project
  // already stores id references inside Mixed fields (e.g.
  // Notification.metadata).
  if (valueType === 'object' && typeof value.toHexString === 'function') {
    return value;
  }
  if (valueType === 'object') {
    const safeObject = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        continue; // dropped entirely, never persisted, not even masked
      }
      const sanitizedValue = sanitizeStructuredData(nestedValue, depth + 1);
      if (sanitizedValue !== undefined) {
        safeObject[key] = sanitizedValue;
      }
    }
    return safeObject;
  }
  // Functions/symbols/anything else unexpected - dropped, never persisted.
  return undefined;
}

// Records one administrative audit event. Never throws - see this file's
// own top comment on failure strategy. Callers therefore never need their
// own try/catch, and never await-block their response on this call
// (task spec section 12: "business operation succeeds -> audit write
// attempted", never the other order).
//
// `actorId` - required; always the caller's own trusted `req.user.userId`,
//   never anything from req.body (task spec section 5).
// `organizationId` - the AFFECTED Organization when one exists, `null` for
//   a genuinely platform-level action (task spec section 4). Never trusted
//   from req.body/req.query - every call site in this project derives it
//   from either `req.user.organizationId` (Manager actions) or an
//   already-resolved Organization document (System Admin actions on a
//   specific Organization).
// `action` - required; must be one of AuditLog.AUDIT_ACTIONS.
// `targetType` / `targetId` - required; `targetType` must be one of
//   AuditLog.TARGET_TYPES.
// `changes` - optional, default `null`. Structured `{ field: {from, to} }`
//   pairs for ONLY the fields that actually changed - never a full
//   document dump.
// `metadata` - optional, default `{}`. Small, already-safe, structured
//   extra context - never req.body, never a password/secret/token.
async function recordAuditLog({
  actorId, organizationId = null, action, targetType, targetId, changes = null, metadata = {},
}) {
  try {
    if (!actorId) {
      throw new Error('recordAuditLog requires actorId.');
    }
    if (!AUDIT_ACTIONS.includes(action)) {
      throw new Error(`recordAuditLog received an unrecognized action: "${action}".`);
    }
    if (!TARGET_TYPES.includes(targetType)) {
      throw new Error(`recordAuditLog received an unrecognized targetType: "${targetType}".`);
    }
    if (!targetId) {
      throw new Error('recordAuditLog requires targetId.');
    }

    const sanitizedChanges = changes ? sanitizeStructuredData(changes) : null;
    const sanitizedMetadata = sanitizeStructuredData(metadata || {}) || {};

    return await AuditLog.create({
      organizationId: organizationId || null,
      actorId,
      action,
      targetType,
      targetId,
      changes: sanitizedChanges,
      metadata: sanitizedMetadata,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to record audit log (action=${action}, targetType=${targetType}, targetId=${targetId}):`, error.message);
    return null;
  }
}

module.exports = {
  recordAuditLog,
  sanitizeStructuredData,
  AUDIT_ACTIONS,
  TARGET_TYPES,
};
