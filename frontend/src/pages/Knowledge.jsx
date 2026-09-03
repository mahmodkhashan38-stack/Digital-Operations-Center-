import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { knowledgeApi } from '../services/api.js';
import EmptyState from '../components/EmptyState.jsx';
import Avatar from '../components/Avatar.jsx';

// DOC-75 - "Organization Q&A / Knowledge Board". A single shared page for
// all three allowed roles (the same established pattern as `/chat`,
// `/messages`, `/policies`) - Manager gets exactly two extra privileges
// (accept an answer, close/reopen a question) applied inline on the SAME
// board, never a separate Manager-only view, since Manager visibility
// here is identical to everyone else's (task spec section 49).
//
// PLAIN TEXT ONLY (task spec section 4/5/45 - CRITICAL). Question/answer
// `content` is ALWAYS rendered as ordinary React text, NEVER via
// `dangerouslySetInnerHTML`/`innerHTML` - the same "storage is honest,
// rendering is safe" contract Policies.jsx (DOC-74) already established.
// CSS `white-space: pre-wrap` preserves line breaks without HTML.
const CATEGORY_OPTIONS = ['GENERAL', 'IT', 'NETWORK', 'COMPUTERS', 'ELECTRICITY', 'PLUMBING', 'MAINTENANCE', 'SECURITY', 'HR', 'OTHER'];
const STATUS_OPTIONS = ['OPEN', 'ANSWERED', 'CLOSED'];
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'mostAnswered', label: 'Most Answered' },
];
const TITLE_MIN_LENGTH = 5;
const TITLE_MAX_LENGTH = 200;
const QUESTION_CONTENT_MIN_LENGTH = 10;
const QUESTION_CONTENT_MAX_LENGTH = 5000;
const ANSWER_CONTENT_MIN_LENGTH = 2;
const ANSWER_CONTENT_MAX_LENGTH = 5000;

