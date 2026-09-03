const mongoose = require('mongoose');
const KnowledgeQuestion = require('../models/KnowledgeQuestion');
const KnowledgeAnswer = require('../models/KnowledgeAnswer');
const User = require('../models/User');
const {
  validateTitle, validateQuestionContent, validateAnswerContent, validateCategory,
} = require('../utils/knowledgeFieldValidation');
const {
  statusAfterAccept, statusAfterUnaccept, statusAfterClose, statusAfterReopen, canAcceptOrUnaccept, canEdit,
} = require('../utils/knowledgeStatusTransitions');
const { createNotification } = require('../services/notification.service');
const { recordAuditLog } = require('../services/auditLog.service');
const { escapeRegExp } = require('../utils/requestQueryBuilder');

// DOC-75 - "Organization Q&A / Knowledge Board".
// -----------------------------------------------------------------------
// PERSISTENT, SEARCHABLE KNOWLEDGE - NOT CHAT. Every endpoint here is
// scoped by `organizationId: req.user.organizationId` FIRST (task spec
// section 40), the same DOC-38 anti-enumeration convention every other
// cross-tenant lookup in this project already uses - a cross-Organization
// id (question or answer) behaves exactly like a nonexistent one: a
// generic 404, never a distinguishing error.
//
// UNLIKE DOC-74's OrganizationPolicy, there is no per-role VISIBILITY
// axis here - Manager/Operator/Employee all see the exact same
// Organization-wide board (task spec section 49: "Manager sees same
// Knowledge Board as users"). The only additional Manager privileges are
// the two explicitly named in the task spec: accepting an answer, and
// closing/reopening a question (section 49) - Manager gets NO extra
// visibility, only extra WRITE privilege on those two specific actions.
//
// System Admin never reaches this file at all - routes/knowledge.routes.js
// only gates manager/operator/employee (task spec section 8/50 - "System
// Admin should remain excluded if no org membership... No global
// knowledge surveillance page").
// -----------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 200;
const SORT_VALUES = ['newest', 'oldest', 'mostAnswered'];
const STATUS_VALUES = ['OPEN', 'ANSWERED', 'CLOSED'];

// ---------------------------------------------------------------------
// PAGINATION (task spec section 47 - "Use existing project convention...
// Be consistent with existing APIs"). DECISION, documented: this endpoint
// uses simple PAGE-BASED pagination (`page` + `limit`, skip/limit) rather
// than the `limit` + `before`-cursor convention Organization Chat/Direct
// Messages/Audit Log all share. That cursor shape is specifically suited
// to an append-only, real-time/immutable, always-newest-first feed - it
// has no natural meaning for `sort=mostAnswered` (a value, `answerCount`,
// that can change out from under a stable point-in-time cursor) or for
// browsing back and forth through a searchable, filterable, editable
// knowledge board the way a person browses search results. Page numbers
// work identically regardless of which of the three sort options is
// active, which a single-field timestamp cursor cannot offer - the exact
// "persistent/searchable knowledge vs. transient/real-time communication"
// distinction this ticket itself draws between Q&A and Chat.
function parsePagination(rawPage, rawLimit) {
  let page = 1;
  let limit = DEFAULT_PAGE_SIZE;
  if (rawPage !== undefined && rawPage !== '') {
    if (typeof rawPage !== 'string' || !/^\d+$/.test(rawPage.trim()) || Number.parseInt(rawPage, 10) < 1) {
      return { error: 'page must be a whole number of at least 1.' };
    }
    page = Number.parseInt(rawPage, 10);
  }
  if (rawLimit !== undefined && rawLimit !== '') {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit.trim())) {
      return { error: `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}.` };
    }
    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (parsedLimit < 1 || parsedLimit > MAX_PAGE_SIZE) {
      return { error: `limit must be a whole number between 1 and ${MAX_PAGE_SIZE}.` };
    }
    limit = parsedLimit;
  }
  return { page, limit, error: null };
}

// ---------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------

