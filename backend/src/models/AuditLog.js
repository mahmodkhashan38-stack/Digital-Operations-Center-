const mongoose = require('mongoose');

/**
 * Administrative Audit Log (DOC-64)
 * -------------------------------------------------------------------------
 *
 * NOT THE REQUEST ACTIVITY TIMELINE (DOC-17)
 * RequestActivity (models/RequestActivity.js) answers "what happened to
 * THIS Request?" - Request creation, assignment, status changes, cancel,
 * images, etc. This model answers a completely different question: "who
 * performed an ADMINISTRATIVE/SECURITY-SENSITIVE action, what changed, on
 * which entity, and when?" - Organization lifecycle, Manager/User account
 * management, Organization Settings, and self-service Profile changes.
 * Neither model is ever a substitute for the other, and this ticket does
 * not duplicate any normal Request lifecycle event into this collection
 * (see services/auditLog.service.js's own top comment and
 * backend/README.md's "Audit Log (DOC-64)" section for the full
 * classification rationale - default rule: Request operational history
 * stays in RequestActivity, administrative account/org changes go here,
 * never both without a documented strong reason, and none was found).
 *
 * SCHEMA
 *   organizationId - the AFFECTED Organization, when one exists (task spec
 *     section 4: "Prefer storing the affected Organization when one
 *     exists"). For an organization-scoped Manager action, this is always
 *     the Manager's own `req.user.organizationId` - never trusted from
 *     req.body/req.query (the same DOC-38 rule every other organization-
 *     scoped write in this project already follows). For a System Admin
 *     action, this is the Organization the action was actually performed
 *     on when one exists (create/activate/deactivate/regenerate-code/
     *     assign-manager/delete an Organization), or `null` for a genuinely
 *     platform-level action with no single affected Organization (e.g.
 *     System Admin's own self-service Profile update).
 *   actorId - who performed the action. Always `req.user.userId` - a
 *     trusted, database-backed identity from middleware/auth.js, NEVER
 *     `req.body.actorId` (task spec section 5). Required - every audit
 *     entry has a real actor; there is no system-generated audit event in
 *     this version.
 *   action - a controlled enum (AUDIT_ACTIONS below) - never an arbitrary
 *     free-text event, the same "no arbitrary strings" discipline DOC-17's
 *     own `type` field already enforces.
 *   targetType / targetId - which KIND of entity was acted on
 *     ('Organization' | 'User' | 'ServiceCategory') and its real
 *     Mongoose `_id`. Deliberately two separate fields rather than one
 *     polymorphic `ref` - Mongoose's `refPath` would work here too, but a
 *     plain enum + id is simpler to reason about for a read-only audit
 *     trail that only ever needs to DISPLAY a safe target identity
 *     (resolved by the read API, never a live `.populate()` that could
 *     break if the target is later deleted).
 *   changes - structured before/after values for ONLY the fields that
 *     actually changed (task spec section 9: "Do not store unchanged
 *     fields"), e.g. `{ role: { from: 'employee', to: 'operator' } }`.
 *     `null` for an action with no meaningful before/after diff (e.g.
 *     ORGANIZATION_CREATED, USER_PASSWORD_RESET - a password reset has no
 *     safe "from/to" value to show at all, see this file's own
 *     PASSWORD SECURITY note below).
 *   metadata - small, already-safe, structured extra context (e.g.
 *     `{ organizationName, targetUserName }`) - resolved/curated by the
 *     calling controller BEFORE this document is ever created, never a
 *     raw `req.body` dump (task spec section 10). Both `changes` and
 *     `metadata` pass through `services/auditLog.service.js`'s own
 *     `sanitizeStructuredData` as a defense-in-depth filter regardless of
 *     what a caller passes in - see that file's own comment.
 *   createdAt - server time only, via Mongoose's own `timestamps` option
 *     (see below) - never client-suppliable, exactly like DOC-17's
 *     RequestActivity already guarantees for the identical reason (task
 *     spec section 5.2 test: "audit entry createdAt cannot be forged").
 *
 * PASSWORD / SECRET SECURITY (task spec sections 7/10/40 - CRITICAL)
 * This collection must NEVER contain a plaintext password, a temporary
 * password, a `passwordHash`, or any of `currentPassword`/`newPassword`/
 * `confirmPassword` - not even accidentally. `USER_PASSWORD_RESET`'s own
 * `changes` is always `null` (there is no safe "from/to" to show for a
 * password), and its `metadata` is limited to `{ targetUserId,
 * targetUserName }` by the one call site that creates it
 * (user.controller.js's `resetUserPassword`). The service-level
 * `sanitizeStructuredData` filter is a second, independent line of
 * defense against this same class of leak, not the only one.
 *
 * COMPANY CODE SECURITY (task spec section 8)
 * `COMPANY_CODE_REGENERATED` never stores the actual old/new companyCode
 * values - only `{ companyCodeChanged: true }` (organization.controller.js's
 * `regenerateCompanyCode`). This collection is an audit trail, never a
 * secondary store of onboarding codes.
 *
 * IMMUTABILITY (task spec section 36)
 * There is no PATCH/DELETE endpoint anywhere for this collection (see
 * routes/auditLog.routes.js - only a single `GET` route exists) - the same
 * "immutable by the complete absence of any edit/delete endpoint" pattern
 * RequestActivity (DOC-17) and Notification (DOC-18) already establish in
 * this project, not a schema-level lock. No role, including System Admin,
 * can edit or delete an audit entry through any API in this project.
 *
 * HISTORICAL DATA (task spec section 37)
 * Administrative actions performed before this ticket shipped simply have
 * no corresponding AuditLog entry - there is no backfill script, and none
 * is run automatically on startup (see app.js - this model requires no
 * migration).
 */
