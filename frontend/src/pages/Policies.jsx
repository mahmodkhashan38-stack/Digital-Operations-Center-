import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { policyApi } from '../services/api.js';
import EmptyState from '../components/EmptyState.jsx';

// DOC-74 - "Organization Policies & Guidelines". A single shared page for
// all three allowed roles (task spec: implicit in "backend decides
// visibility... one page, role-aware rendering" - the exact same
// established precedent OrganizationChat.jsx (/chat) and Messages.jsx
// (/messages) already use), rather than a new ManagerDashboard.jsx
// section - the read-only audit found that file already extremely large
// with many inline sections, and extending it further was judged
// higher-risk than following this project's own proven pattern.
//
// PLAIN TEXT ONLY (task spec section 4 - CRITICAL). `content` below is
// ALWAYS rendered as ordinary React text (`{value}`), NEVER via
// `dangerouslySetInnerHTML`/`innerHTML` - a policy containing
// `<script>...</script>` displays as harmless literal text, never
// executes. Line breaks are preserved via CSS `white-space: pre-wrap`
// (see index.css's own `.policy-detail-content`), never manual `<br>`
// injection - the exact "storage is honest, rendering is safe" contract
// utils/policyFieldValidation.js's own top comment documents.
//
// BACKEND DECIDES VISIBILITY (task spec section 11) - this component never
// filters/hides a policy itself; `policyApi.list`/`policyApi.get` already
// return exactly what the caller's role is allowed to see (Manager: any
// status; Employee/Operator: published+active only).
const CATEGORY_OPTIONS = ['GENERAL', 'SECURITY', 'IT', 'SAFETY', 'HR', 'OPERATIONS', 'OTHER'];
const TITLE_MAX_LENGTH = 150;
const CONTENT_MAX_LENGTH = 10000;

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function CategoryBadge({ category }) {
  if (!category) return null;
  return <span className="status-badge policy-category-badge">{category}</span>;
}

function PublishBadge({ isPublished }) {
  return (
    <span className={isPublished ? 'status-badge status-active' : 'status-badge status-inactive'}>
      {isPublished ? 'Published' : 'Draft'}
    </span>
  );
}

