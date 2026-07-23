import { NavLink, useNavigate } from 'react-router-dom';
import logoMark from '../assets/logo-mark.png';
import { useAuth } from '../context/AuthContext.jsx';
import { DASHBOARD_ROUTE_BY_ROLE } from '../utils/roleRoutes.js';

// Human-readable label for each role's dashboard link. Kept separate from
// DASHBOARD_ROUTE_BY_ROLE (utils/roleRoutes.js) - that file is routing
// logic (shared with Login/ProtectedRoute), this is presentation-only.
const DASHBOARD_LABEL_BY_ROLE = {
  system_admin: 'Admin Dashboard',
  manager: 'Manager Dashboard',
  operator: 'Operator Dashboard',
  employee: 'My Dashboard',
};

// Site navigation bar. Reflects authentication state: shows Login/Register
// when signed out, and Dashboard/Logout when signed in.
function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();
  const linkClass = ({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  // Every role (system_admin/manager/operator/employee - DOC-42) gets a
  // link to its own dedicated Dashboard, and only that one - a Manager
  // never sees "Admin Dashboard" or "Operator Dashboard", and so on for
  // every other role. Nothing here shows more than one dashboard link at
  // once.
  const dashboardNav = {
    path: DASHBOARD_ROUTE_BY_ROLE[user?.role] || '/dashboard',
    label: DASHBOARD_LABEL_BY_ROLE[user?.role] || 'Dashboard',
  };

  return (
    <header className="navbar">
      <NavLink to="/" end className="navbar-brand">
        <img src={logoMark} alt="Digital Operations Center logo" className="navbar-logo" />
        Digital Operations Center
      </NavLink>
      <nav className="navbar-links">
        <NavLink to="/" end className={linkClass}>
          Home
        </NavLink>
        {isAuthenticated ? (
          <>
            <NavLink to={dashboardNav.path} className={linkClass}>
              {dashboardNav.label}
            </NavLink>
            <button type="button" className="nav-link nav-link-button" onClick={handleLogout}>
              Logout
            </button>
          </>
        ) : (
          <>
            <NavLink to="/login" className={linkClass}>
              Login
            </NavLink>
            <NavLink to="/register" className={linkClass}>
              Register
            </NavLink>
          </>
        )}
      </nav>
    </header>
  );
}

export default Navbar;
