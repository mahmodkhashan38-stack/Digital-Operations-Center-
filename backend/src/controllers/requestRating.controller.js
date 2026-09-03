const mongoose = require('mongoose');
const Request = require('../models/Request');
const RequestRating = require('../models/RequestRating');
const User = require('../models/User');
const { validateScore, validateRatingComment } = require('../utils/requestFieldValidation');
const { recordRequestActivity } = require('../services/requestActivity.service');
const { buildCreatedAtRangeFilter } = require('../utils/requestQueryBuilder');

/**
 * DOC-68 - "Employee Satisfaction Rating".
 * -------------------------------------------------------------------------
 * Three endpoints:
 *   POST /api/requests/:id/rating              - Employee only, own Request
 *   GET  /api/requests/:id/rating               - Employee only, own Request
 *   GET  /api/requests/ratings/organization      - Manager only, own Org
 *
 * All three reuse the exact same DOC-38 anti-enumeration pattern every
 * other Request-scoped lookup in this project already uses - a scoped
 * `Request.findOne({ _id, organizationId })` (never `findById` + a manual
 * comparison), so "this Request does not exist" and "this Request belongs
 * to another Organization" are structurally indistinguishable.
 */

// Strips a RequestRating document + its already-resolved employee/operator
// down to a safe response shape - never a raw Mongoose document, never
// organizationId (the caller already knows which Organization this is).
// `employee`/`operator` are documents already resolved by the caller
// (batched lookups - never a query per rating). A historical
// employee/operator that can no longer be resolved (should not normally
// happen - Users are never hard-deleted in this project - but handled
// defensively regardless, task spec section 36) falls back to a safe
// "Unknown user" identity rather than crashing the response.
function sanitizeRating(rating, employee, operator) {
  return {
    id: rating._id,
    requestId: rating.requestId,
    score: rating.score,
    comment: rating.comment,
    createdAt: rating.createdAt,
    employee: employee
      ? { id: employee._id, fullName: employee.fullName }
      : { id: rating.employeeId, fullName: 'Unknown user' },
    operator: rating.operatorId
      ? (operator ? { id: operator._id, fullName: operator.fullName } : { id: rating.operatorId, fullName: 'Unknown user' })
      : null,
  };
}

// Shared scoped-lookup for both rating endpoints below - identical
// anti-enumeration shape every other id-based Request lookup in this
// controller uses. Returns `{ requestDoc }` on success, or `{ error }`
// otherwise (caller sends the response).
async function loadOwnClosedRequestOrRespondLookup(req, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return { error: { status: 400, message: 'Invalid request id.' } };
  }

  // Scoped by organizationId AND createdBy together - exactly like
  // getMyRequestById/updateMyRequest/cancelMyRequest already do for every
  // other Employee-own-Request endpoint in this file. A Request that
  // exists but belongs to another Organization, or exists in this
  // Organization but was created by a different Employee, both collapse
  // into the same 404 (task spec section 11 - never reveal which).
  const requestDoc = await Request.findOne({
    _id: id,
    organizationId: req.user.organizationId,
    createdBy: req.user.userId,
  });

  if (!requestDoc) {
    return { error: { status: 404, message: 'Request not found.' } };
  }

  return { requestDoc };
}

