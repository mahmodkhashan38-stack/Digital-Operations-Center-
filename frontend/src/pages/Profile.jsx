import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, userSelfApi } from '../services/api.js';
import DashboardHeader from '../components/DashboardHeader.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import ActiveSessionsPanel from '../components/ActiveSessionsPanel.jsx';
import Avatar from '../components/Avatar.jsx';
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

// DOC-71 - "Enhanced User Profile: Profile Picture + Bio". Kept identical
// to the backend's own MAX_BIO_LENGTH (backend/src/utils/
// userFieldValidation.js) and ALLOWED_MIME_TYPES/MAX_FILE_SIZE_BYTES
// (backend/src/middleware/upload.js) for fast, consistent client-side
// feedback only - the backend remains the sole authority and re-validates
// every one of these independently regardless (task spec section 15:
// "Client-side checks are convenience; backend is authoritative").
const BIO_MAX_LENGTH = 250;
const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

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

// DOC-71 (task spec section 9 - "Bio must be plain text only... never
// rendered via dangerouslySetInnerHTML/innerHTML"). This client never
// needs to render bio as HTML at all - it is only ever placed inside a
// `<textarea>` (as a value, always escaped by React/the DOM) and, on
// display, this same plain-string form. Client-side length validation
// only; a non-string type is not reachable from a plain `<textarea>`'s
// `.value`, so there is nothing else to check here that the backend does
// not already re-validate authoritatively.
function validateBioForm(bio) {
  if (bio.trim().length > BIO_MAX_LENGTH) {
    return `Bio must be at most ${BIO_MAX_LENGTH} characters.`;
  }
  return null;
}

