const mongoose = require('mongoose');
const ServiceCategory = require('../models/ServiceCategory');
const User = require('../models/User');
const { SLA_STATUS_VALUES, buildSlaStatusQuery } = require('./slaPolicy');

// DOC-54 - "Request Search, Filters and Sorting". One small, reusable
// query-building helper shared by all three Request list endpoints
// (listMyRequests, listOrganizationRequests, listAssignedRequests) - see
// request.controller.js. This is NOT a generic permissions framework:
// authorization (which endpoint a role may even call) still lives
// entirely in routes/request.routes.js and each controller function, the
// same as every other endpoint in this project. This helper only ever
// ADDS restrictions on top of a caller-trusted `baseQuery` - it can never
// remove or override a key already present in `baseQuery` (see the
// role-gated branches below, each of which only ever touches a key the
// relevant base query never sets).
//
// Deliberately does its own DB-backed validation for categoryId/
// assignedOperatorId/createdBy (unlike utils/requestFieldValidation.js's
// pure, synchronous validators) - a category/operator/creator FILTER is
// only meaningful once it is confirmed to actually belong to the caller's
// own Organization, exactly the same anti-enumeration-safe pattern
// createRequest/managerUpdateRequest already use for the same three
// entity types. Centralizing it here is what lets all three callers share
// one implementation instead of three near-identical copies.

const MAX_SEARCH_LENGTH = 200;

const STATUS_VALUES = ['open', 'in_progress', 'resolved', 'closed', 'reopened', 'cancelled'];
const PRIORITY_VALUES = ['low', 'medium', 'high'];
const ALLOWED_SORT_FIELDS = ['createdAt', 'updatedAt', 'priority', 'status', 'title', 'slaDueAt'];
const ALLOWED_SORT_ORDERS = ['asc', 'desc'];

// Business order (NOT alphabetical - alphabetical would read
// high/low/medium, which is meaningless for a priority queue). Lower rank
// number sorts first in ASCENDING order.
//   priority asc:  low -> medium -> high
//   priority desc: high -> medium -> low
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };

// Workflow order (NOT alphabetical either). Lower rank number sorts first
// in ASCENDING order. Mirrors the Request lifecycle documented in
// utils/requestStatusTransitions.js: open -> (reopened) -> in_progress ->
// resolved -> closed, with the terminal 'cancelled' bucket sorted last
// regardless of direction's literal meaning - this is a display-ordering
// choice, not a new status rule, and has zero effect on any transition
// logic.
//   status asc:  open -> reopened -> in_progress -> resolved -> closed -> cancelled
//   status desc: cancelled -> closed -> resolved -> in_progress -> reopened -> open
const STATUS_WORKFLOW_RANK = {
  open: 0,
  reopened: 1,
  in_progress: 2,
  resolved: 3,
  closed: 4,
  cancelled: 5,
};

// Escapes every regex metacharacter in user-supplied text before it is
// ever used to build a `RegExp` - the one thing standing between "safe
// case-insensitive search" and letting a caller inject an arbitrary,
// potentially catastrophic-backtracking pattern (task spec: "Do not let
// the user supply a raw RegExp"). Applied to `q` and nothing else - no
// other filter in this file ever builds a RegExp from client input.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidObjectId(value) {
  return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);
}

// Interprets a single date-range boundary. A bare date-only string like
// "2026-08-01" (task spec's own example) is expanded to the very start or
// very end of that UTC day depending on `boundary` - this is what makes
// `createdFrom=2026-08-01&createdTo=2026-08-01` return everything created
// on that one calendar day, rather than nothing (a raw
// `new Date('2026-08-01')` parses to midnight UTC, which as a `$lte`
// bound would exclude the entire rest of that day). A full ISO timestamp
// (with a "T") is used exactly as given, unmodified - the caller has
// already been explicit about the exact instant they mean.
function parseDateBoundary(rawValue, boundary) {
  const value = rawValue.trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const iso = isDateOnly ? `${value}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}Z` : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { error: true };
  }
  return { date };
}

