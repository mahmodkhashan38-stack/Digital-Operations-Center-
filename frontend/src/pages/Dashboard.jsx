import { useAuth } from '../context/AuthContext.jsx';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';

// Text shown for every request-derived number this page cannot yet
// compute - there is no Ticket API in Sprint 3 yet (DOC-42 explicitly must
// not build one). Never replaced with a fake number.
const REQUESTS_UNAVAILABLE_TEXT = 'Available when Request Management is enabled';

// Employee's dedicated Personal Request Management dashboard (DOC-42).
// This is the same /dashboard route Employee has always used - what
// changed is its content (and that Operator now has its own /operator
// route instead of sharing this one). Everything Request-related here is
// a structural placeholder ready to be wired to a future Ticket API - this
// page does not invent requests, counts, or a working "create" action that
// do not exist yet.
function Dashboard() {
  const { user } = useAuth();

  return (
    <section className="page dashboard-page">
      <div className="dashboard-shell">
        <DashboardHeader
          title={`My Dashboard${user?.fullName ? ` - ${user.fullName}` : ''}`}
          subtitle="Personal request management - track and open your own requests."
        />

        <div className="admin-section-header">
          <h2>New Request</h2>
        </div>
        <div className="card admin-panel">
          {/* Request creation depends on a future Ticket API that DOC-42
              explicitly must not build. The button stays visible (so the
              intended final layout is clear) but is disabled with an
              honest explanation rather than pretending to work. */}
          <button type="button" className="btn btn-primary" disabled title="Request Management is not enabled yet">
            Open New Request
          </button>
          <p className="form-hint">Available once Request Management is enabled.</p>
        </div>

        <div className="admin-section-header">
          <h2>My Requests</h2>
        </div>
        {/* Once a real Ticket API exists, this becomes a table scoped to
            requests created by THIS employee only (Title, Category,
            Priority, Status, Assigned Operator, Created At) - never another
            employee's requests. */}
        <EmptyState message="You haven't opened any requests yet." />

        <div className="admin-section-header">
          <h2>Request Overview</h2>
        </div>
        <div className="dashboard-stats">
          <StatCard label="My Requests" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="Open" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="In Progress" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
          <StatCard label="Closed" placeholder={REQUESTS_UNAVAILABLE_TEXT} />
        </div>
      </div>
    </section>
  );
}

export default Dashboard;
