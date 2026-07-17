import { NavLink, useNavigate } from 'react-router-dom';
import logoMark from '../assets/logo-mark.png';
import { useAuth } from '../context/AuthContext.jsx';

// Site navigation bar. Reflects authentication state: shows Login/Register
// when signed out, and Dashboard/Logout when signed in.
function Navbar() {
  const { isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();
  const linkClass = ({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');

  const handleLogout = () => {
    logout();
    navigate('/');
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
            <NavLink to="/dashboard" className={linkClass}>
              Dashboard
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