// Validates and builds the `createdAt` range filter shared by
// buildRequestQuery (DOC-54) and the DOC-53 statistics endpoints
// (utils/requestStatistics.js) - the ONE place "what does
// createdFrom/createdTo mean" is implemented, so the list endpoints and
// the statistics endpoints can never quietly interpret a date range
// differently from each other. Returns `{ filter, error }` - `filter` is
// either `{}` (no date params given) or `{ createdAt: { $gte, $lte } }`
// (at least one given); `error` is `{ status, message }` on the first
// validation failure, in which case `filter` is `null`.
function buildCreatedAtRangeFilter(params) {
  let createdFromDate = null;
  let createdToDate = null;

  if (params.createdFrom !== undefined && params.createdFrom !== '') {
    if (typeof params.createdFrom !== 'string') {
      return { filter: null, error: { status: 400, message: 'createdFrom must be a valid date.' } };
    }
    const parsed = parseDateBoundary(params.createdFrom, 'start');
    if (parsed.error) {
      return { filter: null, error: { status: 400, message: 'createdFrom must be a valid date.' } };
    }
    createdFromDate = parsed.date;
  }

  if (params.createdTo !== undefined && params.createdTo !== '') {
    if (typeof params.createdTo !== 'string') {
      return { filter: null, error: { status: 400, message: 'createdTo must be a valid date.' } };
    }
    const parsed = parseDateBoundary(params.createdTo, 'end');
    if (parsed.error) {
      return { filter: null, error: { status: 400, message: 'createdTo must be a valid date.' } };
    }
    createdToDate = parsed.date;
  }

  if (createdFromDate && createdToDate && createdFromDate.getTime() > createdToDate.getTime()) {
    return { filter: null, error: { status: 400, message: 'createdFrom must not be after createdTo.' } };
  }

  if (!createdFromDate && !createdToDate) {
    return { filter: {}, error: null };
  }

  const createdAt = {};
  if (createdFromDate) createdAt.$gte = createdFromDate;
  if (createdToDate) createdAt.$lte = createdToDate;
  return { filter: { createdAt }, error: null };
}

