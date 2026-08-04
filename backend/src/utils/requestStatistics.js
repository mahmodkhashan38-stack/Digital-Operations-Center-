const ServiceCategory = require('../models/ServiceCategory');
const User = require('../models/User');
const Request = require('../models/Request');
const { classifySlaBucket } = require('./slaPolicy');

// DOC-53 - "Dashboard Statistics". One shared computation helper used by
// all three Request statistics endpoints (Employee/Operator/Manager - see
// request.controller.js's getMyRequestStatistics/
// getAssignedRequestStatistics/getOrganizationRequestStatistics), the same
// "one implementation, three callers" shape DOC-54's buildRequestQuery
// already established for the list endpoints. `baseQuery` is the
// caller's own TRUSTED, already-role-scoped Mongo filter (computed from
// req.user alone, optionally extended with the shared
// buildCreatedAtRangeFilter date range) - this file never reads
// req.user/req.query itself, it only ever counts/groups whatever `query`
// it is given.
//
// QUERY STRATEGY (task spec: "Use efficient database-side counts where
// practical... Avoid N+1 queries... Do not load every Request into Node
// merely to count simple statuses"):
//   - totals/byStatus/byPriority: exactly 10 `countDocuments` calls, run
//     in parallel via Promise.all - a small, FIXED number (never
//     proportional to how many Requests exist), no full documents ever
//     fetched for these. total + 6 status buckets + 3 priority buckets.
//   - byCategory (and, for Manager, byOperator - see
//     computeOperatorWorkload below) inherently need a GROUP BY that a
//     fixed set of countDocuments calls cannot express without knowing
//     the category/operator ids up front. Rather than a second
//     categoryId-by-categoryId query loop (which WOULD be N+1), this
//     performs exactly ONE additional `Request.find(query)` and groups
//     the results in Node - the same "one query, group in memory" shape
//     buildRequestEnrichmentMaps (request.controller.js) already uses
//     elsewhere in this project, and the smallest honest option that
//     avoids hand-rolling a MongoDB aggregation pipeline (task spec: "If
//     this requires aggregation, keep it simple" / DOC-54's own
//     precedent for priority/status business-order sorting). This is NOT
//     "downloading every Request merely to count simple statuses" - the
//     simple counts above never touch it; this one query exists only
//     because a real grouped breakdown has no cheaper form without
//     aggregation. The same fetched array is reused for the Manager-only
//     byOperator grouping (see the controller), never fetched twice.
async function computeRequestStatistics(baseQuery, organizationId) {
  const [
    total,
    open, inProgress, resolved, closed, reopened, cancelled,
    high, medium, low,
  ] = await Promise.all([
    Request.countDocuments(baseQuery),
    Request.countDocuments({ ...baseQuery, status: 'open' }),
    Request.countDocuments({ ...baseQuery, status: 'in_progress' }),
    Request.countDocuments({ ...baseQuery, status: 'resolved' }),
    Request.countDocuments({ ...baseQuery, status: 'closed' }),
    Request.countDocuments({ ...baseQuery, status: 'reopened' }),
    Request.countDocuments({ ...baseQuery, status: 'cancelled' }),
    Request.countDocuments({ ...baseQuery, priority: 'high' }),
    Request.countDocuments({ ...baseQuery, priority: 'medium' }),
    Request.countDocuments({ ...baseQuery, priority: 'low' }),
  ]);

  const totals = {
    total,
    open,
    inProgress,
    resolved,
    closed,
    reopened,
    cancelled,
    highPriority: high,
  };

  const byStatus = [
    { value: 'open', count: open },
    { value: 'in_progress', count: inProgress },
    { value: 'resolved', count: resolved },
    { value: 'closed', count: closed },
    { value: 'reopened', count: reopened },
    { value: 'cancelled', count: cancelled },
  ];

  const byPriority = [
    { value: 'high', count: high },
    { value: 'medium', count: medium },
    { value: 'low', count: low },
  ];

  // The one grouping query - see this file's own header comment.
  const scopedDocs = await Request.find(baseQuery);

  const byCategory = await buildByCategory(scopedDocs, organizationId);

  return {
    totals, byStatus, byPriority, byCategory, scopedDocs,
  };
}

