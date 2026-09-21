import { useState } from 'react';
import { authApi } from '../services/api.js';
import getApiErrorMessage from '../utils/apiError.js';

// The one-time code length - matches backend/src/utils/otp.js's
// OTP_LENGTH exactly. This is display/UX only (maxLength on the input);
// the backend is the sole authority on what code is actually accepted.
const OTP_LENGTH = 6;

// EMAIL VERIFICATION UX FIX - shared "enter the 6-digit code" screen,
// extracted out of Register.jsx's own pre-existing 'verify' step so
// Login.jsx can reuse the EXACT same logic (task spec: "Do not duplicate
// verification logic unnecessarily... extract or reuse a small shared
// component"). Talks to the same two PUBLIC backend endpoints every
// caller already used before this extraction - POST /api/auth/verify-email
// (authApi.verifyEmail) and POST /api/auth/resend-email-otp
// (authApi.resendEmailOtp) - both keyed ONLY by `userId`, never by an
// email address this component could be tricked into changing (task spec
// section 11: "Do not allow changing the target email during
// verification" - there is no email input on this form at all).
//
// This component is intentionally "dumb": it owns only the OTP input and
// the verify/resend network calls. It never decides what happens after a
// successful verification (`onVerified`) or what "give up and go back"
// means (`onBack`) - each caller (Register.jsx, Login.jsx) supplies that,
// since a brand-new registration and a login-time verification gate need
// different post-verification destinations (Register always continues on
// to /login; Login is already ON /login and just needs to return to its
// own sign-in form). The backend remains the sole authority on whether a
// code is actually correct/expired/rate-limited/already-verified - every
// message shown here (success, wrong code, expired, rate limit, already
// verified) is the backend's own client-safe message text, passed through
// exactly like every other form in this app already does via
// getApiErrorMessage - this component never invents or guesses one.
function EmailVerificationForm({
  userId,
  title,
  description,
  onVerified,
  onBack,
  backLabel = 'Back',
}) {
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState('');
  const [otpServerError, setOtpServerError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

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
      // Exact existing contract - { userId, code } - never a new endpoint
      // and never anything beyond these two fields (task spec: "Do not
      // invent a new endpoint if the existing endpoint already supports
      // this flow").
      await authApi.verifyEmail({ userId, code: otpCode.trim() });
      onVerified();
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
      await authApi.resendEmailOtp({ userId });
      setResendMessage('A new code has been sent to your email.');
    } catch (error) {
      // The backend's own rate-limit (max 3 resends / 15 min per userId+IP)
      // and "already verified" responses surface here unchanged - see
      // backend/src/routes/auth.routes.js / auth.controller.js.
      setOtpServerError(getApiErrorMessage(error, 'Could not resend the code. Please try again shortly.'));
    } finally {
      setIsResending(false);
    }
  };

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>{title}</h1>
        <p className="auth-subtitle">{description}</p>

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
            {/* Register.jsx's original 'verify' step never had a "go back"
                action (there is nothing useful to return to mid-
                registration) - only Login.jsx's own use of this component
                supplies `onBack`, so this renders conditionally rather than
                every caller being forced to have one. */}
            {onBack && (
              <button type="button" className="btn btn-outline btn-block" onClick={onBack}>
                {backLabel}
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

export default EmailVerificationForm;
