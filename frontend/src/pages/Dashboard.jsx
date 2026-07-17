import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// Protected dashboard placeholder. Displays the logged-in user's basic
// details and allows them to log out (removes the token client-side).
function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <section className="page dashboard-page">
      <div className="dashboard-shell">
        <div className="dashboard-welcome">
          <h1>Welcome{user?.fullName ? `, ${user.fullName}` : ''}</h1>
          <p>This page will become the employee dashboard after authentication.</p>
        </div>

        <div className="dashboard-stats">
          <div className="stat-card">
            <span className="stat-label">Name</span>
            <span className="stat-value">{user?.fullName}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Email</span>
            <span className="stat-value">{user?.email}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Role</span>
            <span className="stat-value">{user?.role}</span>
          </div>
        </div>

        <div className="dashboard-actions">
          <button type="button" className="btn btn-outline" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>
    </section>
  );
}

export default Dashboard;