// Groups already-fetched Request documents by categoryId, resolves each
// distinct category in ONE additional `$in` query (never one lookup per
// Request), and falls back to a safe "Unknown Category" placeholder for
// the defensive/should-never-happen case where a categoryId no longer
// resolves to any document (task spec: "If a Category document is
// missing, use a safe fallback"). Historical INACTIVE categories are
// included with no special handling at all - this simply resolves
// whatever categoryId each Request actually has, the same
// no-isActive-filter behavior DOC-54's own categoryId filter already
// uses for the identical reason (a Request opened against a
// since-deactivated Category must still be counted under it). Never
// exposes `normalizedName` - only `id`/`name`, the same minimal shape
// every other Category reference in this project's API responses uses.
async function buildByCategory(scopedDocs, organizationId) {
  const counts = new Map();
  scopedDocs.forEach((doc) => {
    const key = doc.categoryId ? String(doc.categoryId) : 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const categoryIds = [...counts.keys()].filter((key) => key !== 'unknown');
  const categories = categoryIds.length > 0
    ? await ServiceCategory.find({ _id: { $in: categoryIds }, organizationId })
    : [];
  const categoryMap = new Map(categories.map((category) => [String(category._id), category]));

  return [...counts.entries()].map(([key, count]) => {
    const category = key !== 'unknown' ? categoryMap.get(key) : null;
    return {
      category: category
        ? { id: category._id, name: category.name }
        : { id: key !== 'unknown' ? key : null, name: 'Unknown Category' },
      count,
    };
  });
}

// DOC-53 - Manager-only "Operator Workload". Reuses the SAME `scopedDocs`
// array computeRequestStatistics already fetched for byCategory - never a
// second full Request fetch. Every Operator currently in the Organization
// is included (via a single `User.find({ organizationId, role:
// 'operator' })` query), even one with zero currently-assigned Requests
// or one who has since been deactivated ("Inactive historical Operator
// still represented safely" - task spec test 20/44) - `isActive` is
// returned on each entry so the frontend can show it, never used to
// filter an Operator OUT of this list.
//   activeCount:    status in {open, in_progress, reopened}
//   completedCount: status in {resolved, closed}
// (cancelled Requests count toward neither bucket - they are neither
// "active" work nor a "completed" outcome, the same treatment DOC-59's
// own terminal-status handling already gives 'cancelled'.) Unassigned
// Requests are deliberately NOT part of this array at all - they are
// counted once, separately, as `totals.unassigned` (see the Manager
// statistics controller) - task spec: "Unassigned Requests must be
// counted separately."
const ACTIVE_STATUSES = new Set(['open', 'in_progress', 'reopened']);
const COMPLETED_STATUSES = new Set(['resolved', 'closed']);

async function computeOperatorWorkload(scopedDocs, organizationId) {
  const operators = await User.find({ organizationId, role: 'operator' });

  const countsByOperator = new Map();
  scopedDocs.forEach((doc) => {
    if (!doc.assignedOperatorId) return;
    const key = String(doc.assignedOperatorId);
    if (!countsByOperator.has(key)) {
      countsByOperator.set(key, { assignedCount: 0, activeCount: 0, completedCount: 0 });
    }
    const bucket = countsByOperator.get(key);
    bucket.assignedCount += 1;
    if (ACTIVE_STATUSES.has(doc.status)) bucket.activeCount += 1;
    if (COMPLETED_STATUSES.has(doc.status)) bucket.completedCount += 1;
  });

  return operators.map((operator) => {
    const bucket = countsByOperator.get(String(operator._id)) || {
      assignedCount: 0, activeCount: 0, completedCount: 0,
    };
    return {
      operator: { id: operator._id, fullName: operator.fullName, isActive: operator.isActive },
      assignedCount: bucket.assignedCount,
      activeCount: bucket.activeCount,
      completedCount: bucket.completedCount,
    };
  });
}

// DOC-55 - "Request SLA and Due Dates" statistics. Reuses the SAME
// `scopedDocs` array `computeRequestStatistics` already fetched for
// `byCategory` (see that function's own header comment) - never a second
// `Request.find`/`countDocuments` round trip just for this. Every number
// here is derived in-memory from documents already in hand, using the
// exact same bucket definitions `classifySlaBucket`/`buildSlaStatusQuery`
// (utils/slaPolicy.js) use for the slaStatus list filter, so a stat card
// and its equivalent filtered list can never silently disagree.
//
// Returns ALL four numbers unconditionally - which of them a given
// caller actually exposes in its HTTP response is a controller-level
// decision (task spec: Employee only gets `overdueCount`, Operator gets
// `overdueCount`/`dueSoonCount`, Manager gets all four; System Admin
// never calls this function at all, since none of the three statistics
// endpoints are reachable by a system_admin token - see
// routes/request.routes.js).
//
// SLA COMPLIANCE RATE (task spec's own definition): eligible completed
// Requests are those with `status` in resolved/closed AND real SLA data
// (`slaDueAt` AND `resolvedAt` both present) - cancelled Requests are
// structurally excluded (their status is never 'resolved'/'closed'), and
// a historical Request with no SLA data is excluded by the `slaDueAt`
// check. A Request is compliant when `resolvedAt <= slaDueAt`. If there
// are zero eligible Requests, `slaComplianceRate` is `null` - never a
// misleading 0%.
//
// AVERAGE RESOLUTION TIME (task spec's own definition): every Request
// with both `createdAt` and `resolvedAt` set, excluding cancelled ones -
// deliberately NOT restricted to `status === 'resolved'`/`'closed'` the
// way compliance rate is, since a Request that was resolved, reopened,
// and resolved again still has a real `resolvedAt` reflecting its most
// recent resolution and is meaningful "time to resolve" data regardless
// of its CURRENT status. Excludes anything without a `resolvedAt` at all
// (unresolved) and anything cancelled, per the task spec's own exclusion
// list. `null` when there is nothing eligible to average, never `0` or
// `NaN`.
function computeSlaStatistics(scopedDocs) {
  let overdueCount = 0;
  let dueSoonCount = 0;

  scopedDocs.forEach((doc) => {
    const bucket = classifySlaBucket(doc);
    if (bucket === 'overdue') overdueCount += 1;
    if (bucket === 'due_soon') dueSoonCount += 1;
  });

  const eligibleCompleted = scopedDocs.filter(
    (doc) => (doc.status === 'resolved' || doc.status === 'closed') && doc.slaDueAt && doc.resolvedAt,
  );
  const compliantCount = eligibleCompleted.filter(
    (doc) => new Date(doc.resolvedAt).getTime() <= new Date(doc.slaDueAt).getTime(),
  ).length;
  const slaComplianceRate = eligibleCompleted.length > 0
    ? Math.round((compliantCount / eligibleCompleted.length) * 10000) / 100
    : null;

  const resolvedForAverage = scopedDocs.filter(
    (doc) => doc.status !== 'cancelled' && doc.resolvedAt && doc.createdAt,
  );
  const averageResolutionMinutes = resolvedForAverage.length > 0
    ? Math.round(
      resolvedForAverage.reduce(
        (sum, doc) => sum + (new Date(doc.resolvedAt).getTime() - new Date(doc.createdAt).getTime()) / 60000,
        0,
      ) / resolvedForAverage.length,
    )
    : null;

  return {
    overdueCount, dueSoonCount, slaComplianceRate, averageResolutionMinutes,
  };
}

module.exports = {
  computeRequestStatistics,
  computeOperatorWorkload,
  computeSlaStatistics,
};
