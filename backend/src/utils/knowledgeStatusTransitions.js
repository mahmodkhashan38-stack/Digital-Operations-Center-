// DOC-75 - "Organization Q&A / Knowledge Board" - centralized status
// transition logic (task spec section 43: "Centralize status transition
// logic... Do not derive status only in frontend"). Every controller
// function that can change a KnowledgeQuestion's `status` calls exactly
// one of these two pure functions rather than re-deriving the rule
// inline - the same "one place decides the rule" discipline
// utils/requestStatusTransitions.js already established for Requests.
//
// THE THREE STATUSES
//   OPEN     - no accepted answer, not closed.
//   ANSWERED - an accepted answer exists, not closed.
//   CLOSED   - the author or a Manager intentionally ended discussion.
//     Closing always wins over whatever OPEN/ANSWERED value applied
//     before it, and is the ONLY status a plain accept/unaccept action
//     can never produce or remove - only close/reopen ever sets or clears
//     it.
//
// THE EXACT RULES (task spec section 43, reproduced verbatim as the
// contract this file implements):
//   OPEN + accept answer                       -> ANSWERED
//   ANSWERED + different accepted answer        -> ANSWERED
//   ANSWERED + unaccept                         -> OPEN
//   OPEN/ANSWERED + close                       -> CLOSED
//   CLOSED + reopen + accepted answer exists    -> ANSWERED
//   CLOSED + reopen + no accepted answer        -> OPEN

// Called after an answer has just been accepted (a brand-new
// acceptedAnswerId was just set, whether the question previously had none
// at all or had a DIFFERENT accepted answer - task spec section 17: "If
// another answer is later accepted: replace acceptedAnswerId... Do not
// create multiple accepted answers"). Deliberately callable regardless of
// the CURRENT status's exact value (OPEN or already ANSWERED) - both
// collapse to the same ANSWERED result, matching the task spec's own two
// separate rules for OPEN and ANSWERED landing on an identical outcome.
// Accepting is never permitted while CLOSED at all (see this file's own
// `canAcceptOrUnaccept` guard below) - a CLOSED question never reaches
// this function.
function statusAfterAccept() {
  return 'ANSWERED';
}

// Called after an accepted answer is explicitly removed (task spec
// section 18 - "unaccept"). Always OPEN - unaccepting can only ever be
// called from ANSWERED (see `canAcceptOrUnaccept` below), and removing
// the one thing that made it ANSWERED leaves nothing but OPEN. Never
// reachable while CLOSED (unaccept, like accept, is blocked outright on a
// closed question - see this file's own guard below), so the "unless
// question is separately CLOSED" caveat in the task spec's own section 18
// is structurally impossible to hit: a CLOSED question can never have its
// acceptedAnswerId cleared, it must be reopened first.
function statusAfterUnaccept() {
  return 'OPEN';
}

// Called when the author or a Manager closes a question (task spec
// section 19) - always CLOSED, regardless of whether it was OPEN or
// ANSWERED beforehand (task spec: "OPEN/ANSWERED + close -> CLOSED").
function statusAfterClose() {
  return 'CLOSED';
}

// Called when the author or a Manager reopens a CLOSED question (task
// spec section 20). The ONLY rule here that depends on additional state -
// whether an acceptedAnswerId already exists determines whether the
// question returns to ANSWERED (its accepted answer was never removed,
// simply hidden behind the CLOSED status) or back to OPEN (no accepted
// answer ever existed, or it was removed before closing).
function statusAfterReopen(hasAcceptedAnswer) {
  return hasAcceptedAnswer ? 'ANSWERED' : 'OPEN';
}

// Task spec section 42/43 (this project's own documented extension of the
// ticket's explicit "closed = not answerable" rule): a CLOSED question is
// fully locked - no new answers (enforced separately in the controller's
// own createAnswer), and ALSO no accept/unaccept/edit action of any kind,
// since none of the task spec's own six transition rules mention
// "CLOSED + accept" or "CLOSED + unaccept" at all. The only way to change
// an accepted answer on a CLOSED question is to reopen it first - this
// keeps every state transition unambiguous and exactly matches the six
// rules actually specified, rather than inventing a seventh, unspecified
// one.
function canAcceptOrUnaccept(question) {
  return question.status !== 'CLOSED';
}

// Task spec section 21/22 (this project's own documented extension, for
// the identical reason as `canAcceptOrUnaccept` above): editing a
// question's title/content/category, or editing an existing answer's
// content, is blocked once the question is CLOSED - "closed" means the
// discussion is fully locked, not merely "no NEW answers". The author (or
// answer author) must reopen the question first via a Manager/author
// reopen action before either kind of edit can proceed.
function canEdit(question) {
  return question.status !== 'CLOSED';
}

module.exports = {
  statusAfterAccept,
  statusAfterUnaccept,
  statusAfterClose,
  statusAfterReopen,
  canAcceptOrUnaccept,
  canEdit,
};
