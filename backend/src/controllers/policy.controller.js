const mongoose = require('mongoose');
const OrganizationPolicy = require('../models/OrganizationPolicy');
const PolicyAcknowledgement = require('../models/PolicyAcknowledgement');
const User = require('../models/User');
const { validateTitle, validateContent, validateCategory } = require('../utils/policyFieldValidation');
const { createNotification } = require('../services/notification.service');
const { recordAuditLog } = require('../services/auditLog.service');
const { escapeRegExp } = require('../utils/requestQueryBuilder');

// DOC-74 - "Organization Policies & Guidelines".
// -----------------------------------------------------------------------
// THE TWO RULES EVERY ENDPOINT ON THIS CONTROLLER SHARES:
//
// 1. ORGANIZATION ISOLATION (task spec section 1/2 - "Policies belong to
//    exactly one Organization... Managers may manage only policies from
//    their own Organization"). Every lookup here is scoped by
//    `organizationId: req.user.organizationId` FIRST - never trusted from
//    req.body/req.params - the same DOC-38 anti-enumeration convention
//    every other cross-tenant lookup in this project already uses (a
//    cross-Organization Manager PATCHing another Organization's policy id
//    gets the exact same generic 404 a nonexistent id gets).
//
// 2. ROLE-BASED VISIBILITY IS A SEPARATE, SECOND AXIS (task spec section
//    6/10/11 - "Manager can see both Draft and Published... Employee/
//    Operator: only Published"). `isManagerRole(req)` below is the ONE
//    helper every read endpoint consults; a non-Manager's failed lookup
//    (nonexistent / cross-org / a real but currently-invisible draft or
//    archived policy) always resolves to the SAME generic 404 - never a
//    distinguishing error that would itself leak "a draft with this id
//    exists in your Organization" to an Employee/Operator (task spec
//    section 25's own cross-org-must-fail-safely principle, extended here
//    to also cover same-org-but-wrong-visibility).
//
// System Admin never reaches this file at all - routes/policy.routes.js's
// own `requireRole('manager', 'operator', 'employee')` never includes it
// (task spec: "System Admin does not participate in organization policy
// reading/editing by default... no platform-wide policy management in
// this ticket" - there is no special case anywhere below).
// -----------------------------------------------------------------------

// Task spec section 10 - who counts toward compliance denominators/lists.
// DECISION (documented per task spec's own "document your decision"
// instruction): Managers are ALWAYS excluded from both the compliance
// denominator and the acknowledgement user-inspection list, even though a
// Manager is technically allowed to acknowledge a policy too (task spec:
// "Manager may acknowledge too, but compliance reporting should primarily
// focus on organization users") - only ACTIVE Employees/Operators are
// counted. An inactive Employee/Operator is also excluded (task spec
// section 33: "inactive users should not count against compliance
// percentage").
const COMPLIANCE_ELIGIBLE_ROLES = ['employee', 'operator'];

// Task spec section 30 - controlled, small filter surface only ("do not
// overbuild"): category / isPublished / a simple title substring search.
const MAX_SEARCH_QUERY_LENGTH = 150;

function isManagerRole(req) {
  return req.user.role === 'manager';
}

function policyNotFoundResponse(res) {
  return res.status(404).json({ status: 'error', message: 'Policy not found.' });
}

// ---------------------------------------------------------------------
// THE authorization gate for a single policy - see this file's own top
// comment. Every single-policy endpoint calls this first and never
// re-implements the check inline.
// ---------------------------------------------------------------------
//
// Manager: any status/publish-state, as long as it belongs to their own
// Organization.
// Employee/Operator: their own Organization AND `isPublished: true` AND
// `status: 'ACTIVE'` - anything else (nonexistent, cross-org, draft,
// archived) resolves to the same `null` here, and every call site turns
// that into the identical generic 404 above.
async function loadAuthorizedPolicy(policyId, req) {
  if (!mongoose.Types.ObjectId.isValid(policyId)) {
    return null;
  }
  const query = { _id: policyId, organizationId: req.user.organizationId };
  if (!isManagerRole(req)) {
    query.isPublished = true;
    query.status = 'ACTIVE';
  }
  return OrganizationPolicy.findOne(query);
}

// ---------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------

