import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../services/api.js';
import { destinationForRole } from '../utils/roleRoutes.js';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../utils/validation.js';

// DOC-57 - "Secure Password Management". One shared authenticated page,
// reachable by every role (system_admin/manager/operator/employee) via
// two different paths:
//   1. Voluntarily, from the Navbar's "Change Password" link - available
//      at any time, regardless of `user.mustChangePassword`.
//   2. Involuntarily, redirected here by ProtectedRoute.jsx whenever
//      `user.mustChangePassword === true` (a Manager reset happened) -
//      this same page is also where that state gets cleared, via a
//      successful submission here.
// Either way this is the exact same form/component - there is no second,
// "forced" variant of this page. The backend (PATCH
// /api/auth/change-password, always reachable regardless of
// mustChangePassword - see middleware/requirePasswordChangeCompleted.js)
// remains the sole authority on whether a submission actually succeeds;
// this page's own validation is only for fast, friendly feedback.
function ChangePassword() {
  const navigate = useNavigate();
  const { user, token, updateUser } = useAuth();

  const [formData, setFormData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const validate = () => {
    const nextErrors = {};

    if (!formData.currentPassword) {
      nextErrors.currentPassword = 'Current password is required.';
    }

    if (!formData.newPassword) {
      nextErrors.newPassword = 'New password is required.';
    } else if (formData.newPassword.length < MIN_PASSWORD_LENGTH) {
      nextErrors.newPassword = `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (formData.newPassword.length > MAX_PASSWORD_LENGTH) {
      nextErrors.newPassword = `New password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }

    if (!formData.confirmPassword) {
      nextErrors.confirmPassword = 'Please confirm your new password.';
    } else if (formData.confirmPassword !== formData.newPassword) {
      nextErrors.confirmPassword = 'Passwords do not match.';
    }

    // Client-side-only early check for immediate feedback - the backend
    // independently re-checks this against the real stored hash
    // regardless (this check here can only ever compare the two typed
    // strings, not prove anything about the actual current password).
    if (formData.newPassword && formData.currentPassword && formData.newPassword === formData.currentPassword) {
      nextErrors.newPassword = 'New password must be different from your current password.';
    }

    return nextErrors;
  };

  // Clears every password field - used both after a successful change
  // (task spec: "clear sensitive fields after success") and is never
  // itself a place any of these values are persisted anywhere (no
  // localStorage, no logging).
  const clearFields = () => {
    setFormData({ currentPassword: '', newPassword: '', confirmPassword: '' });
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
      const response = await authApi.changePassword(
        {
          currentPassword: formData.currentPassword,
          newPassword: formData.newPassword,
          confirmPassword: formData.confirmPassword,
        },
        token,
      );
      // The backend's own response is the only source of truth for the
      // user's new state (mustChangePassword is now false) - never a
      // locally-guessed update.
      updateUser(response.data);
      clearFields();
      navigate(destinationForRole(response.data?.role), { replace: true });
    } catch (error) {
      // Failed: nothing is cleared - the backend's own client-safe error
      // message (wrong current password, mismatch, weak password, ...) is
      // shown inline, and the typed fields stay exactly as they were so
      // the person doesn't have to retype everything.
      setServerError(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>Change Password</h1>
        <p className="auth-subtitle">
          {user?.mustChangePassword
            ? 'Your password was reset by your Organization Manager. Choose a new password to continue.'
            : 'Update the password for your account.'}
        </p>

        {serverError && <p className="form-error form-error-server">{serverError}</p>}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="currentPassword">Current Password</label>
            <div className="input-group">
              <input
                id="currentPassword"
                name="currentPassword"
                type="password"
                placeholder="••••••••"
                value={formData.currentPassword}
                onChange={handleChange}
                disabled={isSubmitting}
                autoComplete="current-password"
              />
            </div>
            {errors.currentPassword && <span className="form-error">{errors.currentPassword}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="newPassword">New Password</label>
            <div className="input-group">
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                placeholder="••••••••"
                value={formData.newPassword}
                onChange={handleChange}
                disabled={isSubmitting}
                autoComplete="new-password"
              />
            </div>
            {errors.newPassword && <span className="form-error">{errors.newPassword}</span>}
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm New Password</label>
            <div className="input-group">
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                placeholder="••••••••"
                value={formData.confirmPassword}
                onChange={handleChange}
                disabled={isSubmitting}
                autoComplete="new-password"
              />
            </div>
            {errors.confirmPassword && <span className="form-error">{errors.confirmPassword}</span>}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary btn-block" disabled={isSubmitting}>
              {isSubmitting ? 'Changing Password...' : 'Change Password'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

export default ChangePassword;