const AUDIT_ACTIONS = [
  // Organization lifecycle (System Admin)
  'ORGANIZATION_CREATED',
  'ORGANIZATION_UPDATED',
  'ORGANIZATION_ACTIVATED',
  'ORGANIZATION_DEACTIVATED',
  'ORGANIZATION_DELETED',
  'COMPANY_CODE_REGENERATED',
  'MANAGER_ASSIGNED',
  'MANAGER_REPLACED',
  // User/account management (Manager)
  'USER_ROLE_CHANGED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_PASSWORD_RESET',
  'USER_SPECIALTIES_CHANGED',
  // Service Categories (Manager, DOC-43)
  'SERVICE_CATEGORY_CREATED',
  'SERVICE_CATEGORY_UPDATED',
  'SERVICE_CATEGORY_ACTIVATED',
  'SERVICE_CATEGORY_DEACTIVATED',
  // Organization Settings (Manager, DOC-61)
  'ORGANIZATION_SETTINGS_UPDATED',
  // Self-service Profile (any role, DOC-62)
  'PROFILE_UPDATED',
];

const TARGET_TYPES = ['Organization', 'User', 'ServiceCategory'];

const auditLogSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
      index: true,
    },
    targetType: {
      type: String,
      enum: TARGET_TYPES,
      required: true,
    },
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    changes: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  // Only `createdAt` - no `updatedAt` (task spec: "Use timestamps or an
  // explicit createdAt" / immutability - a record that can never be
  // edited has no meaningful "last updated" concept, so this deliberately
  // does not add a field with no real use, unlike this project's other
  // `{ timestamps: true }` models).
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Task spec section 38 - "add useful indexes... do not add excessive
// indexes". Exactly the three the task spec itself names, each leading
// with the field the real query shapes actually filter by first:
//   - organizationId+createdAt: a Manager's own-Organization log (the most
//     common read - GET /api/audit-logs for a Manager).
//   - actorId+createdAt: the optional "actor" filter (System Admin/Manager
//     narrowing to one person's actions).
//   - action+createdAt: the optional "action" filter.
// No separate `targetType`/`targetId` index is added - filtering by target
// is not a query shape either read path actually needs yet, and adding one
// speculatively would be exactly the "excessive indexes" the task spec
// warns against.
auditLogSchema.index({ organizationId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
module.exports.TARGET_TYPES = TARGET_TYPES;
