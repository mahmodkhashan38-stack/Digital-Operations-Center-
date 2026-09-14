import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../services/api.js';
import { EMAIL_REGEX } from '../utils/validation.js';
import getApiErrorMessage from '../utils/apiError.js';

// Mirrors the backend's Company Code format (DOC-41): 6 letters/digits.
// This is just a fast, friendly client-side check for obviously wrong
// input - the backend (src/utils/companyCode.js) remains the authority on
// what is actually valid and whether the code resolves to a real,
// active Organization.
const COMPANY_CODE_REGEX = /^[A-Za-z0-9]{6}$/;

// The one-time code length - matches backend/src/utils/otp.js's
// OTP_LENGTH exactly. This is display/UX only (maxLength on the input);
// the backend is the sole authority on what code is actually accepted.
const OTP_LENGTH = 6;

// DOC EMAIL AUTHENTICATION & NOTIFICATION UPGRADE ("REGISTRATION UPDATE" +
// "OTP VERIFICATION FLOW"). Registration is a two-step page:
//
//   STEP 'form' - fullName/email/password/companyCode only - the retired
//     Sprint 7 phoneNumber field has been removed entirely (see git
//     history). Submitting calls authApi.register - the backend creates
//     the real User document immediately (emailVerificationStatus:
//     'pending') and sends a 6-digit OTP to that email
//     (services/emailVerification.service.js). The account CANNOT sign
//     in yet - see auth.controller.js's login() email-verification gate -
//     so this page does not redirect to /login the moment the account is
//     created; it advances to the OTP step instead.
//   STEP 'verify' - the person enters the 6-digit code they received by
//     email. This calls the public POST /api/auth/verify-email endpoint
//     (authApi.verifyEmail) with { userId, code } - `userId` is simply
//     `data.id` from the register response above, never anything the user
//     types. A "Resend code" action (authApi.resendEmailOtp) is available
//     for the case where the email is slow, undelivered, or the original
//     code (10-minute expiry, see emailVerification.service.js) has
//     lapsed. Only after verification succeeds does this page send the
//     person to /login - there is still no auto-login here: verifying an
//     email is not the same event as authenticating, and the account's
//     password was already collected and hashed in the STEP 'form'
//     request above.
//
// Neither step ever stores the password or OTP code anywhere but this
// component's own in-memory React state - nothing is written to
// localStorage/sessionStorage (see this project's established
// browser-storage restriction), and both are discarded the instant this
// component unmounts (e.g. navigating away).
function Register() {
  const navigate = useNavigate();
  const { register, isAuthenticated, isLoading } = useAuth();

  const [step, setStep] = useState('form'); // 'form' | 'verify'
  const [registeredUserId, setRegisteredUserId] = useState(null);

  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyCode: '',
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpServerError, setOtpServerError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  if (!isLoading && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleChange = (event) => {
    const { name, value } = event.target;
    // Company Code is case-insensitive from the user's perspective; the
    // backend normalizes it authoritatively regardless, but uppercasing it
    // as the person types makes it visually match the code they were given.
    const nextValue = name === 'companyCode' ? value.toUpperCase() : value;
    setFormData((prev) => ({ ...prev, [name]: nextValue }));
  };

  const validate = () => {
    const nextErrors = {};

    if (!formData.fullName.trim()) {
      nextErrors.fullName = 'Full name is required.';
    }

    if (!formData.email.trim()) {
      nextErrors.email = 'Email is required.';
    } else if (!EMAIL_REGEX.test(formData.email)) {
      nextErrors.email = 'Please enter a valid email address.';
    }

    if (!formData.password) {
      nextErrors.password = 'Password is required.';
    } else if (formData.password.length < 6) {
      nextErrors.password = 'Password must be at least 6 characters.';
    }

    if (formData.confirmPassword !== formData.password) {
      nextErrors.confirmPassword = 'Passwords do not match.';
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

    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await register({
        fullName: formData.fullName.trim(),
        email: formData.email.trim(),
        password: formData.password,
        companyCode: formData.companyCode.trim(),
      });
      // The password is cleared the instant it is no longer needed - the
      // account has already been created server-side by this point, and
      // nothing on the 'verify' step ever needs it again.
      setFormData((prev) => ({ ...prev, password: '', confirmPassword: '' }));
      setRegisteredUserId(response.data.id);
      setStep('verify');
    } catch (error) {
      // DOC-69 - same defensive safety net as Login.jsx - see
      // utils/apiError.js's own comment.
      setServerError(getApiErrorMessage(error, 'Registration failed. Please try again.'));
      setFormData((prev) => ({ ...prev, password: '', confirmPassword: '' }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifySubmit = async (event) => {
    event.preventDefault();
    setOtpServerError('');
    setResendMessage('');

    if (!otpCode.trim() || otpCode.trim().length !== OTP_LENGTH) {
      setOtpError(`Please enter the ${OTP_LENGTH}-digit code we sent you.`);
      return;
    }
    setOtpError('');

    setIsVerifying(true);
    try {
      await authApi.verifyEmail({ userId: registeredUserId, code: otpCode.trim() });
      navigate('/login', { state: { emailVerified: true } });
    } catch (error) {
      setOtpServerError(getApiErrorMessage(error, 'Verification failed. Please check the code and try again.'));
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResendCode = async () => {
    setOtpServerError('');
    setResendMessage('');
    setIsResending(true);
    try {
      await authApi.resendEmailOtp({ userId: registeredUserId });
      setResendMessage('A new code has been sent to your email.');
    } catch (error) {
      setOtpServerError(getApiErrorMessage(error, 'Could not resend the code. Please try again shortly.'));
    } finally {
      setIsResending(false);
    }
  };

  if (step === 'verify') {
    return (
      <section className="page auth-page">
        <div className="card auth-card">
          <h1>Verify Your Email</h1>
          <p className="auth-subtitle">
            We sent a verification code to your email address. Enter it below to
            finish creating your account. You will not be able to sign in until your email is verified.
          </p>

          {otpServerError && <p className="form-error form-error-server">{otpServerError}</p>}
          {resendMessage && <p className="form-success">{resendMessage}</p>}

          <form className="auth-form" onSubmit={handleVerifySubmit} noValidate>
            <div className="form-group">
              <label htmlFor="otpCode">Verification Code</label>
              <div className="input-group">
                <span className="input-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <path d="M3 9h18" />
                  </svg>
                </span>
                <input
                  id="otpCode"
                  name="otpCode"
                  type="text"
                  inputMode="numeric"
                  maxLength={OTP_LENGTH}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, ''))}
                />
              </div>
              {otpError && <span className="form-error">{otpError}</span>}
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary btn-block" disabled={isVerifying}>
                {isVerifying ? 'Verifying...' : 'Verify Email'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-block"
                onClick={handleResendCode}
                disabled={isResending}
              >
                {isResending ? 'Sending...' : 'Resend Code'}
              </button>
            </div>
          </form>
        </div>
      </section>
    );
  }

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>Register</h1>
        <p className="auth-subtitle">Create an account to start reporting operational requests.</p>

        {serverError && <p className="form-error form-error-server">{serverError}</p>}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="fullName">Full Name</label>
            <div className="input-group">
              <span className="input-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
                </svg>
              </span>
              <input
                id="fullName"
                name="fullName"
                type="text"
                autoComplete="name"
                placeholder="John Doe"
                value={formData.fullName}
                onChange={handleChange}
              />
            </div>
            {errors.fullName && <span className="form-error">{errors.fullName}</span>}
          </div>

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
                autoComplete="new-password"
                placeholder="••••••••"
                value={formData.password}
                onChange={handleChange}
              />
            </div>
            {errors.password && <span className="form-error">{errors.password}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <div className="input-group">
              <span className="input-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
              </span>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={formData.confirmPassword}
                onChange={handleChange}
              />
            </div>
            {errors.confirmPassword && <span className="form-error">{errors.confirmPassword}</span>}
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
              />
            </div>
            <span className="form-hint">Ask your organization for this code - it connects your account to them.</span>
            {errors.companyCode && <span className="form-error">{errors.companyCode}</span>}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
              {isSubmitting ? 'Creating account...' : 'Register'}
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

export default Register;
