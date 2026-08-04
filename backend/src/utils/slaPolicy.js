// DOC-55 - "Request SLA and Due Dates". The one backend source of truth
// for every SLA number and calculation in this project - no controller,
// route, or frontend file ever hardcodes an hour count or re-implements
// "is this overdue" on its own. The frontend is never the authority for
// any deadline (task spec): it only ever displays the `sla` object
// request.controller.js's sanitizeRequest attaches to every Request
// response (see computeSlaSummary below), formatting durations for
// display only.
//
// SCOPE (explicitly NOT implemented here, per task spec):
//   - working hours / business-hours calendars
//   - weekends / holidays
//   - paused or resumed SLA clocks
//   - notifications, email reminders, escalation workflows
//   - auto-assignment, new roles, new Request statuses
// This is intentionally a continuous-clock-time, v1 implementation.
//
// TIMEZONE POLICY: every date here is stored and calculated in UTC
// (`Date` objects and Mongoose `Date` fields are always UTC internally
// regardless of server locale - no explicit timezone math is performed
// anywhere in this file). The frontend may format these in the browser's
// local timezone for display - that is a presentation choice only, never
// a stored or calculated value. No organization-specific timezone
// setting exists or is planned for this version.

// The one SLA policy table - hours allowed to resolve a Request, by
// priority. Changing a number here changes it everywhere in the project;
// nothing else duplicates these three numbers.
const SLA_HOURS_BY_PRIORITY = {
  high: 4,
  medium: 24,
  low: 72,
};

// Statuses where the SLA clock is still "live" - a Request may become
// (newly) overdue only while in one of these three (task spec: "A Request
// may be overdue while status is: open, in_progress, reopened"). Once a
// Request leaves this set (resolved/closed/cancelled) it can never become
// newly overdue again, regardless of how far past slaDueAt the current
// time is - see computeSlaSummary's own comment for how completion timing
// is reported instead (on-time/late, a separate concept from "still-live
// overdue").
const ACTIVE_SLA_STATUSES = ['open', 'in_progress', 'reopened'];

// "Due soon" window - task spec's own suggested definition: due within
// the next 2 hours, and not yet overdue, and still an active SLA status.
const DUE_SOON_WINDOW_MINUTES = 120;

function isValidSlaPriority(priority) {
  return Object.prototype.hasOwnProperty.call(SLA_HOURS_BY_PRIORITY, priority);
}

// calculateSlaDueAt({ priority, createdAt }) -> Date
//
// The one place "priority + creation time -> deadline" is computed.
// `createdAt` must be a real Date (or a value `new Date(...)` can parse) -
// callers always pass either a document's own real `createdAt` (creation
// time) or that SAME original `createdAt` again (priority-change
// recalculation - task spec: "Recalculate SLA from the original Request
// createdAt... Do not reset the SLA clock from the moment of editing.").
// Throws on an unsupported priority or an unparseable date - callers are
// expected to have already validated priority via the project's existing
// requestFieldValidation.validatePriority before ever reaching this
// function, so this is a defensive backstop, not the primary validation
// path (task spec test 4: "invalid priority rejected" - rejected by the
// existing validator, never silently defaulted here).
function calculateSlaDueAt({ priority, createdAt }) {
  if (!isValidSlaPriority(priority)) {
    throw new Error(`Unsupported priority for SLA calculation: ${priority}`);
  }
  const baseTime = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (Number.isNaN(baseTime)) {
    throw new Error('A valid createdAt date is required for SLA calculation.');
  }
  const hours = SLA_HOURS_BY_PRIORITY[priority];
  return new Date(baseTime + hours * 60 * 60 * 1000);
}

// computeSlaSummary(requestDoc, now) -> the safe `sla` response shape, or
// `null`.
//
// SLA BREACH RECORDING POLICY (documented choice - task spec explicitly
// asks for one to be chosen): this project does NOT persist
// `slaBreachedAt` automatically. Writing to the database as a side effect
// of an ordinary GET/read is surprising and was explicitly flagged by the
// task spec as the riskier option ("silently writing during GET requests
// can be surprising"). `slaBreachedAt` stays optional/null on every
// Request for this version and is reserved for a LATER scheduled-job/
// notification task (explicitly out of scope here: "Do not add background
// schedulers"). `isOverdue`/`overdueByMinutes` are instead computed
// dynamically, every time, from `status` + `slaDueAt` + the current server
// time - never stored, never trusted from a prior calculation.
//
// Returns `null` for a historical, pre-DOC-55 Request that has no
// `slaDueAt` at all (schema fields are optional for those - see
// models/Request.js's own comment) - this is the documented "SLA not
// available" safe null structure (task spec: "historical Request without
// slaDueAt returns a safe null structure"). The frontend renders this as
// an "SLA Unavailable" badge, never as 0/on-track/false data.
//
// `now` defaults to `new Date()` (real server time) and is only ever
// overridden by this project's own test harness - a request's own
// (unverified) clock is never used for this calculation anywhere in this
// project.
function computeSlaSummary(requestDoc, now = new Date()) {
  if (!requestDoc || !requestDoc.slaDueAt) {
    return null;
  }

  const dueAtDate = requestDoc.slaDueAt instanceof Date ? requestDoc.slaDueAt : new Date(requestDoc.slaDueAt);
  const nowTime = now.getTime();
  const dueTime = dueAtDate.getTime();

  const isActiveSlaStatus = ACTIVE_SLA_STATUSES.includes(requestDoc.status);
  const isOverdue = isActiveSlaStatus && nowTime > dueTime;

  // Never negative (task spec: "remainingMinutes is never negative").
  // Once overdue, remaining is pinned at 0 - it is never reported as a
  // negative countdown.
  const remainingMinutes = Math.max(0, Math.ceil((dueTime - nowTime) / 60000));
  // 0 when not overdue (task spec: "overdueByMinutes is 0 when not
  // overdue") - including for a completed (resolved/closed/cancelled)
  // Request whose deadline has technically passed; overdue is a live-clock
  // concept only, not a historical fact about completed work.
  const overdueByMinutes = isOverdue ? Math.floor((nowTime - dueTime) / 60000) : 0;

  return {
    policyHours: requestDoc.slaPolicyHours ?? null,
    dueAt: dueAtDate,
    isOverdue,
    overdueByMinutes,
    remainingMinutes,
    resolvedAt: requestDoc.resolvedAt || null,
    closedAt: requestDoc.closedAt || null,
  };
}