// Task spec section 24 - minimal author data only: id/fullName/role/
// hasProfileImage - the exact same shape chat.controller.js's own
// `sanitizeMentionCandidate` and directMessage.controller.js's own
// `sanitizeUserSummary` already established. NEVER email/bio/sessions/
// organization internals. `null` (author no longer resolvable - should be
// unreachable, Users are never hard-deleted in this project, but handled
// the same safe way chat's own `sanitizeChatMessage` already does for its
// identical fallback case) renders as an honest "Unknown user" rather
// than crashing (task spec section 51 - "Display historical author
// safely").
function sanitizeAuthorSummary(user) {
  if (!user) {
    return {
      id: null, fullName: 'Unknown user', role: null, hasProfileImage: false,
    };
  }
  return {
    id: user._id, fullName: user.fullName, role: user.role, hasProfileImage: !!user.profileImage,
  };
}

function sanitizeQuestionSummary(question, author) {
  return {
    id: question._id,
    title: question.title,
    category: question.category,
    status: question.status,
    answerCount: question.answerCount,
    viewCount: question.viewCount,
    author: sanitizeAuthorSummary(author),
    createdAt: question.createdAt,
    updatedAt: question.updatedAt,
  };
}

// Task spec section 13 - "Return question, author summary, acceptedAnswer
// reference, metadata." `acceptedAnswerId` is returned as a plain
// reference id ONLY (never the accepted answer's own content inlined
// here) - the full accepted answer is already available from the answers
// list endpoint (task spec: "Then answers may be fetched separately"),
// where it is flagged `isAccepted: true` - returning it twice here would
// be redundant duplicated data for no benefit.
function sanitizeQuestionDetail(question, author) {
  return {
    ...sanitizeQuestionSummary(question, author),
    content: question.content,
    acceptedAnswerId: question.acceptedAnswerId,
  };
}

function sanitizeAnswer(answer, author, isAccepted) {
  return {
    id: answer._id,
    questionId: answer.questionId,
    content: answer.content,
    author: sanitizeAuthorSummary(author),
    isAccepted: !!isAccepted,
    createdAt: answer.createdAt,
    updatedAt: answer.updatedAt,
  };
}

// Batches every distinct author id referenced by a page of questions/
// answers into at most one additional query - never one query per row
// (N+1) - the same shape chat.controller.js's own `buildUserLookupMap`
// already established. Deliberately does NOT filter by `isActive` - a
// deactivated author's historical question/answer must remain visible
// with their real name (task spec section 51: "Inactive user cannot
// create NEW content" - reading/displaying their past content is a
// completely separate, always-allowed concern).
async function buildUserLookupMap(userIds, organizationId) {
  const uniqueIds = Array.from(new Set(userIds.map((id) => String(id))));
  if (uniqueIds.length === 0) {
    return new Map();
  }
  const users = await User.find({ _id: { $in: uniqueIds }, organizationId });
  return new Map(users.map((user) => [String(user._id), user]));
}

// ---------------------------------------------------------------------
// Authorization gates - see this file's own top comment.
// ---------------------------------------------------------------------

// A missing question and one belonging to another Organization resolve
// to the exact same `null` here - every call site turns that into the
// identical generic 404 below (task spec section 46: "Org A user GET Org
// B question -> 404").
async function loadAuthorizedQuestion(questionId, req) {
  if (!mongoose.Types.ObjectId.isValid(questionId)) {
    return null;
  }
  return KnowledgeQuestion.findOne({ _id: questionId, organizationId: req.user.organizationId });
}

// Task spec section 41 - "ANSWER IDOR... Use scoped relationship:
// answer._id, questionId, organizationId - all must match." Never a
// global `KnowledgeAnswer.findById(answerId)` followed by a separate
// questionId comparison - a single scoped query is what makes a
// mismatched answer/question pairing (task spec section 30/49) and a
// cross-Organization answer id both resolve to the same `null`.
async function loadAuthorizedAnswer(answerId, question, req) {
  if (!mongoose.Types.ObjectId.isValid(answerId)) {
    return null;
  }
  return KnowledgeAnswer.findOne({
    _id: answerId, questionId: question._id, organizationId: req.user.organizationId,
  });
}

function questionNotFoundResponse(res) {
  return res.status(404).json({ status: 'error', message: 'Question not found.' });
}
function answerNotFoundResponse(res) {
  return res.status(404).json({ status: 'error', message: 'Answer not found.' });
}
function forbiddenResponse(res, message) {
  return res.status(403).json({ status: 'error', message: message || 'You do not have permission to perform this action.' });
}

// Task spec sections 16/19/20 - "question author OR Manager from same
// Organization" is the one recurring permission rule for accept/
// unaccept/close/reopen. `question` here is already Organization-scoped
// (loaded via loadAuthorizedQuestion), so this only ever needs to check
// authorship or role, never Organization membership again.
function isOwnerOrManager(req, question) {
  return String(question.authorId) === String(req.user.userId) || req.user.role === 'manager';
}

