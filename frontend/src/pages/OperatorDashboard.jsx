import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';

// Text shown for every request-derived number this page cannot yet
// compute - there is no Ticket API in Sprint 3 yet (DOC-42 explicitly must
// not build one). Never replaced with a fake number.
const REQUESTS_UNAVAILABLE_TEXT = 'Available when Request Management is enabled';

// Operator's dedicated Work Management dashboard (DOC-42). Previously
// Operator shared the generic /dashboard placeholder with Employee; this
// is its own route (/operator) now that both roles have real, different
// responsibilities. Everything Request-related here is a structural
// placeholder ready to be wired to a future Ticket API - this page does
// not invent requests, counts, or actions that do not exist yet.
function OperatorDashboard() {
  const { user, token } = useAuth();

  // Organization context (name only) - fetched the same secure way the
  // Manager Dashboard gets its own Organization: GET /api/organizations/me,
  // which the backend derives exclusively from req.user.organizationId.
  // Nothing sensitive (companyCode, managerId, createdBy) is displayed
  // here - Operator only needs to know WHICH organization it is working
  // for, not to manage it.
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

  const subtitle = organization
    ? `Signed in as ${user?.fullName || user?.email} - ${organization.name}`
    : `Signed in as ${user?.fullName || user?.email}${orgError ? '' : ' - loading organization...'}`;

  return (
    <section className="page operator-page">
      <div className="operator-shell">
        <DashboardHeader title="Operator Dashboard" subtitle={subtitle} />

        {orgError && <p className="form-error form-error-server">{orgError}</p>}

        <div className="dashboard-stats">
          <StatCard label="Assigned" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="Open" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="In Progress" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="Completed" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
        </div>

        <div className="admin-section-header">
          <h2>Assigned Requests</h2>
        </div>
        {/* This section is intentionally a placeholder: DOC-42 prepares the
            surface (title, empty state, the future column list documented
            below) but does not implement Ticket CRUD, assignment, comments,
            or any backend for it. Once a real Ticket API exists, this block
            becomes a table with: Title, Priority, Status, Category, Created
            By, Created At, and actions (Open Request / Change status / Add
            Comment). */}
        <EmptyState message="No requests are currently assigned to you." />
      </div>
    </section>
  );
}

export default OperatorDashboard;
