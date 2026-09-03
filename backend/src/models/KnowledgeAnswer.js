const mongoose = require('mongoose');
const { ANSWER_CONTENT_MIN_LENGTH, ANSWER_CONTENT_MAX_LENGTH } = require('../utils/knowledgeFieldValidation');

// DOC-75 - "Organization Q&A / Knowledge Board" - answers.
// -----------------------------------------------------------------------
// A DEDICATED, separate collection - one row per answer, never embedded
// inside KnowledgeQuestion (see that model's own top comment for the full
// "unbounded child data lives in its own collection" reasoning). Both
// `questionId` and `organizationId` are stored directly on every answer
// (denormalized from the already-authorized parent question at answer-
// creation time) so every answer-scoped lookup can be a single flat query
// - `{_id: answerId, questionId, organizationId}` - rather than a
// `.populate()` or a second round trip (task spec section 41 - "ANSWER
// IDOR... Use scoped relationship: answer._id, questionId,
// organizationId - all must match").
//
// PLAIN TEXT ONLY - identical contract to KnowledgeQuestion.content (see
// that model's own top comment) - `content` is never HTML-stripped/
// escaped at write time because the frontend never renders it via
// dangerouslySetInnerHTML/innerHTML.
//
// NO SOFT-DELETE FIELD (task spec section 23 - "Avoid hard deletes if not
// needed. Prefer: no delete in first version." DECISION, documented: this
// first version implements NO delete of any kind, not even soft-delete -
// there is no `routes/knowledge.routes.js` DELETE route for an answer or
// a question anywhere in this ticket. Persistent organizational knowledge
// is not expected to disappear casually, and no requirement in this
// ticket calls for removing a question or answer once posted - editing
// (title/content/category, or an answer's own content) is the only
// content-mutation path this version supports.
const knowledgeAnswerSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeQuestion',
      required: true,
      index: true,
    },
    // Task spec section 39-equivalent for answers - always req.user.userId
    // at creation time, never accepted from req.body (task spec section
    // 15: "Server derives: authorId").
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      minlength: [ANSWER_CONTENT_MIN_LENGTH, `content must be at least ${ANSWER_CONTENT_MIN_LENGTH} characters.`],
      maxlength: [ANSWER_CONTENT_MAX_LENGTH, `content must be at most ${ANSWER_CONTENT_MAX_LENGTH} characters.`],
    },
  },
  { timestamps: true },
);

// Task spec section 48 - the one real query shape this feature's answer-
// list endpoint runs: "every answer for this question, in this
// Organization, oldest first" (task spec section 14: "Sort: oldest first
// is natural for discussion").
knowledgeAnswerSchema.index({ organizationId: 1, questionId: 1, createdAt: 1 });

module.exports = mongoose.model('KnowledgeAnswer', knowledgeAnswerSchema);
