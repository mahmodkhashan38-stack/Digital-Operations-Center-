import React from 'react';
import { NavLink } from 'react-router-dom';
import logoMark from '../assets/logo-mark.png';

// Simple site navigation bar. No authentication-aware logic yet.
function Navbar() {
  const linkClass = ({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');

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
        <NavLink to="/login" className={linkClass}>
          Login
        </NavLink>
        <NavLink to="/register" className={linkClass}>
          Register
        </NavLink>
        <NavLink to="/dashboard" className={linkClass}>
          Dashboard
        </NavLink>
      </nav>
    </header>
  );
}

export default Navbar;
