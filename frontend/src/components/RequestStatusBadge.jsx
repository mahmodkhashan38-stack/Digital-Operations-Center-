import { statusLabel } from '../utils/requestLabels.js';

// DOC-11 - a small sibling to StatusBadge.jsx, not a modification of it.
// StatusBadge's prop contract (`isActive: boolean`) is used identically
// across every existing caller (OrganizationCard, OrganizationUserRow,
// ServiceCategoryRow, the Manager Dashboard's Organization Information
// panel) for a genuinely binary Active/Inactive concept - forcing a
// five-value Request status enum through that same boolean prop would
// either lose information (collapsing open/in_progress/reopened into one
// "active" bucket) or require changing StatusBadge's contract and
// re-verifying every existing caller, which is not the "small safe
// change" this task calls for. This component reuses the same visual
// language instead (the shared `.status-badge` base class, see
// index.css) with its own status-keyed modifier class.
//
// DOC-69 - the label mapping itself now lives in utils/requestLabels.js
// (one centralized place, shared with RequestRow.jsx/
// ManagerRequestRow.jsx/ManagerDashboard.jsx - see that file's own
// comment) instead of being redeclared here.
function RequestStatusBadge({ status }) {
  return <span className={`status-badge status-request-${status}`}>{statusLabel(status)}</span>;
}

export default RequestStatusBadge;