// Task spec section 38 - never leaks createdBy/updatedBy as raw internal
// fields to non-Managers (not that either field is sensitive, but a
// non-Manager has no use for another user's internal id, the same
// "minimal fields only" discipline sanitizeUserSummary already
// established in directMessage.controller.js). Managers get the fuller
// shape since it is genuinely useful for their own management UI
// (task spec section 32: "title, category, version, Published/Draft,
// last updated, acknowledgement summary").
function sanitizePolicySummary(policy, { includeManagerFields }) {
  const base = {
    id: policy._id,
    title: policy.title,
    category: policy.category,
    version: policy.version,
    updatedAt: policy.updatedAt,
  };
  if (includeManagerFields) {
    return {
      ...base,
      isPublished: policy.isPublished,
      status: policy.status,
      createdAt: policy.createdAt,
      archivedAt: policy.archivedAt,
    };
  }
  return base;
}

// Task spec section 19/20 - the detail view's fuller shape, INCLUDING
// `content` (never returned in the list view - task spec: "do not
// overbuild" - a list of potentially many policies never needs to ship
// every policy's full text body over the wire at once).
function sanitizePolicyDetail(policy, { includeManagerFields }) {
  return {
    ...sanitizePolicySummary(policy, { includeManagerFields }),
    content: policy.content,
    // Present even for a Manager response (harmless, symmetric shape) -
    // Employee/Operator/Manager-detail all include it, list never does.
    isPublished: policy.isPublished,
    status: policy.status,
  };
}

function sanitizeAcknowledgement(acknowledgement) {
  return {
    acknowledgedAt: acknowledgement.acknowledgedAt,
    policyVersion: acknowledgement.policyVersion,
  };
}

// ---------------------------------------------------------------------
// Compliance-statistics helpers (task spec sections 22/23/24 - "avoid
// N+1"). Both call sites below batch the SAME two queries: the eligible
// user set for this Organization (task spec section 10's own denominator
// rule), and every matching PolicyAcknowledgement row for the policy's
// CURRENT version, restricted to that same eligible set (task spec
// section 33 - a Manager's own acknowledgement, or any inactive user's
// stale one, must never inflate the numerator either).
// ---------------------------------------------------------------------
async function loadEligibleUsers(organizationId) {
  return User.find({
    organizationId,
    isActive: true,
    role: { $in: COMPLIANCE_ELIGIBLE_ROLES },
  }).select('_id fullName role');
}

