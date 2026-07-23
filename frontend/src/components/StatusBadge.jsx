// DOC-42: extracted from the identical "Active/Inactive" badge markup that
// was independently duplicated in OrganizationCard.jsx and
// OrganizationUserRow.jsx (and is now needed a third time, for the Manager
// Dashboard's Organization Information section) - one component, one
// source of truth for what "active" looks like everywhere in the product.
function StatusBadge({ isActive, activeLabel = 'Active', inactiveLabel = 'Inactive' }) {
  return (
    <span className={`status-badge ${isActive ? 'status-active' : 'status-inactive'}`}>
      {isActive ? activeLabel : inactiveLabel}
    </span>
  );
}

export default StatusBadge;
