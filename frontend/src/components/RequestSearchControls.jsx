import { useEffect, useRef, useState } from 'react';

// DOC-54 - "Request Search, Filters and Sorting". One shared component
// used by all three dashboards (Manager/Operator/Employee) - the controls
// that differ by role (Manager's Operator/Requester/date-range filters)
// are simply not rendered when the corresponding data isn't passed in,
// rather than forking this into three near-identical components. Every
// dashboard owns its OWN `filters` state and its OWN fetch-on-change
// effect (see ManagerDashboard.jsx/OperatorDashboard.jsx/Dashboard.jsx) -
// this component only ever reads `filters` and calls `onFilterChange`/
// `onClear`; it never talks to the backend itself.
//
// Text search (`q`) is debounced locally (task spec: "Use a small
// debounce for text search if every keystroke triggers an API request" -
// 300-500ms) so the parent only refetches after the Employee/Operator/
// Manager pauses typing, not on every keystroke. Every OTHER control
// (status/priority/category/operator/requester/date/sort) calls
// `onFilterChange` immediately - task spec: "Filter dropdown changes may
// trigger immediately."
const SEARCH_DEBOUNCE_MS = 400;

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
  { value: 'reopened', label: 'Reopened' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_OPTIONS = [
  { value: '', label: 'All priorities' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

// DOC-55 - "Request SLA and Due Dates". All roles (task spec: "Extend
// DOC-54 with Manager, Operator, and Employee filters") - role scope
// itself is unaffected, this is validated/applied identically to how
// status/priority already work in requestQueryBuilder.js (only ever ADDS
// a restriction on top of the caller's own trusted, already-role-scoped
// base query).
const SLA_STATUS_OPTIONS = [
  { value: '', label: 'All SLA statuses' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_soon', label: 'Due Soon' },
  { value: 'on_track', label: 'On Track' },
  { value: 'unavailable', label: 'SLA Unavailable' },
];

const SORT_BY_OPTIONS = [
  { value: 'createdAt', label: 'Created date' },
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'title', label: 'Title' },
  // DOC-55 - Requests without an slaDueAt (historical) always sort last,
  // in either direction - see requestQueryBuilder.js's sortRequestDocs.
  { value: 'slaDueAt', label: 'SLA due date' },
];

const SORT_ORDER_OPTIONS = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' },
];

function RequestSearchControls({
  filters,
  onFilterChange,
  onClear,
  categories = [],
  // Manager-only data/controls - simply omitted (undefined/false) by the
  // Operator and Employee dashboards.
  showManagerFilters = false,
  operators = [],
  employees = [],
}) {
  // Local, debounced mirror of filters.q - typing updates this
  // immediately (so the input never feels laggy) while the actual
  // `onFilterChange` call (and therefore the network refetch) is delayed.
  const [qInput, setQInput] = useState(filters.q || '');
  const debounceRef = useRef(null);

  // Keeps the local text box in sync if the parent's filters.q changes
  // for a reason OTHER than typing here - e.g. "Clear Filters".
  useEffect(() => {
    setQInput(filters.q || '');
  }, [filters.q]);

  const handleQChange = (event) => {
    const { value } = event.target;
    setQInput(value);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      onFilterChange({ q: value });
    }, SEARCH_DEBOUNCE_MS);
  };

  useEffect(() => () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
  }, []);

  const handleImmediateChange = (key) => (event) => {
    onFilterChange({ [key]: event.target.value });
  };

  return (
    <div className="card admin-panel request-search-panel">
      <div className="form-group request-search-text">
        <label htmlFor="request-search-q">Search</label>
        <input
          id="request-search-q"
          type="text"
          placeholder="Search title or description..."
          value={qInput}
          onChange={handleQChange}
          maxLength={200}
        />
      </div>

      <div className="request-search-grid">
        <div className="form-group">
          <label htmlFor="request-search-status">Status</label>
          <select id="request-search-status" value={filters.status || ''} onChange={handleImmediateChange('status')}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="request-search-priority">Priority</label>
          <select id="request-search-priority" value={filters.priority || ''} onChange={handleImmediateChange('priority')}>
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="request-search-category">Category</label>
          <select id="request-search-category" value={filters.categoryId || ''} onChange={handleImmediateChange('categoryId')}>
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="request-search-sla">SLA Status</label>
          <select id="request-search-sla" value={filters.slaStatus || ''} onChange={handleImmediateChange('slaStatus')}>
            {SLA_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        {showManagerFilters && (
          <div className="form-group">
            <label htmlFor="request-search-operator">Assigned Operator</label>
            <select
              id="request-search-operator"
              value={filters.assignedOperatorId || ''}
              onChange={handleImmediateChange('assignedOperatorId')}
            >
              <option value="">All operators</option>
              <option value="unassigned">Unassigned</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>{operator.fullName}</option>
              ))}
            </select>
          </div>
        )}

        {showManagerFilters && (
          <div className="form-group">
            <label htmlFor="request-search-createdby">Requester</label>
            <select id="request-search-createdby" value={filters.createdBy || ''} onChange={handleImmediateChange('createdBy')}>
              <option value="">All requesters</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>{employee.fullName}</option>
              ))}
            </select>
          </div>
        )}

        {showManagerFilters && (
          <div className="form-group">
            <label htmlFor="request-search-from">Created From</label>
            <input
              id="request-search-from"
              type="date"
              value={filters.createdFrom || ''}
              onChange={handleImmediateChange('createdFrom')}
            />
          </div>
        )}

        {showManagerFilters && (
          <div className="form-group">
            <label htmlFor="request-search-to">Created To</label>
            <input
              id="request-search-to"
              type="date"
              value={filters.createdTo || ''}
              onChange={handleImmediateChange('createdTo')}
            />
          </div>
        )}

        <div className="form-group">
          <label htmlFor="request-search-sortby">Sort By</label>
          <select id="request-search-sortby" value={filters.sortBy || 'createdAt'} onChange={handleImmediateChange('sortBy')}>
            {SORT_BY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="request-search-sortorder">Sort Order</label>
          <select id="request-search-sortorder" value={filters.sortOrder || 'desc'} onChange={handleImmediateChange('sortOrder')}>
            {SORT_ORDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-actions form-actions-row request-search-actions">
        <button type="button" className="btn btn-outline" onClick={onClear}>
          Clear Filters
        </button>
      </div>
    </div>
  );
}

export default RequestSearchControls;
