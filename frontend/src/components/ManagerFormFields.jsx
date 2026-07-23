// Reusable presentational fieldset for collecting a new Manager's
// { fullName, email, password }. Used by both CreateOrganizationForm
// (optional initial Manager, DOC-34) and OrganizationCard's "Assign
// Manager" action (for an Organization that doesn't have one yet) - so the
// same fields/markup/validation display exist in exactly one place.
//
// This component never stores anything outside the parent's own state
// (React state only, no localStorage/sessionStorage - see AdminDashboard
// and OrganizationCard, which both discard the password value as soon as
// the request finishes, success or failure), and it never displays an
// existing password - there is no such thing as an "existing" password
// here, only a new one being typed in for account creation.
function ManagerFormFields({ values, errors, onChange, idPrefix }) {
  const fieldId = (name) => `${idPrefix}-${name}`;

  return (
    <>
      <div className="form-group">
        <label htmlFor={fieldId('fullName')}>Manager Full Name</label>
        <div className="input-group">
          <span className="input-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
            </svg>
          </span>
          <input
            id={fieldId('fullName')}
            name="fullName"
            type="text"
            placeholder="Jane Doe"
            value={values.fullName}
            onChange={onChange}
            autoComplete="off"
          />
        </div>
        {errors.fullName && <span className="form-error">{errors.fullName}</span>}
      </div>

      <div className="form-group">
        <label htmlFor={fieldId('email')}>Manager Email</label>
        <div className="input-group">
          <span className="input-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m3 7 9 6 9-6" />
            </svg>
          </span>
          <input
            id={fieldId('email')}
            name="email"
            type="email"
            placeholder="manager@example.com"
            value={values.email}
            onChange={onChange}
            autoComplete="off"
          />
        </div>
        {errors.email && <span className="form-error">{errors.email}</span>}
      </div>

      <div className="form-group">
        <label htmlFor={fieldId('password')}>Manager Password</label>
        <div className="input-group">
          <span className="input-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <input
            id={fieldId('password')}
            name="password"
            type="password"
            placeholder="••••••••"
            value={values.password}
            onChange={onChange}
            autoComplete="new-password"
          />
        </div>
        {errors.password && <span className="form-error">{errors.password}</span>}
        <span className="form-hint">Share this password with the Manager directly - it cannot be viewed again here.</span>
      </div>
    </>
  );
}

export default ManagerFormFields;
