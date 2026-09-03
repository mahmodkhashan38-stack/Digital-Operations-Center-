import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth, SESSION_EXPIRED_FLAG_KEY } from '../context/AuthContext.jsx';
import { destinationForRole } from '../utils/roleRoutes.js';
import getApiErrorMessage from '../utils/apiError.js';

// DOC-69 - "Error & UX Hardening" (task spec section 14: "user sees a
// meaningful message if practical"). Reads AuthContext's one-time flag
// (set by services/api.js's unauthorized handler right before it clears
// stale auth state and redirects here via ProtectedRoute) and clears it
// immediately - a plain function, not a Hook, so it only ever runs once
// per actual page load, during this module's first render, never on a
// later re-render of the same mounted Login instance.
function readAndClearSessionExpiredFlag() {
  const wasSet = sessionStorage.getItem(SESSION_EXPIRED_FLAG_KEY) === '1';
  if (wasSet) {
    sessionStorage.removeItem(SESSION_EXPIRED_FLAG_KEY);
  }
  return wasSet;
}

// Login page. Submits credentials to the backend, stores the JWT on
// success, and redirects the user to the dashboard.
// A logged-in user's post-login destination depends on their role - see
// utils/roleRoutes.js for the full mapping: system_admin -> /admin (DOC-37),
// manager -> /manager (DOC-36), operator -> /operator (DOC-42), employee ->
// /dashboard (DOC-42).

// DOC-57 - a signed-in user whose password must still be changed (a
// Manager reset, or any other mustChangePassword === true state) is
// always sent to /change-password instead of their normal dashboard -
// used both for an already-signed-in visitor landing back on /login and
// for a fresh login submission below.
function postLoginDestination(user) {
  if (user?.mustChangePassword) {
    return '/change-password';
  }
  return destinationForRole(user?.role);
}

function Login() {
  const navigate = useNavigate();
  const { login, isAuthenticated, isLoading, user } = useAuth();

  const [formData, setFormData] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Lazy initializer - runs exactly once, on this component's first
  // render, so a later re-render (e.g. while `isSubmitting` toggles)
  // never re-reads/re-clears the flag a second time.
  const [showSessionExpired] = useState(readAndClearSessionExpiredFlag);

  if (!isLoading && isAuthenticated) {
    return <Navigate to={postLoginDestination(user)} replace />;
  }

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const validate = () => {
    const nextErrors = {};
    if (!formData.email.trim()) {
      nextErrors.email = 'Email is required.';
    }
    if (!formData.password) {
      nextErrors.password = 'Password is required.';
    }
    return nextErrors;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setServerError('');

    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const loggedInUser = await login(formData);
      // Login always succeeds even when mustChangePassword is true (task
      // spec: "login still succeeds") - only the POST-login destination
      // changes; the backend's own requirePasswordChangeCompleted
      // middleware is what actually blocks every normal route afterward.
      navigate(postLoginDestination(loggedInUser));
    } catch (error) {
      // DOC-69 - the extra `getApiErrorMessage` safety net specifically on
      // this page (the very first screen an unauthenticated/offline
      // visitor can hit) rather than everywhere - see utils/apiError.js's
      // own comment for why most of this project's existing
      // `error.message` displays don't need it.
      setServerError(getApiErrorMessage(error, 'Login failed. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>Login</h1>
        <p className="auth-subtitle">Sign in to access your Digital Operations Center account.</p>

        {showSessionExpired && !serverError && (
          <p className="form-error form-error-server">Your session has expired. Please sign in again.</p>
        )}
        {serverError && <p className="form-error form-error-server">{serverError}</p>}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <div className="input-group">
              <span className="input-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </svg>
              </span>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={formData.email}
                onChange={handleChange}
              />
            </div>
            {errors.email && <span className="form-error">{errors.email}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="input-group">
              <span className="input-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
              </span>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={formData.password}
                onChange={handleChange}
              />
            </div>
            {errors.password && <span className="form-error">{errors.password}</span>}
          </div>

          {/* DOC-70 - "Forgot Password / Password Recovery via Manager
              Approval". Placed directly under the form fields, above the
              submit button - a person who cannot log in should see this
              before, not after, trying (and failing) to submit. */}
          <p className="auth-forgot-password-link">
            <Link to="/forgot-password">Forgot Password?</Link>
          </p>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
              {isSubmitting ? 'Logging in...' : 'Login'}
            </button>
            <Link to="/" className="btn btn-outline btn-block">
              Back to Home
            </Link>
          </div>
        </form>
      </div>
    </section>
  );
}

export default Login;
