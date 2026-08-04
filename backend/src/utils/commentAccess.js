// DOC-13 - the single source of truth for "who may read/write comments on
// this Request", the same centralized-helper pattern DOC-12's
// canTransitionRequestStatus already established (utils/
// requestStatusTransitions.js) - not scattered inline role checks across
// comment.controller.js, and not three duplicated per-role endpoints.
//
// Deliberately reads NOTHING from the database itself and trusts NOTHING
// from req.body/req.query - every argument must be derived by the caller
// from a fresh, Organization-scoped Request document (see
// getRequestScopedToCaller in comment.controller.js) and from req.user.
//
// canRead and canWrite are kept as two separate functions (task spec
// section 11) specifically because of the closed-Request rule: a closed
// Request's comments must remain fully readable forever, but no new
// comment may be added once closed. Collapsing these into one function
// would risk exactly the bug the spec warns against - someone who can read
// but should not be able to write, or vice versa, diverging by accident.

// Base "may this role touch this Request's comments at all" rule, shared
// by both read and write - independent of the Request's current status.
//   employee  -> only the Request's own creator
//   operator  -> only the Operator actually assigned to this Request
//                (specialty relevance, DOC-44, is never checked here)
//   manager   -> any Request inside their own Organization (the Request
//                was already resolved via an Organization-scoped query
//                before this is ever called, so "same organization" is
//                already guaranteed by construction)
//   anything else (system_admin, or an unrecognized role) -> never
function hasRequestCommentAccess({ role, userId, requestCreatedBy, assignedOperatorId }) {
  if (role === 'employee') {
    return String(requestCreatedBy) === String(userId);
  }
  if (role === 'operator') {
    return !!assignedOperatorId && String(assignedOperatorId) === String(userId);
  }
  if (role === 'manager') {
    return true;
  }
  return false; // system_admin, or any unrecognized role
}

// GET .../comments - read access is NOT affected by Request status. A
// closed OR cancelled Request's conversation history must remain visible
// (task spec section 6/18, extended by DOC-46 section 18) - closing or
// cancelling a Request never hides what was already said.
function canReadRequestComments(params) {
  return hasRequestCommentAccess(params);
}

// Statuses that make a Request comment-read-only. 'closed' was the
// original DOC-13 rule; DOC-46 adds 'cancelled' to the exact same policy
// (a cancelled Request never had - and now never will have - further
// operational activity) rather than inventing a second, parallel
// read-only concept.
const COMMENT_READ_ONLY_STATUSES = ['closed', 'cancelled'];

// POST .../comments - identical base rule, PLUS: a 'closed' or
// 'cancelled' Request is read-only (task spec section 6/18's chosen rule)
// - no new comment may be added once a Request reaches either terminal
// state, regardless of role (Employee, Operator, or Manager all get the
// same 403, not just Employee).
function canWriteRequestComments({ requestStatus, ...rest }) {
  if (COMMENT_READ_ONLY_STATUSES.includes(requestStatus)) {
    return false;
  }
  return hasRequestCommentAccess(rest);
}

module.exports = { canReadRequestComments, canWriteRequestComments };