// buildRequestQuery({ baseQuery, queryParams, role, organizationId })
//
// `baseQuery` - the TRUSTED, already-role-scoped Mongo filter the caller
// computed from req.user alone (never from req.query) - see the three
// call sites in request.controller.js. This function only ever spreads it
// as the starting point and adds MORE keys on top; it never deletes a key
// baseQuery already set.
// `queryParams` - raw req.query (every value a string, or undefined).
// `role` - req.user.role ('employee' | 'operator' | 'manager'). Gates
//   which filters are even looked at: assignedOperatorId/createdBy are
//   only ever read when role === 'manager' - for any other role those two
//   keys in queryParams are simply never inspected, which is what
//   structurally prevents an Employee/Operator from ever widening their
//   own base scope via a query-string injection (task spec: "Query
//   parameters must only add restrictions. They must never remove or
//   override the trusted base scope.").
// `organizationId` - req.user.organizationId (trusted) - the only
//   Organization any categoryId/assignedOperatorId/createdBy filter is
//   ever validated against, regardless of what the caller's role is.
//
// Returns `{ query, sortBy, sortOrder, error }`. `error` is `{ status,
// message }` on the FIRST validation failure encountered (fields are
// checked in a fixed order - see below) and `query`/`sortBy`/`sortOrder`
// are `null` in that case; callers must check `error` before using
// anything else on the return value.
async function buildRequestQuery({
  baseQuery, queryParams, role, organizationId,
}) {
  const params = queryParams || {};
  const query = { ...baseQuery };

  // --- q (text search: title OR description, case-insensitive) ---------
  if (params.q !== undefined && params.q !== '') {
    if (typeof params.q !== 'string') {
      return { error: { status: 400, message: 'q must be a single text value.' } };
    }
    if (params.q.length > MAX_SEARCH_LENGTH) {
      return { error: { status: 400, message: `q must be at most ${MAX_SEARCH_LENGTH} characters.` } };
    }
    const trimmed = params.q.trim();
    // A whitespace-only q imposes no search filter at all (task spec item
    // 4, "whitespace search handled consistently") - documented, chosen
    // behavior, not an accidental no-op: the search box functionally
    // clears itself if the Employee/Operator/Manager only typed spaces.
    if (trimmed.length > 0) {
      const pattern = new RegExp(escapeRegExp(trimmed), 'i');
      query.$or = [{ title: pattern }, { description: pattern }];
    }
  }

  // --- status (all roles) ------------------------------------------------
  if (params.status !== undefined && params.status !== '') {
    if (!STATUS_VALUES.includes(params.status)) {
      return { error: { status: 400, message: `status must be one of: ${STATUS_VALUES.join(', ')}.` } };
    }
    query.status = params.status;
  }

  // --- priority (all roles) -----------------------------------------------
  if (params.priority !== undefined && params.priority !== '') {
    if (!PRIORITY_VALUES.includes(params.priority)) {
      return { error: { status: 400, message: `priority must be one of: ${PRIORITY_VALUES.join(', ')}.` } };
    }
    query.priority = params.priority;
  }

  // --- slaStatus (all roles) --- DOC-55 - "Request SLA and Due Dates".
  // Extends this same query builder with one more all-roles filter, the
  // same way `status`/`priority` above are already all-roles - role scope
  // itself is entirely unaffected (this only ever ADDS restrictions on top
  // of `baseQuery`, exactly like every filter in this file). An invalid
  // value is rejected explicitly (task spec: "Do not accept arbitrary SLA
  // filter values.") rather than silently ignored. See
  // utils/slaPolicy.js's buildSlaStatusQuery for exactly what each of the
  // four real values means; 'all' (or an absent/empty param) applies no
  // extra restriction at all.
  if (params.slaStatus !== undefined && params.slaStatus !== '') {
    if (!SLA_STATUS_VALUES.includes(params.slaStatus)) {
      return { error: { status: 400, message: `slaStatus must be one of: ${SLA_STATUS_VALUES.join(', ')}.` } };
    }
    const slaFilter = buildSlaStatusQuery(params.slaStatus);
    if (slaFilter) {
      Object.assign(query, slaFilter);
    }
  }

  // --- categoryId (all roles) ---------------------------------------------
  // Deliberately NOT restricted to isActive: a historical Request may
  // reference a Category that has since been deactivated, and filtering
  // by it must still work (task spec: "historical inactive Categories may
  // still be used as filters if Requests already reference them"). Cross-
  // Organization or nonexistent both collapse into the same generic 400 -
  // the one consistent, documented policy this file uses everywhere else
  // for an entity-id filter (never a silent empty result, per the task
  // spec's stated preference).
  if (params.categoryId !== undefined && params.categoryId !== '') {
    if (!isValidObjectId(params.categoryId)) {
      return { error: { status: 400, message: 'categoryId must be a valid id.' } };
    }
    // eslint-disable-next-line no-await-in-loop
    const category = await ServiceCategory.findOne({ _id: params.categoryId, organizationId });
    if (!category) {
      return {
        error: {
          status: 400,
          message: 'The selected category filter does not belong to your organization.',
        },
      };
    }
    query.categoryId = category._id;
  }

  // --- assignedOperatorId (MANAGER ONLY) -----------------------------------
  // Employee/Operator never reach this branch at all (role !== 'manager'),
  // regardless of what is in queryParams - this is what makes an
  // Employee's or Operator's assignedOperatorId query-string injection a
  // structural no-op rather than something that needs its own runtime
  // rejection (task spec: "Do not let Operator override it" /
  // "Operator must always remain the authenticated Operator").
  if (role === 'manager' && params.assignedOperatorId !== undefined && params.assignedOperatorId !== '') {
    if (params.assignedOperatorId === 'unassigned') {
      query.assignedOperatorId = null;
    } else {
      if (!isValidObjectId(params.assignedOperatorId)) {
        return { error: { status: 400, message: 'assignedOperatorId must be a valid id or "unassigned".' } };
      }
      // Deliberately NOT restricted to isActive - a historical assignment
      // to an Operator who has since been deactivated must still be
      // filterable (task spec: "The Operator may be inactive because
      // historical assignments still exist.").
      // eslint-disable-next-line no-await-in-loop
      const operator = await User.findOne({ _id: params.assignedOperatorId, organizationId, role: 'operator' });
      if (!operator) {
        return {
          error: {
            status: 400,
            message: 'The selected operator filter does not belong to your organization.',
          },
        };
      }
      query.assignedOperatorId = operator._id;
    }
  }

  // --- createdBy (MANAGER ONLY) --------------------------------------------
  // Employee/Operator never reach this branch either - structurally the
  // same protection as assignedOperatorId above (task spec: "Do not allow
  // Employee or Operator to override ownership.").
  if (role === 'manager' && params.createdBy !== undefined && params.createdBy !== '') {
    if (!isValidObjectId(params.createdBy)) {
      return { error: { status: 400, message: 'createdBy must be a valid id.' } };
    }
    // Deliberately NOT restricted to isActive - a historical creator who
    // has since been deactivated must still be filterable (task spec:
    // "Historical users may be inactive and must still be filterable.").
    // Restricted to role: 'employee' - the only role that may create a
    // Request today (task spec: "a role that may create Requests,
    // normally employee").
    // eslint-disable-next-line no-await-in-loop
    const creator = await User.findOne({ _id: params.createdBy, organizationId, role: 'employee' });
    if (!creator) {
      return {
        error: {
          status: 400,
          message: 'The selected requester filter does not belong to your organization.',
        },
      };
    }
    query.createdBy = creator._id;
  }

  // --- createdFrom / createdTo (all roles - see this file's own header
  // comment for why: a time-range filter never widens a role's scope, it
  // only narrows it, so there is no isolation reason to restrict it to
  // Manager. Only the MANAGER DASHBOARD is given a date-range UI control -
  // see ManagerDashboard.jsx / RequestSearchControls.jsx - Employee/
  // Operator dashboards simply never send these two parameters, even
  // though the backend supports them uniformly.) DOC-53 reuses this exact
  // same helper for the statistics endpoints (see requestStatistics.js) -
  // one implementation of "what does createdFrom/createdTo mean" for the
  // whole project, never two. ---------------------------------------------
  const dateRange = buildCreatedAtRangeFilter(params);
  if (dateRange.error) {
    return { error: dateRange.error };
  }
  Object.assign(query, dateRange.filter);

  // --- sorting --------------------------------------------------------------
  let sortBy = 'createdAt';
  let sortOrder = 'desc';

  if (params.sortBy !== undefined && params.sortBy !== '') {
    if (!ALLOWED_SORT_FIELDS.includes(params.sortBy)) {
      return { error: { status: 400, message: `sortBy must be one of: ${ALLOWED_SORT_FIELDS.join(', ')}.` } };
    }
    sortBy = params.sortBy;
  }

  if (params.sortOrder !== undefined && params.sortOrder !== '') {
    if (!ALLOWED_SORT_ORDERS.includes(params.sortOrder)) {
      return { error: { status: 400, message: `sortOrder must be one of: ${ALLOWED_SORT_ORDERS.join(', ')}.` } };
    }
    sortOrder = params.sortOrder;
  }

  return {
    query, sortBy, sortOrder, error: null,
  };
}

