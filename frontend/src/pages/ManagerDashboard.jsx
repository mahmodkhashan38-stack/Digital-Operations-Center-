import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, userApi, serviceCategoryApi, requestApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import OrganizationUserRow from '../components/OrganizationUserRow.jsx';
import ServiceCategoryRow from '../components/ServiceCategoryRow.jsx';
import ManagerRequestRow from '../components/ManagerRequestRow.jsx';
import RequestSearchControls from '../components/RequestSearchControls.jsx';
import StatBreakdownList from '../components/StatBreakdownList.jsx';

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  reopened: 'Reopened',
  cancelled: 'Cancelled',
};

// DOC-55 - "Request SLA and Due Dates" stat-card formatting helpers.
// `null` (never `0`) means "nothing eligible yet" (task spec: "If no
// eligible Requests exist: return null rather than a misleading 0%.") -
// both render as "N/A" here, never a fake zero.
function formatCompliancePercent(rate) {
  return rate === null || rate === undefined ? 'N/A' : `${rate}%`;
}

function formatMinutesDuration(totalMinutes) {
  if (totalMinutes === null || totalMinutes === undefined) return 'N/A';
  const minutes = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// DOC-54 - the Manager Dashboard's full filter set, including the three
// Manager-only fields (assignedOperatorId/createdBy/date range) - see
// RequestSearchControls.jsx's `showManagerFilters` prop. `sortBy`/
// `sortOrder` default to the exact same "newest first" behavior DOC-52's
// original unfiltered list already had, so a Manager who never touches
// any control sees an identical list to before this task.
const DEFAULT_REQUEST_FILTERS = {
  q: '',
  status: '',
  priority: '',
  categoryId: '',
  // DOC-55 - "Request SLA and Due Dates" filter, all roles.
  slaStatus: '',
  assignedOperatorId: '',
  createdBy: '',
  createdFrom: '',
  createdTo: '',
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

// True only when at least one actual FILTER (not a sort field) is
// currently set - used to choose between "no requests at all" and "no
// requests match the selected filters" (task spec: "Use different empty
// wording when filters are active.").
function hasActiveRequestFilters(filters) {
  return Boolean(
    filters.q || filters.status || filters.priority || filters.categoryId || filters.slaStatus
      || filters.assignedOperatorId || filters.createdBy || filters.createdFrom || filters.createdTo,
  );
}

// Renders one role group ("Employees" or "Operators") as a simple table.
// Kept inline rather than a separate file - it is a thin wrapper around
// OrganizationUserRow with no state or logic of its own, so a dedicated
// component/file would not add clarity.
function UserRoleSection({
  title,
  users,
  actionRole,
  actionLabel,
  onChangeRole,
  onUpdateProfile,
  onToggleStatus,
  emptyText,
  showSpecialties = false,
  activeCategories = [],
  categoriesReady = false,
  onUpdateSpecialties,
  onResetPassword,
}) {
  return (
    <div className="card admin-panel user-section">
      <h2>{title}</h2>
      {users.length === 0 ? (
        <p className="auth-subtitle">{emptyText}</p>
      ) : (
        <div className="user-table-wrapper">
          <table className="user-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <OrganizationUserRow
                  key={user.id}
                  user={user}
                  actionRole={actionRole}
                  actionLabel={actionLabel}
                  onChangeRole={onChangeRole}
                  onUpdateProfile={onUpdateProfile}
                  onToggleStatus={onToggleStatus}
                  showSpecialties={showSpecialties}
                  activeCategories={activeCategories}
                  categoriesReady={categoriesReady}
                  onUpdateSpecialties={onUpdateSpecialties}
                  onResetPassword={onResetPassword}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Organization Manager's dedicated, Organization-scoped dashboard
// (DOC-36, extended by DOC-42). Unlike System Admin's global Dashboard
// (DOC-37), everything here is implicitly scoped to the Manager's own
// Organization by the backend itself - GET /api/organizations/me (DOC-42),
// GET /api/users and PATCH /api/users/:id/role (DOC-35) all derive the
// tenant boundary from the authenticated Manager's own token context
// (DOC-38). This page never sends organizationId on any request, and never
// needs to. It cannot show or affect any other Organization's users or
// data, and it does not try to enforce that itself - that would be relying
// on React for security, which the backend never allows anyway.
function ManagerDashboard() {
  const { user, token } = useAuth();

  // --- Organization Information (DOC-42) ---------------------------------
  const [organization, setOrganization] = useState(null); // null = not loaded yet
  const [orgError, setOrgError] = useState('');

  const loadOrganization = useCallback(async () => {
    setOrgError('');
    try {
      const response = await organizationApi.getMine(token);
      setOrganization(response.data);
    } catch (error) {
      setOrgError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadOrganization();
  }, [loadOrganization]);

  // --- Employees / Operators (DOC-35/36) ----------------------------------
  const [users, setUsers] = useState(null); // null = not loaded yet
  const [listError, setListError] = useState('');

  const loadUsers = useCallback(async () => {
    setListError('');
    try {
      const response = await userApi.list(token);
      setUsers(response.data);
    } catch (error) {
      setListError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // Only ever called with actionRole === 'employee' or 'operator' (see
  // OrganizationUserRow) - never 'manager'/'system_admin', and
  // organizationId is never part of the payload (userApi.updateRole only
  // ever sends { role }).
  const handleChangeRole = async (targetUser, role) => {
    const response = await userApi.updateRole(targetUser.id, role, token);
    setUsers((prev) => (prev || []).map((u) => (u.id === targetUser.id ? response.data : u)));
    // DOC-53: a promote/demote changes who counts as an Employee/Operator
    // - Employee/Operator counts are derived straight from `users` above,
    // so no separate refresh is needed for THOSE, but a demotion can also
    // change which Requests are "assigned to an Operator" in the Operator
    // Workload breakdown below, so the Request statistics are refreshed
    // too, for consistency.
    loadStats();
    return response.data;
  };

  // DOC-50: fullName/email only - the backend rejects anything else sent
  // to this endpoint, and this page never sends anything else anyway.
  const handleUpdateProfile = async (targetUser, updates) => {
    const response = await userApi.updateProfile(targetUser.id, updates, token);
    setUsers((prev) => (prev || []).map((u) => (u.id === targetUser.id ? response.data : u)));
    return response.data;
  };

  // DOC-50: activate/deactivate. A deactivated Employee/Operator is
  // rejected on their very next authenticated request regardless of this
  // page (DOC-38's fresh per-request isActive check) - there is nothing
  // else this page needs to do to make deactivation "take effect".
  //
  // DOC-48: returns the FULL response (not just `response.data`) so
  // OrganizationUserRow can read the optional `warning` field the backend
  // now attaches when deactivating an Operator who still has active
  // assigned Requests (task spec section 11) - purely informational, the
  // row list itself is still updated from `response.data` exactly as
  // before.
  const handleToggleStatus = async (targetUser, nextIsActive) => {
    const response = await userApi.updateStatus(targetUser.id, nextIsActive, token);
    setUsers((prev) => (prev || []).map((u) => (u.id === targetUser.id ? response.data : u)));
    // DOC-53: deactivating an Operator changes the Operator Workload
    // breakdown's `isActive` flag for that row (task spec: refresh after
    // "activate/deactivate user").
    loadStats();
    return response;
  };

  // DOC-44: full-replacement specialty assignment - `categoryIds` is
  // always the Operator's complete desired specialty set (possibly []).
  // This never sends organizationId or role; the backend derives the
  // target's identity from the scoped :id lookup alone.
  const handleUpdateSpecialties = async (targetUser, categoryIds) => {
    const response = await userApi.updateSpecialties(targetUser.id, categoryIds, token);
    setUsers((prev) => (prev || []).map((u) => (u.id === targetUser.id ? response.data : u)));
    return response.data;
  };

  // DOC-57 - "Manager Password Reset". Same row-owns-pending/error/
  // success-UI, parent-owns-token/network-access split every other
  // mutating action on this page already uses. `payload` is always
  // exactly { newPassword, confirmPassword } (OrganizationUserRow.jsx
  // never sends anything else). The response replaces this user in
  // `users` state the same way every other user-mutation here does - its
  // `mustChangePassword` is now `true`, which is all this page needs to
  // reflect (there is no dedicated "pending password change" badge in
  // this table; the row itself never displays the new password, per task
  // spec).
  const handleResetPassword = async (targetUser, payload) => {
    const response = await userApi.resetPassword(targetUser.id, payload, token);
    setUsers((prev) => (prev || []).map((u) => (u.id === targetUser.id ? response.data : u)));
    return response.data;
  };

  // GET /api/users returns every user in the Manager's own Organization,
  // including the Manager themselves (role: 'manager') - grouping strictly
  // by role: 'employee' / role: 'operator' below is what keeps the
  // Manager's own row (and any other manager/system_admin row, though the
  // latter can never actually appear here - DOC-38) out of both sections
  // entirely, with no special-case "is this me?" check required.
  // DOC-53 - Employee/Operator Active/Inactive counts are computed here,
  // extending this ALREADY-EXISTING derivation, rather than duplicated in
  // a new backend statistics field - `users` is already the complete,
  // unfiltered Organization user list (unaffected by the DOC-54 Request
  // search/filter state below), so every number here is already exactly
  // right with no extra network call.
  const {
    employees, operators, activeEmployeeCount, inactiveEmployeeCount, activeOperatorCount, inactiveOperatorCount,
  } = useMemo(() => {
    const list = users || [];
    const employeeList = list.filter((u) => u.role === 'employee');
    const operatorList = list.filter((u) => u.role === 'operator');
    return {
      employees: employeeList,
      operators: operatorList,
      activeEmployeeCount: employeeList.filter((u) => u.isActive).length,
      inactiveEmployeeCount: employeeList.filter((u) => !u.isActive).length,
      activeOperatorCount: operatorList.filter((u) => u.isActive).length,
      inactiveOperatorCount: operatorList.filter((u) => !u.isActive).length,
    };
  }, [users]);

  const hasAnyUsers = employees.length > 0 || operators.length > 0;

  // --- Service Categories (DOC-43) ----------------------------------------
  const [categories, setCategories] = useState(null); // null = not loaded yet
  const [categoriesError, setCategoriesError] = useState('');
  const [showAddCategoryForm, setShowAddCategoryForm] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryError, setNewCategoryError] = useState('');
  const [addCategoryPending, setAddCategoryPending] = useState(false);
  // Sprint 4 - "Create Default Categories" (only offered when the
  // Organization currently has zero Categories at all, see the empty-state
  // render below).
  const [createDefaultsPending, setCreateDefaultsPending] = useState(false);
  const [createDefaultsError, setCreateDefaultsError] = useState('');

  const loadCategories = useCallback(async () => {
    setCategoriesError('');
    try {
      const response = await serviceCategoryApi.list(token);
      setCategories(response.data);
    } catch (error) {
      setCategoriesError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const handleCreateCategory = async (event) => {
    event.preventDefault();
    setNewCategoryError('');

    if (!newCategoryName.trim()) {
      setNewCategoryError('Category name is required.');
      return;
    }

    setAddCategoryPending(true);
    try {
      const response = await serviceCategoryApi.create(newCategoryName.trim(), token);
      setCategories((prev) => [...(prev || []), response.data].sort((a, b) => a.name.localeCompare(b.name)));
      setNewCategoryName('');
      setShowAddCategoryForm(false);
    } catch (error) {
      // Most commonly the backend's 409 for a duplicate normalized name
      // within this Organization - shown inline on the Add form, the
      // category list is left exactly as it was.
      setNewCategoryError(error.message);
    } finally {
      setAddCategoryPending(false);
    }
  };

  // Sprint 4 - real backend call, real refresh, no faked success: on
  // failure the category list is left exactly as it was and the error is
  // shown inline, the same pattern handleCreateCategory above already
  // uses. Safe to click more than once (the backend is idempotent).
  const handleCreateDefaultCategories = async () => {
    setCreateDefaultsError('');
    setCreateDefaultsPending(true);
    try {
      const response = await serviceCategoryApi.createDefaults(token);
      setCategories(response.data);
    } catch (error) {
      setCreateDefaultsError(error.message);
    } finally {
      setCreateDefaultsPending(false);
    }
  };

  const handleUpdateCategoryName = async (category, name) => {
    const response = await serviceCategoryApi.update(category.id, name, token);
    setCategories((prev) => (prev || []).map((c) => (c.id === category.id ? response.data : c)));
    return response.data;
  };

  const handleToggleCategoryStatus = async (category, nextIsActive) => {
    const response = await serviceCategoryApi.updateStatus(category.id, nextIsActive, token);
    setCategories((prev) => (prev || []).map((c) => (c.id === category.id ? response.data : c)));
    return response.data;
  };

  // DOC-44: only ACTIVE categories may be newly assigned as a specialty
  // (see backend/src/controllers/user.controller.js's updateUserSpecialties)
  // - the checkbox list in "Manage Specialties" only ever offers active
  // ones. `categoriesReadyForSpecialties` distinguishes "still loading"
  // from "loaded, zero active categories exist" so the row can show the
  // right message.
  const activeCategories = useMemo(
    () => (categories || []).filter((category) => category.isActive),
    [categories],
  );
  const categoriesReadyForSpecialties = categories !== null && !categoriesError;

  // --- Organization Requests (DOC-52) -------------------------------------
  // Every Request in the Manager's own Organization (GET
  // /requests/organization - NOT scoped by createdBy, unlike the
  // Employee-facing listMine) - this is the "Manager sees Organization
  // Requests" step of the workflow (task spec section 1/17).
  const [requests, setRequests] = useState(null); // null = not loaded yet
  const [requestsError, setRequestsError] = useState('');

  // DOC-54 - search/filter/sort state. Owned entirely by this page (not
  // RequestSearchControls, which only reads it and reports changes) so
  // `loadRequests` can depend on it directly and every DOC-59 action below
  // keeps using its own existing "patch the one row" refresh strategy
  // (task spec: "update the matching row safely" is one of the two
  // explicitly acceptable options) without needing to know anything about
  // filters at all.
  const [requestFilters, setRequestFilters] = useState(DEFAULT_REQUEST_FILTERS);

  const loadRequests = useCallback(async (filters) => {
    setRequestsError('');
    try {
      const response = await requestApi.listOrganization(token, filters);
      setRequests(response.data);
    } catch (error) {
      // An invalid filter combination (e.g. createdFrom after createdTo)
      // surfaces the backend's own client-safe validation message here -
      // the previously-loaded list is left exactly as it was, never
      // cleared or replaced with a fake empty result (task spec: "errors
      // do not erase existing data incorrectly").
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

  // Task spec section 2: only Operators who (a) belong to this same
  // Organization, (b) are currently active, and (c) list the Request's
  // own category among their specialties are ever offered - this is a UI
  // convenience only. The backend (assignRequestOperator) independently
  // re-enforces every one of these rules and is the sole authority
  // regardless of what this list contains.
  const activeOperators = useMemo(
    () => operators.filter((operator) => operator.isActive),
    [operators],
  );

  const eligibleOperatorsForRequest = useCallback((request) => {
    if (!request.category) return [];
    return activeOperators.filter((operator) => (operator.specialties || [])
      .some((specialty) => specialty.id === request.category.id));
  }, [activeOperators]);

  // DOC-52: "Manager assigns Request to a suitable Operator" - the row
  // owns its own pending/error UI (ManagerRequestRow), this page owns the
  // token/network access and the real refetch afterward, the same split
  // every other Request action in this project already uses.
  const handleAssignOperator = async (targetRequest, operatorId) => {
    const response = await requestApi.assignOperator(targetRequest.id, operatorId, token);
    setRequests((prev) => (prev || []).map((r) => (r.id === targetRequest.id ? response.data : r)));
    // DOC-53: assignment changes `totals.unassigned` and the Operator
    // Workload breakdown (task spec: refresh after "assign/reassign/
    // unassign").
    loadStats();
    return response.data;
  };

  // Sprint 4 (DOC-59) - "Manager Request Administration". Same row-owns-
  // pending/error-UI, parent-owns-network-and-refetch split every other
  // mutating Request action in this project already uses: the row calls
  // one of these, the real server response (never a locally-faked one)
  // replaces that Request in `requests` state, so the list is always
  // showing exactly what the backend just confirmed.
  const handleManagerUpdateRequest = async (targetRequest, updates) => {
    const response = await requestApi.managerUpdate(targetRequest.id, updates, token);
    setRequests((prev) => (prev || []).map((r) => (r.id === targetRequest.id ? response.data : r)));
    // DOC-53: priority/category/operator edits can move a Request between
    // status/priority/category/operator buckets (task spec: refresh after
    // "edit priority/category").
    loadStats();
    return response.data;
  };

  const handleManagerCancelRequest = async (targetRequest, reason) => {
    const response = await requestApi.managerCancel(targetRequest.id, reason, token);
    setRequests((prev) => (prev || []).map((r) => (r.id === targetRequest.id ? response.data : r)));
    loadStats();
    return response.data;
  };

  const handleManagerCloseRequest = async (targetRequest) => {
    const response = await requestApi.managerClose(targetRequest.id, token);
    setRequests((prev) => (prev || []).map((r) => (r.id === targetRequest.id ? response.data : r)));
    loadStats();
    return response.data;
  };

  // --- Dashboard Statistics (DOC-53) --------------------------------------
  // DELIBERATELY independent of `requests`/`requestFilters` above - task
  // spec: "Dashboard statistics are based on the role's full authorized
  // scope... They should NOT automatically change based on every DOC-54
  // search/filter control." Before this task, the stat cards were derived
  // from the SAME `requests` state the DOC-54 search/filter controls also
  // drive, which meant a Manager filtering the list down to (say) one
  // Category would also see the Organization Overview cards silently
  // shrink to match - a bug this task fixes by giving statistics their own
  // dedicated fetch, calling the new GET /api/requests/statistics/
  // organization endpoint (never a client-side reduction over the
  // possibly-filtered `requests` array).
  const [stats, setStats] = useState(null); // null = not loaded yet
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    setStatsError('');
    try {
      const response = await requestApi.getOrganizationStatistics(token);
      setStats(response.data);
    } catch (error) {
      // A statistics failure must never make the rest of the Dashboard
      // unusable (task spec) - `stats` is simply left at its last-known
      // value (or null), the Request list/users/categories sections above
      // continue working normally regardless.
      setStatsError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <section className="page manager-page">
      <div className="manager-shell">
        <DashboardHeader
          title="Organization Management"
          subtitle={`Signed in as ${user?.fullName || user?.email} - manage Employees and Operators in your Organization.`}
        />

        {/* --- Organization Information (DOC-42) -------------------------
            Name/Company Code/Status come exclusively from GET
            /api/organizations/me, which the backend derives from
            req.user.organizationId - this page never sends an
            organizationId to choose which Organization to retrieve. The
            Company Code is shown because the Manager is the one who hands
            it to employees who need to register. */}
        <div className="card admin-panel org-info-panel">
          <h2>Organization Information</h2>
          {organization === null && !orgError && (
            <p className="auth-subtitle">Loading organization information...</p>
          )}
          {orgError && (
            <>
              <p className="form-error form-error-server">{orgError}</p>
              <button type="button" className="btn btn-outline" onClick={loadOrganization}>
                Try Again
              </button>
            </>
          )}
          {organization && !orgError && (
            <div className="org-info-details">
              <div className="org-card-detail">
                <span className="stat-label">Organization Name</span>
                <span className="stat-value">{organization.name}</span>
              </div>
              <div className="org-card-detail">
                <span className="stat-label">Company Code</span>
                <span className="stat-value org-code">{organization.companyCode}</span>
              </div>
              <div className="org-card-detail">
                <span className="stat-label">Status</span>
                <StatusBadge isActive={organization.isActive} />
              </div>
            </div>
          )}
        </div>

        {/* --- Organization Overview (DOC-53) ------------------------------
            Employees/Operators come from the already-loaded `users` list
            (unaffected by DOC-54 filters, see the useMemo above). Every
            Request-derived card comes from the dedicated statistics fetch
            (`stats`), deliberately independent of the Organization
            Requests table's own search/filter state further down - task
            spec: "Do not let current search filters incorrectly change
            the overall cards." While `stats` hasn't loaded yet, each
            Request card shows a loading placeholder rather than a
            misleading 0 (task spec: "Do not display fake zeroes before
            data loads"). A statistics failure shows one small inline
            retry notice and leaves every other section of this Dashboard
            fully usable. */}
        <div className="dashboard-stats">
          <StatCard label="Employees" value={employees.length} />
          <StatCard label="Active Employees" value={activeEmployeeCount} />
          <StatCard label="Inactive Employees" value={inactiveEmployeeCount} />
          <StatCard label="Operators" value={operators.length} />
          <StatCard label="Active Operators" value={activeOperatorCount} />
          <StatCard label="Inactive Operators" value={inactiveOperatorCount} />
          <StatCard label="Total Requests" value={stats?.totals.total} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Open Requests" value={stats?.totals.open} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="In Progress Requests" value={stats?.totals.inProgress} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Resolved Requests" value={stats?.totals.resolved} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Closed Requests" value={stats?.totals.closed} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Unassigned Requests" value={stats?.totals.unassigned} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="High Priority Requests" value={stats?.totals.highPriority} placeholder={!stats ? 'Loading...' : undefined} />
          {/* DOC-55 - "Request SLA and Due Dates" - Manager gets all four
              SLA cards (task spec). `slaComplianceRate`/
              `averageResolutionMinutes` are `null` (never `0`) when there
              is nothing eligible yet - shown as "N/A", never a misleading
              0%/0m. */}
          <StatCard label="Overdue" value={stats?.sla?.overdueCount} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Due Soon" value={stats?.sla?.dueSoonCount} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard
            label="SLA Compliance"
            value={stats ? formatCompliancePercent(stats.sla?.slaComplianceRate) : undefined}
            placeholder={!stats ? 'Loading...' : undefined}
          />
          <StatCard
            label="Average Resolution Time"
            value={stats ? formatMinutesDuration(stats.sla?.averageResolutionMinutes) : undefined}
            placeholder={!stats ? 'Loading...' : undefined}
          />
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

        {/* --- User Management (DOC-35/36, unchanged behavior) ------------ */}
        {users === null && !listError && (
          <div className="card admin-panel">
            <p className="auth-subtitle">Loading organization users...</p>
          </div>
        )}

        {listError && (
          <div className="card admin-panel">
            <p className="form-error form-error-server">{listError}</p>
            <button type="button" className="btn btn-outline" onClick={loadUsers}>
              Try Again
            </button>
          </div>
        )}

        {users !== null && !listError && !hasAnyUsers && (
          <div className="card admin-panel">
            <p className="auth-subtitle">No employees or operators are currently registered in this organization.</p>
          </div>
        )}

        {users !== null && !listError && hasAnyUsers && (
          <>
            <UserRoleSection
              title="Employees"
              users={employees}
              actionRole="operator"
              actionLabel="Promote to Operator"
              onChangeRole={handleChangeRole}
              onUpdateProfile={handleUpdateProfile}
              onToggleStatus={handleToggleStatus}
              emptyText="No employees currently."
              onResetPassword={handleResetPassword}
            />
            <UserRoleSection
              title="Operators"
              users={operators}
              actionRole="employee"
              actionLabel="Demote to Employee"
              onChangeRole={handleChangeRole}
              onUpdateProfile={handleUpdateProfile}
              onToggleStatus={handleToggleStatus}
              emptyText="No operators currently."
              showSpecialties
              activeCategories={activeCategories}
              categoriesReady={categoriesReadyForSpecialties}
              onUpdateSpecialties={handleUpdateSpecialties}
              onResetPassword={handleResetPassword}
            />
          </>
        )}

        {/* --- Service Categories (DOC-43) ---------------------------------
            Organization-scoped (never global) - the backend derives
            organizationId from req.user.organizationId on every call
            (GET/POST/PATCH), this page never sends one. No delete action
            exists - only Activate/Deactivate, since a future Request may
            reference a Category by id and history must be preserved. */}
        <div className="admin-section-header">
          <h2>Service Categories</h2>
          {!showAddCategoryForm && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setShowAddCategoryForm(true); setNewCategoryError(''); }}
            >
              Add Category
            </button>
          )}
        </div>

        {showAddCategoryForm && (
          <form className="card admin-panel" onSubmit={handleCreateCategory} noValidate>
            <div className="form-group">
              <label htmlFor="new-category-name">Category Name</label>
              <div className="input-group">
                <input
                  id="new-category-name"
                  name="name"
                  type="text"
                  placeholder="Electricity"
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  autoComplete="off"
                />
              </div>
              {newCategoryError && <span className="form-error">{newCategoryError}</span>}
            </div>
            <div className="form-actions form-actions-row">
              <button type="submit" className="btn btn-primary" disabled={addCategoryPending}>
                {addCategoryPending ? 'Adding...' : 'Add Category'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => { setShowAddCategoryForm(false); setNewCategoryName(''); setNewCategoryError(''); }}
                disabled={addCategoryPending}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {categories === null && !categoriesError && (
          <div className="card admin-panel">
            <p className="auth-subtitle">Loading service categories...</p>
          </div>
        )}

        {categoriesError && (
          <div className="card admin-panel">
            <p className="form-error form-error-server">{categoriesError}</p>
            <button type="button" className="btn btn-outline" onClick={loadCategories}>
              Try Again
            </button>
          </div>
        )}

        {categories !== null && !categoriesError && categories.length === 0 && (
          <div className="card admin-panel">
            <p className="auth-subtitle">No service categories exist for this organization.</p>
            <p className="form-hint">
              Employees cannot open a request until at least one active category exists. Create a practical
              starter set (Computers, Electricity, Plumbing, Network, Maintenance) in one step, then rename,
              deactivate, or add your own at any time.
            </p>
            <div className="form-actions form-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCreateDefaultCategories}
                disabled={createDefaultsPending}
              >
                {createDefaultsPending ? 'Creating...' : 'Create Default Categories'}
              </button>
            </div>
            {createDefaultsError && <p className="form-error form-error-server">{createDefaultsError}</p>}
          </div>
        )}

        {categories !== null && !categoriesError && categories.length > 0 && (
          <div className="card admin-panel user-section">
            <div className="user-table-wrapper">
              <table className="user-table">
                <thead>
                  <tr>
                    <th>Category Name</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map((category) => (
                    <ServiceCategoryRow
                      key={category.id}
                      category={category}
                      onUpdateName={handleUpdateCategoryName}
                      onToggleStatus={handleToggleCategoryStatus}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- Organization Requests (DOC-52) ------------------------------
            Every Request in this Organization, regardless of who created it
            or who it is assigned to (GET /api/requests/organization) - the
            "Manager sees Organization Requests" step of the workflow (task
            spec section 1). Each row's Assign/Reassign control is only
            enabled while that specific Request is still 'open' (task spec
            section 5) - the backend independently enforces the same rule. */}
        <div className="admin-section-header">
          <h2>Organization Requests</h2>
        </div>

        {/* DOC-54 - search/filter/sort controls, always shown (even while
            loading/erroring) so the Manager never loses their in-progress
            filter selections just because a request is in flight. Operator/
            Requester filters deliberately use the FULL (not active-only)
            operators/employees lists - task spec: historical, now-inactive
            Operators/Employees must still be filterable. */}
        <RequestSearchControls
          filters={requestFilters}
          onFilterChange={handleFilterChange}
          onClear={handleClearFilters}
          categories={categories || []}
          showManagerFilters
          operators={operators}
          employees={employees}
        />

        {requests === null && !requestsError && (
          <div className="card admin-panel">
            <p className="auth-subtitle">Loading organization requests...</p>
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
                : 'No requests have been opened in this organization yet.'
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
                    <th>Employee</th>
                    <th>Category</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>SLA</th>
                    <th>Assigned Operator</th>
                    <th>Created At</th>
                    <th>Assign / Manage</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((req) => (
                    <ManagerRequestRow
                      key={req.id}
                      request={req}
                      eligibleOperators={eligibleOperatorsForRequest(req)}
                      onAssignOperator={handleAssignOperator}
                      categories={activeCategories}
                      activeOperators={activeOperators}
                      onManagerUpdate={handleManagerUpdateRequest}
                      onManagerCancel={handleManagerCancelRequest}
                      onManagerClose={handleManagerCloseRequest}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* --- Dashboard Statistics breakdowns (DOC-53) --------------------
            Simple CSS bar lists (StatBreakdownList) and a plain table for
            Operator Workload - no chart library, task spec: "Simple bars
            or tables are enough." Rendered only once `stats` has actually
            loaded; the statsError panel above already covers the failure
            case, so nothing further is shown here while `stats` is null. */}
        {stats && (
          <>
            <div className="admin-section-header">
              <h2>Requests Overview</h2>
            </div>
            <StatBreakdownList
              title="Requests by Status"
              items={stats.byStatus.map((entry) => ({ label: STATUS_LABELS[entry.value] || entry.value, count: entry.count }))}
            />
            <StatBreakdownList
              title="Requests by Priority"
              items={stats.byPriority.map((entry) => ({ label: PRIORITY_LABELS[entry.value] || entry.value, count: entry.count }))}
            />
            <StatBreakdownList
              title="Requests by Category"
              items={stats.byCategory.map((entry) => ({ label: entry.category.name, count: entry.count }))}
              emptyMessage="No requests reference any category yet."
            />

            <div className="admin-section-header">
              <h2>Operator Workload</h2>
            </div>
            {stats.byOperator.length === 0 ? (
              <div className="card admin-panel">
                <p className="auth-subtitle">No operators currently exist in this organization.</p>
              </div>
            ) : (
              <div className="card admin-panel user-section">
                <div className="user-table-wrapper">
                  <table className="user-table">
                    <thead>
                      <tr>
                        <th>Operator</th>
                        <th>Status</th>
                        <th>Assigned</th>
                        <th>Active</th>
                        <th>Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byOperator.map((entry) => (
                        <tr key={entry.operator.id}>
                          <td>{entry.operator.fullName}</td>
                          <td><StatusBadge isActive={entry.operator.isActive} /></td>
                          <td>{entry.assignedCount}</td>
                          <td>{entry.activeCount}</td>
                          <td>{entry.completedCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default ManagerDashboard;
