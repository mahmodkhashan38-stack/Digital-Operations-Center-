import { useState } from 'react';
import ManagerFormFields from './ManagerFormFields.jsx';
import { EMAIL_REGEX, MIN_PASSWORD_LENGTH } from '../utils/validation.js';

const EMPTY_MANAGER = { fullName: '', email: '', password: '' };

// Form for System Admin to create a new Organization (DOC-32), optionally
// creating its initial Manager in the same request (DOC-34). Only ever
// collects fields the backend actually accepts from the client - Company
// Code, managerId, organizationId, and the Manager's role are never part
// of this form because they are entirely backend-controlled (DOC-32/34/41
// generate/derive all of them server-side).
function CreateOrganizationForm({ onCreate, onCancel }) {
  const [name, setName] = useState('');
  const [includeManager, setIncludeManager] = useState(false);
  const [manager, setManager] = useState(EMPTY_MANAGER);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleManagerChange = (event) => {
    const { name: field, value } = event.target;
    setManager((prev) => ({ ...prev, [field]: value }));
  };

  const validate = () => {
    const nextErrors = {};

    if (!name.trim()) {
      nextErrors.name = 'Organization name is required.';
    }

    if (includeManager) {
      if (!manager.fullName.trim()) {
        nextErrors.fullName = 'Manager full name is required.';
      }
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

    const payload = { name: name.trim() };
    if (includeManager) {
      payload.manager = {
        fullName: manager.fullName.trim(),
        email: manager.email.trim(),
        password: manager.password,
      };
    }

    setIsSubmitting(true);
    try {
      await onCreate(payload);
      // Success: nothing left in this form should linger, especially the
      // Manager password - the parent already has what it needs (the
      // created Organization, including the backend-generated Company
      // Code) via onCreate's return value.
      setName('');
      setIncludeManager(false);
      setManager(EMPTY_MANAGER);
      setErrors({});
    } catch (error) {
      setServerError(error.message);
      // The password is cleared even on failure - the admin can simply
      // retype it. It is never kept around longer than one submit attempt.
      setManager((prev) => ({ ...prev, password: '' }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="card admin-panel">
      <h2>Create Organization</h2>
      <p className="auth-subtitle">
        The Company Code is generated automatically after creation - you do not enter one here.
      </p>

      {serverError && <p className="form-error form-error-server">{serverError}</p>}

      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label htmlFor="org-name">Organization Name</label>
          <div className="input-group">
            <span className="input-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="7" width="18" height="13" rx="2" />
                <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
            <input
              id="org-name"
              name="name"
              type="text"
              placeholder="Acme Inc."
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </div>
          {errors.name && <span className="form-error">{errors.name}</span>}
        </div>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={includeManager}
            onChange={(event) => setIncludeManager(event.target.checked)}
          />
          Create the initial Manager now
        </label>

        {includeManager && (
          <div className="admin-subform">
            <ManagerFormFields values={manager} errors={errors} onChange={handleManagerChange} idPrefix="create-org-manager" />
          </div>
        )}

        <div className="form-actions form-actions-row">
          <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Organization'}
          </button>
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreateOrganizationForm;
