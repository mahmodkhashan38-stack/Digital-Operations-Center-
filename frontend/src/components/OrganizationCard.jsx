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

// A single Organization's management card: status, Company Code, Manager
// assignment status, and the three actions DOC-32/34/41 already support -
// activate/deactivate, regenerate Company Code, and (only when no Manager
// is assigned yet) assign an initial Manager. There is deliberately no
// delete action - Organizations are deactivated, never destroyed.
function OrganizationCard({ organization, onToggleActive, onRegenerateCode, onAssignManager }) {
  const [actionError, setActionError] = useState('');
  const [togglePending, setTogglePending] = useState(false);
  const [regeneratePending, setRegeneratePending] = useState(false);
  const [justRegenerated, setJustRegenerated] = useState(false);

  const [showAssignForm, setShowAssignForm] = useState(false);
  const [manager, setManager] = useState(EMPTY_MANAGER);
  const [assignErrors, setAssignErrors] = useState({});
  const [assignPending, setAssignPending] = useState(false);

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

  const handleManagerChange = (event) => {
    const { name, value } = event.target;
    setManager((prev) => ({ ...prev, [name]: value }));
  };

  const validateManager = () => {
    const nextErrors = {};
    if (!manager.fullName.trim()) nextErrors.fullName = 'Manager full name is required.';
    if (!manager.email.trim()) {
      nextErrors.email = 'Manager email is required.';
    } else if (!EMAIL_REGEX.test(manager.email)) {
      nextErrors.email = 'Please enter a valid email address.';
    }
    if (!manager.password) {
      nextErrors.password = 'Manager password is required.';
    } else if (manager.password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return nextErrors;
  };

  const handleAssignManager = async (event) => {
    event.preventDefault();
    setActionError('');

    const validationErrors = validateManager();
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
      setShowAssignForm(false);
      setManager(EMPTY_MANAGER);
      setAssignErrors({});
    } catch (error) {
      setActionError(error.message);
      setManager((prev) => ({ ...prev, password: '' }));
    } finally {
      setAssignPending(false);
    }
  };

  const hasManager = Boolean(organization.managerId);
  const createdDate = formatCreatedDate(organization.createdAt);

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
          <span className="stat-value">{hasManager ? 'Assigned' : 'Not assigned yet'}</span>
        </div>
        {createdDate && (
          <div className="org-card-detail">
            <span className="stat-label">Created</span>
            <span className="stat-value">{createdDate}</span>
          </div>
        )}
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
            onClick={() => setShowAssignForm((prev) => !prev)}
          >
            {showAssignForm ? 'Cancel' : 'Assign Manager'}
          </button>
        )}
      </div>

      {showAssignForm && !hasManager && (
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
    </div>
  );
}

export default OrganizationCard;
