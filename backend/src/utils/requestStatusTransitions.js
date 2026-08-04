// DOC-12 - the single, centralized source of truth for "who may move a
// Request from status A to status B". Every role's rules live here, in
// one small pure function - nothing in request.controller.js ever
// hand-rolls a transition check inline, and no other controller
// duplicates this logic. Keeping this a pure function (no DB access, no
// req/res) also makes it trivially unit-testable on its own.
//
// Final intended lifecycle (DOC-12 task spec):
//
//   OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED
//                              |
//                              v
//                          REOPENED -> IN_PROGRESS
//
// Business rules (deliberately conservative - see each role's own
// comment below for the reasoning):
//
//   OPERATOR (only the Operator this Request is actually assigned to):
//     open      -> in_progress   ("I'm starting this.")
//     in_progress -> resolved    ("I finished the work.")
//     reopened  -> in_progress   ("I'm looking at it again.")
//     Nothing else - an Operator can never jump straight to closed, and
//     can never re-resolve/re-open on their own authority.
//
//   EMPLOYEE (only the Employee who created this Request):
//     resolved -> closed         ("Yes, solved.")
//     resolved -> reopened       ("No, still broken.")
//     Nothing else - an Employee cannot start, progress, or otherwise
//     drive the workflow; they only confirm or dispute a claimed fix.
//     (DOC-46 will separately own Employee edit/cancel of the Request
//     itself - not a status transition, and not implemented here.)
//
//   MANAGER (any Manager in the Request's own Organization):
//     resolved -> closed         (administrative oversight/confirmation)
//     Nothing else - a Manager may not skip the Operator/Employee steps
//     of the workflow; this is the one conservative exception the task
//     spec explicitly allows ("Manager may close a resolved Request if
//     business oversight requires it"), not a general override.
//
//   SYSTEM ADMIN: never allowed. System Admin manages the platform, not
//     day-to-day Organization workflow - enforced both here (returns
//     false unconditionally) and explicitly in the controller (DOC-12
//     section 8), since organizationScope.js's middleware bypasses
//     system_admin rather than blocking it (system_admin is a global,
//     non-organization-scoped role, DOC-31/38), so the controller cannot
//     rely on middleware alone to keep System Admin out of this endpoint.
//
// DOC-46 adds a sixth status, 'cancelled' - the Employee's own "I no
// longer need this" action, deliberately NOT part of this transition
// matrix at all:
//   - No role's map below lists 'cancelled' as an outbound target, so
//     canTransitionRequestStatus already returns false for every attempt
//     to reach 'cancelled' through THIS helper - 'cancelled' can only
//     ever be set by the dedicated PATCH /api/requests/:id/cancel
//     endpoint (request.controller.js's cancelMyRequest), which writes
//     `requestDoc.status = 'cancelled'` directly and never calls this
//     function at all.
//   - 'cancelled' is terminal, exactly like 'closed': the explicit guard
//     below rejects every attempt to transition OUT of 'cancelled',
//     for every role, before any per-role map is even consulted - not
//     because the maps would have allowed it anyway (none of them
//     mention 'cancelled' as a currentStatus key, so a lookup already
//     falls through to `undefined`/`false`), but so that invariant stays
//     true by explicit design even if a future edit to any map below
//     were to add one by mistake.
const OPERATOR_TRANSITIONS = {
  open: 'in_progress',
  in_progress: 'resolved',
  reopened: 'in_progress',
};

const EMPLOYEE_TRANSITIONS = {
  resolved: ['closed', 'reopened'],
};

const MANAGER_TRANSITIONS = {
  resolved: ['closed'],
};

// canTransitionRequestStatus({ role, currentStatus, nextStatus, isCreator, isAssignedOperator })
// -> boolean
//
// Deliberately does NOT check "currentStatus === nextStatus" (same-state
// update) - the controller rejects that case itself with its own clear
// 400 message before ever calling this helper, since "no-op" is a
// different kind of rejection than "not authorized to do this", and the
// controller is what owns HTTP-facing messaging.
//
// `isCreator` / `isAssignedOperator` must be computed server-side by the
// caller from a fresh, DB-scoped Request document - never from anything
// in the request body. Being relevant to a Request's Category via
// Operator specialties (DOC-44) is NEVER sufficient authorization here on
// its own; only `isAssignedOperator` (assignedOperatorId === the calling
// Operator's own id) counts.
function canTransitionRequestStatus({ role, currentStatus, nextStatus, isCreator, isAssignedOperator }) {
  // 'cancelled' is terminal (DOC-46) - explicit and unconditional, ahead
  // of every role check below. Nobody, in any role, may move a Request
  // out of 'cancelled' through this generic status endpoint.
  if (currentStatus === 'cancelled') {
    return false;
  }
  // 'cancelled' may only ever be reached through the dedicated cancel
  // endpoint (cancelMyRequest), never through this generic transition
  // path - no role's map below lists it as a target anyway, but this
  // makes the rule explicit rather than incidental.
  if (nextStatus === 'cancelled') {
    return false;
  }

  if (role === 'operator') {
    if (!isAssignedOperator) return false;
    return OPERATOR_TRANSITIONS[currentStatus] === nextStatus;
  }

  if (role === 'employee') {
    if (!isCreator) return false;
    return (EMPLOYEE_TRANSITIONS[currentStatus] || []).includes(nextStatus);
  }

  if (role === 'manager') {
    return (MANAGER_TRANSITIONS[currentStatus] || []).includes(nextStatus);
  }

  // system_admin, or any unrecognized role - never authorized.
  return false;
}

module.exports = {
  canTransitionRequestStatus,
  OPERATOR_TRANSITIONS,
  EMPLOYEE_TRANSITIONS,
  MANAGER_TRANSITIONS,
};
