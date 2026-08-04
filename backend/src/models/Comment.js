const mongoose = require('mongoose');

// DOC-13 - Add Comments to a Request. A separate, referencing collection -
// NOT a field/array embedded on Request (see Request.js's own top comment,
// which reserved this exact design for DOC-13). Keeping comments in their
// own collection means GET /api/requests never has to load every comment
// for every Request just to render a list (see section 15 of the task
// spec) - comments are only ever fetched for one Request at a time, when
// its detail view is actually opened.
//
// This model deliberately does NOT include: attachment/image fields
// (DOC-45 owns those, on its own future schema), an edited/deleted flag or
// soft-delete support (DOC-13 is create + view only - no PATCH/DELETE
// endpoint exists), or any status-history/audit concept (comments never
// change a Request's status - DOC-12 remains the sole authority there).
const MIN_CONTENT_LENGTH = 1;
const MAX_CONTENT_LENGTH = 2000;

const commentSchema = new mongoose.Schema(
  {
    // Always the validated Request._id the comment was posted against -
    // resolved server-side from the URL param and an Organization-scoped
    // lookup (see controllers/comment.controller.js), never trusted from
    // the request body.
    requestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
      index: true,
    },
    // Always req.user.organizationId - the same tenant-boundary field
    // every other DOC-38-scoped collection in this project carries
    // directly on the document (Request, ServiceCategory, ...), rather
    // than only being reachable by first joining through requestId. This
    // is what lets GET .../comments query `{ requestId, organizationId }`
    // directly instead of `{ requestId }` alone (task spec section 12).
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Always req.user.userId - who wrote this comment. Never trusted from
    // the client (see controller's explicit allowlist construction).
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      minlength: [MIN_CONTENT_LENGTH, 'Comment content cannot be empty.'],
      maxlength: [MAX_CONTENT_LENGTH, `Comment content must be at most ${MAX_CONTENT_LENGTH} characters.`],
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for the actual query shape every comment-listing request
// uses: "all comments for one Request, inside one Organization, oldest
// first" (task spec section 29). requestId and organizationId already have
// their own single-field indexes above for other/defensive lookups, but
// this compound index is what actually serves GET .../comments' query +
// sort in one index scan rather than a filter-then-sort - a reasonable,
// deliberate addition at this scale (unlike DOC-11's compound-index
// question, this one directly matches the one query this feature actually
// runs, not a hypothetical future one).
commentSchema.index({ organizationId: 1, requestId: 1, createdAt: 1 });

module.exports = mongoose.model('Comment', commentSchema);
module.exports.MIN_CONTENT_LENGTH = MIN_CONTENT_LENGTH;
module.exports.MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH;
