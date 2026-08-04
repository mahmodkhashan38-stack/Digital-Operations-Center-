// DOC-55 - "Request SLA and Due Dates". One small, reusable badge shared
// by all three dashboards (Manager/Operator/Employee) - the ONE place SLA
// badge/duration-display logic lives (task spec: "Do not duplicate badge
// logic across three dashboards"). This component never calculates a
// trusted deadline itself - it only ever reads the already-sanitized `sla`
// object request.controller.js's sanitizeRequest attaches to every
// Request response (see backend/src/utils/slaPolicy.js's
// computeSlaSummary), plus the Request's own `status`, and formats them
// for display. The backend remains the sole authority for every number
// shown here (task spec: "Frontend must never be the authority for the
// deadline.").
//
// Props:
//   sla    - the sanitized `sla` object from a Request response
//            ({ policyHours, dueAt, isOverdue, overdueByMinutes,
//            remainingMinutes, resolvedAt, closedAt }), or `null` for a
//            historical, pre-DOC-55 Request with no SLA data at all.
//   status - the Request's own `status` string - needed to tell "still
//            active" apart from "completed", and to handle 'cancelled'
//            (SLA tracking stops, task spec) as its own case.
//   showDueDate - whether to also render the raw target date/time
//            (defaults true; a dashboard summary card can pass `false`
//            for a more compact badge-only rendering if ever needed).
//
// REFRESH POLICY (documented choice): this component does NOT run its own
// setInterval/countdown - it always renders exactly what the last-fetched
// `sla` object says, and re-renders naturally whenever the owning
// dashboard reloads its Request list (which already happens after every
// mutating action on that Request - status change, priority edit,
// assignment, etc. - see each dashboard's own loadRequests/loadStats
// calls). This keeps the display accurate without inventing client-side
// deadline math or a background poller (task spec explicitly rules out
// background schedulers elsewhere in this ticket) - the tradeoff is that
// a badge can be up to one normal page interaction stale, acceptable for
// a human-facing "roughly how urgent is this" indicator, not a real-time
// clock.
//
// TIMEZONE: `sla.dueAt`/`sla.resolvedAt` are UTC ISO timestamps from the
// backend (see slaPolicy.js's own UTC policy comment) - `formatDueDate`
// below uses the browser's own `toLocaleString()`, which automatically
// renders them in the viewer's local timezone. No timezone math is ever
// performed here.
const ACTIVE_STATUSES = ['open', 'in_progress', 'reopened'];
const COMPLETED_STATUSES = ['resolved', 'closed'];

// Mirrors backend/src/utils/slaPolicy.js's own DUE_SOON_WINDOW_MINUTES -
// used here ONLY to classify an already-server-computed
// `sla.remainingMinutes` into a display bucket (On Track vs. Due Soon),
// never to calculate a deadline from scratch.
const DUE_SOON_WINDOW_MINUTES = 120;

// "3h 20m remaining" / "45m overdue" / "2d 4h remaining" - the exact
// shapes the task spec itself gives as examples. Minute-level precision
// below one day; day+hour only (no minutes) at or above one day, matching
// the task's own day-level example. No date library is used or needed
// (task spec: "Do not add a large date library.").
function formatDurationMinutes(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDueDate(dueAt) {
  if (!dueAt) return '-';
  return new Date(dueAt).toLocaleString();
}

function RequestSlaBadge({ sla, status, showDueDate = true }) {
  // Historical Request with no SLA data at all (task spec: "historical
  // Request without slaDueAt returns a safe null structure") - never
  // rendered as 0/on-track/overdue, always this one honest label.
  if (!sla) {
    return (
      <div className="sla-badge-wrapper">
        <span className="status-badge status-sla-unavailable">SLA Unavailable</span>
      </div>
    );
  }

  // Cancelled - "SLA stops... do not count cancelled Request as overdue"
  // (task spec). The original deadline is still shown for historical
  // reference, but no urgency badge is implied - cancelled work was never
  // completed, on time or otherwise.
  if (status === 'cancelled') {
    return (
      <div className="sla-badge-wrapper">
        <span className="status-badge status-sla-unavailable">SLA Unavailable</span>
        {showDueDate && <span className="sla-due-date">Target was: {formatDueDate(sla.dueAt)}</span>}
      </div>
    );
  }

  if (COMPLETED_STATUSES.includes(status)) {
    // Defensive: a resolved/closed Request should always have a real
    // resolvedAt (request.controller.js sets it the moment status becomes
    // 'resolved') - but a historical Request resolved/closed before
    // DOC-55 existed may not (the migration script deliberately never
    // invents one). Reported the same honest way as any other missing-data
    // case, rather than guessing on-time/late.
    if (!sla.resolvedAt) {
      return (
        <div className="sla-badge-wrapper">
          <span className="status-badge status-sla-unavailable">SLA Unavailable</span>
        </div>
      );
    }
    const onTime = new Date(sla.resolvedAt).getTime() <= new Date(sla.dueAt).getTime();
    return (
      <div className="sla-badge-wrapper">
        <span className={`status-badge ${onTime ? 'status-sla-completed-on-time' : 'status-sla-completed-late'}`}>
          {onTime ? 'Completed On Time' : 'Completed Late'}
        </span>
        {showDueDate && <span className="sla-due-date">Target resolution time: {formatDueDate(sla.dueAt)}</span>}
      </div>
    );
  }

  if (ACTIVE_STATUSES.includes(status)) {
    if (sla.isOverdue) {
      return (
        <div className="sla-badge-wrapper">
          <span className="status-badge status-sla-overdue">Overdue</span>
          <span className="sla-duration">{formatDurationMinutes(sla.overdueByMinutes)} overdue</span>
          {showDueDate && <span className="sla-due-date">Target resolution time: {formatDueDate(sla.dueAt)}</span>}
        </div>
      );
    }
    const dueSoon = sla.remainingMinutes <= DUE_SOON_WINDOW_MINUTES;
    return (
      <div className="sla-badge-wrapper">
        <span className={`status-badge ${dueSoon ? 'status-sla-due-soon' : 'status-sla-on-track'}`}>
          {dueSoon ? 'Due Soon' : 'On Track'}
        </span>
        <span className="sla-duration">{formatDurationMinutes(sla.remainingMinutes)} remaining</span>
        {showDueDate && <span className="sla-due-date">Target resolution time: {formatDueDate(sla.dueAt)}</span>}
      </div>
    );
  }

  // Defensive fallback - every real Request status is one of the three
  // buckets above (active / completed / cancelled); unreachable in
  // practice.
  return (
    <div className="sla-badge-wrapper">
      <span className="status-badge status-sla-unavailable">SLA Unavailable</span>
    </div>
  );
}

export default RequestSlaBadge;