// DOC-71 - "Reuse DOC-71 Avatar... avoid duplicate avatar logic" (task
// spec section 25). The backend's author-summary shape
// (sanitizeAuthorSummary, knowledge.controller.js) deliberately returns
// only `hasProfileImage` - never a pre-built URL, mirroring DOC-72/73's
// own minimalism - so this small helper builds the SAME authenticated
// content-proxy URL shape Messages.jsx's own `profileImageUrlFor` already
// establishes.
function profileImageUrlFor(author) {
  if (!author || !author.hasProfileImage || !author.id) return null;
  return `/users/${author.id}/profile-image`;
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelativeTime(value) {
  if (!value) return '';
  const target = new Date(value);
  const diffMs = Date.now() - target.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return target.toLocaleDateString();
}

function CategoryBadge({ category }) {
  if (!category) return null;
  return <span className="status-badge knowledge-category-badge">{category}</span>;
}

function StatusBadge({ status }) {
  const className = {
    OPEN: 'status-badge status-active',
    ANSWERED: 'status-badge status-active',
    CLOSED: 'status-badge status-inactive',
  }[status] || 'status-badge';
  const label = {
    OPEN: 'Open', ANSWERED: 'Answered', CLOSED: 'Closed',
  }[status] || status;
  return <span className={className}>{label}</span>;
}

function Knowledge() {
  const { user, token } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // --- List / filters ---------------------------------------------------
  const [questions, setQuestions] = useState(null); // null = not loaded yet
  const [listError, setListError] = useState('');
  const [listMeta, setListMeta] = useState({ page: 1, totalPages: 1 });
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortOption, setSortOption] = useState('newest');
  const [page, setPage] = useState(1);

  // --- Ask Question form --------------------------------------------------
  const [showAskForm, setShowAskForm] = useState(false);
  const [askValues, setAskValues] = useState({ title: '', category: 'GENERAL', content: '' });
  const [askErrors, setAskErrors] = useState({});
  const [askServerError, setAskServerError] = useState('');
  const [askPending, setAskPending] = useState(false);

  // --- Detail view -------------------------------------------------------
  const selectedQuestionId = searchParams.get('questionId') || null;
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [answers, setAnswers] = useState(null);
  const [answersError, setAnswersError] = useState('');
  const [lifecyclePending, setLifecyclePending] = useState(false);

  // --- Answer form ---------------------------------------------------------
  const [answerContent, setAnswerContent] = useState('');
  const [answerError, setAnswerError] = useState('');
  const [answerServerError, setAnswerServerError] = useState('');
  const [answerPending, setAnswerPending] = useState(false);
  const [editingAnswerId, setEditingAnswerId] = useState(null);
  const [editingAnswerContent, setEditingAnswerContent] = useState('');
  const [editingQuestion, setEditingQuestion] = useState(false);
  const [editQuestionValues, setEditQuestionValues] = useState({ title: '', category: 'GENERAL', content: '' });
  const [editQuestionErrors, setEditQuestionErrors] = useState({});

  const loadQuestions = useCallback(async () => {
    setListError('');
    try {
      const response = await knowledgeApi.listQuestions(token, {
        q: activeSearch || undefined,
        category: categoryFilter || undefined,
        status: statusFilter || undefined,
        sort: sortOption,
        page,
      });
      setQuestions(response.data);
      setListMeta(response.meta || { page: 1, totalPages: 1 });
    } catch (error) {
      setListError(error.message);
    }
  }, [token, activeSearch, categoryFilter, statusFilter, sortOption, page]);

  useEffect(() => {
    if (!selectedQuestionId) {
      loadQuestions();
    }
  }, [loadQuestions, selectedQuestionId]);

  const loadDetail = useCallback(async (questionId) => {
    setDetailLoading(true);
    setDetailError('');
    setAnswersError('');
    try {
      const [questionRes, answersRes] = await Promise.all([
        knowledgeApi.getQuestion(questionId, token),
        knowledgeApi.listAnswers(questionId, token, { limit: 50 }),
      ]);
      setDetail(questionRes.data);
      setAnswers(answersRes.data);
    } catch (error) {
      setDetailError(error.message);
      setDetail(null);
      setAnswers(null);
    } finally {
      setDetailLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (selectedQuestionId) {
      loadDetail(selectedQuestionId);
    } else {
      setDetail(null);
      setAnswers(null);
      setEditingQuestion(false);
      setEditingAnswerId(null);
    }
  }, [selectedQuestionId, loadDetail]);

  const openQuestion = (questionId) => {
    setSearchParams({ questionId });
  };

  const backToList = () => {
    setSearchParams({});
  };

  const handleSearchSubmit = (event) => {
    event.preventDefault();
    setPage(1);
    setActiveSearch(searchInput.trim());
  };

  // ---- Ask Question form ----
  function validateAsk(values) {
    const errors = {};
    const trimmedTitle = values.title.trim();
    if (trimmedTitle.length < TITLE_MIN_LENGTH || trimmedTitle.length > TITLE_MAX_LENGTH) {
      errors.title = `Title must be between ${TITLE_MIN_LENGTH} and ${TITLE_MAX_LENGTH} characters.`;
    }
    const trimmedContent = values.content.trim();
    if (trimmedContent.length < QUESTION_CONTENT_MIN_LENGTH || trimmedContent.length > QUESTION_CONTENT_MAX_LENGTH) {
      errors.content = `Question must be between ${QUESTION_CONTENT_MIN_LENGTH} and ${QUESTION_CONTENT_MAX_LENGTH} characters.`;
    }
    return errors;
  }

  const handleAskChange = (event) => {
    const { name, value } = event.target;
    setAskValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleAskSubmit = async (event) => {
    event.preventDefault();
    const errors = validateAsk(askValues);
    setAskErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setAskPending(true);
    setAskServerError('');
    try {
      const response = await knowledgeApi.createQuestion({
        title: askValues.title.trim(),
        content: askValues.content.trim(),
        category: askValues.category,
      }, token);
      setShowAskForm(false);
      setAskValues({ title: '', category: 'GENERAL', content: '' });
      openQuestion(response.data.id);
    } catch (error) {
      setAskServerError(error.message);
    } finally {
      setAskPending(false);
    }
  };

  // ---- Question edit ----
  const openEditQuestion = () => {
    if (!detail) return;
    setEditQuestionValues({ title: detail.title, category: detail.category, content: detail.content });
    setEditQuestionErrors({});
    setEditingQuestion(true);
  };

  const handleEditQuestionSubmit = async (event) => {
    event.preventDefault();
    const errors = validateAsk(editQuestionValues);
    setEditQuestionErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      const response = await knowledgeApi.updateQuestion(detail.id, {
        title: editQuestionValues.title.trim(),
        content: editQuestionValues.content.trim(),
        category: editQuestionValues.category,
      }, token);
      setDetail(response.data);
      setEditingQuestion(false);
    } catch (error) {
      setEditQuestionErrors({ form: error.message });
    }
  };

  // ---- Close / Reopen ----
  const handleClose = async () => {
    setLifecyclePending(true);
    try {
      const response = await knowledgeApi.closeQuestion(detail.id, token);
      setDetail(response.data);
    } catch (error) {
      setDetailError(error.message);
    } finally {
      setLifecyclePending(false);
    }
  };

  const handleReopen = async () => {
    setLifecyclePending(true);
    try {
      const response = await knowledgeApi.reopenQuestion(detail.id, token);
      setDetail(response.data);
    } catch (error) {
      setDetailError(error.message);
    } finally {
      setLifecyclePending(false);
    }
  };

  // ---- Answers ----
  const handleAnswerSubmit = async (event) => {
    event.preventDefault();
    const trimmed = answerContent.trim();
    if (trimmed.length < ANSWER_CONTENT_MIN_LENGTH || trimmed.length > ANSWER_CONTENT_MAX_LENGTH) {
      setAnswerError(`Answer must be between ${ANSWER_CONTENT_MIN_LENGTH} and ${ANSWER_CONTENT_MAX_LENGTH} characters.`);
      return;
    }
    setAnswerError('');
    setAnswerServerError('');
    setAnswerPending(true);
    try {
      await knowledgeApi.createAnswer(detail.id, trimmed, token);
      setAnswerContent('');
      await loadDetail(detail.id);
    } catch (error) {
      setAnswerServerError(error.message);
    } finally {
      setAnswerPending(false);
    }
  };

  const startEditAnswer = (answer) => {
    setEditingAnswerId(answer.id);
    setEditingAnswerContent(answer.content);
  };

  const handleAnswerEditSubmit = async (event, answerId) => {
    event.preventDefault();
    const trimmed = editingAnswerContent.trim();
    if (trimmed.length < ANSWER_CONTENT_MIN_LENGTH || trimmed.length > ANSWER_CONTENT_MAX_LENGTH) {
      setAnswerError(`Answer must be between ${ANSWER_CONTENT_MIN_LENGTH} and ${ANSWER_CONTENT_MAX_LENGTH} characters.`);
      return;
    }
    try {
      await knowledgeApi.updateAnswer(detail.id, answerId, trimmed, token);
      setEditingAnswerId(null);
      await loadDetail(detail.id);
    } catch (error) {
      setAnswersError(error.message);
    }
  };

  const handleAccept = async (answerId) => {
    try {
      const response = await knowledgeApi.acceptAnswer(detail.id, answerId, token);
      setDetail(response.data);
      const answersRes = await knowledgeApi.listAnswers(detail.id, token, { limit: 50 });
      setAnswers(answersRes.data);
    } catch (error) {
      setAnswersError(error.message);
    }
  };

  const handleUnaccept = async () => {
    try {
      const response = await knowledgeApi.unacceptAnswer(detail.id, token);
      setDetail(response.data);
      const answersRes = await knowledgeApi.listAnswers(detail.id, token, { limit: 50 });
      setAnswers(answersRes.data);
    } catch (error) {
      setAnswersError(error.message);
    }
  };

  const isManager = user?.role === 'manager';

  // ======================================================================
  // DETAIL VIEW
  // ======================================================================
  if (selectedQuestionId) {
    const isOwner = detail && String(detail.author.id) === String(user?.id);
    const canModerate = detail && (isOwner || isManager);
    const isClosed = detail && detail.status === 'CLOSED';

    return (
      <div className="page knowledge-page">
        <button type="button" className="btn btn-outline knowledge-back-btn" onClick={backToList}>
          ← Back to Knowledge Board
        </button>

        {detailLoading && <p className="auth-subtitle">Loading question...</p>}
        {detailError && <p className="form-error form-error-server">{detailError}</p>}

        {detail && !detailError && !editingQuestion && (
          <div className="card admin-panel knowledge-detail-panel">
            <div className="knowledge-detail-header">
              <h1>{detail.title}</h1>
              <div className="knowledge-detail-meta">
                <CategoryBadge category={detail.category} />
                <StatusBadge status={detail.status} />
                <span className="auth-subtitle">
                  Asked by {detail.author.fullName} · {formatDate(detail.createdAt)} · {detail.viewCount} views
                </span>
              </div>
            </div>
            <p className="knowledge-detail-content">{detail.content}</p>

            {canModerate && (
              <div className="knowledge-moderation-actions">
                {isOwner && !isClosed && (
                  <button type="button" className="btn btn-outline btn-small" onClick={openEditQuestion}>
                    Edit Question
                  </button>
                )}
                {!isClosed && (
                  <button type="button" className="btn btn-outline btn-small" onClick={handleClose} disabled={lifecyclePending}>
                    Close Question
                  </button>
                )}
                {isClosed && (
                  <button type="button" className="btn btn-outline btn-small" onClick={handleReopen} disabled={lifecyclePending}>
                    Reopen Question
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {detail && editingQuestion && (
          <div className="card admin-panel knowledge-editor-panel">
            <h2>Edit Question</h2>
            <form onSubmit={handleEditQuestionSubmit} noValidate>
              <div className="form-group">
                <label htmlFor="edit-q-title">Title</label>
                <input
                  id="edit-q-title"
                  value={editQuestionValues.title}
                  onChange={(e) => setEditQuestionValues((prev) => ({ ...prev, title: e.target.value }))}
                  maxLength={TITLE_MAX_LENGTH}
                />
                {editQuestionErrors.title && <p className="form-error">{editQuestionErrors.title}</p>}
              </div>
              <div className="form-group">
                <label htmlFor="edit-q-category">Category</label>
                <select
                  id="edit-q-category"
                  value={editQuestionValues.category}
                  onChange={(e) => setEditQuestionValues((prev) => ({ ...prev, category: e.target.value }))}
                >
                  {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="edit-q-content">Question</label>
                <textarea
                  id="edit-q-content"
                  rows={8}
                  value={editQuestionValues.content}
                  onChange={(e) => setEditQuestionValues((prev) => ({ ...prev, content: e.target.value }))}
                  maxLength={QUESTION_CONTENT_MAX_LENGTH}
                />
                {editQuestionErrors.content && <p className="form-error">{editQuestionErrors.content}</p>}
              </div>
              {editQuestionErrors.form && <p className="form-error form-error-server">{editQuestionErrors.form}</p>}
              <div className="form-actions form-actions-row">
                <button type="submit" className="btn btn-primary">Save Changes</button>
                <button type="button" className="btn btn-outline" onClick={() => setEditingQuestion(false)}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        <div className="knowledge-answers-section">
          <h2>Answers</h2>
          {answersError && <p className="form-error form-error-server">{answersError}</p>}
          {answers !== null && answers.length === 0 && (
            <EmptyState title="No answers yet." message="Know the answer? Help your organization." />
          )}
          {answers !== null && answers.length > 0 && (
            <ul className="knowledge-answer-list">
              {answers.map((answer) => (
                <li key={answer.id} className={answer.isAccepted ? 'knowledge-answer-item knowledge-answer-accepted' : 'knowledge-answer-item'}>
                  <div className="knowledge-answer-header">
                    <Avatar profileImageUrl={profileImageUrlFor(answer.author)} fullName={answer.author.fullName} size="small" />
                    <span className="knowledge-answer-author">{answer.author.fullName}</span>
                    <span className="auth-subtitle">{formatRelativeTime(answer.createdAt)}</span>
                    {answer.isAccepted && <span className="status-badge status-active knowledge-accepted-badge">✓ Accepted Answer</span>}
                  </div>

                  {editingAnswerId === answer.id ? (
                    <form onSubmit={(e) => handleAnswerEditSubmit(e, answer.id)} className="knowledge-answer-edit-form">
                      <textarea
                        rows={4}
                        value={editingAnswerContent}
                        onChange={(e) => setEditingAnswerContent(e.target.value)}
                        maxLength={ANSWER_CONTENT_MAX_LENGTH}
                      />
                      <div className="form-actions form-actions-row">
                        <button type="submit" className="btn btn-primary btn-small">Save</button>
                        <button type="button" className="btn btn-outline btn-small" onClick={() => setEditingAnswerId(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <p className="knowledge-answer-content">{answer.content}</p>
                  )}

                  <div className="knowledge-answer-actions">
                    {String(answer.author.id) === String(user?.id) && !isClosed && editingAnswerId !== answer.id && (
                      <button type="button" className="btn btn-outline btn-small" onClick={() => startEditAnswer(answer)}>
                        Edit
                      </button>
                    )}
                    {canModerate && !isClosed && !answer.isAccepted && (
                      <button type="button" className="btn btn-outline btn-small" onClick={() => handleAccept(answer.id)}>
                        Accept Answer
                      </button>
                    )}
                    {canModerate && !isClosed && answer.isAccepted && (
                      <button type="button" className="btn btn-outline btn-small" onClick={handleUnaccept}>
                        Remove Acceptance
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {detail && !isClosed && (
            <form className="knowledge-answer-form" onSubmit={handleAnswerSubmit}>
              <div className="form-group">
                <label htmlFor="new-answer-content">Your Answer</label>
                <textarea
                  id="new-answer-content"
                  rows={4}
                  value={answerContent}
                  onChange={(e) => setAnswerContent(e.target.value)}
                  maxLength={ANSWER_CONTENT_MAX_LENGTH}
                  placeholder="Share what you know..."
                  disabled={answerPending}
                />
                {answerError && <p className="form-error">{answerError}</p>}
              </div>
              {answerServerError && <p className="form-error form-error-server">{answerServerError}</p>}
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={answerPending}>
                  {answerPending ? 'Posting...' : 'Post Answer'}
                </button>
              </div>
            </form>
          )}
          {detail && isClosed && (
            <p className="auth-subtitle knowledge-closed-notice">This question is closed and no longer accepts new answers.</p>
          )}
        </div>
      </div>
    );
  }

  // ======================================================================
  // LIST VIEW
  // ======================================================================
  return (
    <div className="page knowledge-page">
      <div className="admin-section-header">
        <h1>Knowledge Board</h1>
        <button type="button" className="btn btn-primary" onClick={() => setShowAskForm((prev) => !prev)}>
          {showAskForm ? 'Cancel' : 'Ask Question'}
        </button>
      </div>

      {showAskForm && (
        <div className="card admin-panel knowledge-editor-panel">
          <h2>Ask a Question</h2>
          <form onSubmit={handleAskSubmit} noValidate>
            <div className="form-group">
              <label htmlFor="ask-title">Title</label>
              <input
                id="ask-title"
                name="title"
                value={askValues.title}
                onChange={handleAskChange}
                disabled={askPending}
                maxLength={TITLE_MAX_LENGTH}
                placeholder="e.g. How do I connect to the office VPN?"
              />
              {askErrors.title && <p className="form-error">{askErrors.title}</p>}
            </div>
            <div className="form-group">
              <label htmlFor="ask-category">Category</label>
              <select id="ask-category" name="category" value={askValues.category} onChange={handleAskChange} disabled={askPending}>
                {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="ask-content">Question</label>
              <textarea
                id="ask-content"
                name="content"
                rows={6}
                value={askValues.content}
                onChange={handleAskChange}
                disabled={askPending}
                maxLength={QUESTION_CONTENT_MAX_LENGTH}
                placeholder="Describe your question in detail..."
              />
              {askErrors.content && <p className="form-error">{askErrors.content}</p>}
            </div>
            {askServerError && <p className="form-error form-error-server">{askServerError}</p>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={askPending}>
                {askPending ? 'Posting...' : 'Post Question'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="knowledge-filters">
        <form className="knowledge-search-form" onSubmit={handleSearchSubmit}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search questions..."
          />
          <button type="submit" className="btn btn-outline btn-small">Search</button>
        </form>
        <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}>
          <option value="">All Categories</option>
          {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={sortOption} onChange={(e) => { setSortOption(e.target.value); setPage(1); }}>
          {SORT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>

      {listError && (
        <>
          <p className="form-error form-error-server">{listError}</p>
          <button type="button" className="btn btn-outline" onClick={loadQuestions}>Try Again</button>
        </>
      )}

      {questions === null && !listError && <p className="auth-subtitle">Loading questions...</p>}

      {questions !== null && !listError && questions.length === 0 && (
        <EmptyState title="No questions yet." message="Be the first to ask a question." />
      )}

      {questions !== null && !listError && questions.length > 0 && (
        <>
          <div className="knowledge-card-list">
            {questions.map((question) => (
              <button type="button" key={question.id} className="knowledge-card" onClick={() => openQuestion(question.id)}>
                <span className="knowledge-card-title">{question.title}</span>
                <span className="knowledge-card-meta">
                  <CategoryBadge category={question.category} />
                  <StatusBadge status={question.status} />
                  <span className="auth-subtitle">{question.answerCount} answer{question.answerCount === 1 ? '' : 's'}</span>
                </span>
                <span className="knowledge-card-footer auth-subtitle">
                  Asked by {question.author.fullName} · {formatRelativeTime(question.createdAt)}
                </span>
              </button>
            ))}
          </div>
          {listMeta.totalPages > 1 && (
            <div className="knowledge-pagination">
              <button type="button" className="btn btn-outline btn-small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </button>
              <span className="auth-subtitle">Page {listMeta.page} of {listMeta.totalPages}</span>
              <button type="button" className="btn btn-outline btn-small" disabled={page >= listMeta.totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default Knowledge;