// Applies business-order sorting for `priority`/`status` - the two
// sortBy values MongoDB's own `.sort()` cannot express correctly with a
// plain field sort (that would sort alphabetically: "high", "low",
// "medium" - meaningless for a priority queue or a workflow). Kept as a
// small, in-memory, post-fetch sort rather than an aggregation pipeline
// (task spec: "If this requires aggregation, keep it simple" / "Do not
// introduce a complicated analytics pipeline merely for status
// ordering.") - acceptable for this project's scale (see the pagination
// decision documented in request.controller.js and the final report).
// `createdAt`/`updatedAt`/`title` are NOT handled here - those sort
// correctly at the database level and the caller uses `.sort()` directly
// for them instead of calling this function at all.
// DOC-55 - `slaDueAt` is handled here too (in-memory), alongside
// priority/status, for a DIFFERENT reason: a plain MongoDB `.sort()`
// cannot express "documents missing this field always sort last,
// regardless of direction" (task spec) - Mongo's own BSON comparison
// order treats a missing field as the lowest possible value, so an
// ordinary ascending sort would put historical, pre-DOC-55 Requests
// (no `slaDueAt` at all) FIRST, not last, and only descending would
// happen to put them last. Splitting into "has a due date" / "does not"
// and always appending the second group, in EITHER direction, is the
// smallest correct fix - still no aggregation pipeline, matching this
// file's own established "keep it simple" precedent.
function sortRequestDocs(requestDocs, sortBy, sortOrder) {
  const direction = sortOrder === 'asc' ? 1 : -1;

  if (sortBy === 'slaDueAt') {
    const withDueDate = requestDocs.filter((doc) => doc.slaDueAt);
    const withoutDueDate = requestDocs.filter((doc) => !doc.slaDueAt);
    withDueDate.sort((a, b) => (new Date(a.slaDueAt).getTime() - new Date(b.slaDueAt).getTime()) * direction);
    return [...withDueDate, ...withoutDueDate];
  }

  const rankTable = sortBy === 'priority' ? PRIORITY_RANK : STATUS_WORKFLOW_RANK;
  const field = sortBy === 'priority' ? 'priority' : 'status';
  return [...requestDocs].sort((a, b) => (rankTable[a[field]] - rankTable[b[field]]) * direction);
}

module.exports = {
  buildRequestQuery,
  buildCreatedAtRangeFilter,
  sortRequestDocs,
  escapeRegExp,
  MAX_SEARCH_LENGTH,
  STATUS_VALUES,
  PRIORITY_VALUES,
  ALLOWED_SORT_FIELDS,
  ALLOWED_SORT_ORDERS,
  PRIORITY_RANK,
  STATUS_WORKFLOW_RANK,
};