// ---------------------------------------------------------------------
// POST /api/knowledge/questions   (employee/operator/manager)
// ---------------------------------------------------------------------
//
// Task spec section 10 - accepts ONLY {title, content, category}.
// organizationId/authorId/status/acceptedAnswerId/answerCount/viewCount
// are NEVER read from req.body even if present (task spec section 39:
// "Use server-side authorId. Do not accept authorId in payload.") -
// always server-derived/server-defaulted.
const createQuestion = async (req, res, next) => {
  try {
    const body = req.body || {};

    const titleError = validateTitle(body.title);
    if (titleError) {
      return res.status(400).json({ status: 'error', message: titleError });
    }
    const contentError = validateQuestionContent(body.content);
    if (contentError) {
      return res.status(400).json({ status: 'error', message: contentError });
    }
    const categoryError = validateCategory(body.category);
    if (categoryError) {
      return res.status(400).json({ status: 'error', message: categoryError });
    }

    const question = await KnowledgeQuestion.create({
      organizationId: req.user.organizationId,
      authorId: req.user.userId,
      title: body.title.trim(),
      content: body.content.trim(),
      category: body.category !== undefined ? body.category : 'GENERAL',
    });

    const author = await User.findById(req.user.userId);
    return res.status(201).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/knowledge/questions   (employee/operator/manager)
// ---------------------------------------------------------------------
//
// Task spec section 11/12 - same-Organization only, with pagination,
// search (title+content), category filter, status filter, and sort
// (newest/oldest/mostAnswered). Never an unlimited dataset (task spec:
// "Do not return unlimited dataset.").
const listQuestions = async (req, res, next) => {
  try {
    const {
      q, category, status, sort, page: rawPage, limit: rawLimit,
    } = req.query || {};

    const query = { organizationId: req.user.organizationId };

    // Task spec section 12/46 - case-insensitive substring search over
    // title+content, regex-escaped (never a raw user-supplied RegExp -
    // see this project's own `escapeRegExp`, reused verbatim from
    // utils/requestQueryBuilder.js rather than re-implemented a third
    // time).
    if (q !== undefined && q !== '') {
      if (typeof q !== 'string') {
        return res.status(400).json({ status: 'error', message: 'q must be a single text value.' });
      }
      if (q.length > MAX_SEARCH_LENGTH) {
        return res.status(400).json({ status: 'error', message: `q must be at most ${MAX_SEARCH_LENGTH} characters.` });
      }
      const trimmed = q.trim();
      if (trimmed.length > 0) {
        const pattern = new RegExp(escapeRegExp(trimmed), 'i');
        query.$or = [{ title: pattern }, { content: pattern }];
      }
    }

    if (category !== undefined && category !== '') {
      const categoryError = validateCategory(category);
      if (categoryError) {
        return res.status(400).json({ status: 'error', message: categoryError });
      }
      query.category = category;
    }

    if (status !== undefined && status !== '') {
      if (!STATUS_VALUES.includes(status)) {
        return res.status(400).json({ status: 'error', message: `status must be one of: ${STATUS_VALUES.join(', ')}.` });
      }
      query.status = status;
    }

    let sortKey = 'newest';
    if (sort !== undefined && sort !== '') {
      if (!SORT_VALUES.includes(sort)) {
        return res.status(400).json({ status: 'error', message: `sort must be one of: ${SORT_VALUES.join(', ')}.` });
      }
      sortKey = sort;
    }
    const sortSpec = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      mostAnswered: { answerCount: -1, createdAt: -1 },
    }[sortKey];

    const { page, limit, error: pageError } = parsePagination(rawPage, rawLimit);
    if (pageError) {
      return res.status(400).json({ status: 'error', message: pageError });
    }

    const [questions, totalCount] = await Promise.all([
      KnowledgeQuestion.find(query).sort(sortSpec).skip((page - 1) * limit).limit(limit),
      KnowledgeQuestion.countDocuments(query),
    ]);

    const authorMap = await buildUserLookupMap(questions.map((question) => question.authorId), req.user.organizationId);
    const data = questions.map((question) => sanitizeQuestionSummary(question, authorMap.get(String(question.authorId))));

    return res.status(200).json({
      status: 'success',
      data,
      meta: {
        page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/knowledge/questions/:questionId
// ---------------------------------------------------------------------
const getQuestion = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }

    // Task spec section 36 - "Optional. If implemented: increment
    // carefully without excessive writes. Do not prioritize over core
    // functionality." A single atomic `$inc`, fire-and-forget - its
    // result is never awaited by the response and its failure is only
    // ever logged, never surfaced - a view-count write can never slow
    // down or break the primary read.
    KnowledgeQuestion.updateOne({ _id: question._id }, { $inc: { viewCount: 1 } }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`Failed to increment view count for question ${question._id}:`, error.message);
    });

    const author = await User.findById(question.authorId);
    return res.status(200).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// PATCH /api/knowledge/questions/:questionId   (author only)
// ---------------------------------------------------------------------
//
// Task spec section 21 - "question author can edit title/content/category
// while question is not CLOSED. Manager may optionally moderate but
// should not silently rewrite user content without requirement." DECISION
// (documented): Manager moderation-editing is NOT implemented in this
// version - no requirement in this ticket calls for it, and silently
// allowing a Manager to rewrite another user's question text would be a
// surprising, undocumented capability. Only the question's own author may
// edit it here, even a same-Organization Manager gets the same 403 an
// unrelated Employee would.
const updateQuestion = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.questionId)) {
      return questionNotFoundResponse(res);
    }
    const question = await KnowledgeQuestion.findOne({
      _id: req.params.questionId, organizationId: req.user.organizationId,
    });
    if (!question) {
      return questionNotFoundResponse(res);
    }
    if (String(question.authorId) !== String(req.user.userId)) {
      return forbiddenResponse(res, 'Only the question author may edit this question.');
    }
    if (!canEdit(question)) {
      return res.status(409).json({ status: 'error', message: 'This question is closed and cannot be edited. Reopen it first.' });
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
      const contentError = validateQuestionContent(body.content);
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

    if (has('title')) question.title = body.title.trim();
    if (has('content')) question.content = body.content.trim();
    if (has('category')) question.category = body.category;
    await question.save();

    const author = await User.findById(question.authorId);
    return res.status(200).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/knowledge/questions/:questionId/close   (owner or Manager)
// ---------------------------------------------------------------------
const closeQuestion = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }
    const isManager = req.user.role === 'manager';
    const isOwner = String(question.authorId) === String(req.user.userId);
    if (!isOwner && !isManager) {
      return forbiddenResponse(res);
    }

    if (question.status !== 'CLOSED') {
      question.status = statusAfterClose();
      await question.save();

      // Task spec section 34 - "If Manager closes someone else's
      // question: optional controlled Audit event could be justified.
      // Default: no noisy Audit Log." DECISION (documented): this is the
      // ONE Q&A action that IS Audit-Logged - a Manager exercising a
      // moderation privilege over content they do not own is a genuine
      // administrative action, unlike normal ask/answer/accept activity
      // (never logged - see createAnswer/acceptAnswer/unacceptAnswer's
      // own comments). Closing one's own question is never logged.
      if (isManager && !isOwner) {
        await recordAuditLog({
          actorId: req.user.userId,
          organizationId: req.user.organizationId,
          action: 'KNOWLEDGE_QUESTION_CLOSED_BY_MANAGER',
          targetType: 'KnowledgeQuestion',
          targetId: question._id,
          metadata: { questionId: question._id, title: question.title },
        });
      }
    }

    const author = await User.findById(question.authorId);
    return res.status(200).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/knowledge/questions/:questionId/reopen   (owner or Manager)
// ---------------------------------------------------------------------
const reopenQuestion = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }
    const isManager = req.user.role === 'manager';
    const isOwner = String(question.authorId) === String(req.user.userId);
    if (!isOwner && !isManager) {
      return forbiddenResponse(res);
    }

    if (question.status === 'CLOSED') {
      question.status = statusAfterReopen(!!question.acceptedAnswerId);
      await question.save();
    }

    const author = await User.findById(question.authorId);
    return res.status(200).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// GET /api/knowledge/questions/:questionId/answers
