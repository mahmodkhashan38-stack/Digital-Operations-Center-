import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [createSuccess, setCreateSuccess] = useState(null); // { name, companyCode }

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

  const handleCreate = async (payload) => {
    const response = await organizationApi.create(payload, token);
    setOrganizations((prev) => [response.data, ...(prev || [])]);
    setCreateSuccess({ name: response.data.name, companyCode: response.data.companyCode });
    setShowCreateForm(false);
    return response.data;
  };

  const replaceOrganization = (updatedOrg) => {
    setOrganizations((prev) => (prev || []).map((org) => (org.id === updatedOrg.id ? updatedOrg : org)));
  };

  const handleToggleActive = async (organization) => {
    const response = await organizationApi.update(organization.id, { isActive: !organization.isActive }, token);
    replaceOrganization(response.data);
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
    return response.data;
  };

  // Summary is derived entirely from Organization data already loaded for
  // the list below - no extra backend calls, no analytics engine.
  const summary = useMemo(() => {
    const list = organizations || [];
    return {
      total: list.length,
      active: list.filter((org) => org.isActive).length,
      inactive: list.filter((org) => !org.isActive).length,
      withoutManager: list.filter((org) => !org.managerId).length,
    };
  }, [organizations]);

  return (
    <section className="page admin-page">
      <div className="admin-shell">
        <DashboardHeader
          title="System Admin Dashboard"
          subtitle={`Signed in as ${user?.fullName || user?.email} - manage the platform's Organizations. Day-to-day Organization operations belong to each Organization's own Manager.`}
        />

        {/* Platform Overview - every value here is calculated frontend-side
            from the Organization list already loaded below (no dedicated
            counts endpoint - DOC-42 spec explicitly says not to add one
            just for this). */}
        <div className="dashboard-stats">
          <StatCard label="Total Organizations" value={summary.total} />
          <StatCard label="Active Organizations" value={summary.active} />
          <StatCard label="Inactive Organizations" value={summary.inactive} />
          <StatCard label="Organizations Without Manager" value={summary.withoutManager} />
        </div>

        {createSuccess && (
          <p className="form-success">
            Organization &quot;{createSuccess.name}&quot; created. Company Code:{' '}
            <strong className="org-code">{createSuccess.companyCode}</strong> - share this with employees so
            they can register.
          </p>
        )}

        <div className="admin-section-header">
          <h2>Organizations</h2>
          {!showCreateForm && (
            <button type="button" className="btn btn-primary" onClick={() => { setShowCreateForm(true); setCreateSuccess(null); }}>
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
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default AdminDashboard;
