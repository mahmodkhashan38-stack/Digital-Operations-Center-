import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, userApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import OrganizationUserRow from '../components/OrganizationUserRow.jsx';

// Text shown for every Request-derived number this page cannot yet
// compute - there is no Ticket API in Sprint 3 yet (DOC-42 explicitly must
// not build one). Never replaced with a fake number.
const REQUESTS_UNAVAILABLE_TEXT = 'Available when Request Management is enabled';

// Renders one role group ("Employees" or "Operators") as a simple table.
// Kept inline rather than a separate file - it is a thin wrapper around
// OrganizationUserRow with no state or logic of its own, so a dedicated
// component/file would not add clarity.
function UserRoleSection({ title, users, actionRole, actionLabel, onChangeRole, emptyText }) {
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
    return response.data;
  };

  // GET /api/users returns every user in the Manager's own Organization,
  // including the Manager themselves (role: 'manager') - grouping strictly
  // by role: 'employee' / role: 'operator' below is what keeps the
  // Manager's own row (and any other manager/system_admin row, though the
  // latter can never actually appear here - DOC-38) out of both sections
  // entirely, with no special-case "is this me?" check required.
  const { employees, operators } = useMemo(() => {
    const list = users || [];
    return {
      employees: list.filter((u) => u.role === 'employee'),
      operators: list.filter((u) => u.role === 'operator'),
    };
  }, [users]);

  const hasAnyUsers = employees.length > 0 || operators.length > 0;

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

        {/* --- Organization Overview -------------------------------------
            Employees/Operators are real counts derived from the same user
            list loaded below. The three Request counts are NOT faked -
            there is no Ticket API yet, so they show an honest placeholder
            instead of a number (spec: never hardcode fake statistics). */}
        <div className="dashboard-stats">
          <StatCard label="Employees" value={employees.length} />
          <StatCard label="Operators" value={operators.length} />
          <StatCard label="Open Requests" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="In Progress Requests" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="Closed Requests" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
        </div>

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
              emptyText="No employees currently."
            />
            <UserRoleSection
              title="Operators"
              users={operators}
              actionRole="employee"
              actionLabel="Demote to Employee"
              onChangeRole={handleChangeRole}
              emptyText="No operators currently."
            />
          </>
        )}

        {/* --- Organization Requests (DOC-42, prepared for a future Ticket
            API) ------------------------------------------------------
            This section intentionally has no data source yet. Once a real
            Ticket API exists, it becomes a table of the Organization's
            requests with: All/Open/In Progress/Closed filters, Priority,
            Employee, Assigned Operator, and Created At. No fake Ticket data
            or fake API is used to fill it in the meantime. */}
        <div className="admin-section-header">
          <h2>Organization Requests</h2>
        </div>
        <EmptyState
          title="Request Management is coming next"
          message="Once Ticket functionality is enabled, all of this Organization's requests will appear here."
        />
      </div>
    </section>
  );
}

export default ManagerDashboard;