function Policies() {
  const { user, token } = useAuth();
  const isManager = user?.role === 'manager';

  // --- List --------------------------------------------------------
  const [policies, setPolicies] = useState(null); // null = not loaded yet
  const [listError, setListError] = useState('');

  // --- Detail (Employee/Operator read view, and Manager's own read view
  // when not editing) -------------------------------------------------
  const [selectedPolicyId, setSelectedPolicyId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [acknowledgePending, setAcknowledgePending] = useState(false);

  // --- Manager create/edit form ---------------------------------------
  const [formMode, setFormMode] = useState(null); // null | 'create' | 'edit'
  const [formValues, setFormValues] = useState({
    title: '', category: 'GENERAL', content: '', isPublished: false,
  });
  const [formErrors, setFormErrors] = useState({});
  const [formServerError, setFormServerError] = useState('');
  const [formPending, setFormPending] = useState(false);

  // --- Manager acknowledgement inspection panel -----------------------
  const [ackPanelPolicyId, setAckPanelPolicyId] = useState(null);
  const [ackDetail, setAckDetail] = useState(null);
  const [ackError, setAckError] = useState('');
  const [ackLoading, setAckLoading] = useState(false);

  const loadPolicies = useCallback(async () => {
    setListError('');
    try {
      const response = await policyApi.list(token);
      setPolicies(response.data);
    } catch (error) {
      setListError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  const loadDetail = useCallback(async (policyId) => {
    setDetailLoading(true);
    setDetailError('');
    try {
      const response = await policyApi.get(policyId, token);
      setDetail(response.data);
    } catch (error) {
      setDetailError(error.message);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [token]);

  const handleSelectPolicy = (policyId) => {
    setFormMode(null);
    setAckPanelPolicyId(null);
    setSelectedPolicyId(policyId);
    loadDetail(policyId);
  };

  // Task spec section 20 - "I Have Read and Understand This Policy" -
  // deliberately NOT "I legally agree" wording (task spec: "avoid
  // language implying legal consent beyond what is recorded").
  const handleAcknowledge = async () => {
    if (!detail) return;
    setAcknowledgePending(true);
    try {
      const response = await policyApi.acknowledge(detail.id, token);
      setDetail((prev) => (prev ? { ...prev, myAcknowledgement: response.data } : prev));
    } catch (error) {
      setDetailError(error.message);
    } finally {
      setAcknowledgePending(false);
    }
  };

  // ---- Manager: create/edit form -------------------------------------
  const openCreateForm = () => {
    setSelectedPolicyId(null);
    setDetail(null);
    setAckPanelPolicyId(null);
    setFormMode('create');
    setFormValues({
      title: '', category: 'GENERAL', content: '', isPublished: false,
    });
    setFormErrors({});
    setFormServerError('');
  };

  const openEditForm = async (policy) => {
    setSelectedPolicyId(policy.id);
    setDetail(null);
    setAckPanelPolicyId(null);
    setFormMode('edit');
    setFormErrors({});
    setFormServerError('');
    // Task spec: the list view never carries full `content` (only the
    // detail endpoint does - see policy.controller.js's own
    // sanitizePolicySummary vs. sanitizePolicyDetail) - fetch it fresh so
    // the editor always starts from the real, current stored text.
    setFormValues({
      title: policy.title, category: policy.category, content: '', isPublished: policy.isPublished,
    });
    try {
      const response = await policyApi.get(policy.id, token);
      setFormValues({
        title: response.data.title,
        category: response.data.category,
        content: response.data.content,
        isPublished: response.data.isPublished,
      });
    } catch (error) {
      setFormServerError(error.message);
    }
  };

  const closeForm = () => {
    setFormMode(null);
    setFormErrors({});
    setFormServerError('');
  };

  const handleFormChange = (event) => {
    const { name, value, type, checked } = event.target;
    setFormValues((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  function validateForm(values) {
    const errors = {};
    const trimmedTitle = values.title.trim();
    if (!trimmedTitle) {
      errors.title = 'Title is required.';
    } else if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      errors.title = `Title must be at most ${TITLE_MAX_LENGTH} characters.`;
    }
    const trimmedContent = values.content.trim();
    if (!trimmedContent) {
      errors.content = 'Content is required.';
    } else if (trimmedContent.length > CONTENT_MAX_LENGTH) {
      errors.content = `Content must be at most ${CONTENT_MAX_LENGTH} characters.`;
    }
    return errors;
  }

  const handleFormSubmit = async (event) => {
    event.preventDefault();
    const errors = validateForm(formValues);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setFormPending(true);
    setFormServerError('');
    const payload = {
      title: formValues.title.trim(),
      content: formValues.content.trim(),
      category: formValues.category,
      isPublished: formValues.isPublished,
    };
    try {
      if (formMode === 'create') {
        await policyApi.create(payload, token);
      } else if (formMode === 'edit' && selectedPolicyId) {
        await policyApi.update(selectedPolicyId, payload, token);
      }
      setFormMode(null);
      setSelectedPolicyId(null);
      await loadPolicies();
    } catch (error) {
      setFormServerError(error.message);
    } finally {
      setFormPending(false);
    }
  };

  // ---- Manager: publish/unpublish + archive --------------------------
  const handleTogglePublish = async (policy) => {
    setListError('');
    try {
      await policyApi.update(policy.id, { isPublished: !policy.isPublished }, token);
      await loadPolicies();
      if (selectedPolicyId === policy.id) {
        loadDetail(policy.id);
      }
    } catch (error) {
      setListError(error.message);
    }
  };

  // Task spec section 9/29 - soft-archive only, no hard delete anywhere in
  // this UI (there is no corresponding backend endpoint either).
  const handleArchive = async (policy) => {
    const confirmed = window.confirm(
      `Archive "${policy.title}"? Employees/Operators will no longer see it in their active policy list. This can be inspected later but not undone from here.`,
    );
    if (!confirmed) return;
    setListError('');
    try {
      await policyApi.archive(policy.id, token);
      await loadPolicies();
      if (selectedPolicyId === policy.id) {
        loadDetail(policy.id);
      }
    } catch (error) {
      setListError(error.message);
    }
  };

  // ---- Manager: acknowledgement inspection ---------------------------
  const handleViewAcknowledgements = async (policyId) => {
    setFormMode(null);
    setSelectedPolicyId(null);
    setAckPanelPolicyId(policyId);
    setAckError('');
    setAckDetail(null);
    setAckLoading(true);
    try {
      const response = await policyApi.getAcknowledgements(policyId, token);
      setAckDetail(response.data);
    } catch (error) {
      setAckError(error.message);
    } finally {
      setAckLoading(false);
    }
  };

  const renderManagerActions = (policy) => (
    <div className="policy-row-actions">
      <button type="button" className="btn btn-outline btn-small" onClick={() => openEditForm(policy)}>
        Edit
      </button>
      <button type="button" className="btn btn-outline btn-small" onClick={() => handleTogglePublish(policy)}>
        {policy.isPublished ? 'Unpublish' : 'Publish'}
      </button>
      {policy.status !== 'ARCHIVED' && (
        <button type="button" className="btn btn-outline btn-small" onClick={() => handleArchive(policy)}>
          Archive
        </button>
      )}
      <button type="button" className="btn btn-outline btn-small" onClick={() => handleViewAcknowledgements(policy.id)}>
        Acknowledgements
      </button>
    </div>
  );

  const renderPolicyForm = () => (
    <div className="card admin-panel policy-editor-panel">
      <h2>{formMode === 'create' ? 'Create Policy' : 'Edit Policy'}</h2>
      {/* Task spec section 21 - "policy editor is a simple form (Title,
          Category, Content textarea, Published toggle). No rich-text
          editor, no HTML toolbar." Exactly that and nothing more. */}
      <form className="policy-editor-form" onSubmit={handleFormSubmit} noValidate>
        <div className="form-group">
          <label htmlFor="policy-title">Title</label>
          <input
            id="policy-title"
            name="title"
            type="text"
            value={formValues.title}
            onChange={handleFormChange}
            disabled={formPending}
            maxLength={TITLE_MAX_LENGTH}
          />
          {formErrors.title && <p className="form-error">{formErrors.title}</p>}
        </div>

        <div className="form-group">
          <label htmlFor="policy-category">Category</label>
          <select
            id="policy-category"
            name="category"
            value={formValues.category}
            onChange={handleFormChange}
            disabled={formPending}
          >
            {CATEGORY_OPTIONS.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="policy-content">Content</label>
          <textarea
            id="policy-content"
            name="content"
            value={formValues.content}
            onChange={handleFormChange}
            disabled={formPending}
            maxLength={CONTENT_MAX_LENGTH}
            rows={12}
            placeholder="Plain text only - no HTML formatting."
          />
          <p className="field-hint">{formValues.content.trim().length} / {CONTENT_MAX_LENGTH} characters</p>
          {formErrors.content && <p className="form-error">{formErrors.content}</p>}
        </div>

        <div className="checkbox-field">
          <label htmlFor="policy-is-published">
            <input
              id="policy-is-published"
              name="isPublished"
              type="checkbox"
              checked={formValues.isPublished}
              onChange={handleFormChange}
              disabled={formPending}
            />
            {' '}Published (visible to Employees/Operators)
          </label>
        </div>

        {formServerError && <p className="form-error form-error-server">{formServerError}</p>}

        <div className="form-actions form-actions-row">
          <button type="submit" className="btn btn-primary" disabled={formPending}>
            {formPending ? 'Saving...' : 'Save Policy'}
          </button>
          <button type="button" className="btn btn-outline" onClick={closeForm} disabled={formPending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );

  const renderAcknowledgementsPanel = () => (
    <div className="card admin-panel policy-ack-panel">
      <h2>Acknowledgement Status</h2>
      {ackLoading && <p className="auth-subtitle">Loading acknowledgement status...</p>}
      {ackError && <p className="form-error form-error-server">{ackError}</p>}
      {ackDetail && !ackError && (
        <>
          {/* Task spec section 22 - "Acknowledged: 18/25" or "72%", CURRENT
              version only - never counting old-version acknowledgements
              (see policy.controller.js's own buildAcknowledgementSummaryMap/
              getPolicyAcknowledgements). */}
          <p className="policy-ack-summary">
            Acknowledged: {ackDetail.summary.acknowledgedCount}/{ackDetail.summary.totalEligible}
            {' '}({ackDetail.summary.percentage}%)
          </p>
          {ackDetail.users.length === 0 ? (
            <p className="auth-subtitle">No active Employees/Operators to acknowledge this policy yet.</p>
          ) : (
            <div className="user-table-wrapper">
              <table className="user-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Acknowledged On</th>
                  </tr>
                </thead>
                <tbody>
                  {ackDetail.users.map((row) => (
                    <tr key={row.id}>
                      <td>{row.fullName}</td>
                      <td>{row.role}</td>
                      <td>
                        <span className={row.status === 'ACKNOWLEDGED' ? 'status-badge status-active' : 'status-badge status-inactive'}>
                          {row.status === 'ACKNOWLEDGED' ? 'Acknowledged' : 'Pending'}
                        </span>
                      </td>
                      <td>{row.acknowledgedAt ? formatDate(row.acknowledgedAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-outline" onClick={() => setAckPanelPolicyId(null)}>
          Close
        </button>
      </div>
    </div>
  );

  const renderDetailPanel = () => (
    <div className="card admin-panel policy-detail-panel">
      {detailLoading && <p className="auth-subtitle">Loading policy...</p>}
      {detailError && <p className="form-error form-error-server">{detailError}</p>}
      {detail && !detailError && (
        <>
          <div className="policy-detail-header">
            <h2>{detail.title}</h2>
            <div className="policy-detail-meta">
              <CategoryBadge category={detail.category} />
              {isManager && <PublishBadge isPublished={detail.isPublished} />}
              <span className="auth-subtitle">Version {detail.version} · Updated {formatDate(detail.updatedAt)}</span>
            </div>
          </div>
          {/* CRITICAL - plain text only, never dangerouslySetInnerHTML. CSS
              `white-space: pre-wrap` (index.css) preserves the author's own
              line breaks without any HTML injection. */}
          <p className="policy-detail-content">{detail.content}</p>

          {/* Task spec section 20 - the acknowledgement action itself.
              Wording is deliberately "I have read this policy" - never
              "I legally agree" (task spec: "must not imply legal consent
              beyond what is recorded"). */}
          <div className="policy-acknowledge-row">
            {detail.myAcknowledgement ? (
              <span className="status-badge status-active">
                ✓ Acknowledged on {formatDate(detail.myAcknowledgement.acknowledgedAt)}
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAcknowledge}
                disabled={acknowledgePending || !detail.isPublished}
              >
                {acknowledgePending ? 'Saving...' : 'I Have Read and Understand This Policy'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  if (!isManager) {
    return (
      <div className="page policy-page">
        <h1>Organization Policies & Guidelines</h1>
        {policies === null && !listError && <p className="auth-subtitle">Loading policies...</p>}
        {listError && (
          <>
            <p className="form-error form-error-server">{listError}</p>
            <button type="button" className="btn btn-outline" onClick={loadPolicies}>Try Again</button>
          </>
        )}
        {policies !== null && !listError && policies.length === 0 && (
          <EmptyState
            title="No policies yet"
            message="Your organization has not published any policies yet. Check back later."
          />
        )}
        {policies !== null && !listError && policies.length > 0 && (
          <div className="policy-shell">
            <div className="policy-list">
              {policies.map((policy) => (
                <button
                  type="button"
                  key={policy.id}
                  className={selectedPolicyId === policy.id ? 'policy-list-item policy-list-item-active' : 'policy-list-item'}
                  onClick={() => handleSelectPolicy(policy.id)}
                >
                  <span className="policy-list-item-title">{policy.title}</span>
                  <span className="policy-list-item-meta">
                    <CategoryBadge category={policy.category} />
                    <span className="auth-subtitle">Updated {formatDate(policy.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="policy-detail-wrapper">
              {selectedPolicyId ? renderDetailPanel() : (
                <EmptyState title="Select a policy" message="Choose a policy from the list to read it." />
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Manager management view ---------------------------------------
  return (
    <div className="page policy-page">
      <div className="admin-section-header">
        <h1>Policies & Guidelines</h1>
        <button type="button" className="btn btn-primary" onClick={openCreateForm}>
          Create Policy
        </button>
      </div>

      {listError && (
        <>
          <p className="form-error form-error-server">{listError}</p>
          <button type="button" className="btn btn-outline" onClick={loadPolicies}>Try Again</button>
        </>
      )}

      {policies === null && !listError && <p className="auth-subtitle">Loading policies...</p>}

      {policies !== null && !listError && policies.length === 0 && formMode === null && (
        <EmptyState
          title="No policies yet"
          message="Create your organization's first policy to get started."
        />
      )}

      {policies !== null && !listError && policies.length > 0 && (
        <div className="user-table-wrapper">
          <table className="user-table policy-manager-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Version</th>
                <th>Status</th>
                <th>Last Updated</th>
                <th>Acknowledged</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>{policy.title}</td>
                  <td><CategoryBadge category={policy.category} /></td>
                  <td>{policy.version}</td>
                  <td>
                    <PublishBadge isPublished={policy.isPublished} />
                    {policy.status === 'ARCHIVED' && (
                      <span className="status-badge status-inactive">Archived</span>
                    )}
                  </td>
                  <td>{formatDate(policy.updatedAt)}</td>
                  <td>
                    {policy.acknowledgementSummary
                      ? `${policy.acknowledgementSummary.acknowledgedCount}/${policy.acknowledgementSummary.totalEligible} (${policy.acknowledgementSummary.percentage}%)`
                      : '—'}
                  </td>
                  <td>{renderManagerActions(policy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formMode && renderPolicyForm()}
      {ackPanelPolicyId && renderAcknowledgementsPanel()}
    </div>
  );
}

export default Policies;
