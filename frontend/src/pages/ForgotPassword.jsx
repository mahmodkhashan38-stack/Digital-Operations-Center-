import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../services/api.js';
import { EMAIL_REGEX } from '../utils/validation.js';
import getApiErrorMessage from '../utils/apiError.js';

// DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
// This project has no email delivery (no SMTP, no third-party provider, no
// reset links - task spec's own standing constraint) - recovery is
// instead routed through the requesting User's own Organization Manager.
// This page only ever submits { email, companyCode } to the backend
// (authApi.forgotPassword) and shows whatever safe, generic status
// message the backend returns - it never learns (and must never guess)
// whether the account actually exists, is active, or already has a
// pending request; the backend's own response text is displayed verbatim
// (see auth.controller.js's forgotPassword for the full
// enumeration-resistance contract this page deliberately does not
// second-guess).
const COMPANY_CODE_REGEX = /^[A-Za-z0-9]{6}$/;

function ForgotPassword() {
  const { isAuthenticated, isLoading } = useAuth();

  const [formData, setFormData] = useState({ email: '', companyCode: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // A signed-in visitor has no reason to be here - same redirect pattern
  // Login.jsx/Register.jsx already use.
  if (!isLoading && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const handleChange = (event) => {
    const { name, value } = event.target;
    // Company Code is case-insensitive from the user's perspective - the
    // backend normalizes it authoritatively regardless (Register.jsx
    // already established this exact same UX convention).
    const nextValue = name === 'companyCode' ? value.toUpperCase() : value;
    setFormData((prev) => ({ ...prev, [name]: nextValue }));
  };

  const validate = () => {
    const nextErrors = {};
    if (!formData.email.trim()) {
      nextErrors.email = 'Email is required.';
    } else if (!EMAIL_REGEX.test(formData.email)) {
      nextErrors.email = 'Please enter a valid email address.';
    }
    if (!formData.companyCode.trim()) {
      nextErrors.companyCode = 'Company code is required.';
    } else if (!COMPANY_CODE_REGEX.test(formData.companyCode.trim())) {
      nextErrors.companyCode = 'Company code must be 6 letters/digits.';
    }
    return nextErrors;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setServerError('');
    setSuccessMessage('');

    // Task spec section 34 item 60 - "double-submit prevented". Guards
    // against a second click while the first request is still in flight,
    // the same `isSubmitting` gate every other auth form in this project
    // already uses on its submit button (`disabled={isSubmitting}` below)
    // - this extra early-return is defense in depth against a rapid
    // double Enter-key submit racing ahead of React's own re-render.
    if (isSubmitting) {
      return;
    }

    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await authApi.forgotPassword({
        email: formData.email.trim(),
        companyCode: formData.companyCode.trim(),
      });
      // Task spec section 19 - display the backend's own safe message
      // verbatim, never a locally-invented one that might drift from the
      // backend's carefully-chosen enumeration-resistant wording.
      setSuccessMessage(response.message || 'Your password reset request has been submitted for manager review.');
      setFormData({ email: '', companyCode: '' });
    } catch (error) {
      // Reached only for a genuine input-format problem (invalid
      // email/companyCode shape, or an unknown/inactive company code -
      // see the backend's own documented decision to keep THAT one
      // signal consistent with Register's existing behavior). Never a
      // raw network/technical string (task spec section 62).
      setServerError(getApiErrorMessage(error, 'Unable to submit your request. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>Forgot Password</h1>
        <p className="auth-subtitle">
          Enter your email and your organization&apos;s Company Code. Your Organization Manager
          will review the request and reset your password - no email will be sent.
        </p>

        {serverError && <p className="form-error form-error-server">{serverError}</p>}

        {successMessage ? (
          <>
            <p className="form-success">{successMessage}</p>
            <div className="form-actions">
              <Link to="/login" className="btn btn-primary btn-block">
                Back to Login
              </Link>
            </div>
          </>
        ) : (
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
                  disabled={isSubmitting}
                />
              </div>
              {errors.email && <span className="form-error">{errors.email}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="companyCode">Company Code</label>
              <div className="input-group">
                <span className="input-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="7" width="18" height="13" rx="2" />
                    <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </span>
                <input
                  id="companyCode"
                  name="companyCode"
                  type="text"
                  placeholder="A7K9P2"
                  maxLength={6}
                  autoCapitalize="characters"
                  value={formData.companyCode}
                  onChange={handleChange}
                  disabled={isSubmitting}
                />
              </div>
              <span className="form-hint">This identifies your organization so your Manager can review the request.</span>
              {errors.companyCode && <span className="form-error">{errors.companyCode}</span>}
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
                {isSubmitting ? 'Submitting...' : 'Submit Request'}
              </button>
              <Link to="/login" className="btn btn-outline btn-block">
                Back to Login
              </Link>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

export default ForgotPassword;
