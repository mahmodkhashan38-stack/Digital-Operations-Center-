// DOC-64 - "Audit Log". Centralized mapping from the backend's controlled
// action enum (backend/src/models/AuditLog.js's own AUDIT_ACTIONS) to a
// short, human-readable label - task spec section 33: "Do not show enum
// values like USER_ROLE_CHANGED directly... Centralize labels where
// practical." This is the ONLY place in the frontend such a label is ever
// constructed, the same "one owner of a label map" discipline
// requestLabels.js (DOC-69) already established for Request status/
// priority.
export const AUDIT_ACTION_LABELS = {
  ORGANIZATION_CREATED: 'Organization created',
  ORGANIZATION_UPDATED: 'Organization updated',
  ORGANIZATION_ACTIVATED: 'Organization activated',
  ORGANIZATION_DEACTIVATED: 'Organization deactivated',
  ORGANIZATION_DELETED: 'Organization deleted',
  COMPANY_CODE_REGENERATED: 'Company code regenerated',
  MANAGER_ASSIGNED: 'Manager assigned',
  MANAGER_REPLACED: 'Manager replaced',
  USER_ROLE_CHANGED: 'User role changed',
  USER_DEACTIVATED: 'User deactivated',
  USER_REACTIVATED: 'User reactivated',
  USER_PASSWORD_RESET: 'Password reset',
  USER_SPECIALTIES_CHANGED: 'Specialties changed',
  SERVICE_CATEGORY_CREATED: 'Service category created',
  SERVICE_CATEGORY_UPDATED: 'Service category updated',
  SERVICE_CATEGORY_ACTIVATED: 'Service category activated',
  SERVICE_CATEGORY_DEACTIVATED: 'Service category deactivated',
  ORGANIZATION_SETTINGS_UPDATED: 'Organization settings updated',
  PROFILE_UPDATED: 'Profile updated',
};

export function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action || 'Unknown action';
}

// Human-readable label for each field name that can appear inside a
// `changes` object across every action type this ticket implements -
// never a raw camelCase key shown directly in the UI.
const CHANGE_FIELD_LABELS = {
  role: 'Role',
  isActive: 'Status',
  name: 'Name',
  description: 'Description',
  contactEmail: 'Contact Email',
  contactPhone: 'Contact Phone',
  fullName: 'Full Name',
  specialties: 'Specialties',
  manager: 'Manager',
  companyCodeChanged: 'Company Code',
};

function formatChangeValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'Active' : 'Inactive';
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'None';
  }
  if (typeof value === 'object') {
    // Task spec section 34 - "Unknown/complex metadata should degrade
    // gracefully" - this should not normally be reached for any change
    // shape this project's own backend produces, but never dumps a raw
    // JSON blob into the UI either way.
    return 'Updated';
  }
  return String(value);
}

// Turns a backend `changes` object (`{ field: { from, to } }`, or the
// special `{ companyCodeChanged: true }` shape) into an array of
// ready-to-render `{ label, display }` rows - task spec section 34: "Do
// not dump JSON blobs directly into UI." Returns `[]` for `null`/`{}`
// (e.g. ORGANIZATION_CREATED, USER_PASSWORD_RESET, which never have a
// field-level diff to show).
export function formatAuditChanges(changes) {
  if (!changes || typeof changes !== 'object') {
    return [];
  }
  return Object.entries(changes).map(([field, value]) => {
    const label = CHANGE_FIELD_LABELS[field] || field;
    // The one non-from/to shape this project's backend ever produces -
    // COMPANY_CODE_REGENERATED's own deliberately code-free
    // `{ companyCodeChanged: true }` (task spec sections 8/15 - the actual
    // codes are never sent to the frontend at all).
    if (field === 'companyCodeChanged') {
      return { label, display: 'Regenerated' };
    }
    if (value && typeof value === 'object' && ('from' in value || 'to' in value)) {
      return { label, display: `${formatChangeValue(value.from)} → ${formatChangeValue(value.to)}` };
    }
    return { label, display: formatChangeValue(value) };
  });
}