// The four DOC-54-extension filter values this project accepts for
// `slaStatus`, plus the always-allowed 'all' (task spec: "Do not accept
// arbitrary SLA filter values.").
const SLA_STATUS_VALUES = ['all', 'overdue', 'due_soon', 'on_track', 'unavailable'];

// buildSlaStatusQuery(slaStatus, now) -> a Mongo filter object, or `null`
// for 'all' (no additional restriction).
//
// Every branch here mirrors computeSlaSummary's own definitions exactly -
// this is the ONE place "what does each SLA filter value mean" is
// expressed as a database query, so the search/filter endpoints
// (requestQueryBuilder.js) and the in-memory summary above can never
// silently drift apart from each other.
//
// DEFINITION NOTE (documented choice): overdue/due_soon/on_track are all
// restricted to Requests currently in an ACTIVE_SLA_STATUSES status AND
// that already have `slaDueAt` set - exactly mirroring
// computeSlaSummary's own "isOverdue is only ever computed for an active
// SLA status" rule. A resolved/closed/cancelled Request with real SLA
// data therefore never matches overdue/due_soon/on_track (it is not being
// actively monitored against its deadline any more) but is still included
// under 'all' - only a genuinely historical, pre-migration Request with no
// `slaDueAt` at all matches 'unavailable'.
function buildSlaStatusQuery(slaStatus, now = new Date()) {
  if (slaStatus === 'unavailable') {
    return { slaDueAt: { $exists: false } };
  }

  if (slaStatus === 'overdue') {
    return {
      slaDueAt: { $exists: true, $lt: now },
      status: { $in: ACTIVE_SLA_STATUSES },
    };
  }

  if (slaStatus === 'due_soon') {
    const windowEnd = new Date(now.getTime() + DUE_SOON_WINDOW_MINUTES * 60000);
    return {
      slaDueAt: { $exists: true, $gte: now, $lte: windowEnd },
      status: { $in: ACTIVE_SLA_STATUSES },
    };
  }

  if (slaStatus === 'on_track') {
    const windowEnd = new Date(now.getTime() + DUE_SOON_WINDOW_MINUTES * 60000);
    return {
      slaDueAt: { $exists: true, $gt: windowEnd },
      status: { $in: ACTIVE_SLA_STATUSES },
    };
  }

  // 'all' (or anything else - callers validate against SLA_STATUS_VALUES
  // before ever calling this function) imposes no additional restriction.
  return null;
}

// classifySlaBucket(requestDoc, now) -> 'unavailable' | 'completed' |
// 'overdue' | 'due_soon' | 'on_track'
//
// The single-document equivalent of buildSlaStatusQuery - used by
// requestStatistics.js to bucket an already-fetched array of Requests
// in-memory (no second/third database round trip - see that file's own
// comment) while guaranteeing the exact same bucket boundaries the
// slaStatus QUERY filter uses, so a Manager's "Overdue Requests" stat
// card and the slaStatus=overdue filtered list can never silently
// disagree with each other. 'completed' covers any resolved/closed/
// cancelled Request that DOES have real SLA data - it is deliberately its
// own bucket, distinct from the four `SLA_STATUS_VALUES` filter values
// (task spec's SLA compliance/average-resolution-time definitions are
// concerned with THIS bucket, not with overdue/due_soon/on_track, which
// only ever apply to a still-active SLA status).
function classifySlaBucket(requestDoc, now = new Date()) {
  if (!requestDoc || !requestDoc.slaDueAt) {
    return 'unavailable';
  }
  if (!ACTIVE_SLA_STATUSES.includes(requestDoc.status)) {
    return 'completed';
  }
  const dueTime = new Date(requestDoc.slaDueAt).getTime();
  const nowTime = now.getTime();
  if (nowTime > dueTime) {
    return 'overdue';
  }
  if (dueTime - nowTime <= DUE_SOON_WINDOW_MINUTES * 60000) {
    return 'due_soon';
  }
  return 'on_track';
}

module.exports = {
  SLA_HOURS_BY_PRIORITY,
  ACTIVE_SLA_STATUSES,
  DUE_SOON_WINDOW_MINUTES,
  SLA_STATUS_VALUES,
  isValidSlaPriority,
  calculateSlaDueAt,
  computeSlaSummary,
  buildSlaStatusQuery,
  classifySlaBucket,
};