function validateImageFile(file) {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
    return 'Only JPEG, PNG, and WEBP images are supported.';
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return 'Image must be 5 MB or smaller.';
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
  const [bio, setBio] = useState(user?.bio || '');
  const [fieldError, setFieldError] = useState('');
  const [bioFieldError, setBioFieldError] = useState('');
  const [serverError, setServerError] = useState('');
  const [success, setSuccess] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Re-syncs the editable fields whenever the AuthContext's own `user`
  // changes - both on initial load AND right after a successful save
  // (whose response replaces `user` below), so the form always reflects
  // the backend's own confirmed current value, never a locally-guessed one.
  useEffect(() => {
    setFullName(user?.fullName || '');
    setBio(user?.bio || '');
  }, [user]);

  const hasChanges = useMemo(() => {
    if (!user) return false;
    return fullName.trim() !== (user.fullName || '') || bio.trim() !== (user.bio || '');
  }, [fullName, bio, user]);

  const handleChange = (event) => {
    setFullName(event.target.value);
    setSuccess('');
    setFieldError('');
  };

  const handleBioChange = (event) => {
    setBio(event.target.value);
    setSuccess('');
    setBioFieldError('');
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
    const bioValidationError = validateBioForm(bio);
    setBioFieldError(bioValidationError || '');
    if (validationError || bioValidationError) {
      return;
    }

    setIsSaving(true);
    try {
      // DOC-71 - `bio` now rides along with `fullName` in the same PATCH
      // /api/users/me call - the backend independently decides whether
      // this counts as a "real" profile change worth an Audit Log entry
      // (only when fullName itself changed - see user.controller.js's own
      // updateMyProfile) regardless of what this client sends, so sending
      // both every time here is safe even when only one actually changed.
      const trimmedBio = bio.trim();
      const response = await userSelfApi.updateMine(
        { fullName: fullName.trim(), bio: trimmedBio === '' ? null : trimmedBio },
        token,
      );
      // The backend's own response is the only source of truth for the
      // caller's new state - never a locally-guessed update. AuthContext's
      // existing `updateUser` (already used by ChangePassword.jsx) is what
      // makes the new fullName/bio appear everywhere `user` is read,
      // immediately, with no logout/login and no page reload required
      // (task spec sections 16/17).
      updateUser(response.data);
      setSuccess('Profile updated successfully.');
    } catch (error) {
      setServerError(getApiErrorMessage(error, 'Unable to update your profile. Please try again.'));
    } finally {
      setIsSaving(false);
    }
  };

  // ---------- DOC-71 - Profile Photo (upload / replace / remove) ----------
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [photoError, setPhotoError] = useState('');
  const [photoSuccess, setPhotoSuccess] = useState('');
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [isRemovingPhoto, setIsRemovingPhoto] = useState(false);

  // Revokes the local preview object URL whenever it changes/unmounts -
  // this is a client-only preview (task spec section 16: "image preview
  // before upload"), never the same object URL Avatar.jsx manages for the
  // already-saved image, so it needs its own independent cleanup.
  useEffect(() => () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
  }, [previewUrl]);

  const handleChoosePhotoClick = () => {
    if (isUploadingPhoto || isRemovingPhoto) return;
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event) => {
    const file = event.target.files && event.target.files[0];
    // Always reset the input's own value so selecting the SAME file twice
    // in a row (e.g. after cancelling) still fires this handler again.
    event.target.value = '';
    if (!file) return;

    setPhotoSuccess('');
    const validationError = validateImageFile(file);
    if (validationError) {
      setPhotoError(validationError);
      return;
    }

    setPhotoError('');
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleCancelPhoto = () => {
    if (isUploadingPhoto) return;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setSelectedFile(null);
    setPreviewUrl(null);
    setPhotoError('');
  };

  const handleSavePhoto = async () => {
    if (!selectedFile || isUploadingPhoto) return;
    setPhotoError('');
    setIsUploadingPhoto(true);
    try {
      const response = await userSelfApi.uploadProfileImage(selectedFile, token);
      updateUser(response.data);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      setSelectedFile(null);
      setPreviewUrl(null);
      setPhotoSuccess('Profile photo updated.');
    } catch (error) {
      setPhotoError(getApiErrorMessage(error, 'Unable to upload your photo. Please try again.'));
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  const handleRemovePhoto = async () => {
    if (isRemovingPhoto || isUploadingPhoto) return;
    setPhotoError('');
    setPhotoSuccess('');
    setIsRemovingPhoto(true);
    try {
      const response = await userSelfApi.deleteProfileImage(token);
      updateUser(response.data);
      setPhotoSuccess('Profile photo removed.');
    } catch (error) {
      setPhotoError(getApiErrorMessage(error, 'Unable to remove your photo. Please try again.'));
    } finally {
      setIsRemovingPhoto(false);
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
            {/* DOC-71 - "Enhanced User Profile: Profile Picture + Bio".
                Avatar shows the SELECTED-BUT-NOT-YET-SAVED file's local
                preview while one is pending (task spec section 16), the
                already-saved image otherwise, or initials - Avatar.jsx
                itself never shows a broken-image icon either way. */}
            <div className="profile-photo-section">
              {previewUrl ? (
                <img src={previewUrl} alt="Selected profile preview" className="avatar avatar-large" />
              ) : (
                <Avatar profileImageUrl={user.profileImage?.url} fullName={user.fullName} size="large" />
              )}
              <div className="profile-photo-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileSelected}
                  style={{ display: 'none' }}
                />
                <div className="profile-photo-buttons">
                  {previewUrl ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={handleSavePhoto}
                        disabled={isUploadingPhoto}
                      >
                        {isUploadingPhoto ? 'Uploading...' : 'Save Photo'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-small"
                        onClick={handleCancelPhoto}
                        disabled={isUploadingPhoto}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-outline btn-small"
                        onClick={handleChoosePhotoClick}
                        disabled={isUploadingPhoto || isRemovingPhoto}
                      >
                        Change Photo
                      </button>
                      {user.hasProfileImage && (
                        <button
                          type="button"
                          className="btn btn-danger btn-small"
                          onClick={handleRemovePhoto}
                          disabled={isRemovingPhoto || isUploadingPhoto}
                        >
                          {isRemovingPhoto ? 'Removing...' : 'Remove Photo'}
                        </button>
                      )}
                    </>
                  )}
                </div>
                <p className="profile-photo-hint">JPEG, PNG, or WEBP. Up to 5 MB.</p>
                {photoError && <p className="form-error">{photoError}</p>}
                {photoSuccess && <p className="form-success">{photoSuccess}</p>}
              </div>
            </div>

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
              <label htmlFor="profile-bio">Bio</label>
              <textarea
                id="profile-bio"
                name="bio"
                rows={3}
                value={bio}
                onChange={handleBioChange}
                disabled={isSaving}
                maxLength={BIO_MAX_LENGTH}
                placeholder="Say a little about yourself..."
              />
              <span className={`profile-bio-counter ${bio.length > BIO_MAX_LENGTH ? 'profile-bio-counter-over' : ''}`}>
                {bio.length}/{BIO_MAX_LENGTH}
              </span>
              {bioFieldError && <p className="form-error">{bioFieldError}</p>}
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

      {/* DOC-69 - "Login History & Active Sessions". Self-contained (owns
          its own fetch/loading/error state) - see that component's own top
          comment. Rendered only once `user` has actually loaded, exactly
          like the Account Information card above it. */}
      {user && <ActiveSessionsPanel />}
    </section>
  );
}

export default Profile;