// ---------------------------------------------------------------------
//
// Task spec section 14 - "Sort: oldest first is natural for discussion.
// Accepted answer should be clearly identified."
const listAnswers = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }

    const { page, limit, error: pageError } = parsePagination(req.query.page, req.query.limit);
    if (pageError) {
      return res.status(400).json({ status: 'error', message: pageError });
    }

    const answerQuery = { questionId: question._id, organizationId: req.user.organizationId };
    const [answers, totalCount] = await Promise.all([
      KnowledgeAnswer.find(answerQuery).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit),
      KnowledgeAnswer.countDocuments(answerQuery),
    ]);

    const authorMap = await buildUserLookupMap(answers.map((answer) => answer.authorId), req.user.organizationId);
    const data = answers.map((answer) => sanitizeAnswer(
      answer,
      authorMap.get(String(answer.authorId)),
      String(answer._id) === String(question.acceptedAnswerId),
    ));

    return res.status(200).json({
      status: 'success',
      data,
      meta: {
        page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)), acceptedAnswerId: question.acceptedAnswerId,
      },
    });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/knowledge/questions/:questionId/answers
// ---------------------------------------------------------------------
//
// Task spec section 9/15 - any active same-Organization user (employee/
// operator/manager) may answer, including the question's own author.
// `authorId`/`organizationId`/`questionId` are always server-derived -
// never accepted from req.body (only `content` is ever read).
//
// Task spec section 42 - "Backend must reject answer creation on CLOSED
// question" - frontend hiding the answer form is explicitly NOT
// sufficient; this check is the real enforcement.
const createAnswer = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }
    if (question.status === 'CLOSED') {
      return res.status(409).json({ status: 'error', message: 'This question is closed and no longer accepts new answers.' });
    }

    const body = req.body || {};
    const contentError = validateAnswerContent(body.content);
    if (contentError) {
      return res.status(400).json({ status: 'error', message: contentError });
    }

    const answer = await KnowledgeAnswer.create({
      organizationId: req.user.organizationId,
      questionId: question._id,
      authorId: req.user.userId,
      content: body.content.trim(),
    });

    // Task spec section 44 - denormalized answerCount, updated
    // SERVER-SIDE via an atomic `$inc` only AFTER the answer document has
    // actually been saved - a failed answer creation (a validation error
    // thrown above, before this line) can never increment it.
    await KnowledgeQuestion.updateOne({ _id: question._id }, { $inc: { answerCount: 1 } });

    // Task spec section 31 - KNOWLEDGE_ANSWER_ADDED, best-effort, never
    // fails the already-successful answer creation. Task spec: "Do not
    // notify if answer author == question author" - checked explicitly
    // here AND independently guarded again inside createNotification
    // itself (actorId === recipientId -> silent no-op), the same
    // defense-in-depth shape DOC-72/73's own notification dispatch sites
    // already use.
    if (String(question.authorId) !== String(req.user.userId)) {
      try {
        const answerAuthor = await User.findById(req.user.userId);
        await createNotification({
          organizationId: req.user.organizationId,
          recipientId: question.authorId,
          actorId: req.user.userId,
          type: 'KNOWLEDGE_ANSWER_ADDED',
          title: 'New answer to your question',
          message: `${answerAuthor ? answerAuthor.fullName : 'Someone'} answered your question.`,
          // Task spec section 31 - "Do not include full answer text" -
          // only opaque ids.
          metadata: { questionId: question._id, answerId: answer._id },
        });
      } catch (notificationError) {
        // eslint-disable-next-line no-console
        console.error('Failed to dispatch KNOWLEDGE_ANSWER_ADDED notification:', notificationError.message);
      }
    }

    // Normal answer creation is NOT an administrative action - never
    // Audit-Logged (task spec section 34).
    const author = await User.findById(req.user.userId);
    return res.status(201).json({ status: 'success', data: sanitizeAnswer(answer, author, false) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// PATCH /api/knowledge/questions/:questionId/answers/:answerId
// ---------------------------------------------------------------------
//
// Task spec section 22 - "answer author can edit their own answer. If
// accepted answer is edited: it remains accepted." (Editing content never
// touches `question.acceptedAnswerId` at all, so this is automatically
// true - there is no code path here that could ever un-accept an answer
// as a side effect of editing its text.)
const updateAnswer = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }
    const answer = await loadAuthorizedAnswer(req.params.answerId, question, req);
    if (!answer) {
      return answerNotFoundResponse(res);
    }
    if (String(answer.authorId) !== String(req.user.userId)) {
      return forbiddenResponse(res, 'Only the answer author may edit this answer.');
    }
    if (!canEdit(question)) {
      return res.status(409).json({ status: 'error', message: 'This question is closed and its answers cannot be edited. Reopen it first.' });
    }

    const body = req.body || {};
    const contentError = validateAnswerContent(body.content);
    if (contentError) {
      return res.status(400).json({ status: 'error', message: contentError });
    }
    answer.content = body.content.trim();
    await answer.save();

    const author = await User.findById(answer.authorId);
    const isAccepted = String(answer._id) === String(question.acceptedAnswerId);
    return res.status(200).json({ status: 'success', data: sanitizeAnswer(answer, author, isAccepted) });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    return next(error);
  }
};

