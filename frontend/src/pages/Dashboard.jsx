import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, serviceCategoryApi, requestApi, commentApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import RequestRow from '../components/RequestRow.jsx';
import RequestSearchControls from '../components/RequestSearchControls.jsx';
import StatBreakdownList from '../components/StatBreakdownList.jsx';
import RequestStatusBadge from '../components/RequestStatusBadge.jsx';

// DOC-54 - Employee gets no creator/Operator override (task spec: "Do not
// allow creator or Operator filtering unless merely displaying assigned
// Operator information.") - only text search, status, priority, category,
// and sort, the same reduced set Operator gets.
const DEFAULT_REQUEST_FILTERS = {
  q: '',
  status: '',
  priority: '',
  categoryId: '',
  // DOC-55 - "Request SLA and Due Dates" filter, all roles.
  slaStatus: '',
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

function hasActiveRequestFilters(filters) {
  return Boolean(filters.q || filters.status || filters.priority || filters.categoryId || filters.slaStatus);
}

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const EMPTY_REQUEST_FORM = { title: '', description: '', categoryId: '', priority: 'medium' };

// DOC-58 - same "-" fallback / toLocaleString() formatting RequestRow.jsx
// and ManagerRequestRow.jsx already use for createdAt elsewhere; this file
// had no local copy of its own yet since it never rendered a date outside
// the request table (which delegates to RequestRow instead).
function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

// DOC-45 - mirrors the backend's own limits exactly (middleware/upload.js
// / models/Request.js) so an Employee gets immediate feedback before ever
// sending a request; the backend remains the sole authority and
// re-validates independently regardless.
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGES_PER_REQUEST = 5;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

// Employee's dedicated Personal Request Management dashboard (DOC-42,
// extended by DOC-51, DOC-10, DOC-11, DOC-12, DOC-13, DOC-46). This is
// the same /dashboard route Employee has always used - what changed is
// its content (and that Operator now has its own /operator route instead
// of sharing this one). "Open New Request" (DOC-10) creates via POST
// /api/requests. "My Requests" and "Request Overview" (DOC-11) show this
// Employee's own real Requests via GET /api/requests. DOC-12 adds the
// Employee's only two legal status actions - Confirm Resolved / Problem
// Still Exists - shown ONLY on a `resolved` Request (see RequestRow.jsx);
// every other status stays strictly read-only, with no generic status
// dropdown anywhere. DOC-13 adds a comment thread inside each Request's
// expanded detail panel (loaded lazily, only when that row is opened) -
// see RequestRow.jsx. DOC-46 adds Edit Request and Cancel Request, both
// shown only while a Request is 'open' and unassigned (also in
// RequestRow.jsx) - editing reuses this same "Open New Request" category
// list (`activeCategories`, passed down as a prop) rather than a second
// category fetch. DOC-45 adds optional image attachments to both "Open
// New Request" (selected here, uploaded as part of the same FormData
// submission) and to each Request's detail panel (RequestRow.jsx owns the
// gallery + Add/Remove controls, gated on the same open+unassigned
// eligibility DOC-46 already established).
function Dashboard() {
  const { user, token } = useAuth();

  // DOC-51 "Manager Contact": basic contact info (name/email) for this
  // Employee's own Organization Manager - fetched the same secure way the
  // Manager Dashboard gets its own Organization (GET /api/organizations/me,
  // DOC-42/DOC-49), which the backend derives exclusively from
  // req.user.organizationId. No other Manager/Organization detail is
  // requested or shown here - just enough to know who to contact.
  const [organization, setOrganization] = useState(null);
  const [orgError, setOrgError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await organizationApi.getMine(token);
        if (!cancelled) setOrganization(response.data);
      } catch (error) {
        if (!cancelled) setOrgError(error.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // --- Open New Request (DOC-10) ------------------------------------------
  // Active Service Categories for this Employee's own Organization, via
  // the read-only GET /api/service-categories/available endpoint (not the
  // Manager-only management one) - loaded once on mount so the form can
  // open instantly and the "no categories" state can be detected up front.
  const [categories, setCategories] = useState(null); // null = not loaded yet
  const [categoriesError, setCategoriesError] = useState('');

  const loadCategories = useCallback(async () => {
    setCategoriesError('');
    try {
      const response = await serviceCategoryApi.listAvailable(token);
      setCategories(response.data);
    } catch (error) {
      setCategoriesError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  // --- My Requests (DOC-11) -----------------------------------------------
  // This Employee's OWN Requests only - the backend enforces that (scoped
  // by createdBy + organizationId, see GET /api/requests), this page never
  // filters a broader list client-side to fake the same guarantee.
  const [requests, setRequests] = useState(null); // null = not loaded yet
  const [requestsError, setRequestsError] = useState('');

  // DOC-54 - search/filter/sort state, owned by this page.
  const [requestFilters, setRequestFilters] = useState(DEFAULT_REQUEST_FILTERS);

  const loadRequests = useCallback(async (filters) => {
    setRequestsError('');
    try {
      const response = await requestApi.listMine(token, filters);
      setRequests(response.data);
    } catch (error) {
      // Previously-loaded list is left exactly as it was - never cleared
      // on a failed (re)load, e.g. an invalid filter combination.
      setRequestsError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadRequests(requestFilters);
  }, [loadRequests, requestFilters]);

  const handleFilterChange = (patch) => {
    setRequestFilters((prev) => ({ ...prev, ...patch }));
  };

  const handleClearFilters = () => {
    setRequestFilters(DEFAULT_REQUEST_FILTERS);
  };

  // DOC-12: the Employee's only two legal status actions ("Confirm
  // Resolved" -> closed, "Problem Still Exists" -> reopened), both only
  // ever offered by RequestRow when status === 'resolved'. This refreshes
  // the real list on success rather than guessing the new status
  // client-side - the backend's response is the only source of truth for
  // whether the transition actually happened.
  const handleUpdateRequestStatus = async (targetRequest, nextStatus) => {
    await requestApi.updateStatus(targetRequest.id, nextStatus, token);
    await loadRequests(requestFilters);
    // DOC-53: "close/reopen resolved Request" is one of the explicit
    // Employee refresh triggers (task spec) - a status change moves a
    // Request between status buckets.
    loadStats();
  };

  // DOC-13: comments are loaded lazily, only when a Request row is actually
  // expanded (RequestRow.jsx), and only ever for that one Request - never
  // upfront for the whole "My Requests" list. Both calls simply forward to
  // the real backend and return its response; RequestRow owns its own
  // loading/error/pending UI state around these two calls, this page only
  // owns the token/network access, matching the same split `onUpdateStatus`
  // already uses.
  const handleLoadComments = async (requestId) => {
    const response = await commentApi.list(requestId, token);
    return response.data;
  };

  const handleAddComment = async (requestId, content) => {
    const response = await commentApi.create(requestId, content, token);
    return response.data;
  };

  // DOC-46: Edit and Cancel, both only ever offered by RequestRow while a
  // Request is 'open' and unassigned. Same "row owns pending/error UI,
  // parent owns the real network call + refresh" split every other
  // Request action on this page already uses - the backend's response
  // (and the subsequent real refetch) is the only source of truth for
  // whether the edit/cancellation actually happened.
  const handleUpdateRequest = async (targetRequest, updates) => {
    await requestApi.updateMine(targetRequest.id, updates, token);
    await loadRequests(requestFilters);
    // DOC-53: not explicitly listed among the task spec's Employee
    // refresh triggers, but included for correctness - an edit can change
    // priority/categoryId, both of which directly affect the byPriority/
    // byCategory breakdown below.
    loadStats();
  };

  const handleCancelRequest = async (targetRequest) => {
    await requestApi.cancelMine(targetRequest.id, token);
    await loadRequests(requestFilters);
    // DOC-53: "cancel Request" is an explicit Employee refresh trigger.
    loadStats();
  };

  // DOC-45: Add/remove image attachments, both only ever offered by
  // RequestRow while a Request is 'open' and unassigned (same eligibility
  // DOC-46's Edit/Cancel already use). Same split as every other Request
  // action here - RequestRow owns its own pending/error UI, this page
  // owns the token/network access and the real refetch afterward.
  const handleAddAttachments = async (targetRequest, formData) => {
    await requestApi.addAttachments(targetRequest.id, formData, token);
    await loadRequests(requestFilters);
  };

  const handleRemoveAttachment = async (targetRequest, attachmentId) => {
    await requestApi.removeAttachment(targetRequest.id, attachmentId, token);
    await loadRequests(requestFilters);
  };

  // --- Dashboard Statistics (DOC-53) --------------------------------------
  // DELIBERATELY independent of `requests`/`requestFilters` above - see
  // ManagerDashboard.jsx's identical comment for the full reasoning. This
  // replaces the old `requestCounts` useMemo, which was derived from the
  // same `requests` state the DOC-54 search/filter controls drive.
  const [stats, setStats] = useState(null); // null = not loaded yet
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    setStatsError('');
    try {
      const response = await requestApi.getMyStatistics(token);
      setStats(response.data);
    } catch (error) {
      setStatsError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestForm, setRequestForm] = useState(EMPTY_REQUEST_FORM);
  const [requestFormErrors, setRequestFormErrors] = useState({});
  const [requestSubmitError, setRequestSubmitError] = useState('');
  const [requestSubmitPending, setRequestSubmitPending] = useState(false);
  const [requestSuccessMessage, setRequestSuccessMessage] = useState('');

  // DOC-58 - "Duplicate Request Detection". `duplicateWarning` is `null`
  // when the dialog is hidden, or the backend's own `duplicates` array
  // (see request.controller.js's createRequest) while it is shown - never
  // a locally-guessed list. Set only when the initial submit comes back
  // 409 with `duplicateDetected: true` (see submitCreateRequest below);
  // cleared on a successful creation, on Cancel, or when the Employee
  // starts a brand-new "Open New Request" form.
  const [duplicateWarning, setDuplicateWarning] = useState(null);

  // DOC-45 - selected-but-not-yet-uploaded images for the "Open New
  // Request" form. Plain `File` objects only - nothing is uploaded until
  // Submit is actually pressed, and nothing here is sent anywhere on
  // selection alone.
  const [selectedImages, setSelectedImages] = useState([]);
  const [imageSelectionError, setImageSelectionError] = useState('');

  const openRequestForm = () => {
    setRequestForm(EMPTY_REQUEST_FORM);
    setRequestFormErrors({});
    setRequestSubmitError('');
    setRequestSuccessMessage('');
    setSelectedImages([]);
    setImageSelectionError('');
    setDuplicateWarning(null);
    setShowRequestForm(true);
  };

  const cancelRequestForm = () => {
    setShowRequestForm(false);
    setRequestForm(EMPTY_REQUEST_FORM);
    setRequestFormErrors({});
    setRequestSubmitError('');
    setSelectedImages([]);
    setImageSelectionError('');
    setDuplicateWarning(null);
  };

  const handleRequestFieldChange = (event) => {
    const { name, value } = event.target;
    setRequestForm((prev) => ({ ...prev, [name]: value }));
  };

  // DOC-45 - client-side gatekeeping only (reject unsupported types/
  // oversized files/too-many-files immediately, with a clear message);
  // the backend independently re-validates every one of these regardless
  // (task spec section 14). The native file input is reset after every
  // selection so choosing the same file again (e.g. after removing it)
  // re-fires this handler.
  const handleImageInputChange = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    const errors = [];
    const accepted = [];
    files.forEach((file) => {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        errors.push(`"${file.name}" is not a supported image type (JPEG, PNG, or WEBP only).`);
        return;
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        errors.push(`"${file.name}" is larger than 5 MB.`);
        return;
      }
      accepted.push(file);
    });

    setSelectedImages((prev) => {
      const combined = [...prev, ...accepted];
      if (combined.length > MAX_IMAGES_PER_REQUEST) {
        errors.push(`Only ${MAX_IMAGES_PER_REQUEST} images may be attached - the extra file(s) were not added.`);
        return combined.slice(0, MAX_IMAGES_PER_REQUEST);
      }
      return combined;
    });
    setImageSelectionError(errors.join(' '));
  };

  const removeSelectedImage = (index) => {
    setSelectedImages((prev) => prev.filter((_, i) => i !== index));
  };

  // DOC-58 - shared by both the normal form submit AND the duplicate
  // dialog's "Create Anyway" button, so the actual POST /api/requests
  // call (and its FormData-building) exists in exactly one place.
  // `forceCreate` is only ever `true` when called from "Create Anyway" -
  // the Employee already saw and explicitly dismissed the duplicate
  // warning at that point, so this skips re-validating the form fields
  // (already validated on the initial attempt; nothing about them has
  // changed since) and goes straight to resubmitting with the one extra
  // field the backend reads to skip its own duplicate check just this
  // once (task spec: "Only duplicate detection may be skipped.
  // Validation remains identical.").
  const submitCreateRequest = async (forceCreate) => {
    setRequestSubmitError('');
    setRequestSuccessMessage('');

    if (!forceCreate) {
      // Frontend catches the obvious cases for fast feedback - the
      // backend remains the sole authority and re-validates everything
      // independently (see backend/src/controllers/request.controller.js).
      const nextErrors = {};
      if (!requestForm.title.trim()) nextErrors.title = 'Title is required.';
      if (!requestForm.description.trim()) nextErrors.description = 'Description is required.';
      if (!requestForm.categoryId) nextErrors.categoryId = 'Please select a service category.';
      setRequestFormErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        return;
      }
    }

    setRequestSubmitPending(true);
    try {
      // DOC-45: always submitted as FormData now (even with zero images) -
      // organizationId, createdBy, status, and assignedOperatorId are
      // never part of this payload; the backend derives/hardcodes all of
      // those itself regardless. Every selected image is appended under
      // the same 'attachments' field name the backend expects.
      const formData = new FormData();
      formData.append('title', requestForm.title.trim());
      formData.append('description', requestForm.description.trim());
      formData.append('categoryId', requestForm.categoryId);
      formData.append('priority', requestForm.priority);
      selectedImages.forEach((file) => formData.append('attachments', file));
      // DOC-58 - only ever appended on the explicit "Create Anyway" path;
      // a normal first-attempt submission never sends this field at all.
      if (forceCreate) {
        formData.append('forceCreate', 'true');
      }

      const response = await requestApi.create(formData, token);
      setRequestSuccessMessage(`Request "${response.data.title}" was created successfully.`);
      setShowRequestForm(false);
      setRequestForm(EMPTY_REQUEST_FORM);
      setSelectedImages([]);
      setImageSelectionError('');
      setDuplicateWarning(null);
      // DOC-11: refresh from the real list endpoint rather than inserting
      // a fake local object - the freshly created Request now has a real
      // place to appear (My Requests below). DOC-54: preserves whatever
      // filters were already active rather than resetting them.
      loadRequests(requestFilters);
      // DOC-53: "create Request" is an explicit Employee refresh trigger.
      loadStats();
    } catch (error) {
      // DOC-58 - a 409 with duplicateDetected shows the confirm dialog
      // instead of a plain inline error; every other failure (validation,
      // network, server error) keeps the exact same behavior this page
      // already had. This branch can only ever be reached on the
      // NON-forced attempt - by the time `forceCreate` is true the
      // backend has already skipped duplicate detection entirely, so a
      // 409 at that point (if it somehow still happened) would fall
      // through to the plain error path below rather than looping back
      // into another confirm dialog.
      if (!forceCreate && error.status === 409 && error.data?.duplicateDetected) {
        setDuplicateWarning(error.data.duplicates || []);
      } else {
        // Nothing succeeded - no fake success message, no form reset, the
        // Employee's typed input (including selected images) stays
        // exactly as it was.
        setRequestSubmitError(error.message);
      }
    } finally {
      setRequestSubmitPending(false);
    }
  };

  const handleCreateRequest = (event) => {
    event.preventDefault();
    submitCreateRequest(false);
  };

  // DOC-58 - "Create Anyway": the Employee has seen the candidate(s) and
  // explicitly chose to proceed. Reuses the exact same form state the
  // initial attempt already validated - nothing is re-typed.
  const handleConfirmCreateAnyway = () => {
    setDuplicateWarning(null);
    submitCreateRequest(true);
  };

  const handleCancelDuplicate = () => {
    setDuplicateWarning(null);
  };

  const activeCategories = categories || [];
  const categoriesReady = categories !== null && !categoriesError;

  return (
    <section className="page dashboard-page">
      <div className="dashboard-shell">
        <DashboardHeader
          title={`My Dashboard${user?.fullName ? ` - ${user.fullName}` : ''}`}
          subtitle="Personal request management - track and open your own requests."
        />

        {/* DOC-51: Manager Contact - loading/error/success all handled
            explicitly, never a blank gap while this loads. */}
        <div className="card admin-panel">
          <h2>Manager Contact</h2>
          {organization === null && !orgError && <p className="auth-subtitle">Loading...</p>}
          {orgError && <p className="form-error form-error-server">{orgError}</p>}
          {organization && !orgError && organization.manager && (
            <div className="org-card-detail">
              <span className="stat-value">{organization.manager.fullName}</span>
              <span className="org-card-detail-sub">{organization.manager.email}</span>
            </div>
          )}
          {organization && !orgError && !organization.manager && (
            <p className="auth-subtitle">Your Organization does not have a Manager assigned yet.</p>
          )}
        </div>

        <div className="admin-section-header">
          <h2>New Request</h2>
          {!showRequestForm && (
            <button type="button" className="btn btn-primary" onClick={openRequestForm}>
              Open New Request
            </button>
          )}
        </div>
        <div className="card admin-panel">
          {requestSuccessMessage && !showRequestForm && (
            <p className="form-success">{requestSuccessMessage}</p>
          )}

          {showRequestForm && (
            <form onSubmit={handleCreateRequest} noValidate>
              <div className="form-group">
                <label htmlFor="request-title">Title</label>
                <input
                  id="request-title"
                  name="title"
                  type="text"
                  placeholder="Computer does not turn on"
                  value={requestForm.title}
                  onChange={handleRequestFieldChange}
                />
                {requestFormErrors.title && <span className="form-error">{requestFormErrors.title}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="request-category">Service Category</label>
                {!categoriesReady && !categoriesError && (
                  <p className="auth-subtitle">Loading service categories...</p>
                )}
                {categoriesError && (
                  <>
                    <p className="form-error form-error-server">{categoriesError}</p>
                    <button type="button" className="btn btn-outline" onClick={loadCategories}>
                      Try Again
                    </button>
                  </>
                )}
                {categoriesReady && activeCategories.length === 0 && (
                  <p className="auth-subtitle">
                    No active service categories are available. Your Organization Manager must create or
                    activate at least one category before requests can be opened.
                  </p>
                )}
                {categoriesReady && activeCategories.length > 0 && (
                  <select
                    id="request-category"
                    name="categoryId"
                    value={requestForm.categoryId}
                    onChange={handleRequestFieldChange}
                  >
                    <option value="">Select a category...</option>
                    {activeCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                )}
                {requestFormErrors.categoryId && <span className="form-error">{requestFormErrors.categoryId}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="request-priority">Priority</label>
                <select
                  id="request-priority"
                  name="priority"
                  value={requestForm.priority}
                  onChange={handleRequestFieldChange}
                >
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="request-description">Description</label>
                <textarea
                  id="request-description"
                  name="description"
                  rows={4}
                  placeholder="The computer in office 203 does not start."
                  value={requestForm.description}
                  onChange={handleRequestFieldChange}
                />
                {requestFormErrors.description && <span className="form-error">{requestFormErrors.description}</span>}
              </div>

              {/* DOC-45 - optional images, selected here but not uploaded
                  until Submit is pressed. Client-side checks (type/size/
                  count) give immediate feedback; the backend independently
                  re-validates everything regardless. */}
              <div className="form-group">
                <label htmlFor="request-images">Images (optional)</label>
                <input
                  id="request-images"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={handleImageInputChange}
                  disabled={selectedImages.length >= MAX_IMAGES_PER_REQUEST}
                />
                <p className="form-hint">Up to {MAX_IMAGES_PER_REQUEST} images - JPEG, PNG, or WEBP, 5 MB each.</p>
                {imageSelectionError && <span className="form-error">{imageSelectionError}</span>}
                {selectedImages.length > 0 && (
                  <ul className="selected-image-list">
                    {selectedImages.map((file, index) => (
                      <li key={`${file.name}-${index}`} className="selected-image-item">
                        <span className="selected-image-name">{file.name}</span>
                        <button type="button" className="btn btn-outline" onClick={() => removeSelectedImage(index)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {requestSubmitError && <p className="form-error form-error-server">{requestSubmitError}</p>}

              <div className="form-actions form-actions-row">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={requestSubmitPending || (categoriesReady && activeCategories.length === 0)}
                >
                  {requestSubmitPending ? 'Submitting...' : 'Submit'}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={cancelRequestForm}
                  disabled={requestSubmitPending}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {!showRequestForm && !requestSuccessMessage && (
            <p className="form-hint">Open a new request to report an issue in your organization.</p>
          )}
        </div>

        <div className="admin-section-header">
          <h2>My Requests</h2>
        </div>

        {/* DOC-54 - text search, status, priority, category, sort - no
            creator/Operator filtering (task spec: Employee must still see
            only their own Requests). Reuses the same `activeCategories`
            list already loaded for "Open New Request" above - no second
            category fetch. */}
        <RequestSearchControls
          filters={requestFilters}
          onFilterChange={handleFilterChange}
          onClear={handleClearFilters}
          categories={activeCategories}
        />

        {requests === null && !requestsError && (
          <div className="card admin-panel">
            <p className="auth-subtitle">Loading your requests...</p>
          </div>
        )}
        {requestsError && (
          <div className="card admin-panel">
            <p className="form-error form-error-server">{requestsError}</p>
            <button type="button" className="btn btn-outline" onClick={() => loadRequests(requestFilters)}>
              Try Again
            </button>
          </div>
        )}
        {requests !== null && !requestsError && requests.length === 0 && (
          <EmptyState
            message={
              hasActiveRequestFilters(requestFilters)
                ? 'No requests match the selected filters.'
                : "You haven't opened any requests yet."
            }
          />
        )}
        {requests !== null && !requestsError && requests.length > 0 && (
          <div className="card admin-panel user-section">
            <div className="user-table-wrapper">
              <table className="user-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Category</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>SLA</th>
                    <th>Created At</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((req) => (
                    <RequestRow
                      key={req.id}
                      request={req}
                      onUpdateStatus={handleUpdateRequestStatus}
                      onLoadComments={handleLoadComments}
                      onAddComment={handleAddComment}
                      onUpdateRequest={handleUpdateRequest}
                      onCancelRequest={handleCancelRequest}
                      onAddAttachments={handleAddAttachments}
                      onRemoveAttachment={handleRemoveAttachment}
                      activeCategories={activeCategories}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="admin-section-header">
          <h2>Request Overview</h2>
        </div>

        {/* DOC-53 - independent statistics fetch (GET
            /api/requests/statistics/mine), never derived from the
            possibly-filtered "My Requests" list above (task spec: "Do not
            let current search filters incorrectly change the overall
            cards."). Loading placeholders instead of misleading zeroes
            while `stats` is still null; a failure shows a small retry
            notice without touching the Request list above. */}
        <div className="dashboard-stats">
          <StatCard label="My Requests" value={stats?.totals.total} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Open" value={stats?.totals.open} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="In Progress" value={stats?.totals.inProgress} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Resolved" value={stats?.totals.resolved} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Closed" value={stats?.totals.closed} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Reopened" value={stats?.totals.reopened} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Cancelled" value={stats?.totals.cancelled} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="High Priority" value={stats?.totals.highPriority} placeholder={!stats ? 'Loading...' : undefined} />
          {/* DOC-55 - "Request SLA and Due Dates" - Employee gets exactly
              one SLA card (task spec: "My Overdue Requests"), already
              scoped to only this Employee's own Requests by the backend
              (see getMyRequestStatistics). */}
          <StatCard label="My Overdue Requests" value={stats?.sla?.overdueCount} placeholder={!stats ? 'Loading...' : undefined} />
        </div>

        {statsError && (
          <div className="card admin-panel stat-error-panel">
            <p className="form-error form-error-server">
              Statistics could not be loaded: {statsError}
            </p>
            <button type="button" className="btn btn-outline" onClick={loadStats}>
              Retry
            </button>
          </div>
        )}
      </div>

      {/* DOC-58 - Duplicate Request Detection confirm dialog. Employee
          Dashboard only (task spec: "Frontend: Employee Dashboard only") -
          this is the only place `duplicateWarning` is ever set. The
          backend never rejects outright; this is purely the Employee's own
          choice to proceed or not (task spec: "The frontend decides"). */}
      {duplicateWarning !== null && (
        <div className="modal-overlay" role="presentation" onClick={handleCancelDuplicate}>
          <div
            className="modal-panel card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="duplicate-request-heading"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="duplicate-request-heading">Similar Request Found</h2>
            <p className="auth-subtitle">
              A similar Request already exists. Do you still want to create this Request?
            </p>

            <ul className="duplicate-request-list">
              {duplicateWarning.map((duplicate) => (
                <li key={duplicate.id} className="duplicate-request-item">
                  <div className="duplicate-request-item-main">
                    <span className="stat-value">{duplicate.title}</span>
                    <RequestStatusBadge status={duplicate.status} />
                  </div>
                  <div className="duplicate-request-item-sub">
                    <span>Created {formatDateTime(duplicate.createdAt)}</span>
                    <span>by {duplicate.createdBy?.fullName || 'Unknown User'}</span>
                  </div>
                </li>
              ))}
            </ul>

            <div className="form-actions form-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmCreateAnyway}
                disabled={requestSubmitPending}
              >
                {requestSubmitPending ? 'Submitting...' : 'Create Anyway'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleCancelDuplicate}
                disabled={requestSubmitPending}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default Dashboard;
