import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';
import { EMAIL_REGEX } from '../utils/validation.js';

// A single Employee or Operator row inside the Manager Dashboard's user
// table. `actionRole` is the ONE role this row's Promote/Demote button may
// request ('operator' for an Employee row, 'employee' for an Operator
// row) - there is no dropdown offering every role, because the backend
// (DOC-35) only ever allows these two exact transitions in the first
// place. `manager` and `system_admin` are never options here, and never
// will be: this component has no code path that could send either, and
// the Manager's own row is never rendered here at all (see
// ManagerDashboard.jsx, which only ever builds Employee/Operator sections).
//
// DOC-50 added two more actions, following the exact same "only reflect
// the change once the backend confirms it" pattern the Promote/Demote
// button already used: Edit (fullName/email, toggles inline edit mode for
// this row) and Activate/Deactivate. Both call an async prop owned by the
// parent (ManagerDashboard), which is what actually calls the backend and
// updates the shared user list on success - if a request fails, nothing
// about `user` has changed, and the backend's own client-safe error
// message is shown inline instead of pretending the change happened.
//
// DOC-48 ("Organization Employee Removal") reuses this same
// Activate/Deactivate action rather than adding a second, duplicate
// control - a real audit of the existing implementation found DOC-50's
// PATCH /api/users/:id/status already provides the safe, tenant-scoped,
// self/manager/system_admin-protected soft removal DOC-48 asks for (see
// backend/README.md's DOC-48 section). What DOC-48 adds here is exactly
// two things the earlier version was missing: (1) an explicit confirm/
// keep step before DEACTIVATING (never before reactivating - task spec
// section 12 explicitly allows reactivation to stay a simpler direct
// action), mirroring the same dedicated confirm/keep panel pattern
// RequestRow.jsx already uses for DOC-46's "Cancel Request"; and (2)
// surfacing the backend's new optional `warning` (an Operator being
// deactivated while they still have active assigned Requests, task spec
// section 11) as a small non-blocking inline notice - deactivation is
// never blocked by this, it is purely informational.
//
// DOC-44 added a fourth action, "Manage Specialties" - visible ONLY when
// `showSpecialties` is true, which the parent only ever sets for rows in
// the Operators section (never Employees, and the Manager's own row is
// never rendered here at all - see ManagerDashboard.jsx). Same pattern as
// every other action: this row owns its own pending/error/local-selection
// state, but `onUpdateSpecialties` (owned by the parent) is what actually
// calls the backend and is the only thing that ever changes `user.specialties`.
function OrganizationUserRow({
  user,
  actionRole,
  actionLabel,
  onChangeRole,
  onUpdateProfile,
  onToggleStatus,
  showSpecialties = false,
  activeCategories = [],
  categoriesReady = false,
  onUpdateSpecialties,
  onResetPassword,
}) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');

  const [isEditing, setIsEditing] = useState(false);
  const [editValues, setEditValues] = useState({ fullName: user.fullName, email: user.email });
  const [editErrors, setEditErrors] = useState({});
  const [editPending, setEditPending] = useState(false);

  const [statusPending, setStatusPending] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [statusWarning, setStatusWarning] = useState('');

  const [isManagingSpecialties, setIsManagingSpecialties] = useState(false);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([]);
  const [specialtiesError, setSpecialtiesError] = useState('');
  const [specialtiesPending, setSpecialtiesPending] = useState(false);

  // DOC-57 - "Manager Password Reset", redesigned by Sprint 7 - "SMS +
  // Phone Authentication Upgrade" (task spec Phase 12). `onResetPassword`
  // is only ever passed by ManagerDashboard.jsx for rows in the
  // Employees/Operators sections (task spec: "Only Manager sees it" / "Do
  // not show Reset Password for: manager rows, system_admin, the Manager
  // themselves") - this component structurally never renders a Manager's
  // or System Admin's own row at all (see ManagerDashboard.jsx's
  // UserRoleSection, which only ever builds Employee/Operator groups), so
  // no additional role guard is needed here beyond the same "only render
  // the control if the prop was actually passed" pattern every other
  // action on this row already uses.
  //
  // Sprint 7 removed the Manager's ability to type/see a new password
  // entirely (task spec: "Prefer sending a system-generated temporary
  // password directly to user's verified phone... do not let Manager
  // know/send plaintext password") - there is no longer a form here, only
  // a confirm/cancel step exactly like the Deactivate confirm panel above
  // (`showDeactivateConfirm`), since triggering this now takes no input at
  // all: the backend generates the temporary password and SMS's it to the
  // target user's own verified phone (user.controller.js's
  // performPasswordReset).
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetSuccessMessage, setResetSuccessMessage] = useState('');

  const handleChangeRoleClick = async () => {
    setError('');
    setIsPending(true);
    try {
      await onChangeRole(user, actionRole);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsPending(false);
    }
  };

  const openEdit = () => {
    setError('');
    setEditValues({ fullName: user.fullName, email: user.email });
    setEditErrors({});
    setIsEditing(true);
  };

  const handleEditFieldChange = (event) => {
    const { name, value } = event.target;
    setEditValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSaveProfile = async (event) => {
    event.preventDefault();
    setError('');

    const nextErrors = {};
    if (!editValues.fullName.trim()) nextErrors.fullName = 'Name is required.';
    if (!editValues.email.trim()) {
      nextErrors.email = 'Email is required.';
    } else if (!EMAIL_REGEX.test(editValues.email)) {
      nextErrors.email = 'Please enter a valid email address.';
    }
    setEditErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setEditPending(true);
    try {
      await onUpdateProfile(user, {
        fullName: editValues.fullName.trim(),
        email: editValues.email.trim(),
      });
      setIsEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setEditPending(false);
    }
  };

  // DOC-48 - `nextIsActive` is always passed explicitly by the caller
  // (never inferred from `!user.isActive` here) so this same handler can
  // serve both the direct "Activate" click and the confirmed "Deactivate
  // User" click from the confirm panel below without any ambiguity about
  // which direction is being requested.
  const handleToggleStatusClick = async (nextIsActive) => {
    setError('');
    setStatusWarning('');
    setStatusPending(true);
    try {
      const result = await onToggleStatus(user, nextIsActive);
      // Purely informational (task spec section 11) - never blocks or
      // reverts the deactivation that already succeeded.
      if (result && result.warning) {
        setStatusWarning(result.warning);
      }
      setShowDeactivateConfirm(false);
    } catch (err) {
      // Failed: nothing about `user.isActive` has changed - the backend's
      // own client-safe error message is shown inline instead of
      // pretending the change happened. The confirm panel (if open) stays
      // open so the Manager can retry without re-clicking Deactivate.
      setError(err.message);
    } finally {
      setStatusPending(false);
    }
  };

  // DOC-48 - the actual click handler on the row's Deactivate/Activate
  // button: Deactivate opens the confirm panel (never calls the backend
  // directly), Activate calls the backend immediately.
  const handleStatusButtonClick = () => {
    if (user.isActive) {
      setError('');
      setStatusWarning('');
      setShowDeactivateConfirm(true);
      return;
    }
    handleToggleStatusClick(true);
  };

  const openManageSpecialties = () => {
    setError('');
    setSpecialtiesError('');
    setSelectedCategoryIds((user.specialties || []).map((specialty) => specialty.id));
    setIsManagingSpecialties(true);
  };

  const handleToggleCategory = (categoryId) => {
    setSelectedCategoryIds((prev) => (
      prev.includes(categoryId) ? prev.filter((id) => id !== categoryId) : [...prev, categoryId]
    ));
  };

  const handleSaveSpecialties = async (event) => {
    event.preventDefault();
    setSpecialtiesError('');
    setSpecialtiesPending(true);
    try {
      await onUpdateSpecialties(user, selectedCategoryIds);
      setIsManagingSpecialties(false);
    } catch (err) {
      // Nothing about `user.specialties` has changed - the checkbox
      // selection stays exactly as the Manager left it, and the backend's
      // own client-safe error message is shown inline instead of
      // pretending the save succeeded.
      setSpecialtiesError(err.message);
    } finally {
      setSpecialtiesPending(false);
    }
  };

  // Sprint 7 - opens a fresh confirm panel every time (never reuses a
  // previous attempt's leftover error/success message) - the same "start
  // clean" pattern openEdit/openManageSpecialties already use.
  const openResetConfirm = () => {
    setError('');
    setResetError('');
    setResetSuccessMessage('');
    setShowResetConfirm(true);
  };

  const closeResetConfirm = () => {
    setShowResetConfirm(false);
    setResetError('');
    setResetSuccessMessage('');
  };

  // Sprint 7 - no form fields to validate or submit anymore; confirming
  // this action takes no input at all. `onResetPassword` (ManagerDashboard.
  // jsx's handleResetPassword) calls PATCH /api/users/:id/reset-password
  // with no body, which tells the backend to generate a temporary password
  // and SMS it directly to the target user's own verified phone - this
  // component never sees, types, or displays that password at any point.
  const handleConfirmReset = async () => {
    setResetError('');
    setResetSuccessMessage('');
    setResetPending(true);
    try {
      await onResetPassword(user);
      setResetSuccessMessage('A temporary password has been sent to this user by SMS. They must set a new password at their next login.');
    } catch (err) {
      // Failed (most commonly: this user has no verified phone number yet,
      // or the SMS provider failed to deliver) - the backend's own
      // client-safe error message is shown inline; the confirm panel stays
      // open so the Manager can simply try again.
      setResetError(err.message);
    } finally {
      setResetPending(false);
    }
  };

  // DOC-48 - a dedicated confirm/keep panel, never a single accidental
  // click, for deactivation only (task spec section 12). Reuses the same
  // `.cancel-confirm-panel` styling RequestRow.jsx's DOC-46 "Cancel
  // Request" confirmation already established - one visual language for
  // "are you sure about this destructive-adjacent action" across the app.
  if (showDeactivateConfirm) {
    return (
      <tr>
        <td colSpan={5}>
          <div className="cancel-confirm-panel">
            <p>Deactivate this user? They will no longer be able to sign in, but their request history will be preserved.</p>
            {error && <p className="form-error form-error-server">{error}</p>}
            <div className="form-actions form-actions-row">
              <button
                type="button"
                className="btn btn-outline"
                disabled={statusPending}
                onClick={() => {
                  setShowDeactivateConfirm(false);
                  setError('');
                }}
              >
                Keep Active
              </button>
              {/* DOC-69 - `.btn-danger`, for visual consistency with every
                  other destructive confirm action in this project (task
                  spec section 16). */}
              <button
                type="button"
                className="btn btn-danger"
                disabled={statusPending}
                onClick={() => handleToggleStatusClick(false)}
              >
                {statusPending ? 'Deactivating...' : 'Deactivate User'}
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  if (isManagingSpecialties) {
    return (
      <tr>
        <td colSpan={5}>
          <form className="user-row-edit-form" onSubmit={handleSaveSpecialties} noValidate>
            <p className="user-row-edit-title">Manage Specialties for {user.fullName}</p>
            {!categoriesReady ? (
              <p className="auth-subtitle">Loading service categories...</p>
            ) : activeCategories.length === 0 ? (
              <p className="auth-subtitle">
                No active service categories are available. Create a category first.
              </p>
            ) : (
              <div className="specialty-checkbox-list">
                {activeCategories.map((category) => (
                  <label key={category.id} className="specialty-checkbox-option">
                    <input
                      type="checkbox"
                      checked={selectedCategoryIds.includes(category.id)}
                      onChange={() => handleToggleCategory(category.id)}
                    />
                    {category.name}
                  </label>
                ))}
              </div>
            )}
            {specialtiesError && <span className="form-error">{specialtiesError}</span>}
            <div className="form-actions form-actions-row">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={specialtiesPending || !categoriesReady}
              >
                {specialtiesPending ? 'Saving...' : 'Save Specialties'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setIsManagingSpecialties(false)}
                disabled={specialtiesPending}
              >
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  // Sprint 7 - replaced the old newPassword/confirmPassword form with a
  // simple confirm/cancel step (same visual language as the Deactivate
  // confirm panel above) - there is nothing left for the Manager to type,
  // only a decision to make.
  if (showResetConfirm) {
    return (
      <tr>
        <td colSpan={5}>
          <div className="cancel-confirm-panel">
            <p className="user-row-edit-title">Send Temporary Password to {user.fullName}?</p>
            {resetSuccessMessage ? (
              <>
                <p className="form-success">{resetSuccessMessage}</p>
                <div className="form-actions form-actions-row">
                  <button type="button" className="btn btn-outline" onClick={closeResetConfirm}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  A secure, system-generated temporary password will be sent by SMS to this user&apos;s verified phone
                  number. You will not see or choose this password - the user must set a new permanent password the
                  next time they log in.
                </p>
                {resetError && <p className="form-error form-error-server">{resetError}</p>}
                <div className="form-actions form-actions-row">
                  <button type="button" className="btn btn-outline" onClick={closeResetConfirm} disabled={resetPending}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleConfirmReset} disabled={resetPending}>
                    {resetPending ? 'Sending...' : 'Send Temporary Password'}
                  </button>
                </div>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  if (isEditing) {
    return (
      <tr>
        <td colSpan={5}>
          <form className="user-row-edit-form" onSubmit={handleSaveProfile} noValidate>
            <div className="user-row-edit-fields">
              <div className="form-group user-row-edit-field">
                <label htmlFor={`edit-name-${user.id}`}>Name</label>
                <input
                  id={`edit-name-${user.id}`}
                  name="fullName"
                  type="text"
                  value={editValues.fullName}
                  onChange={handleEditFieldChange}
                />
                {editErrors.fullName && <span className="form-error">{editErrors.fullName}</span>}
              </div>
              <div className="form-group user-row-edit-field">
                <label htmlFor={`edit-email-${user.id}`}>Email</label>
                <input
                  id={`edit-email-${user.id}`}
                  name="email"
                  type="email"
                  value={editValues.email}
                  onChange={handleEditFieldChange}
                />
                {editErrors.email && <span className="form-error">{editErrors.email}</span>}
              </div>
            </div>
            {error && <span className="form-error">{error}</span>}
            <div className="form-actions form-actions-row">
              <button type="submit" className="btn btn-primary" disabled={editPending}>
                {editPending ? 'Saving...' : 'Save'}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => setIsEditing(false)} disabled={editPending}>
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{user.fullName}</td>
      <td>{user.email}</td>
      <td className="user-table-role-cell">
        {user.role}
        {showSpecialties && (
          <div className="user-specialties-summary">
            {(user.specialties || []).length > 0
              ? (user.specialties || []).map((specialty) => specialty.name).join(', ')
              : 'No specialties assigned yet.'}
          </div>
        )}
      </td>
      <td>
        <StatusBadge isActive={user.isActive} />
      </td>
      <td className="user-table-action-cell">
        <div className="user-table-action-group">
          <button type="button" className="btn btn-outline" onClick={handleChangeRoleClick} disabled={isPending}>
            {isPending ? 'Updating...' : actionLabel}
          </button>
          <button type="button" className="btn btn-outline" onClick={openEdit}>
            Edit
          </button>
          {/* DOC-48 - Deactivate always opens the confirm panel above first
              (task spec section 12); Activate is a direct action (spec
              explicitly allows a simpler flow for reactivation, and
              nothing destructive-adjacent is happening). */}
          <button
            type="button"
            className="btn btn-outline"
            disabled={statusPending}
            onClick={handleStatusButtonClick}
          >
            {statusPending ? 'Updating...' : user.isActive ? 'Deactivate' : 'Activate'}
          </button>
          {showSpecialties && (
            <button type="button" className="btn btn-outline" onClick={openManageSpecialties}>
              Manage Specialties
            </button>
          )}
          {/* DOC-57 - only rendered when the parent actually passed
              onResetPassword (ManagerDashboard.jsx, Employee/Operator
              rows only) - see this component's own comment on that prop
              above for why no further role guard is needed here. */}
          {typeof onResetPassword === 'function' && (
            <button type="button" className="btn btn-outline" onClick={openResetConfirm}>
              Send Temporary Password
            </button>
          )}
        </div>
        {error && <span className="form-error">{error}</span>}
        {/* DOC-48 - purely informational (task spec section 11): an
            Operator was just deactivated while still holding one or more
            active assigned Requests. Never blocks anything, never implies
            the deactivation itself failed. */}
        {statusWarning && <span className="form-warning">{statusWarning}</span>}
      </td>
    </tr>
  );
}

export default OrganizationUserRow;
