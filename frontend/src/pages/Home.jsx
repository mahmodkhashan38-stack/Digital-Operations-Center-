import React from 'react';
import { Link } from 'react-router-dom';
// Logo Replacement task - see components/Navbar.jsx's own import comment
// for the full rationale (new DOC wordmark, transparent background, same
// .hero-logo CSS unchanged since it already sizes via object-fit: contain).
import logoMark from '../assets/doc-logo.png';

// Home Page Redesign - "modern SaaS-style landing page" task spec.
//
// Section 2 (Product Value) - exactly four compact feature cards, per the
// task spec's explicit copy. Icons are plain inline SVGs in the same
// viewBox/stroke conventions already used across this file and Navbar.jsx
// (task spec: "Do not introduce a large new dependency only for icons.").
const FEATURES = [
  {
    title: 'Request Management',
    description: 'Create, assign, track, and resolve operational requests.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 3h7l4 4v14H7z" />
        <path d="M14 3v4h4" />
        <path d="M9.5 13h5M9.5 16.5h5" />
      </svg>
    ),
  },
  {
    title: 'Team Communication',
    description: 'Keep conversations, mentions, and direct messages in one place.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4h16v11H9l-4 4V4z" />
        <path d="M8 9h8M8 12.5h5" />
      </svg>
    ),
  },
  {
    title: 'Organization Control',
    description: 'Manage users, roles, policies, and organizational workflows.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" />
        <circle cx="17.5" cy="8.5" r="2.5" />
        <path d="M15.5 14.3c2.4.3 4.5 2.5 4.5 5.2" />
      </svg>
    ),
  },
  {
    title: 'Secure Access',
    description: 'Role-based access, verified accounts, sessions, and protected data.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
];

// Section 3 (Simple Workflow) - the four-step Create -> Assign -> Track ->
// Resolve lifecycle, per the task spec's explicit copy. Rendered as a
// responsive row of steps connected by arrows (desktop/tablet) that
// collapses to a vertical stack on mobile - see .workflow-steps /
// .workflow-arrow in index.css.
const WORKFLOW_STEPS = [
  {
    title: 'Create',
    description: 'Employees submit a clear operational request.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 3h7l4 4v14H7z" />
        <path d="M14 3v4h4" />
        <path d="M12 12v5M9.5 14.5h5" />
      </svg>
    ),
  },
  {
    title: 'Assign',
    description: 'Managers route work to the right operator.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4l16 8-16 8 4-8-4-8z" />
      </svg>
    ),
  },
  {
    title: 'Track',
    description: 'Everyone sees status and progress.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
  {
    title: 'Resolve',
    description: 'Work is completed, confirmed, and recorded.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.5 2.5 2.5 5-6" />
      </svg>
    ),
  },
];

// Small reusable arrow separator between workflow steps - purely
// decorative (aria-hidden), the step titles/order already convey the
// sequence to assistive tech via normal reading order.
function WorkflowArrow() {
  return (
    <div className="workflow-arrow" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </div>
  );
}

// Public landing page introducing the Digital Operations Center system.
// Accessible without logging in - contains no private, database-driven, or
// protected content (no real requests, comments, or user data).
//
// Home Page Redesign task - replaces the previous four-section, text-heavy
// layout (How It Works / Request Types / Main Benefits / Security Overview)
// with a focused Hero -> 4 feature cards -> 4-step workflow -> final CTA ->
// footer structure, per the task spec's explicit section-by-section brief.
// Reuses the project's existing .card/.btn/.feature-card/.features-grid
// classes and CSS variables throughout rather than introducing a parallel
// style system - only Home-page-specific classes are new (see the
// "Home / landing page" block in index.css).
function Home() {
  return (
    <section className="page home-page">
      <div className="hero">
        <div className="hero-content">
          <img src={logoMark} alt="Digital Operations Center logo" className="hero-logo" />
          <h1>Digital Operations Center</h1>
          <p className="hero-description">
            Manage requests, coordinate teams, and keep your organization in control.
          </p>
          <p className="hero-subtext">
            One secure workspace for requests, communication, policies, and operational
            visibility.
          </p>
          <div className="hero-actions">
            <Link to="/login" className="btn btn-primary btn-lg">
              Sign In
            </Link>
            <Link to="/register" className="btn btn-outline btn-lg">
              Create Account
            </Link>
          </div>
        </div>
      </div>

      <div className="features-section">
        <div className="features-grid features-grid-4">
          {FEATURES.map((feature) => (
            <div className="feature-card" key={feature.title}>
              <span className="feature-icon">{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="features-section">
        <h2 className="features-title">How It Works</h2>
        <div className="workflow-steps">
          {WORKFLOW_STEPS.map((step, index) => (
            <React.Fragment key={step.title}>
              <div className="feature-card workflow-step">
                <span className="feature-icon">{step.icon}</span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
              {index < WORKFLOW_STEPS.length - 1 && <WorkflowArrow />}
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="home-final-cta">
        <h2>Ready to organize your operations?</h2>
        <div className="hero-actions">
          <Link to="/login" className="btn btn-primary">
            Sign In
          </Link>
          <Link to="/register" className="btn btn-outline">
            Create Account
          </Link>
        </div>
      </div>

      <footer className="home-footer">
        <p className="home-footer-title">Digital Operations Center</p>
        <p className="home-footer-copy">&copy; 2026 DOC</p>
        <p className="home-footer-tagline">Built for organized operational management.</p>
      </footer>
    </section>
  );
}

export default Home;
