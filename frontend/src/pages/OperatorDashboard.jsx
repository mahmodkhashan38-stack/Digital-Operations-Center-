import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, requestApi, commentApi, serviceCategoryApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import RequestRow from '../components/RequestRow.jsx';
import RequestSearchControls from '../components/RequestSearchControls.jsx';
import StatBreakdownList from '../components/StatBreakdownList.jsx';

// DOC-54 - Operator gets no Operator/Requester/date-range filters (task
// spec: "No Operator filter. No creator override. No unassigned filter.")
// - only text search, status, priority, category, and sort.
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

// Operator's dedicated Work Management dashboard (DOC-42, completed by
// DOC-52). Previously Operator shared the generic /dashboard placeholder
// with Employee; this is its own route (/operator). Until DOC-52, every
// Request-related section here was a structural placeholder - there was
// no Manager->Operator assignment anywhere in the backend, so an Operator
// had no legitimate way to be shown any real Request at all (see the
// DOC-48/51/52 audit that preceded this task). DOC-52 replaces every
// placeholder with the real thing:
//   - GET /api/requests/assigned (new, Operator-only, scoped to BOTH
//     assignedOperatorId === this Operator AND organizationId - never a
//     broader list filtered client-side, task spec section 17) drives
//     both the stat cards and the table below.
//   - Each row reuses RequestRow.jsx (the exact same component the
//     Employee Dashboard already uses for DOC-11/12/13/45/46) with
//     `viewerRole="operator"` - this swaps only which status-transition
//     buttons are offered (Start Work / Mark Resolved / Resume Work,
//     reusing DOC-12's PATCH /api/requests/:id/status unchanged - task
//     spec section 10). Edit Request/Cancel Request/Add Images/Remove
//     Image never appear here at all, simply because
//     onUpdateRequest/onCancelRequest/onAddAttachments/onRemoveAttachment
//     are never passed in from this page (task spec section 12: Operator
//     may only view/download attachments, never remove one).
function OperatorDashboard() {
  const { user, token } = useAuth();

  // Organization context (name only) - fetched the same secure way the
  // Manager Dashboard gets its own Organization: GET /api/organizations/me,
  // which the backend derives exclusively from req.user.organizationId.
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

  // --- Assigned Requests (DOC-52) -----------------------------------------
  const [requests, setRequests] = useState(null); // null = not loaded yet
  const [requestsError, setRequestsError] = useState('');

  // DOC-54 - search/filter/sort state, owned by this page.
  const [requestFilters, setRequestFilters] = useState(DEFAULT_REQUEST_FILTERS);

  const loadRequests = useCallback(async (filters) => {
    setRequestsError('');
    try {
      const response = await requestApi.getAssigned(token, filters);
      setRequests(response.data);
    } catch (error) {
      // Previously-loaded list is left exactly as it was on a failed
      // (re)load - e.g. an invalid filter combination - never cleared.
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

  // --- Categories (DOC-54 filter dropdown only - Operator has no other
  // use for this list) --------------------------------------------------
  // GET /api/service-categories/available is open to any authenticated
  // Organization member, not just Employee (see
  // backend/src/routes/serviceCategory.routes.js) - the Employee Dashboard
  // already uses this same endpoint for its "Open New Request" category
  // selector.
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await serviceCategoryApi.listAvailable(token);
        if (!cancelled) setCategories(response.data);
      } catch (error) {
        // Non-fatal: the category filter dropdown simply stays empty
        // (search/status/priority/sort remain fully usable) - this never
        // blocks the Operator's actual assigned-Requests list from
        // loading or working.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // DOC-12, reused unchanged: the Operator's three legal transitions
  // (open->in_progress, in_progress->resolved, reopened->in_progress),
  // each offered by RequestRow only when the Request's CURRENT status
  // actually allows it (see RequestRow.jsx's `statusActions`). Refreshes
  // the real list on success rather than guessing the new status
  // client-side.
  const handleUpdateRequestStatus = async (targetRequest, nextStatus) => {
    await requestApi.updateStatus(targetRequest.id, nextStatus, token);
    // DOC-54: re-run with the CURRENTLY active filters, not an unfiltered
    // reload - a status change must not silently reset whatever the
    // Operator was searching/filtering for.
    await loadRequests(requestFilters);
    // DOC-53: start work / resolve / resume reopened all move a Request
    // between status buckets (task spec: refresh after "start work",
    // "resolve", "resume reopened Request").
    loadStats();
  };

  // DOC-13, reused unchanged: comments are loaded lazily, only when a row
  // is expanded, and only for that one Request. The backend's own
  // canReadRequestComments/canWriteRequestComments already allow the
  // assigned Operator - this was already implemented, just unreachable
  // until a Request could ever actually be assigned to anyone.
  const handleLoadComments = async (requestId) => {
    const response = await commentApi.list(requestId, token);
    return response.data;
  };

  const handleAddComment = async (requestId, content) => {
    const response = await commentApi.create(requestId, content, token);
    return response.data;
  };

  // DOC-56 - "Operator Completion Proof Images". Same row-owns-pending/
  // error-UI, parent-owns-network-and-refetch split every other mutating
  // Request action in this project already uses. Refreshes the real list
  // (preserving whatever filters are currently active, same as
  // handleUpdateRequestStatus above) rather than guessing the new
  // completionAttachments array client-side. Deliberately does NOT call
  // loadStats() - adding/removing a completion image never changes
  // totals/byStatus/byPriority/byCategory (DOC-53's statistics shape has
  // no notion of attachment counts at all).
  const handleAddCompletionImages = async (targetRequest, formData) => {
    await requestApi.addCompletionImages(targetRequest.id, formData, token);
    await loadRequests(requestFilters);
  };

  const handleRemoveCompletionImage = async (targetRequest, attachmentId) => {
    await requestApi.removeCompletionImage(targetRequest.id, attachmentId, token);
    await loadRequests(requestFilters);
  };

  // --- Dashboard Statistics (DOC-53) --------------------------------------
  // DELIBERATELY independent of `requests`/`requestFilters` above - see
  // ManagerDashboard.jsx's identical comment for the full reasoning. This
  // replaces the old `requestCounts` useMemo, which was derived from the
  // same `requests` state the DOC-54 search/filter controls drive - a
  // filtered search would previously also shrink these cards, which this
  // task fixes.
  const [stats, setStats] = useState(null); // null = not loaded yet
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    setStatsError('');
    try {
      const response = await requestApi.getAssignedStatistics(token);
      setStats(response.data);
    } catch (error) {
      setStatsError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const subtitle = organization
    ? `Signed in as ${user?.fullName || user?.email} - ${organization.name}`
    : `Signed in as ${user?.fullName || user?.email}${orgError ? '' : ' - loading organization...'}`;

  return (
    <section className="page operator-page">
      <div className="operator-shell">
        <DashboardHeader title="Operator Dashboard" subtitle={subtitle} />

        {orgError && <p className="form-error form-error-server">{orgError}</p>}

        {/* DOC-53 - independent statistics fetch (GET
            /api/requests/statistics/assigned), never derived from the
            possibly-filtered `requests` list below. Loading placeholders
            instead of misleading zeroes while `stats` is still null. */}
        <div className="dashboard-stats">
          <StatCard label="Total Assigned" value={stats?.totals.total} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Open" value={stats?.totals.open} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="In Progress" value={stats?.totals.inProgress} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Resolved" value={stats?.totals.resolved} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Reopened" value={stats?.totals.reopened} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="High Priority" value={stats?.totals.highPriority} placeholder={!stats ? 'Loading...' : undefined} />
          {/* DOC-55 - "Request SLA and Due Dates" - Operator gets two SLA
              cards (task spec: "My Overdue Requests, My Due Soon
              Requests"), already scoped to only this Operator's assigned
              Requests by the backend (see getAssignedRequestStatistics). */}
          <StatCard label="Overdue" value={stats?.sla?.overdueCount} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Due Soon" value={stats?.sla?.dueSoonCount} placeholder={!stats ? 'Loading...' : undefined} />
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

        {stats && (
          <StatBreakdownList
            title="Requests by Category"
            items={stats.byCategory.map((entry) => ({ label: entry.category.name, count: entry.count }))}
            emptyMessage="No assigned requests reference any category yet."
          />
        )}

        <div className="admin-section-header">
          <h2>Assigned Requests</h2>
        </div>

        {/* DOC-54 - text search, status, priority, category, sort - no
            Operator filter, no creator override, no unassigned filter
            (task spec: Operator must still see only assigned Requests). */}
        <RequestSearchControls
          filters={requestFilters}
          onFilterChange={handleFilterChange}
          onClear={handleClearFilters}
          categories={categories}
        />

        {requests === null && !requestsError && (
          <div className="card admin-panel">
            <p className="auth-subtitle">Loading your assigned requests...</p>
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
                : 'No requests are currently assigned to you.'
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
                      viewerRole="operator"
                      onUpdateStatus={handleUpdateRequestStatus}
                      onLoadComments={handleLoadComments}
                      onAddComment={handleAddComment}
                      onAddCompletionImages={handleAddCompletionImages}
                      onRemoveCompletionImage={handleRemoveCompletionImage}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default OperatorDashboard;