// ---------------------------------------------------------------------
// POST /api/knowledge/questions/:questionId/answers/:answerId/accept
// ---------------------------------------------------------------------
//
// Task spec section 16/17 - question author OR same-Organization Manager
// only. Replaces any previously-accepted answer (never creates a second
// one) and transitions status via the centralized
// utils/knowledgeStatusTransitions.js helper - never derived ad hoc here.
const acceptAnswer = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }
    if (!isOwnerOrManager(req, question)) {
      return forbiddenResponse(res);
    }
    if (!canAcceptOrUnaccept(question)) {
      return res.status(409).json({ status: 'error', message: 'This question is closed. Reopen it before changing the accepted answer.' });
    }

    const answer = await loadAuthorizedAnswer(req.params.answerId, question, req);
    if (!answer) {
      return answerNotFoundResponse(res);
    }

    question.acceptedAnswerId = answer._id;
    question.status = statusAfterAccept();
    await question.save();

    // Task spec section 32/43 - KNOWLEDGE_ANSWER_ACCEPTED, best-effort,
    // never self-notify (the question owner accepting their OWN answer -
    // a self-answer that then gets accepted - never notifies anyone).
    if (String(answer.authorId) !== String(req.user.userId)) {
      try {
        const accepter = await User.findById(req.user.userId);
        await createNotification({
          organizationId: req.user.organizationId,
          recipientId: answer.authorId,
          actorId: req.user.userId,
          type: 'KNOWLEDGE_ANSWER_ACCEPTED',
          title: 'Your answer was accepted',
          message: `${accepter ? accepter.fullName : 'Someone'} accepted your answer.`,
          metadata: { questionId: question._id, answerId: answer._id },
        });
      } catch (notificationError) {
        // eslint-disable-next-line no-console
        console.error('Failed to dispatch KNOWLEDGE_ANSWER_ACCEPTED notification:', notificationError.message);
      }
    }

    // Accepting an answer is NOT audit-logged (task spec section 34 -
    // normal Q&A activity, not a moderation action - unlike a Manager
    // closing someone else's question, accepting an answer is not an
    // action performed AGAINST another user's content ownership; it is
    // the question owner's own normal workflow, or a Manager helping in
    // exactly the way any question owner already could).
    const author = await User.findById(question.authorId);
    return res.status(200).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------
