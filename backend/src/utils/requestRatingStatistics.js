const RequestRating = require('../models/RequestRating');
const User = require('../models/User');

// DOC-68 - "Employee Satisfaction Rating" statistics (task spec section
// 18/19). A small, self-contained module - deliberately NOT merged into
// utils/requestStatistics.js, since it queries an entirely different
// collection (RequestRating, not Request) for a genuinely separate
// concern (service-quality feedback, not workflow/SLA counts). Reused by
// request.controller.js's getOrganizationRequestStatistics (task spec's
// own audit question 6 - decided: satisfaction numbers are ADDED to that
// same existing Manager statistics response, exactly the way DOC-55's own
// `sla` block was added alongside `totals`/`byStatus`/`byCategory` there,
// rather than a second, separate statistics endpoint).
//
// QUERY STRATEGY - mirrors requestStatistics.js's own documented choice:
// one `RequestRating.find({ organizationId })` fetch (never a full Request
// scan), then average/distribution/per-operator grouping computed in
// memory from that one small result set - a real Organization's total
// rating count is bounded by its total closed-and-rated Request count,
// never large enough to justify a MongoDB aggregation pipeline for a
// project at this scale (same "keep it simple" precedent
// requestQueryBuilder.js/requestStatistics.js already established).
async function computeSatisfactionStatistics(organizationId) {
  const ratings = await RequestRating.find({ organizationId });

  const totalRated = ratings.length;
  const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let scoreSum = 0;
  ratings.forEach((rating) => {
    scoreSum += rating.score;
    distribution[rating.score] = (distribution[rating.score] || 0) + 1;
  });

  // Task spec section 18/46/47 - a safe `null` (never a fake `0`/`0.0`)
  // when there are no ratings at all yet - the frontend renders this as
  // "N/A", exactly the same "N/A rather than fake 0.0" rule task spec
  // section 19 also requires for a zero-rating Operator below.
  const averageScore = totalRated > 0 ? Math.round((scoreSum / totalRated) * 100) / 100 : null;

  return {
    averageScore,
    totalRated,
    distribution: [
      { score: 5, count: distribution[5] },
      { score: 4, count: distribution[4] },
      { score: 3, count: distribution[3] },
      { score: 2, count: distribution[2] },
      { score: 1, count: distribution[1] },
    ],
    // Passed back to the caller so computeOperatorRatingBreakdown below can
    // reuse this same fetched array - never a second
    // `RequestRating.find` round trip for the same page load, mirroring
    // requestStatistics.js's own `scopedDocs` reuse pattern for
    // byCategory/byOperator/SLA.
    scopedRatings: ratings,
  };
}

// DOC-68 task spec section 19 - "Operator Performance" ratings breakdown.
// Deliberately kept as simple as computeOperatorWorkload
// (utils/requestStatistics.js) already is for the analogous SLA/status
// breakdown: one `User.find` for every Operator in the Organization
// (active AND historical/deactivated - task spec: "active and historical
// Operators handled safely"), then group the already-fetched
// `scopedRatings` in memory by `operatorId`. An Operator with zero ratings
// still appears in the list (task spec: "zero-rating Operators show N/A
// rather than fake 0.0") - `averageScore: null`, not `0`.
async function computeOperatorRatingBreakdown(scopedRatings, organizationId) {
  const operators = await User.find({ organizationId, role: 'operator' });

  const bucketsByOperator = new Map();
  scopedRatings.forEach((rating) => {
    if (!rating.operatorId) return; // task spec section 8 - a rating with no attributable operator is simply excluded from this per-operator breakdown, not crashed on.
    const key = String(rating.operatorId);
    if (!bucketsByOperator.has(key)) {
      bucketsByOperator.set(key, { count: 0, scoreSum: 0 });
    }
    const bucket = bucketsByOperator.get(key);
    bucket.count += 1;
    bucket.scoreSum += rating.score;
  });

  return operators.map((operator) => {
    const bucket = bucketsByOperator.get(String(operator._id));
    return {
      operator: { id: operator._id, fullName: operator.fullName, isActive: operator.isActive },
      ratingCount: bucket ? bucket.count : 0,
      averageScore: bucket && bucket.count > 0 ? Math.round((bucket.scoreSum / bucket.count) * 100) / 100 : null,
    };
  });
}

module.exports = { computeSatisfactionStatistics, computeOperatorRatingBreakdown };
