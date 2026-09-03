import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { requestApi } from '../services/api.js';
import StarRating from './StarRating.jsx';

const MAX_COMMENT_LENGTH = 500;

// DOC-68 - "Employee Satisfaction Rating". Self-contained, exactly like
// RequestActivityTimeline.jsx (that file's own comment explains the
// pattern in full): it reads `token` from `useAuth()` and talks to the
// backend itself, so it can be dropped into RequestRow.jsx with a single
// prop (`requestId`) and zero new plumbing through Dashboard.jsx. Fetches
// once when it mounts - i.e. the moment the row's own "View Details"
// expansion actually renders this component (it is only ever rendered at
// all when the caller has already gated on `viewerRole === 'employee' &&
// request.status === 'closed'` - see RequestRow.jsx's own call site).
//
// GET /api/requests/:id/rating returns `{ status: 'success', data: null }`
// (never a 404) when the Employee has not rated this Request yet - that is
// the normal "show the form" case, not an error. Once a rating exists it is
// immutable (task spec section 14 - no PATCH/DELETE route exists at all),
// so after a successful POST this component simply swaps the form out for
// the same read-only "Your Rating" display a page refresh would also show
// (task spec section 15: persists correctly across revisits, no full page
// reload needed to see it appear).
//
// DECISION (documented here, not only in the final report): no "Rated
// ★★★★★" indicator is added to the COLLAPSED row. Showing one there would
// require either (a) a per-row GET /api/requests/:id/rating call for every
// closed Request in the list - the exact N+1 pattern this codebase
// deliberately avoids everywhere else (see RequestActivityTimeline.jsx's
// and request.controller.js's own batch-fetch comments) - or (b) enriching
// the existing GET /api/requests list response, a larger, riskier change
// to an endpoint far outside this ticket's scope (echoing RequestRow.jsx's
// own DOC-16 comment on exactly this tradeoff). The rating (or the option
// to add one) is therefore only ever shown in the expanded detail panel -
// which already matches how Comments and Activity on this same row work
// (never previewed collapsed either), and matches the task spec's own
// explicit instruction for the Manager side ("sees rating only in expanded
// details or dedicated panel").
function RequestRatingSection({ requestId }) {
  const { token } = useAuth();
  const [rating, setRating] = useState(undefined); // undefined = not loaded yet, null = loaded, not rated
  const [loadError, setLoadError] = useState('');

  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const [submitPending, setSubmitPending] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRating(undefined);
    setLoadError('');

    if (!requestId || !token) {
      return undefined;
    }

    (async () => {
      try {
        const response = await requestApi.getMyRating(requestId, token);
        if (!cancelled) setRating(response.data);
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId, token]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitError('');

    // Client-side mirror of the backend's own authoritative validation
    // (utils/requestFieldValidation.js's validateScore/validateRatingComment)
    // - purely for a fast, friendly message; the backend re-checks
    // everything regardless and is the only real authority.
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      setSubmitError('Please select a star rating before submitting.');
      return;
    }
    const trimmedComment = comment.trim();
    if (trimmedComment.length > MAX_COMMENT_LENGTH) {
      setSubmitError(`Comment must be at most ${MAX_COMMENT_LENGTH} characters.`);
      return;
    }

    setSubmitPending(true);
    try {
      const response = await requestApi.submitRating(
        requestId,
        { score, comment: trimmedComment || null },
        token,
      );
      // Swap straight to the "Your Rating" display using the backend's own
      // response - never a locally guessed object (no fake success), and
      // with no full page reload (task spec section 15).
      setRating(response.data);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitPending(false);
    }
  };

  if (rating === undefined && !loadError) {
    return (
      <div className="request-rating">
        <span className="stat-label">Service Rating</span>
        <p className="auth-subtitle">Loading rating...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="request-rating">
        <span className="stat-label">Service Rating</span>
        <p className="form-error form-error-server">{loadError}</p>
      </div>
    );
  }

  // Already rated - a read-only, immutable display (task spec section 14
  // - no edit/delete affordance exists anywhere in this UI, matching the
  // backend having no route for it).
  if (rating) {
    return (
      <div className="request-rating">
        <span className="stat-label">Service Rating</span>
        <div className="request-rating-submitted">
          <StarRating value={rating.score} />
          {rating.comment && <p className="request-rating-comment">{rating.comment}</p>}
        </div>
      </div>
    );
  }

  // Not yet rated - the "Rate Service" form (task spec section 15).
  return (
    <div className="request-rating">
      <span className="stat-label">Service Rating</span>
      <form className="request-rating-form" onSubmit={handleSubmit}>
        <StarRating value={score} onChange={setScore} />
        <textarea
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder="Optional feedback (max 500 characters)..."
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={submitPending}
        />
        {submitError && <span className="form-error">{submitError}</span>}
        <div className="form-actions form-actions-row">
          <button type="submit" className="btn btn-primary" disabled={submitPending}>
            {submitPending ? 'Submitting...' : 'Rate Service'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default RequestRatingSection;
