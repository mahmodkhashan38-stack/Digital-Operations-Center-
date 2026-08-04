import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi } from '../services/api.js';
import CreateOrganizationForm from '../components/CreateOrganizationForm.jsx';
import OrganizationCard from '../components/OrganizationCard.jsx';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';

// System Admin's dedicated, GLOBAL dashboard (DOC-37). System Admin does
// not belong to an Organization (organizationId is always null - DOC-31),
// so unlike a future Manager Dashboard (DOC-36, not implemented here) this
// page is not scoped to any single tenant - it lists and manages every
// Organization in the system, using the exact backend endpoints DOC-32/
// DOC-34/DOC-41 already implemented. Nothing here is mocked: every action
// below is a real call through organizationApi (services/api.js) to the
// live backend, which remains the actual authority - this page cannot do
// anything the backend wouldn't already allow a system_admin token to do
// via curl.
function AdminDashboard() {
  const { user, token } = useAuth();

  const [organizations, setOrganizations] = useState(null); // null = not loaded yet
  const [listError, setListError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createSuccess, setCreateSuccess] = useState(null); // { name, companyCode, defaultCategoriesCreated }
  const [deleteSuccess, setDeleteSuccess] = useState(''); // DOC-47

  const loadOrganizations = useCallback(async () => {
    setListError('');
    try {
      const response = await organizationApi.list(token);
      setOrganizations(response.data);
    } catch (error) {
      setListError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadOrganizations();
  }, [loadOrganizations]);

  // --- Dashboard Statistics (DOC-53) --------------------------------------
  // Platform-level only (task spec: "System Admin remains platform-level,
  // not operational" / "Do not show operational Request statistics") -
  // GET /api/organizations/statistics, deliberately a SEPARATE fetch from
  // `organizations` above rather than recomputed from it: `organizations`
  // is System Admin's own working list (used for the cards below AND
  // every management action), while `stats` is the dedicated,
  // authoritative platform summary (e.g. `totalManagers` counts every
  // Manager-role User account, including a historical, deactivated one
  // from a DOC-49 Manager replacement - not something derivable from the
  // Organization list alone). Independent loading/error state, so a
  // statistics failure never blocks the Organization list/management
  // actions below.
  const [stats, setStats] = useState(null); // null = not loaded yet
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    setStatsError('');
    try {
      const response = await organizationApi.getStatistics(token);
      setStats(response.data);
    } catch (error) {
      setStatsError(error.message);
    }
  }, [token]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const handleCreate = async (payload) => {
    const response = await organizationApi.create(payload, token);
    setOrganizations((prev) => [response.data, ...(prev || [])]);
    // Sprint 4 - `response.setup` is an additive, optional field (see
    // organization.controller.js's createOrganization); a backend that
    // predates this feature simply omits it, and `?.` makes that a no-op
    // here rather than an error.
    setCreateSuccess({
      name: response.data.name,
      companyCode: response.data.companyCode,
      defaultCategoriesCreated: response.setup?.defaultCategoriesCreated,
    });
    setDeleteSuccess('');
    setShowCreateForm(false);
    // DOC-53: "create Organization" is an explicit refresh trigger.
    loadStats();
    return response.data;
  };

  // DOC-47: only removes the Organization from the list AFTER the backend
  // has confirmed deletion (organizationApi.delete throws on any non-2xx
  // response, including the 409 the backend returns while dependent users
  // still exist - that error propagates up to OrganizationCard, which
  // shows it inline and leaves this Organization exactly where it was).
  // DOC-53: the Platform Overview cards are now refreshed separately via
  // loadStats() below, not recalculated from this `organizations` list.
  const handleDelete = async (organization) => {
    await organizationApi.delete(organization.id, token);
    setOrganizations((prev) => (prev || []).filter((org) => org.id !== organization.id));
    setCreateSuccess(null);
    setDeleteSuccess(`Organization "${organization.name}" was permanently deleted.`);
    // DOC-53: not among the task spec's explicit trigger list, but
    // included for correctness - a deletion changes totalOrganizations
    // (and, since DOC-47 already refuses to delete an Organization with
    // any dependent User, this can never silently orphan a Manager count
    // either).
    loadStats();
  };

  const replaceOrganization = (updatedOrg) => {
    setOrganizations((prev) => (prev || []).map((org) => (org.id === updatedOrg.id ? updatedOrg : org)));
  };

  const handleToggleActive = async (organization) => {
    const response = await organizationApi.update(organization.id, { isActive: !organization.isActive }, token);
    replaceOrganization(response.data);
    // DOC-53: "activate/deactivate Organization" is an explicit refresh
    // trigger.
    loadStats();
    return response.data;
  };

  const handleRegenerateCode = async (organization) => {
    const response = await organizationApi.regenerateCode(organization.id, token);
    replaceOrganization(response.data);
    return response.data;
  };

  const handleAssignManager = async (organization, managerPayload) => {
    const response = await organizationApi.assignManager(organization.id, managerPayload, token);
    replaceOrganization(response.data);
    // DOC-53: "create Manager" is an explicit refresh trigger -
    // organizationsWithManager/organizationsWithoutManager/totalManagers
    // all change.
    loadStats();
    return response.data;
  };

  // DOC-49: edits the CURRENT Manager's fullName/email only.
  const handleUpdateManagerProfile = async (organization, updates) => {
    const response = await organizationApi.updateManagerProfile(organization.id, updates, token);
    replaceOrganization(response.data);
    return response.data;
  };

  // DOC-49: replaces the CURRENT Manager with a brand-new account - the
  // backend deactivates the old one (never deletes/detaches). The
  // Organization's managerId now points to the new Manager, which is all
  // this page needs to reflect - replaceOrganization already updates the
  // card from the response the same way every other action here does.
  const handleReplaceManager = async (organization, managerPayload) => {
    const response = await organizationApi.replaceManager(organization.id, managerPayload, token);
    replaceOrganization(response.data);
    // DOC-53: "replace Manager" is an explicit refresh trigger -
    // totalManagers increases (the old Manager is deactivated, never
    // deleted - see this file's own comment on `stats` above).
    loadStats();
    return response.data;
  };

  return (
    <section className="page admin-page">
      <div className="admin-shell">
        <DashboardHeader
          title="System Admin Dashboard"
          subtitle={`Signed in as ${user?.fullName || user?.email} - manage the platform's Organizations. Day-to-day Organization operations belong to each Organization's own Manager.`}
        />

        {/* Platform Overview (DOC-53) - every value now comes from the
            dedicated GET /api/organizations/statistics endpoint, the
            authoritative platform-level count (see this file's own
            comment on `stats` above for why `totalManagers` in particular
            is NOT simply derivable from the `organizations` list alone).
            Deliberately no Request/Ticket-derived card at all here (task
            spec: "Do not show operational Request statistics" - System
            Admin never had that permission and still doesn't). A stale
            Request-Management placeholder string previously lived on the
            per-Organization card (OrganizationCard.jsx) and has been
            removed entirely rather than replaced with another placeholder
            or wired to real per-Organization Request data - see that
            file's own comment for details. Loading placeholders instead
            of misleading zeroes while `stats` is still null. */}
        <div className="dashboard-stats">
          <StatCard label="Total Organizations" value={stats?.totalOrganizations} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Active Organizations" value={stats?.activeOrganizations} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Inactive Organizations" value={stats?.inactiveOrganizations} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Organizations With Manager" value={stats?.organizationsWithManager} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Organizations Without Manager" value={stats?.organizationsWithoutManager} placeholder={!stats ? 'Loading...' : undefined} />
          <StatCard label="Total Managers" value={stats?.totalManagers} placeholder={!stats ? 'Loading...' : undefined} />
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

        {createSuccess && (
          <p className="form-success">
            Organization &quot;{createSuccess.name}&quot; created. Company Code:{' '}
            <strong className="org-code">{createSuccess.companyCode}</strong> - share this with employees so
            they can register.
            {typeof createSuccess.defaultCategoriesCreated === 'number' && (
              <> {createSuccess.defaultCategoriesCreated} default service categor
                {createSuccess.defaultCategoriesCreated === 1 ? 'y was' : 'ies were'} created automatically.</>
            )}
          </p>
        )}

        {deleteSuccess && <p className="form-success">{deleteSuccess}</p>}

        <div className="admin-section-header">
          <h2>Organizations</h2>
          {!showCreateForm && (
            <button type="button" className="btn btn-primary" onClick={() => { setShowCreateForm(true); setCreateSuccess(null); setDeleteSuccess(''); }}>
              Create Organization
            </button>
          )}
        </div>

        {showCreateForm && (
          <CreateOrganizationForm onCreate={handleCreate} onCancel={() => setShowCreateForm(false)} />
        )}

        {organizations === null && !listError && (
          <div className="card admin-panel">
            <p className="auth-subtitle">Loading organizations...</p>
          </div>
        )}

        {listError && (
          <div className="card admin-panel">
            <p className="form-error form-error-server">{listError}</p>
            <button type="button" className="btn btn-outline" onClick={loadOrganizations}>
              Try Again
            </button>
          </div>
        )}

        {organizations !== null && !listError && organizations.length === 0 && (
          <div className="card admin-panel">
            <p className="auth-subtitle">No organizations have been created yet.</p>
          </div>
        )}

        {organizations !== null && organizations.length > 0 && (
          <div className="org-list">
            {organizations.map((organization) => (
              <OrganizationCard
                key={organization.id}
                organization={organization}
                onToggleActive={handleToggleActive}
                onRegenerateCode={handleRegenerateCode}
                onAssignManager={handleAssignManager}
                onUpdateManagerProfile={handleUpdateManagerProfile}
                onReplaceManager={handleReplaceManager}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default AdminDashboard;
