import React from 'react';
import { Link } from 'react-router-dom';
import logoMark from '../assets/logo-mark.png';

// How the request lifecycle flows through the system.
const STEPS = [
  {
    title: 'Employee Creates a Request',
    description: 'An employee submits an operational request describing the issue or need.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3h7l4 4v14H7z" />
        <path d="M14 3v4h4" />
        <path d="M9.5 13h5M12 10.5v5" />
      </svg>
    ),
  },
  {
    title: 'Operator Handles and Updates It',
    description: 'An operator picks up the request, works on it, and keeps its status updated.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 11a8 8 0 1 0-2.34 5.66" />
        <path d="M20 4v7h-7" />
      </svg>
    ),
  },
  {
    title: 'Employee Tracks Progress',
    description: 'The employee follows the request status until it is resolved and closed.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="m7 14 4-4 3 3 5-6" />
      </svg>
    ),
  },
];

// Categories of requests the system is designed to handle.
const REQUEST_TYPES = [
  {
    title: 'Operational Incidents',
    description: 'Issues that disrupt day-to-day operations and need prompt attention.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3 2 20h20L12 3z" />
        <path d="M12 9v4" />
        <path d="M12 16.5v.01" />
      </svg>
    ),
  },
  {
    title: 'Service Requests',
    description: 'Standard requests for services, resources, or support.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M3 10h18" />
        <path d="M8 14h4" />
      </svg>
    ),
  },
  {
    title: 'Internal Tasks',
    description: 'Tasks and follow-ups tracked internally between teams.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="m8 12 2.5 2.5L16 9" />
      </svg>
    ),
  },
];

// Core value the platform provides to the organization.
const BENEFITS = [
  'Centralized information',
  'Clear status tracking',
  'Clear responsibility',
  'User and role management',
  'Reduced information loss',
];

// How the platform protects accounts and data.
const SECURITY_POINTS = [
  {
    title: 'Secure Authentication',
    description: 'Accounts are protected with token-based authentication on every request.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    ),
  },
  {
    title: 'Password Hashing',
    description: 'Passwords are never stored as plain text - only secure hashes are kept.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10.5 12.5 20 3" />
        <path d="M17 6l2.5 2.5" />
        <path d="M14 9l2 2" />
      </svg>
    ),
  },
  {
    title: 'Role-Based Access Control',
    description: 'Each user only accesses the features and data their role allows.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
];

// Public landing page introducing the Digital Operations Center system.
// Accessible without logging in - contains no private, database-driven, or
// protected content (no real requests, comments, or user data).
function Home() {
  return (
    <section className="page home-page">
      <div className="hero">
        <div className="card hero-card">
          <img src={logoMark} alt="Digital Operations Center logo" className="hero-logo" />
          <span className="hero-eyebrow">Public Access</span>
          <h1>Digital Operations Center</h1>
          <p className="hero-description">
            A centralized web application for managing operational requests inside an
            organization.
          </p>

          <ul className="hero-roles">
            <li>Employees can submit operational requests and follow their progress.</li>
            <li>Operators manage assigned requests.</li>
            <li>Administrators manage users and the system.</li>
          </ul>

          <div className="hero-actions">
            <Link to="/login" className="btn btn-primary">
              Login
            </Link>
            <Link to="/register" className="btn btn-outline">
              Register
            </Link>
          </div>
        </div>
      </div>

      <div className="features-section">
        <h2 className="features-title">How It Works</h2>
        <div className="features-grid">
          {STEPS.map((step) => (
            <div className="feature-card" key={step.title}>
              <span className="feature-icon">{step.icon}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="features-section">
        <h2 className="features-title">Request Types</h2>
        <div className="features-grid">
          {REQUEST_TYPES.map((type) => (
            <div className="feature-card" key={type.title}>
              <span className="feature-icon">{type.icon}</span>
              <h3>{type.title}</h3>
              <p>{type.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="features-section">
        <h2 className="features-title">Main Benefits</h2>
        <div className="features-grid">
          {BENEFITS.map((benefit) => (
            <div className="feature-card" key={benefit}>
              <span className="feature-icon">✔</span>
              <p>{benefit}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="features-section">
        <h2 className="features-title">Security Overview</h2>
        <div className="features-grid">
          {SECURITY_POINTS.map((point) => (
            <div className="feature-card" key={point.title}>
              <span className="feature-icon">{point.icon}</span>
              <h3>{point.title}</h3>
              <p>{point.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default Home;
