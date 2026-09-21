import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, SESSION_EXPIRED_FLAG_KEY } from '../context/AuthContext.jsx';
import { destinationForRole } from '../utils/roleRoutes.js';
import getApiErrorMessage from '../utils/apiError.js';
import EmailVerificationForm from '../components/EmailVerificationForm.jsx';

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
  const location = useLocation();
  const { login, isAuthenticated, isLoading, user } = useAuth();

  const [formData, setFormData] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Lazy initializer - runs exactly once, on this component's first
  // render, so a later re-render (e.g. while `isSubmitting` toggles)
  // never re-reads/re-clears the flag a second time.
  const [showSessionExpired] = useState(readAndClearSessionExpiredFlag);

  // EMAIL VERIFICATION UX FIX - "Manager email verification UX". Before
  // this fix, a login attempt against any unverified, non-system_admin
  // account (a Manager created by System Admin, an Employee who never
  // finished registration verification, an Operator who was originally an
  // Employee, etc.) got stuck: the backend's login() correctly returns 403
  // with `data: { userId, emailVerificationRequired: true }` (see
  // auth.controller.js), but this page only ever showed that response's
  // flat error message with no way to actually act on it. `verifyUserId`
  // is that same `userId`, and its presence (rather than a separate
  // string `step` flag) is what switches this page into the "Verify your
  // email" screen below - reusing the exact same shared
  // <EmailVerificationForm> component (components/
  // EmailVerificationForm.jsx) Register.jsx's own OTP step already uses,
  // never a second implementation.
  const [verifyUserId, setVerifyUserId] = useState(null);

  // A one-time success banner, from two possible sources: (a)
  // Register.jsx navigating back here with `state: { emailVerified: true }`
  // once a brand-new registration finishes verifying, or (b) this page's
  // own verification screen below completing successfully. Lazy-
  // initialized exactly once, the same established pattern
  // `showSessionExpired` above already uses, so a later re-render never
  // re-reads router state a second time.
  const [verifiedMessage, setVerifiedMessage] = useState(() => (
    location.state?.emailVerified ? 'Email verified successfully. You can now sign in.' : ''
  ));

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
    setVerifiedMessage('');

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
      // EMAIL VERIFICATION UX FIX (corrected). The backend's login() 403
      // response body is exactly:
      //   { status: 'error', message: '...',
      //     data: { userId, emailVerificationRequired: true } }
      // i.e. `userId`/`emailVerificationRequired` are nested ONE LEVEL
      // DEEPER than the response's own top-level `data` field name would
      // suggest - services/api.js's shared request() helper throws an
      // Error whose `.data` is the RAW, unmodified body above (so
      // `error.data.emailVerificationRequired` is always undefined - that
      // field only exists at `error.data.data.emailVerificationRequired`).
      // A previous version of this fix read `error.data.emailVerificationRequired`
      // directly, which is why the Verify Email screen never actually
      // appeared even though the network tab showed the right 403 payload.
      // `error.payload` (services/api.js) is the corrected, generic fix:
      // it flattens whichever convention a given endpoint used (top-level
      // extra fields, or nested under `data`) into one object, so this
      // check works regardless of that backend inconsistency, and so does
      // any other endpoint that follows either shape in the future. Only
      // this one specific, structurally-checked shape enters the verify
      // flow; every other error (wrong password, deactivated account,
      // network failure, etc.) still falls through to the plain error
      // message below exactly as before.
      if (error?.payload?.emailVerificationRequired === true && typeof error?.payload?.userId === 'string') {
        // The password is cleared, not preserved, across the trip into
        // the verification screen - "the user only needs to enter the
        // password again" (task spec) - it is never sent anywhere on the
        // verify screen and there is no reason to keep holding it in
        // memory while an unrelated, unauthenticated flow runs.
        setFormData((prev) => ({ ...prev, password: '' }));
        setVerifyUserId(error.payload.userId);
      } else {
        // DOC-69 - the extra `getApiErrorMessage` safety net specifically
        // on this page (the very first screen an unauthenticated/offline
        // visitor can hit) rather than everywhere - see utils/apiError.js's
        // own comment for why most of this project's existing
        // `error.message` displays don't need it.
        setServerError(getApiErrorMessage(error, 'Login failed. Please try again.'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Any unverified, non-system_admin account that hit the
  // emailVerificationRequired gate above lands here - a Manager created
  // by System Admin (the bug this fix targets), a public-registration
  // Employee who never finished verifying and came back later, an
  // Operator who was originally an Employee, or any other role email
  // verification applies to. System Admin can never reach this screen:
  // the backend's own login() structurally exempts that role from the
  // emailVerificationRequired gate in the first place (see
  // auth.controller.js), so this branch is simply never taken for it.
  if (verifyUserId) {
    return (
      <EmailVerificationForm
        userId={verifyUserId}
        title="Verify your email"
        description="We sent a 6-digit verification code to your email address."
        backLabel="Back to Sign In"
        onBack={() => setVerifyUserId(null)}
        onVerified={() => {
          setVerifyUserId(null);
          setVerifiedMessage('Email verified successfully. You can now sign in.');
        }}
      />
    );
  }

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>Login</h1>
        <p className="auth-subtitle">Sign in to access your Digital Operations Center account.</p>

        {showSessionExpired && !serverError && !verifiedMessage && (
          <p className="form-error form-error-server">Your session has expired. Please sign in again.</p>
        )}
        {verifiedMessage && <p className="form-success">{verifiedMessage}</p>}
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
