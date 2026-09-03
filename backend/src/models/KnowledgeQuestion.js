const mongoose = require('mongoose');
const {
  KNOWLEDGE_CATEGORIES, TITLE_MIN_LENGTH, TITLE_MAX_LENGTH, QUESTION_CONTENT_MIN_LENGTH, QUESTION_CONTENT_MAX_LENGTH,
} = require('../utils/knowledgeFieldValidation');

// DOC-75 - "Organization Q&A / Knowledge Board".
// -----------------------------------------------------------------------
// A DEDICATED model, deliberately NOT an unbounded `answers` array
// embedded inside this document (task spec section 2: "Do NOT embed an
// unbounded answers array inside Question") - the same 16MB BSON ceiling
// reasoning this project's other unbounded-child features already avoid
// (Notification/RequestActivity/ChatMessage/DirectMessage/DOC-74's own
// OrganizationPolicy+PolicyAcknowledgement split). Answers live in their
// own top-level `KnowledgeAnswer` collection (see that model's own top
// comment), referencing this document by `questionId`.
//
// PERSISTENT, SEARCHABLE KNOWLEDGE - NOT CHAT (task spec's own framing,
// reproduced here since it drives several schema choices below): unlike
// `ChatMessage` (DOC-60), a question is never immutable-by-design (the
// author may edit title/content/category while the question is open -
// task spec section 21) and is expected to be found again much later via
// search/category/status filters, not merely scrolled through
// chronologically - hence the indexes at the bottom of this file.
//
// PLAIN TEXT ONLY (task spec section 4/45 - CRITICAL). `content` is a
// plain String field with no HTML-aware type or sanitizer of its own -
// safety comes entirely from the RENDERING side (Knowledge.jsx renders
// `content` as plain React text, never `dangerouslySetInnerHTML`), the
// exact same "storage is honest, rendering is safe" contract
// `OrganizationPolicy.content` (DOC-74) and `User.bio` (DOC-71) already
// establish.
const knowledgeQuestionSchema = new mongoose.Schema(
  {
    // The tenant boundary (task spec section 40: "Every question/answer
    // query must include organizationId: req.user.organizationId") -
    // always derived from req.user.organizationId at creation time, never
    // trusted from req.body (task spec section 39/10).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Task spec section 39 - "Use server-side authorId. Do not accept
    // authorId in payload." Always req.user.userId at creation time,
    // never re-assigned afterward (there is no "transfer ownership"
    // concept anywhere in this ticket).
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: [TITLE_MIN_LENGTH, `title must be at least ${TITLE_MIN_LENGTH} characters.`],
      maxlength: [TITLE_MAX_LENGTH, `title must be at most ${TITLE_MAX_LENGTH} characters.`],
    },
    content: {
      type: String,
      required: true,
      trim: true,
      minlength: [QUESTION_CONTENT_MIN_LENGTH, `content must be at least ${QUESTION_CONTENT_MIN_LENGTH} characters.`],
      maxlength: [QUESTION_CONTENT_MAX_LENGTH, `content must be at most ${QUESTION_CONTENT_MAX_LENGTH} characters.`],
    },
    // Task spec section 6 - a controlled, fixed enum, NOT a reuse of
    // ServiceCategory - see utils/knowledgeFieldValidation.js's own top
    // comment for the full documented reasoning.
    category: {
      type: String,
      enum: KNOWLEDGE_CATEGORIES,
      default: 'GENERAL',
    },
    // Task spec section 7/43 - controlled status, transitions centralized
    // in utils/knowledgeStatusTransitions.js - never set directly by a
    // controller's own ad hoc logic.
    status: {
      type: String,
      enum: ['OPEN', 'ANSWERED', 'CLOSED'],
      default: 'OPEN',
    },
    // Task spec section 16/17 - `null` while no answer has been accepted
    // yet, or after an accepted answer is explicitly removed (task spec
    // section 18). Never more than one accepted answer at a time - a new
    // acceptance REPLACES this value rather than adding to a list.
    acceptedAnswerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeAnswer',
      default: null,
    },
    // Task spec section 44 - denormalized so the question list/detail
    // never needs a separate `KnowledgeAnswer.countDocuments()` call per
    // question. Updated SERVER-SIDE ONLY via an atomic `$inc` at the
    // exact moment an answer is successfully created (never trusted from
    // the client, never incremented speculatively before the answer
    // document has actually been saved) - see knowledge.controller.js's
    // own `createAnswer`.
    answerCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Task spec section 36 - optional, best-effort, never prioritized
    // over core functionality. Incremented via a single atomic `$inc` on
    // GET .../questions/:questionId (see knowledge.controller.js's own
    // `getQuestion`) - fire-and-forget, its own failure can never affect
    // the primary read response.
    viewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// Task spec section 48 - exactly the query shapes this feature's own list
// endpoint actually runs: "this Organization's questions, newest/oldest
// first" (the default), "...filtered by status", and "...filtered by
// category". No separate title/content text index is added - `q` search
// (task spec section 12: search title+content, case-insensitive) is a
// regex-escaped substring scan over an already Organization-scoped result
// set, not a MongoDB full-text-search feature - the same deliberately
// simple choice DOC-74's own policy search already made ("do not
// overbuild").
knowledgeQuestionSchema.index({ organizationId: 1, createdAt: -1 });
knowledgeQuestionSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
knowledgeQuestionSchema.index({ organizationId: 1, category: 1, createdAt: -1 });

module.exports = mongoose.model('KnowledgeQuestion', knowledgeQuestionSchema);
module.exports.KNOWLEDGE_CATEGORIES = KNOWLEDGE_CATEGORIES;
