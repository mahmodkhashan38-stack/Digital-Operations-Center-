import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, userSelfApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { roleLabel } from '../utils/roleRoutes.js';
import getApiErrorMessage from '../utils/apiError.js';

// DOC-62 - "User Profile". Bounds for the ONE field this page lets a user
// edit about themselves - kept identical to the backend's own
// MIN_SELF_FULLNAME_LENGTH/MAX_SELF_FULLNAME_LENGTH (backend/src/
// controllers/user.controller.js) for fast, consistent client-side
// feedback. The backend remains the sole authority and re-validates
// independently regardless.
const FULLNAME_MIN_LENGTH = 2;
const FULLNAME_MAX_LENGTH = 100;

function validateProfileForm(fullName) {
  const trimmed = fullName.trim();
  if (!trimmed) {
    return 'Full name is required.';
  }
  if (trimmed.length < FULLNAME_MIN_LENGTH || trimmed.length > FULLNAME_MAX_LENGTH) {
    return `Full name must be between ${FULLNAME_MIN_LENGTH} and ${FULLNAME_MAX_LENGTH} characters.`;
  }
  return null;
}

function formatMemberSince(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString();
}

// DOC-62 - "User Profile" (task spec section 14). One shared page for
// every authenticated role (system_admin/manager/operator/employee) - no
// role-specific variant, matching the ticket's own "Profile should work
// for" requirement rather than four separate pages. Reachable at /profile,
// wrapped in the plain `<ProtectedRoute>` (no `roles` restriction) in
// App.jsx - a signed-in user with `mustChangePassword === true` never
// actually sees this page's own content: ProtectedRoute's existing forced-
// change redirect (DOC-57) already sends them to /change-password first,
// completely unchanged, before this component would ever render (task
// spec section 3: "Do not accidentally let mustChangePassword users bypass
// the forced change by visiting Profile").
function Profile() {
  const { user, token, updateUser } = useAuth();

  // Organization display (task spec section 9): Manager/Operator/Employee
  // see their Organization's name; System Admin sees a platform-level
  // notice instead of attempting a call that would only ever 404 (System
  // Admin's own organizationId is always null - see backend/src/
  // controllers/organization.controller.js's getMyOrganization). Reuses
  // the exact same GET /organizations/me endpoint every other organization-
  // scoped dashboard already calls - no new backend surface for this.
  const [organization, setOrganization] = useState(null);
  const [orgError, setOrgError] = useState('');

  const loadOrganization = useCallback(async () => {
    if (!user || user.role === 'system_admin') return;
    setOrgError('');
    try {
      const response = await organizationApi.getMine(token);
      setOrganization(response.data);
    } catch (error) {
      setOrgError(getApiErrorMessage(error, 'Unable to load organization information.'));
    }
  }, [token, user]);

  useEffect(() => {
    loadOrganization();
  }, [loadOrganization]);

  const [fullName, setFullName] = useState(user?.fullName || '');
  const [fieldError, setFieldError] = useState('');
  const [serverError, setServerError] = useState('');
  const [success, setSuccess] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Re-syncs the editable field whenever the AuthContext's own `user`
  // changes - both on initial load AND right after a successful save
  // (whose response replaces `user` below), so the form always reflects
  // the backend's own confirmed current value, never a locally-guessed one.
  useEffect(() => {
    setFullName(user?.fullName || '');
  }, [user]);

  const hasChanges = useMemo(() => {
    if (!user) return false;
    return fullName.trim() !== (user.fullName || '');
  }, [fullName, user]);

  const handleChange = (event) => {
    setFullName(event.target.value);
    setSuccess('');
    setFieldError('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    // Re-checked here, not only via the Save button's own `disabled`
    // attribute (task spec section 15: "Recheck no-change in submit
    // handler.") - and prevents a double-submit while a save is already in
    // flight.
    if (isSaving || !hasChanges) {
      return;
    }

    setServerError('');
    setSuccess('');

    const validationError = validateProfileForm(fullName);
    setFieldError(validationError || '');
    if (validationError) {
      return;
    }

    setIsSaving(true);
    try {
      const response = await userSelfApi.updateMine({ fullName: fullName.trim() }, token);
      // The backend's own response is the only source of truth for the
      // caller's new state - never a locally-guessed update. AuthContext's
      // existing `updateUser` (already used by ChangePassword.jsx) is what
      // makes the new fullName appear in the Navbar and everywhere else
      // `user` is read, immediately, with no logout/login and no page
      // reload required (task spec sections 16/17).
      updateUser(response.data);
      setSuccess('Profile updated successfully.');
    } catch (error) {
      setServerError(getApiErrorMessage(error, 'Unable to update your profile. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  // Organization display value (task spec section 9): never the raw
  // organizationId as the primary UI value. System Admin gets a fixed,
  // human-readable notice; everyone else gets the loaded Organization's
  // name once it resolves, a loading placeholder while it's in flight, or
  // the safe error message if the load failed.
  let organizationDisplay = 'No organization';
  if (user?.role === 'system_admin') {
    organizationDisplay = 'Platform-level account';
  } else if (orgError) {
    organizationDisplay = orgError;
  } else if (organization) {
    organizationDisplay = organization.name;
  } else {
    organizationDisplay = 'Loading...';
  }

  return (
    <section className="page">
      <DashboardHeader
        title="My Profile"
        subtitle="View your account information and update your display name."
      />

      <div className="card admin-panel profile-panel">
        <h2>Account Information</h2>

        {!user ? (
          <p className="auth-subtitle">Loading your profile...</p>
        ) : (
          <form className="org-settings-form" onSubmit={handleSubmit} noValidate>
            <div className="form-group">
              <label htmlFor="profile-fullName">Full Name</label>
              <input
                id="profile-fullName"
                name="fullName"
                type="text"
                value={fullName}
                onChange={handleChange}
                disabled={isSaving}
                maxLength={FULLNAME_MAX_LENGTH}
              />
              {fieldError && <p className="form-error">{fieldError}</p>}
            </div>

            <div className="form-group">
              <label htmlFor="profile-email">Email</label>
              <input id="profile-email" type="email" value={user.email || ''} disabled readOnly />
              <p className="field-hint">Email is read-only and cannot be changed from your profile.</p>
            </div>

            <div className="org-info-details">
              <div className="org-card-detail">
                <span className="stat-label">Role</span>
                <span className="stat-value">{roleLabel(user.role)}</span>
              </div>
              <div className="org-card-detail">
                <span className="stat-label">Organization</span>
                <span className="stat-value">{organizationDisplay}</span>
              </div>
              <div className="org-card-detail">
                <span className="stat-label">Account Status</span>
                <StatusBadge isActive={user.isActive} />
              </div>
              <div className="org-card-detail">
                <span className="stat-label">Member Since</span>
                <span className="stat-value">{formatMemberSince(user.createdAt)}</span>
              </div>
            </div>

            {serverError && <p className="form-error form-error-server">{serverError}</p>}
            {success && <p className="form-success">{success}</p>}

            <div className="form-actions profile-actions">
              <button type="submit" className="btn btn-primary" disabled={isSaving || !hasChanges}>
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
              <Link to="/change-password" className="btn btn-outline">
                Change Password
              </Link>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

export default Profile;
