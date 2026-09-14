import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../services/api.js';
import { EMAIL_REGEX } from '../utils/validation.js';
import getApiErrorMessage from '../utils/apiError.js';

// DOC EMAIL AUTHENTICATION & NOTIFICATION UPGRADE replaced DOC-70's
// Manager-approval recovery flow entirely (see auth.controller.js's
// forgotPassword) - and, before that, the retired Sprint 7 SMS-delivery
// mechanism (see git history). Recovery is fully self-service, with NO
// Manager approval: if the account exists, is active, and has a VERIFIED
// email address, the backend generates a secure temporary password,
// emails it to that address (the one already on file - this page never
// lets the person choose an alternate destination), and forces a
// permanent-password change on next login (see ChangePassword.jsx). This
// page still only ever submits { email, companyCode } to the backend
// (authApi.forgotPassword) and shows whatever safe, generic status
// message the backend returns - it never learns (and must never guess)
// whether the account actually exists, is active, has a verified email,
// or whether the email actually delivered; the backend's own response
// text is displayed verbatim (see auth.controller.js's forgotPassword for
// the full enumeration-resistance contract - a single identical response
// covers every possible outcome, including genuine success).
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
      // Sprint 7 (task spec section 19 equivalent) - display the backend's
      // own safe message verbatim, never a locally-invented one that might
      // drift from the backend's carefully-chosen enumeration-resistant
      // wording. The fallback string below is only ever shown if the
      // backend response is somehow missing its own `message` entirely -
      // it deliberately matches the SAME generic, no-information-leaked
      // tone as GENERIC_FORGOT_PASSWORD_MESSAGE in auth.controller.js.
      setSuccessMessage(
        response.message
          || 'If an account matches those details and has a verified email address, a temporary password has been sent to it.',
      );
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
          Enter your email and your organization&apos;s Company Code. If the account is eligible, a temporary
          password will be sent to your registered email - no Manager approval is needed. Sign in with the
          temporary password and you will be required to choose a new one.
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
              <span className="form-hint">This identifies your organization so we can find your account.</span>
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
