import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { requestApi } from '../services/api.js';

// DOC-17 - "Request Activity Timeline". Self-contained, exactly like
// AuthenticatedRequestImage.jsx (DOC-45/GridFS migration): it reads
// `token` from `useAuth()` and calls the backend itself, so it can be
// dropped into any Request row (RequestRow.jsx, ManagerRequestRow.jsx)
// with a single prop (`requestId`) and zero new plumbing through
// Dashboard.jsx/OperatorDashboard.jsx/ManagerDashboard.jsx - none of
// those three files needed any change for this feature. Fetches once
// when it mounts (i.e. the moment the row's own "View Details" expansion
// actually renders this component - it is never rendered, and therefore
// never fetches, for a collapsed row), never on every keystroke/render.
//
// GET /api/requests/:requestId/activities already returns activities
// oldest-first, actor already resolved to a safe {id, fullName, role}
// (or "Unknown user" - task spec section 6), and oldValue/newValue already
// resolved to display-ready strings for reference-typed events
// (CATEGORY_CHANGED/ASSIGNED/REASSIGNED/UNASSIGNED) - this component's
// only remaining job is `type` + `oldValue`/`newValue` + `metadata` ->
// a human-readable English sentence (task spec section 28: "Do NOT store
// finished English UI sentences in MongoDB... Frontend should map type +
// values + metadata to text" - this file is exactly that mapping, and the
// ONLY place in this project such a sentence for this feature is ever
// constructed).
function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function capitalize(value) {
  if (!value || typeof value !== 'string') return value;
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

function describeActivity(activity) {
  const metadata = activity.metadata || {};
  switch (activity.type) {
    case 'REQUEST_CREATED':
      return { title: 'Request created', detail: null };
    case 'REQUEST_UPDATED': {
      const fields = metadata.fieldsChanged || [];
      return { title: 'Request details updated', detail: fields.length > 0 ? `Changed: ${fields.join(', ')}` : null };
    }
    case 'PRIORITY_CHANGED':
      return { title: 'Priority changed', detail: `${capitalize(activity.oldValue)} → ${capitalize(activity.newValue)}` };
    case 'CATEGORY_CHANGED':
      return { title: 'Category changed', detail: `${activity.oldValue || 'Unknown'} → ${activity.newValue || 'Unknown'}` };
    case 'ASSIGNED':
      // DOC-15 - a first assignment never has (or shows) a reason - task
      // spec section 5's own explicit carve-out, reflected here too.
      return { title: `Assigned to ${activity.newValue || 'an operator'}`, detail: null, reason: null };
    case 'REASSIGNED':
      // DOC-15 - task spec section 10's own example format: title,
      // "Ahmad → Omar", then a separate "Reason:" line. `activity.oldValue`/
      // `newValue` are already resolved, display-ready Operator names (see
      // this file's own top comment) - `metadata.reason` is new (DOC-15),
      // `null` for a REASSIGNED activity recorded before this ticket
      // shipped (a historical event simply has no reason to show, not a
      // broken one).
      return {
        title: 'Reassigned',
        detail: `${activity.oldValue || 'Unknown'} → ${activity.newValue || 'Unknown'}`,
        reason: metadata.reason || null,
      };
    case 'UNASSIGNED':
      // DOC-15 - task spec section 10's own example format for
      // unassignment: "Operator removed", "Omar → Unassigned", then
      // "Reason:". Same historical-event fallback as REASSIGNED above.
      return {
        title: 'Operator removed',
        detail: activity.oldValue ? `${activity.oldValue} → Unassigned` : null,
        reason: metadata.reason || null,
      };
    case 'STATUS_CHANGED':
      return { title: 'Status changed', detail: `${capitalize(activity.oldValue)} → ${capitalize(activity.newValue)}` };
    case 'REQUEST_CANCELLED':
      return { title: 'Request cancelled', detail: metadata.cancelReason ? `Reason: ${metadata.cancelReason}` : null };
    case 'REQUEST_REOPENED':
      return { title: 'Request reopened', detail: null };
    case 'REQUEST_CLOSED':
      return { title: 'Request closed', detail: null };
    case 'BEFORE_IMAGE_ADDED':
      return { title: `Before image${metadata.count === 1 ? '' : 's'} added`, detail: metadata.count ? `${metadata.count} image(s)` : null };
    case 'BEFORE_IMAGE_REMOVED':
      return { title: 'Before image removed', detail: metadata.originalName || null };
    case 'COMPLETION_IMAGE_ADDED':
      return { title: `Completion image${metadata.count === 1 ? '' : 's'} added`, detail: metadata.count ? `${metadata.count} image(s)` : null };
    case 'COMPLETION_IMAGE_REMOVED':
      return { title: 'Completion image removed', detail: metadata.originalName || null };
    default:
      // Defensive only - every activity type the backend can ever produce
      // is one of the cases above (models/RequestActivity.js's own
      // ACTIVITY_TYPES enum); this is never expected to be reached.
      return { title: activity.type, detail: null };
  }
}

function RequestActivityTimeline({ requestId }) {
  const { token } = useAuth();
  const [activities, setActivities] = useState(null); // null = not loaded yet
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setActivities(null);
    setError('');

    if (!requestId || !token) {
      return undefined;
    }

    (async () => {
      try {
        const data = await requestApi.getActivities(requestId, token);
        if (!cancelled) setActivities(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId, token]);

  return (
    <div className="request-timeline">
      <span className="stat-label">Activity</span>

      {activities === null && !error && (
        <p className="auth-subtitle">Loading activity...</p>
      )}
      {error && (
        <p className="form-error form-error-server">{error}</p>
      )}
      {/* DOC-17 section 30 - a Request created before this feature existed
          may genuinely have zero activity records (no fake historical
          events are ever generated - see this feature's own optional,
          manual, non-destructive backfill script for the one narrow
          exception, REQUEST_CREATED only). */}
      {activities !== null && !error && activities.length === 0 && (
        <p className="auth-subtitle">No activity recorded yet.</p>
      )}

      {activities !== null && !error && activities.length > 0 && (
        <ul className="timeline-list">
          {activities.map((activity) => {
            const { title, detail, reason } = describeActivity(activity);
            return (
              <li key={activity.id} className="timeline-item">
                <div className="timeline-item-header">
                  <span className="timeline-title">{title}</span>
                  <span className="timeline-timestamp">{formatDateTime(activity.createdAt)}</span>
                </div>
                {detail && <p className="timeline-detail">{detail}</p>}
                {/* DOC-15 - only ever present for REASSIGNED/UNASSIGNED
                    (never ASSIGNED - task spec section 5), and only for
                    events recorded after this ticket shipped (`reason` is
                    `null` on any older REASSIGNED/UNASSIGNED activity, and
                    this line is simply skipped for those). */}
                {reason && (
                  <p className="timeline-detail timeline-reason">
                    <span className="timeline-reason-label">Reason:</span> {reason}
                  </p>
                )}
                <span className="timeline-actor">
                  {activity.actor.fullName}
                  {activity.actor.role ? ` · ${capitalize(activity.actor.role)}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default RequestActivityTimeline;
