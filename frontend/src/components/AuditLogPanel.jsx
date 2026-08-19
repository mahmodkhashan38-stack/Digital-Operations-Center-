import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { auditLogApi, organizationApi } from '../services/api.js';
import { AUDIT_ACTION_LABELS, auditActionLabel, formatAuditChanges } from '../utils/auditLogLabels.js';
import { roleLabel } from '../utils/roleRoutes.js';
import getApiErrorMessage from '../utils/apiError.js';

const LIST_LIMIT = 20;

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
];

const TARGET_TYPE_OPTIONS = [
  { value: '', label: 'All target types' },
  { value: 'Organization', label: 'Organization' },
  { value: 'User', label: 'User' },
  { value: 'ServiceCategory', label: 'Service Category' },
];

const EMPTY_FILTERS = {
  action: '', targetType: '', createdFrom: '', createdTo: '', organization: '',
};

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

// DOC-64 - "Audit Log" (task spec sections 31/32). One shared component for
// both the Manager Dashboard and the Admin Dashboard - `isSystemAdmin`
// controls only the two things that genuinely differ between the two
// views (an Organization filter dropdown, and an extra "Organization"
// column/line per entry) - everything else (loading/empty/error states,
// filters, pagination, change formatting) is identical, so there is no
// reason for two near-duplicate components. The backend itself is what
// actually enforces "Manager sees own Organization only / System Admin
// sees platform-wide" (routes/auditLog.routes.js + controllers/
// auditLog.controller.js) - this component never filters results
// client-side to fake that boundary.
function AuditLogPanel({ isSystemAdmin = false }) {
  const { token } = useAuth();

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [entries, setEntries] = useState(null); // null = not loaded yet
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);

  // System Admin only - a small id -> name map so each entry can show a
  // real Organization name (task spec section 9: "Do not expose raw
  // organizationId as the primary UI value" - the same principle DOC-62's
  // Profile page already applies, kept consistent here). Loaded once;
  // never refetched on every filter change. An Organization that has
  // since been deleted (DOC-47/DOC-64's own ORGANIZATION_DELETED) simply
  // will not be in this map - handled gracefully below, never a crash.
  const [organizationsById, setOrganizationsById] = useState(new Map());

  useEffect(() => {
    if (!isSystemAdmin) return;
    (async () => {
      try {
        const response = await organizationApi.list(token);
        setOrganizationsById(new Map(response.data.map((org) => [String(org.id), org.name])));
      } catch (err) {
        // Non-blocking - the Organization filter dropdown simply stays
        // empty and entries fall back to showing "Unknown organization";
        // the audit log list itself still loads independently below.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSystemAdmin, token]);

  const buildParams = useCallback((cursor) => {
    const params = { limit: LIST_LIMIT };
    if (filters.action) params.action = filters.action;
    if (filters.targetType) params.targetType = filters.targetType;
    if (filters.createdFrom) params.createdFrom = filters.createdFrom;
    if (filters.createdTo) params.createdTo = filters.createdTo;
    if (isSystemAdmin && filters.organization) params.organization = filters.organization;
    if (cursor) params.before = cursor;
    return params;
  }, [filters, isSystemAdmin]);

  const loadFirstPage = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await auditLogApi.list(token, buildParams(null));
      setEntries(response.data);
      setHasMore(response.meta?.hasMore || false);
      setNextCursor(response.meta?.nextCursor || null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load the audit log. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }, [token, buildParams]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const handleLoadMore = async () => {
    if (isLoadingMore || !hasMore || !nextCursor) return;
    setIsLoadingMore(true);
    setError('');
    try {
      const response = await auditLogApi.list(token, buildParams(nextCursor));
      setEntries((prev) => [...(prev || []), ...response.data]);
      setHasMore(response.meta?.hasMore || false);
      setNextCursor(response.meta?.nextCursor || null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load more audit log entries. Please try again.'));
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleFilterChange = (field) => (event) => {
    setFilters((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleClearFilters = () => {
    setFilters(EMPTY_FILTERS);
  };

  const hasActiveFilters = useMemo(
    () => Object.values(filters).some((value) => value !== ''),
    [filters],
  );

  return (
    <div className="card admin-panel audit-log-panel">
      <h2>Audit Log</h2>
      <p className="auth-subtitle">
        {isSystemAdmin
          ? 'Platform-wide administrative activity across every Organization.'
          : 'Administrative activity for your Organization - role changes, deactivations, password resets, and settings updates.'}
      </p>

      <div className="request-search-grid audit-log-filters">
        <div className="form-group">
          <label htmlFor="audit-log-action">Action</label>
          <select id="audit-log-action" value={filters.action} onChange={handleFilterChange('action')}>
            {ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="audit-log-target-type">Target Type</label>
          <select id="audit-log-target-type" value={filters.targetType} onChange={handleFilterChange('targetType')}>
            {TARGET_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="audit-log-created-from">From</label>
          <input id="audit-log-created-from" type="date" value={filters.createdFrom} onChange={handleFilterChange('createdFrom')} />
        </div>

        <div className="form-group">
          <label htmlFor="audit-log-created-to">To</label>
          <input id="audit-log-created-to" type="date" value={filters.createdTo} onChange={handleFilterChange('createdTo')} />
        </div>

        {isSystemAdmin && (
          <div className="form-group">
            <label htmlFor="audit-log-organization">Organization</label>
            <select id="audit-log-organization" value={filters.organization} onChange={handleFilterChange('organization')}>
              <option value="">All organizations</option>
              {Array.from(organizationsById.entries()).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {hasActiveFilters && (
        <button type="button" className="btn btn-outline audit-log-clear-btn" onClick={handleClearFilters}>
          Clear Filters
        </button>
      )}

      {isLoading && entries === null && (
        <p className="auth-subtitle">Loading audit log...</p>
      )}
      {error && (
        <p className="form-error form-error-server">{error}</p>
      )}
      {!isLoading && !error && entries !== null && entries.length === 0 && (
        <p className="auth-subtitle">No administrative activity recorded yet.</p>
      )}

      {entries !== null && !error && entries.length > 0 && (
        <>
          <ul className="timeline-list audit-log-list">
            {entries.map((entry) => {
              const changeRows = formatAuditChanges(entry.changes);
              const organizationName = isSystemAdmin
                ? (entry.organizationId ? (organizationsById.get(String(entry.organizationId)) || 'Unknown organization') : 'Platform-level')
                : null;
              return (
                <li key={entry.id} className="timeline-item audit-log-item">
                  <div className="timeline-item-header">
                    <span className="timeline-title">{auditActionLabel(entry.action)}</span>
                    <span className="timeline-timestamp">{formatDateTime(entry.createdAt)}</span>
                  </div>
                  <p className="timeline-detail">
                    Target: {entry.target?.displayName || 'Unknown'} ({entry.targetType})
                  </p>
                  {isSystemAdmin && (
                    <p className="timeline-detail audit-log-org-line">Organization: {organizationName}</p>
                  )}
                  {changeRows.map((row) => (
                    <p key={row.label} className="timeline-detail audit-log-change-row">
                      <span className="audit-log-change-label">{row.label}:</span> {row.display}
                    </p>
                  ))}
                  <span className="timeline-actor">
                    {entry.actor.fullName}
                    {entry.actor.role ? ` · ${roleLabel(entry.actor.role)}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>

          {hasMore && (
            <button
              type="button"
              className="btn btn-outline audit-log-load-more-btn"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? 'Loading...' : 'Load More'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default AuditLogPanel;