// Batched across MULTIPLE policies at once (task spec section 32's own
// Manager list view needs one acknowledgement-summary PER policy) - one
// eligible-user query, one aggregate, regardless of how many policies are
// being listed.
async function buildAcknowledgementSummaryMap(policies, organizationId) {
  if (policies.length === 0) {
    return new Map();
  }
  const eligibleUsers = await loadEligibleUsers(organizationId);
  const eligibleUserIds = eligibleUsers.map((user) => user._id);
  const totalEligible = eligibleUserIds.length;

  if (totalEligible === 0 || eligibleUserIds.length === 0) {
    return new Map(policies.map((policy) => [
      String(policy._id),
      { acknowledgedCount: 0, totalEligible: 0, percentage: 0 },
    ]));
  }

  const orConditions = policies.map((policy) => ({
    policyId: policy._id,
    policyVersion: policy.version,
  }));

  const rows = await PolicyAcknowledgement.aggregate([
    { $match: { userId: { $in: eligibleUserIds }, $or: orConditions } },
    { $group: { _id: '$policyId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(rows.map((row) => [String(row._id), row.count]));

  return new Map(policies.map((policy) => {
    const acknowledgedCount = countMap.get(String(policy._id)) || 0;
    const percentage = totalEligible > 0 ? Math.round((acknowledgedCount / totalEligible) * 100) : 0;
    return [String(policy._id), { acknowledgedCount, totalEligible, percentage }];
  }));
}

// ---------------------------------------------------------------------
// POST /api/policies   (Manager only - route-level requireRole('manager'))
// ---------------------------------------------------------------------
//
// Task spec section 7 - accepts ONLY {title, content, category,
// isPublished}. `organizationId`/`createdBy`/`updatedBy`/`version` are
// NEVER read from req.body even if present (task spec section 38: "Server
// controls all of these") - always derived from `req.user` / fixed at 1.
const createPolicy = async (req, res, next) => {
  try {
    const body = req.body || {};

    const titleError = validateTitle(body.title);
    if (titleError) {
      return res.status(400).json({ status: 'error', message: titleError });
    }
    const contentError = validateContent(body.content);
    if (contentError) {
      return res.status(400).json({ status: 'error', message: contentError });
    }
    const categoryError = validateCategory(body.category);
    if (categoryError) {
      return res.status(400).json({ status: 'error', message: categoryError });
    }

    const isPublished = body.isPublished === true;

    const policy = await OrganizationPolicy.create({
      organizationId: req.user.organizationId,
      title: body.title.trim(),
      content: body.content.trim(),
      category: body.category !== undefined ? body.category : 'GENERAL',
      isPublished,
      version: 1,
      status: 'ACTIVE',
      createdBy: req.user.userId,
      updatedBy: req.user.userId,
    });

    // Task spec section 34 - a single POLICY_CREATED audit entry covers
    // this request (DECISION, documented: a separately-logged
    // POLICY_PUBLISHED entry for the SAME create-with-isPublished:true
    // request would be a redundant second audit row describing the exact
    // same moment in time - `metadata.isPublished` already captures
    // whether it went live immediately).
    await recordAuditLog({
      actorId: req.user.userId,
      organizationId: req.user.organizationId,
      action: 'POLICY_CREATED',
      targetType: 'OrganizationPolicy',
      targetId: policy._id,
      metadata: { policyId: policy._id, title: policy.title, version: policy.version, isPublished: policy.isPublished },
    });

    // Task spec section 42/43 - a brand-new policy created ALREADY
    // published is a "new policy available" moment exactly like a
    // subsequent publish action - dispatch the same POLICY_PUBLISHED
    // notification wave immediately, rather than requiring a separate
    // "create draft, then publish" round trip to ever notify anyone.
    if (isPublished) {
      await dispatchPolicyNotifications({
        req, policy, notificationType: 'POLICY_PUBLISHED',
      });
    }

    return res.status(201).json({
      status: 'success',
      data: sanitizePolicyDetail(policy, { includeManagerFields: true }),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// Task spec section 39/40/41 - best-effort, never blocks/fails the
// already-successful write it is called after (mirrors DOC-72/DOC-73's
// own dispatch-notifications-in-a-try/catch shape at the call site,
// PLUS this function's own internal try/catch as defense in depth).
// Message text is deliberately fixed/generic (task spec: "New
// organization policy available.") - metadata carries ONLY `policyId`,
// never title/content (task spec: "never full content").
async function dispatchPolicyNotifications({ req, policy, notificationType }) {
  try {
    const recipients = await User.find({
      organizationId: req.user.organizationId,
      isActive: true,
      role: { $in: COMPLIANCE_ELIGIBLE_ROLES },
    }).select('_id');

    await Promise.all(recipients.map((recipient) => createNotification({
      organizationId: req.user.organizationId,
      recipientId: recipient._id,
      actorId: req.user.userId,
      type: notificationType,
      title: 'New organization policy',
      message: 'New organization policy available.',
      metadata: { policyId: policy._id },
    })));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to dispatch ${notificationType} notifications for policy ${policy._id}:`, error.message);
  }
}

// ---------------------------------------------------------------------
// PATCH /api/policies/:policyId   (Manager only, own Organization)
// ---------------------------------------------------------------------
//
// Task spec section 8/38 - whitelist ONLY title/content/category/
// isPublished via explicit `hasOwnProperty` checks - the same "no mass
// assignment" pattern organization.controller.js's own updateMyOrganization
// already established. `version`/`organizationId`/`createdBy`/`updatedBy`
// are NEVER accepted from req.body even if present.
const updatePolicy = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.policyId)) {
      return policyNotFoundResponse(res);
    }
    const policy = await OrganizationPolicy.findOne({
      _id: req.params.policyId,
      organizationId: req.user.organizationId,
    });
    if (!policy) {
      return policyNotFoundResponse(res);
    }

    const body = req.body || {};
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

    if (has('title')) {
      const titleError = validateTitle(body.title);
      if (titleError) {
        return res.status(400).json({ status: 'error', message: titleError });
      }
    }
    if (has('content')) {
      const contentError = validateContent(body.content);
      if (contentError) {
        return res.status(400).json({ status: 'error', message: contentError });
      }
    }
    if (has('category')) {
      const categoryError = validateCategory(body.category);
      if (categoryError) {
        return res.status(400).json({ status: 'error', message: categoryError });
      }
    }
    if (has('isPublished') && typeof body.isPublished !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isPublished must be true or false.' });
    }

    // Task spec section 27 - "only-changed-fields diff" for the audit
    // entry, the exact same shape organization.controller.js's own
    // updateMyOrganization already established: snapshot BEFORE
    // assignment, compare AFTER save, and only include fields whose
    // value genuinely differs.
    const CONTENT_FIELDS = ['title', 'content', 'category'];
    const previousValues = {};
    for (const field of [...CONTENT_FIELDS, 'isPublished']) {
      if (has(field)) {
        previousValues[field] = policy[field];
      }
    }

    const publishedBefore = policy.isPublished;

    if (has('title')) policy.title = body.title.trim();
    if (has('content')) policy.content = body.content.trim();
    if (has('category')) policy.category = body.category;
    if (has('isPublished')) policy.isPublished = body.isPublished;

    let contentFieldsChanged = false;
    const changes = {};
    for (const field of CONTENT_FIELDS) {
      if (has(field) && String(previousValues[field]) !== String(policy[field])) {
        contentFieldsChanged = true;
        changes[field] = { from: previousValues[field], to: policy[field] };
      }
    }
    if (has('isPublished') && previousValues.isPublished !== policy.isPublished) {
      changes.isPublished = { from: previousValues.isPublished, to: policy.isPublished };
    }

    // Task spec section 5 - "When Manager changes meaningful policy
    // content: increment version." A publish/unpublish-only toggle with
    // no title/content/category change never bumps the version - task
    // spec section 26: "toggling published state alone should not by
    // itself require a version bump unless content also changed."
    if (contentFieldsChanged) {
      policy.version += 1;
    }
    policy.updatedBy = req.user.userId;

    await policy.save();

    const publishedAfter = policy.isPublished;

    // DECISION (documented): POLICY_UPDATED is recorded ONLY when a real
    // title/content/category field changed - NOT for a pure publish-flag
    // toggle with no content change, which already gets its own dedicated
    // POLICY_PUBLISHED/POLICY_UNPUBLISHED entry immediately below. Logging
    // BOTH for a publish-only request would be a redundant second audit
    // row describing the exact same single action (the same "do not
    // duplicate meaningless entries" discipline AuditLog.js's own
    // PASSWORD_RESET_REQUEST_APPROVED comment already documents) - when a
    // request genuinely does both (content changed AND the publish flag
    // also flipped in the same PATCH), both entries fire, because that is
    // two genuinely distinct facts, not one fact logged twice.
    if (contentFieldsChanged) {
      await recordAuditLog({
        actorId: req.user.userId,
        organizationId: req.user.organizationId,
        action: 'POLICY_UPDATED',
        targetType: 'OrganizationPolicy',
        targetId: policy._id,
        changes,
        metadata: { policyId: policy._id, title: policy.title, version: policy.version, changedFields: Object.keys(changes) },
      });
    }

    if (publishedBefore !== publishedAfter) {
      await recordAuditLog({
        actorId: req.user.userId,
        organizationId: req.user.organizationId,
        action: publishedAfter ? 'POLICY_PUBLISHED' : 'POLICY_UNPUBLISHED',
        targetType: 'OrganizationPolicy',
        targetId: policy._id,
        metadata: { policyId: policy._id, title: policy.title, version: policy.version },
      });
    }

    // Task spec section 42/43/44 - DECISION (documented): notify when
    // `publishedAfter === true` AND EITHER this is a newly-published draft
    // (`publishedBefore === false`) OR an already-published policy just
    // received a meaningful content change while remaining published
    // (`contentFieldsChanged`). This single condition correctly excludes
    // draft saves (publishedAfter is false), unpublish actions
    // (publishedAfter is false), and a no-op publish-flag-only save with
    // no content change on an already-published policy (publishedBefore
    // is already true AND contentFieldsChanged is false).
    if (publishedAfter === true && (publishedBefore === false || contentFieldsChanged)) {
      const notificationType = publishedBefore === false ? 'POLICY_PUBLISHED' : 'POLICY_UPDATED';
      await dispatchPolicyNotifications({ req, policy, notificationType });
    }

    return res.status(200).json({
      status: 'success',
      data: sanitizePolicyDetail(policy, { includeManagerFields: true }),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// PATCH /api/policies/:policyId/archive   (Manager only, own Organization)
// ---------------------------------------------------------------------
//
// Task spec section 9/29 - soft-archive only, no hard delete anywhere in
// this ticket (see OrganizationPolicy.js's own top comment for the full
// referential-integrity rationale). Deliberately does NOT force
// `isPublished` to `false` - `status: 'ARCHIVED'` alone is already the
// full non-Manager visibility gate (see loadAuthorizedPolicy above).
const archivePolicy = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.policyId)) {
      return policyNotFoundResponse(res);
    }
    const policy = await OrganizationPolicy.findOne({
      _id: req.params.policyId,
      organizationId: req.user.organizationId,
    });
    if (!policy) {
      return policyNotFoundResponse(res);
    }

    if (policy.status !== 'ARCHIVED') {
      policy.status = 'ARCHIVED';
      policy.archivedAt = new Date();
      policy.updatedBy = req.user.userId;
      await policy.save();

      // Task spec: "Do NOT notify for... archive" - no notification
      // dispatch on this path, ever.
      await recordAuditLog({
        actorId: req.user.userId,
        organizationId: req.user.organizationId,
        action: 'POLICY_ARCHIVED',
        targetType: 'OrganizationPolicy',
        targetId: policy._id,
        metadata: { policyId: policy._id, title: policy.title, version: policy.version },
      });
    }

    return res.status(200).json({
      status: 'success',
      data: sanitizePolicyDetail(policy, { includeManagerFields: true }),
    });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/policies   (all three roles - backend decides visibility)
// ---------------------------------------------------------------------
//
// Task spec section 11/30 - Manager: every status/publish-state in their
// own Organization, with optional category/isPublished/q filters.
// Employee/Operator: `isPublished: true` AND `status: 'ACTIVE'` only -
// never frontend-hidden data (task spec: "backend decides visibility").
const listPolicies = async (req, res, next) => {
  try {
    const managerRole = isManagerRole(req);
    const query = { organizationId: req.user.organizationId };

    if (!managerRole) {
      query.isPublished = true;
      query.status = 'ACTIVE';
    } else {
      const { category, isPublished, q } = req.query || {};
      if (category !== undefined && category !== '') {
        const categoryError = validateCategory(category);
        if (categoryError) {
          return res.status(400).json({ status: 'error', message: categoryError });
        }
        query.category = category;
      }
      if (isPublished === 'true') {
        query.isPublished = true;
      } else if (isPublished === 'false') {
        query.isPublished = false;
      }
      if (typeof q === 'string' && q.trim().length > 0) {
        if (q.trim().length > MAX_SEARCH_QUERY_LENGTH) {
          return res.status(400).json({ status: 'error', message: `q must be at most ${MAX_SEARCH_QUERY_LENGTH} characters.` });
        }
        query.title = new RegExp(escapeRegExp(q.trim()), 'i');
      }
    }

    const policies = await OrganizationPolicy
      .find(query)
      .sort({ updatedAt: -1 });

    let summaryMap = new Map();
    if (managerRole) {
      // Task spec section 32 - the Manager list view's own per-policy
      // acknowledgement summary, batched (see this file's own top
      // comment on buildAcknowledgementSummaryMap).
      summaryMap = await buildAcknowledgementSummaryMap(policies, req.user.organizationId);
    }

    const data = policies.map((policy) => {
      const base = sanitizePolicySummary(policy, { includeManagerFields: managerRole });
      if (managerRole) {
        return { ...base, acknowledgementSummary: summaryMap.get(String(policy._id)) || { acknowledgedCount: 0, totalEligible: 0, percentage: 0 } };
      }
      return base;
    });

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/policies/:policyId
// ---------------------------------------------------------------------
const getPolicy = async (req, res, next) => {
  try {
    const policy = await loadAuthorizedPolicy(req.params.policyId, req);
    if (!policy) {
      return policyNotFoundResponse(res);
    }

    const managerRole = isManagerRole(req);

    // Task spec section 20 - "I Have Read and Understand This Policy" vs
    // "Acknowledged on [date]" - the CALLER's own acknowledgement status
    // for the policy's CURRENT version only (an old-version acknowledgement
    // never counts here, mirroring PolicyAcknowledgement's own version-
    // scoped uniqueness).
    const myAcknowledgement = await PolicyAcknowledgement.findOne({
      policyId: policy._id,
      userId: req.user.userId,
      policyVersion: policy.version,
    });

    return res.status(200).json({
      status: 'success',
      data: {
        ...sanitizePolicyDetail(policy, { includeManagerFields: managerRole }),
        myAcknowledgement: myAcknowledgement ? sanitizeAcknowledgement(myAcknowledgement) : null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/policies/:policyId/acknowledge   (all three roles)
// ---------------------------------------------------------------------
//
// Task spec section 15/16 - `userId` is ALWAYS `req.user.userId` (task
// spec: "Never accept userId in body"). The policy must belong to the
// caller's own Organization (else 404, never leaking cross-org
// existence) AND be currently published+active (else a 400 - a real,
// visible-to-this-role concept of "not currently available", distinct
// from "not found").
const acknowledgePolicy = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.policyId)) {
      return policyNotFoundResponse(res);
    }
    const policy = await OrganizationPolicy.findOne({
      _id: req.params.policyId,
      organizationId: req.user.organizationId,
    });
    if (!policy) {
      return policyNotFoundResponse(res);
    }
    if (!policy.isPublished || policy.status !== 'ACTIVE') {
      return res.status(400).json({ status: 'error', message: 'This policy is not currently available for acknowledgement.' });
    }

    const existing = await PolicyAcknowledgement.findOne({
      policyId: policy._id,
      userId: req.user.userId,
      policyVersion: policy.version,
    });
    if (existing) {
      // Task spec section 16 - idempotent, safe response on duplicate.
      return res.status(200).json({ status: 'success', data: sanitizeAcknowledgement(existing) });
    }

    let acknowledgement;
    try {
      acknowledgement = await PolicyAcknowledgement.create({
        organizationId: req.user.organizationId,
        policyId: policy._id,
        userId: req.user.userId,
        policyVersion: policy.version,
      });
    } catch (createError) {
      // Race-safe idempotency - identical shape to DOC-73's own
      // createConversation duplicate-key handling.
      if (createError && createError.code === 11000) {
        acknowledgement = await PolicyAcknowledgement.findOne({
          policyId: policy._id,
          userId: req.user.userId,
          policyVersion: policy.version,
        });
        if (!acknowledgement) {
          throw createError;
        }
      } else {
        throw createError;
      }
    }

    // Task spec: normal acknowledgement is NOT an administrative action -
    // never Audit-Log'd here (already fully, permanently recorded in
    // PolicyAcknowledgement itself).
    return res.status(201).json({ status: 'success', data: sanitizeAcknowledgement(acknowledgement) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/policies/:policyId/acknowledgements   (Manager only)
// ---------------------------------------------------------------------
//
// Task spec section 24/33 - "who acknowledged / who hasn't" with minimal
// fields (fullName/role/status/acknowledgedAt), own Organization only,
// current version only, active Employees/Operators only (see this file's
// own top comment on COMPLIANCE_ELIGIBLE_ROLES).
const getPolicyAcknowledgements = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.policyId)) {
      return policyNotFoundResponse(res);
    }
    const policy = await OrganizationPolicy.findOne({
      _id: req.params.policyId,
      organizationId: req.user.organizationId,
    });
    if (!policy) {
      return policyNotFoundResponse(res);
    }

    const eligibleUsers = await loadEligibleUsers(req.user.organizationId);
    const eligibleUserIds = eligibleUsers.map((user) => user._id);

    const acknowledgements = eligibleUserIds.length > 0
      ? await PolicyAcknowledgement.find({
        policyId: policy._id,
        policyVersion: policy.version,
        userId: { $in: eligibleUserIds },
      })
      : [];
    const acknowledgedMap = new Map(acknowledgements.map((ack) => [String(ack.userId), ack.acknowledgedAt]));

    const totalEligible = eligibleUsers.length;
    const acknowledgedCount = acknowledgements.length;
    const percentage = totalEligible > 0 ? Math.round((acknowledgedCount / totalEligible) * 100) : 0;

    const users = eligibleUsers.map((user) => {
      const acknowledgedAt = acknowledgedMap.get(String(user._id)) || null;
      return {
        id: user._id,
        fullName: user.fullName,
        role: user.role,
        status: acknowledgedAt ? 'ACKNOWLEDGED' : 'PENDING',
        acknowledgedAt,
      };
    });

    return res.status(200).json({
      status: 'success',
      data: {
        summary: { acknowledgedCount, totalEligible, percentage },
        users,
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createPolicy,
  updatePolicy,
  archivePolicy,
  listPolicies,
  getPolicy,
  acknowledgePolicy,
  getPolicyAcknowledgements,
  loadAuthorizedPolicy,
  sanitizePolicySummary,
  sanitizePolicyDetail,
  COMPLIANCE_ELIGIBLE_ROLES,
};