// POST /api/requests/:id/rating (employee only - see routes/request.routes.js,
// this shares the router's blanket Employee-only chain, no new middleware)
//
// Reads exactly two fields from the request body: score, comment. Every
// other value the task spec explicitly forbids (employeeId, operatorId,
// organizationId, requestId, createdAt, role, status) is simply never
// read - explicit, single-purpose destructuring, not an allowlist-
// filtered spread (task spec section 9).
const createRating = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { requestDoc, error } = await loadOwnClosedRequestOrRespondLookup(req, id);
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    // Task spec section 2/29/40 - rating is allowed ONLY at status ===
    // 'closed'. 'cancelled' gets its own explicit, honest message (task
    // spec section 29: "Return a clear validation error if attempted"),
    // rather than folding it into the generic "must be closed" wording -
    // an Employee who cancelled their own Request should not be confused
    // into thinking the Request will ever become ratable. Every other
    // non-closed status (open/in_progress/resolved/reopened) shares the
    // one generic message - audited: the current lifecycle has no path
    // that reopens a Request AFTER it reaches 'closed' (closed has no
    // outbound transitions in utils/requestStatusTransitions.js's maps at
    // all - see that file's own comment), so this check alone is already
    // sufficient defense against task spec section 30's "reopened before
    // closing" concern; there is no separate reopened-after-closed state
    // to special-case.
    if (requestDoc.status === 'cancelled') {
      return res.status(409).json({
        status: 'error',
        message: 'A cancelled request cannot be rated.',
      });
    }
    if (requestDoc.status !== 'closed') {
      return res.status(409).json({
        status: 'error',
        message: 'This request can only be rated once it has been closed.',
      });
    }

    // Task spec section 5/31/44 - controller-level duplicate check first
    // (fast, clean message); the unique index on RequestRating.requestId
    // is the final, database-level guarantee for a genuinely concurrent
    // double-submission (handled in the catch block below via error.code
    // === 11000, never leaked as a raw Mongo error - task spec section
    // 31: "return a clean application error, not Mongo duplicate-key
    // internals").
    const existingRating = await RequestRating.findOne({ requestId: requestDoc._id });
    if (existingRating) {
      return res.status(409).json({
        status: 'error',
        message: 'This request has already been rated.',
      });
    }

    const body = req.body || {};

    const scoreError = validateScore(body.score);
    if (scoreError) {
      return res.status(400).json({ status: 'error', message: scoreError });
    }

    const { error: commentError, value: normalizedComment } = validateRatingComment(body.comment);
    if (commentError) {
      return res.status(400).json({ status: 'error', message: commentError });
    }

    let rating;
    try {
      // organizationId/employeeId/operatorId are ALWAYS derived
      // server-side (task spec sections 6/7/8) - organizationId and
      // employeeId from req.user (the same trusted, fresh-per-request
      // context every other endpoint in this project uses), operatorId
      // from the Request's own assignedOperatorId (see
      // models/RequestRating.js's own header comment for the full audit
      // of why this is always the correct, final Operator by the time a
      // Request reaches 'closed'). Never anything read from req.body.
      rating = await RequestRating.create({
        organizationId: req.user.organizationId,
        requestId: requestDoc._id,
        employeeId: req.user.userId,
        operatorId: requestDoc.assignedOperatorId,
        score: body.score,
        comment: normalizedComment,
      });
    } catch (createError) {
      if (createError.code === 11000) {
        return res.status(409).json({
          status: 'error',
          message: 'This request has already been rated.',
        });
      }
      if (createError.name === 'ValidationError') {
        return res.status(400).json({ status: 'error', message: createError.message });
      }
      throw createError;
    }

    // DOC-17 - "Request Activity Timeline" (task spec section 26). One
    // meaningful final event, score only - the full comment is
    // deliberately never copied here (see models/RequestActivity.js's own
    // SATISFACTION_SUBMITTED comment). Recorded only AFTER the rating
    // itself has already been successfully created (task spec section 45:
    // "rejected rating creates no Timeline event" - every early return
    // above happens before this line is ever reached).
    await recordRequestActivity({
      request: requestDoc,
      actorId: req.user.userId,
      type: 'SATISFACTION_SUBMITTED',
      oldValue: null,
      newValue: rating.score,
      metadata: { score: rating.score },
    });

    // DOC-27/28 - no notification, no Audit Log entry for an ordinary
    // Employee satisfaction rating (task spec sections 27/28 explicit
    // defaults) - see this ticket's README section for the documented
    // reasoning. RequestActivity above is the only history record this
    // action produces beyond RequestRating itself.

    const employee = await User.findById(req.user.userId);
    const operator = rating.operatorId ? await User.findById(rating.operatorId) : null;

    return res.status(201).json({ status: 'success', data: sanitizeRating(rating, employee, operator) });
  } catch (err) {
    return next(err);
  }
};

// GET /api/requests/:id/rating (employee only, own Request - task spec
// section 15). Returns the rating if one exists, or a safe `data: null` if
// the Request has no rating yet (never a 404 for "not rated yet" - the
// Request itself was found and is genuinely visible to this Employee,
// there is simply nothing to show; a 404 here would be a strange status
// for "the Request exists but has no rating").
const getMyRating = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { requestDoc, error } = await loadOwnClosedRequestOrRespondLookup(req, id);
    if (error) {
      return res.status(error.status).json({ status: 'error', message: error.message });
    }

    const rating = await RequestRating.findOne({ requestId: requestDoc._id });
    if (!rating) {
      return res.status(200).json({ status: 'success', data: null });
    }

    const employee = await User.findById(rating.employeeId);
    const operator = rating.operatorId ? await User.findById(rating.operatorId) : null;

    return res.status(200).json({ status: 'success', data: sanitizeRating(rating, employee, operator) });
  } catch (err) {
    return next(err);
  }
};

