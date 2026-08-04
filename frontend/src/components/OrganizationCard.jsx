import { useState } from 'react';
import ManagerFormFields from './ManagerFormFields.jsx';
import StatusBadge from './StatusBadge.jsx';
import { EMAIL_REGEX, MIN_PASSWORD_LENGTH } from '../utils/validation.js';

// DOC-42 (spec 1.B): "Created date if already available" - Organization
// documents have had a real createdAt (via the schema's `timestamps: true`)
// since Sprint 1, and organization.controller.js's sanitizeOrganization has
// always returned it; this card simply did not display it until now.
const formatCreatedDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const EMPTY_MANAGER = { fullName: '', email: '', password: '' };

// Which single Manager-related form (if any) is currently open. Only one
// at a time, ever - Assign/Edit/Replace are mutually exclusive actions on
// the same relationship, and showing more than one open form for the same
// Manager at once would just invite confusing, conflicting edits.
const MANAGER_FORM = { NONE: null, ASSIGN: 'assign', EDIT: 'edit', REPLACE: 'replace' };

// A single Organization's management card: status, Company Code, Manager
// contact info and Employee/Operator counts (DOC-49 "Organization
// Overview"), the actions DOC-32/34/41/49 support - activate/deactivate,
// regenerate Company Code, assign an initial Manager (only when none is
// assigned yet), edit the current Manager's profile, replace the current
// Manager entirely - and, since DOC-47, a deliberately separated
// destructive Delete action. Deletion is only ever attempted after an
// explicit confirmation, and the backend (not this component) is the
// actual authority on whether any of these are safe.
function OrganizationCard({
  organization,
  onToggleActive,
  onRegenerateCode,
  onAssignManager,
  onUpdateManagerProfile,
  onReplaceManager,
  onDelete,
}) {
  const [actionError, setActionError] = useState('');
  const [togglePending, setTogglePending] = useState(false);
  const [regeneratePending, setRegeneratePending] = useState(false);
  const [justRegenerated, setJustRegenerated] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const [activeManagerForm, setActiveManagerForm] = useState(MANAGER_FORM.NONE);

  const [manager, setManager] = useState(EMPTY_MANAGER);
  const [assignErrors, setAssignErrors] = useState({});
  const [assignPending, setAssignPending] = useState(false);

  // DOC-49: separate state for Edit (fullName/email only, prefilled with
  // the CURRENT Manager's values) - kept independent from `manager` above
  // (Assign/Replace's blank-account state) so opening one form never
  // leaks stale values into the other.
  const [editManagerValues, setEditManagerValues] = useState(EMPTY_MANAGER);
  const [editManagerErrors, setEditManagerErrors] = useState({});
  const [editManagerPending, setEditManagerPending] = useState(false);

  // DOC-49: Replace uses the exact same shape as Assign (a brand new
  // account's fullName/email/password) but a different handler/backend
  // route (PUT, not POST) and a confirmation dialog, since it deactivates
  // the existing Manager as a side effect.
  const [replaceManagerValues, setReplaceManagerValues] = useState(EMPTY_MANAGER);
  const [replaceManagerErrors, setReplaceManagerErrors] = useState({});
  const [replaceManagerPending, setReplaceManagerPending] = useState(false);

  const handleToggleActive = async () => {
    setActionError('');
    setTogglePending(true);
    try {
      await onToggleActive(organization);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setTogglePending(false);
    }
  };

  const handleRegenerateCode = async () => {
    const confirmed = window.confirm(
      `Regenerate the Company Code for "${organization.name}"? The current code will stop working immediately - anyone who has not registered with it yet will need the new one.`,
    );
    if (!confirmed) {
      return;
    }

    setActionError('');
    setJustRegenerated(false);
    setRegeneratePending(true);
    try {
      await onRegenerateCode(organization);
      setJustRegenerated(true);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setRegeneratePending(false);
    }
  };

  // DOC-47: window.confirm is the simplest implementation consistent with
  // this project (regenerate-code already uses the same pattern above).
  // Pressing Cancel sends no request at all - onDelete is never called.
  const handleDelete = async () => {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete this organization?\nThis action cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setActionError('');
    setDeletePending(true);
    try {
      await onDelete(organization);
      // No further state update on success: the parent removes this
      // Organization (and therefore this card) from the list once the
      // backend confirms deletion, so there is nothing left here to reset.
    } catch (error) {
      // Deletion was rejected (most commonly 409 - dependent users still
      // exist) or failed for some other reason. The card stays exactly as
      // it was; the backend's own client-safe error message is shown
      // inline, and deletePending is cleared so the button is usable again.
      setActionError(error.message);
      setDeletePending(false);
    }
  };

  const handleManagerChange = (event) => {
    const { name, value } = event.target;
    setManager((prev) => ({ ...prev, [name]: value }));
  };

  // A brand-new account's fullName/email/password - shared shape/rules for
  // both Assign (no existing Manager yet) and Replace (an existing one is
  // being swapped out) below.
  const validateNewManager = (values) => {
    const nextErrors = {};
    if (!values.fullName.trim()) nextErrors.fullName = 'Manager full name is required.';
    if (!values.email.trim()) {
      nextErrors.email = 'Manager email is required.';
    } else if (!EMAIL_REGEX.test(values.email)) {
      nextErrors.email = 'Please enter a valid email address.';
    }
    if (!values.password) {
      nextErrors.password = 'Manager password is required.';
    } else if (values.password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return nextErrors;
  };

  const closeManagerForms = () => {
    setActiveManagerForm(MANAGER_FORM.NONE);
    setManager(EMPTY_MANAGER);
    setAssignErrors({});
    setEditManagerValues(EMPTY_MANAGER);
    setEditManagerErrors({});
    setReplaceManagerValues(EMPTY_MANAGER);
    setReplaceManagerErrors({});
  };

  const handleAssignManager = async (event) => {
    event.preventDefault();
    setActionError('');

    const validationErrors = validateNewManager(manager);
    setAssignErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setAssignPending(true);
    try {
      await onAssignManager(organization, {
        fullName: manager.fullName.trim(),
        email: manager.email.trim(),
        password: manager.password,
      });
      closeManagerForms();
    } catch (error) {
      setActionError(error.message);
      setManager((prev) => ({ ...prev, password: '' }));
    } finally {
      setAssignPending(false);
    }
  };

  // DOC-49: opens the Edit form prefilled with the CURRENT Manager's
  // fullName/email (organization.manager, from sanitizeOrganization's
  // extras - see organization.controller.js) - never a blank form, since
  // this is correcting an existing profile, not creating a new account.
  const openEditManagerForm = () => {
    setActionError('');
    setEditManagerValues({
      fullName: organization.manager?.fullName || '',
      email: organization.manager?.email || '',
      password: '',
    });
    setEditManagerErrors({});
    setActiveManagerForm(MANAGER_FORM.EDIT);
  };

  const handleEditManagerChange = (event) => {
    const { name, value } = event.target;
    setEditManagerValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleUpdateManagerProfile = async (event) => {
    event.preventDefault();
    setActionError('');

    const nextErrors = {};
    if (!editManagerValues.fullName.trim()) nextErrors.fullName = 'Manager full name is required.';
    if (!editManagerValues.email.trim()) {
      nextErrors.email = 'Manager email is required.';
    } else if (!EMAIL_REGEX.test(editManagerValues.email)) {
      nextErrors.email = 'Please enter a valid email address.';
    }
    setEditManagerErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setEditManagerPending(true);
    try {
      await onUpdateManagerProfile(organization, {
        fullName: editManagerValues.fullName.trim(),
        email: editManagerValues.email.trim(),
      });
      closeManagerForms();
    } catch (error) {
      setActionError(error.message);
    } finally {
      setEditManagerPending(false);
    }
  };

  const handleReplaceManagerChange = (event) => {
    const { name, value } = event.target;
    setReplaceManagerValues((prev) => ({ ...prev, [name]: value }));
  };

  // DOC-49: a confirmation dialog here, unlike Assign - Replace is a more
  // consequential action (it deactivates the CURRENT Manager's account as
  // a side effect, per the backend's documented "safe replacement" rule),
  // so it gets the same window.confirm treatment as Regenerate Company
  // Code and Delete Organization above.
  const handleReplaceManager = async (event) => {
    event.preventDefault();
    setActionError('');

    const validationErrors = validateNewManager(replaceManagerValues);
    setReplaceManagerErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    const confirmed = window.confirm(
      `Replace the Manager of "${organization.name}"? The current Manager's account will be deactivated (not deleted) once the new one is confirmed.`,
    );
    if (!confirmed) {
      return;
    }

    setReplaceManagerPending(true);
    try {
      await onReplaceManager(organization, {
        fullName: replaceManagerValues.fullName.trim(),
        email: replaceManagerValues.email.trim(),
        password: replaceManagerValues.password,
      });
      closeManagerForms();
    } catch (error) {
      setActionError(error.message);
      setReplaceManagerValues((prev) => ({ ...prev, password: '' }));
    } finally {
      setReplaceManagerPending(false);
    }
  };

  const hasManager = Boolean(organization.managerId);
  const createdDate = formatCreatedDate(organization.createdAt);
  // DOC-49: `manager`/`employeeCount`/`operatorCount` come from the
  // backend's enrichOrganization (organization.controller.js) - never
  // computed or guessed client-side. `employeeCount`/`operatorCount` may
  // legitimately be `undefined` if a caller of this component ever passes
  // an Organization object that didn't go through that enrichment; treat
  // that the same as "not available" rather than showing a false 0.
  const hasUserCounts = typeof organization.employeeCount === 'number' && typeof organization.operatorCount === 'number';

  return (
    <div className="card org-card">
      <div className="org-card-header">
        <h3>{organization.name}</h3>
        <StatusBadge isActive={organization.isActive} />
      </div>

      <div className="org-card-details">
        <div className="org-card-detail">
          <span className="stat-label">Company Code</span>
          <span className="stat-value org-code">
            {organization.companyCode}
            {justRegenerated && <span className="org-code-updated"> (updated)</span>}
          </span>
        </div>
        <div className="org-card-detail">
          <span className="stat-label">Manager</span>
          {hasManager && organization.manager ? (
            <span className="stat-value">
              {organization.manager.fullName}
              <span className="org-card-detail-sub">{organization.manager.email}</span>
            </span>
          ) : (
            <span className="stat-value">{hasManager ? 'Assigned' : 'Not assigned yet'}</span>
          )}
        </div>
        {createdDate && (
          <div className="org-card-detail">
            <span className="stat-label">Created</span>
            <span className="stat-value">{createdDate}</span>
          </div>
        )}
      </div>

      {/* DOC-49 "Organization Overview": Employee/Operator counts are real,
          backend-computed numbers (enrichOrganization) - never guessed
          client-side. There is deliberately no per-Organization Request
          count here (System Admin cleanup ticket): Request Management now
          exists (DOC-10 onward), but System Admin has never had - and this
          cleanup does not grant - operational visibility into any single
          Organization's Request data. A stale "Requests" stat left over
          from before Request Management existed was removed rather than
          wired to real per-Organization Request counts, and was not
          replaced with another placeholder. Platform-level, Request-free
          statistics live in the "Platform Overview" cards on
          AdminDashboard.jsx instead (DOC-53). */}
      <div className="org-card-details org-card-overview">
        <div className="org-card-detail">
          <span className="stat-label">Employees</span>
          <span className="stat-value">{hasUserCounts ? organization.employeeCount : '—'}</span>
        </div>
        <div className="org-card-detail">
          <span className="stat-label">Operators</span>
          <span className="stat-value">{hasUserCounts ? organization.operatorCount : '—'}</span>
        </div>
      </div>

      {actionError && <p className="form-error form-error-server">{actionError}</p>}

      <div className="org-card-actions">
        <button type="button" className="btn btn-outline" onClick={handleToggleActive} disabled={togglePending}>
          {togglePending ? 'Updating...' : organization.isActive ? 'Deactivate' : 'Activate'}
        </button>
        <button type="button" className="btn btn-outline" onClick={handleRegenerateCode} disabled={regeneratePending}>
          {regeneratePending ? 'Regenerating...' : 'Regenerate Company Code'}
        </button>
        {!hasManager && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => (activeManagerForm === MANAGER_FORM.ASSIGN ? closeManagerForms() : setActiveManagerForm(MANAGER_FORM.ASSIGN))}
          >
            {activeManagerForm === MANAGER_FORM.ASSIGN ? 'Cancel' : 'Assign Manager'}
          </button>
        )}
        {hasManager && (
          <>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => (activeManagerForm === MANAGER_FORM.EDIT ? closeManagerForms() : openEditManagerForm())}
            >
              {activeManagerForm === MANAGER_FORM.EDIT ? 'Cancel' : 'Edit Manager'}
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => (activeManagerForm === MANAGER_FORM.REPLACE ? closeManagerForms() : setActiveManagerForm(MANAGER_FORM.REPLACE))}
            >
              {activeManagerForm === MANAGER_FORM.REPLACE ? 'Cancel' : 'Replace Manager'}
            </button>
          </>
        )}
      </div>

      {activeManagerForm === MANAGER_FORM.ASSIGN && (
        <form className="admin-subform" onSubmit={handleAssignManager} noValidate>
          <ManagerFormFields
            values={manager}
            errors={assignErrors}
            onChange={handleManagerChange}
            idPrefix={`assign-manager-${organization.id}`}
          />
          <div className="form-actions form-actions-row">
            <button type="submit" className="btn btn-primary" disabled={assignPending}>
              {assignPending ? 'Assigning...' : 'Assign Manager'}
            </button>
          </div>
        </form>
      )}

      {/* DOC-49: fullName/email only - editing the CURRENT Manager's
          profile never touches their password (showPassword={false}). */}
      {activeManagerForm === MANAGER_FORM.EDIT && (
        <form className="admin-subform" onSubmit={handleUpdateManagerProfile} noValidate>
          <ManagerFormFields
            values={editManagerValues}
            errors={editManagerErrors}
            onChange={handleEditManagerChange}
            idPrefix={`edit-manager-${organization.id}`}
            showPassword={false}
          />
          <div className="form-actions form-actions-row">
            <button type="submit" className="btn btn-primary" disabled={editManagerPending}>
              {editManagerPending ? 'Saving...' : 'Save Manager Profile'}
            </button>
          </div>
        </form>
      )}

      {/* DOC-49: a brand-new account, exactly like Assign - but this one
          REPLACES the current Manager (confirmed in handleReplaceManager
          above) rather than being the first one. */}
      {activeManagerForm === MANAGER_FORM.REPLACE && (
        <form className="admin-subform" onSubmit={handleReplaceManager} noValidate>
          <p className="form-hint">
            The current Manager will be deactivated (not deleted) once the new Manager account below is confirmed.
          </p>
          <ManagerFormFields
            values={replaceManagerValues}
            errors={replaceManagerErrors}
            onChange={handleReplaceManagerChange}
            idPrefix={`replace-manager-${organization.id}`}
          />
          <div className="form-actions form-actions-row">
            <button type="submit" className="btn btn-danger" disabled={replaceManagerPending}>
              {replaceManagerPending ? 'Replacing...' : 'Replace Manager'}
            </button>
          </div>
        </form>
      )}

      {/* DOC-47: visually and physically separated from the actions above -
          a destructive action should never be one misclick away from
          Activate/Regenerate. System Admin only ever sees this button in
          the first place, since only System Admin can render this page at
          all (ProtectedRoute roles={['system_admin']}) - the backend's own
          requireRole('system_admin') on DELETE /api/organizations/:id is
          the real boundary regardless. */}
      <div className="org-card-actions org-card-actions-danger">
        <button type="button" className="btn btn-danger" onClick={handleDelete} disabled={deletePending}>
          {deletePending ? 'Deleting...' : 'Delete Organization'}
        </button>
      </div>
    </div>
  );
}

export default OrganizationCard;