// DELETE /api/knowledge/questions/:questionId/accepted-answer
// ---------------------------------------------------------------------
//
// Task spec section 18 - "unaccept". Idempotent: calling this when there
// is no accepted answer already is a safe no-op (200, unchanged state),
// never an error.
const unacceptAnswer = async (req, res, next) => {
  try {
    const question = await loadAuthorizedQuestion(req.params.questionId, req);
    if (!question) {
      return questionNotFoundResponse(res);
    }
    if (!isOwnerOrManager(req, question)) {
      return forbiddenResponse(res);
    }
    if (!canAcceptOrUnaccept(question)) {
      return res.status(409).json({ status: 'error', message: 'This question is closed. Reopen it before changing the accepted answer.' });
    }

    if (question.acceptedAnswerId) {
      question.acceptedAnswerId = null;
      question.status = statusAfterUnaccept();
      await question.save();
    }

    const author = await User.findById(question.authorId);
    return res.status(200).json({ status: 'success', data: sanitizeQuestionDetail(question, author) });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  createQuestion,
  listQuestions,
  getQuestion,
  updateQuestion,
  closeQuestion,
  reopenQuestion,
  listAnswers,
  createAnswer,
  updateAnswer,
  acceptAnswer,
  unacceptAnswer,
  loadAuthorizedQuestion,
  loadAuthorizedAnswer,
  sanitizeQuestionSummary,
  sanitizeQuestionDetail,
  sanitizeAnswer,
  sanitizeAuthorSummary,
};