// Batch-resolves distinct employeeId/operatorId values in a page of
// ratings into at most two additional queries (never one per row - N+1),
// the same shape this project's other list endpoints already establish.
async function buildRatingUserMaps(ratings, organizationId) {
  const employeeIds = Array.from(new Set(ratings.map((rating) => String(rating.employeeId))));
  const operatorIds = Array.from(
    new Set(ratings.filter((rating) => rating.operatorId).map((rating) => String(rating.operatorId))),
  );

  const [employees, operators] = await Promise.all([
    employeeIds.length > 0 ? User.find({ _id: { $in: employeeIds }, organizationId }) : [],
    operatorIds.length > 0 ? User.find({ _id: { $in: operatorIds }, organizationId }) : [],
  ]);

  return {
    employeeMap: new Map(employees.map((employee) => [String(employee._id), employee])),
    operatorMap: new Map(operators.map((operator) => [String(operator._id), operator])),
  };
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

// GET /api/requests/ratings/organization?limit=&before=&score=&operator=&createdFrom=&createdTo=
// (manager only, own Organization only - task spec sections 16/17/33/34/35)
//
// PAGINATION mirrors notification.controller.js/auditLog.controller.js's
// own `limit`/`before`-by-id cursor shape exactly (task spec section 34) -
// newest-first, `before` must itself be a rating id already visible to
// THIS caller, so it can never be used to page past this Manager's own
// Organization boundary.
const listOrganizationRatings = async (req, res, next) => {
  try {
    const query = { organizationId: req.user.organizationId };

    // --- optional score filter -------------------------------------------
    if (req.query.score !== undefined && req.query.score !== '') {
      const parsedScore = Number.parseInt(req.query.score, 10);
      if (!Number.isInteger(parsedScore) || String(parsedScore) !== String(req.query.score) || parsedScore < 1 || parsedScore > 5) {
        return res.status(400).json({ status: 'error', message: 'score must be a whole number between 1 and 5.' });
      }
      query.score = parsedScore;
    }

    // --- optional operator filter -----------------------------------------
    if (req.query.operator !== undefined && req.query.operator !== '') {
      if (!mongoose.Types.ObjectId.isValid(req.query.operator)) {
        return res.status(400).json({ status: 'error', message: 'operator must be a valid user id.' });
      }
      query.operatorId = req.query.operator;
    }

    // --- optional date range (reuses DOC-54's own createdAt semantics) ----
    const dateRange = buildCreatedAtRangeFilter(req.query);
    if (dateRange.error) {
      return res.status(dateRange.error.status).json({ status: 'error', message: dateRange.error.message });
    }
    Object.assign(query, dateRange.filter);

    // --- pagination ---------------------------------------------------------
    let limit = DEFAULT_LIST_LIMIT;
    if (req.query.limit !== undefined) {
      const parsedLimit = Number.parseInt(req.query.limit, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIST_LIMIT) {
        return res.status(400).json({ status: 'error', message: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.` });
      }
      limit = parsedLimit;
    }

    if (req.query.before !== undefined) {
      if (!mongoose.Types.ObjectId.isValid(req.query.before)) {
        return res.status(400).json({ status: 'error', message: 'before must be a valid rating id.' });
      }
      const cursorRating = await RequestRating.findOne({ ...query, _id: req.query.before });
      if (!cursorRating) {
        return res.status(400).json({ status: 'error', message: 'before does not reference a known rating.' });
      }
      query.createdAt = { ...(query.createdAt || {}), $lt: cursorRating.createdAt };
    }

    const page = await RequestRating.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
    const hasMore = page.length > limit;
    const pageItems = hasMore ? page.slice(0, limit) : page;

    const [{ employeeMap, operatorMap }, requestDocs] = await Promise.all([
      buildRatingUserMaps(pageItems, req.user.organizationId),
      Request.find({
        _id: { $in: pageItems.map((rating) => rating.requestId) },
        organizationId: req.user.organizationId,
      }),
    ]);
    const requestMap = new Map(requestDocs.map((doc) => [String(doc._id), doc]));

    const data = pageItems.map((rating) => {
      const requestDoc = requestMap.get(String(rating.requestId));
      return {
        ...sanitizeRating(rating, employeeMap.get(String(rating.employeeId)), operatorMap.get(String(rating.operatorId))),
        // Task spec section 17 - human-readable Request identification,
        // never a raw MongoDB _id as the primary display value. A rating
        // whose Request has since been hard-deleted (see this ticket's
        // README's "Request deletion" decision - audited, does not
        // currently happen anywhere in this project) falls back to a safe
        // placeholder rather than crashing.
        request: requestDoc
          ? { id: requestDoc._id, requestNumber: requestDoc.requestNumber || null, title: requestDoc.title }
          : { id: rating.requestId, requestNumber: null, title: 'Unknown request' },
      };
    });

    return res.status(200).json({
      status: 'success',
      data,
      meta: { hasMore, nextCursor: hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1]._id : null },
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  createRating,
  getMyRating,
  listOrganizationRatings,
  sanitizeRating,
};
