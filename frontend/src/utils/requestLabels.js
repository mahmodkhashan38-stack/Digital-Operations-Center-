// DOC-69 - "Error & UX Hardening" (task spec section 20: "Use one
// centralized mapping if possible."). Before this ticket, the exact same
// two label maps were independently hand-copied in FOUR places
// (RequestRow.jsx, ManagerRequestRow.jsx, ManagerDashboard.jsx each had
// their own `PRIORITY_LABELS`; RequestStatusBadge.jsx and
// ManagerDashboard.jsx each had their own `STATUS_LABELS`) - functionally
// harmless today (all four copies happened to already agree), but a
// genuine drift risk: a future status/priority label change would need to
// be made in every copy, and nothing would catch it if one were missed.
// This file is the one place those two mappings now live; every caller
// below imports from here instead of re-declaring its own copy.
export const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };

export const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  reopened: 'Reopened',
  cancelled: 'Cancelled',
};

// Small helpers so a caller never has to repeat its own `X[value] ||
// value` fallback (task spec section 20: "No raw values such as
// in_progress... if existing UI already maps them"). The `|| value`
// fallback is intentionally preserved here too - an unexpected future
// enum value should still render as SOMETHING readable rather than
// disappearing, never crash.
export function priorityLabel(value) {
  return PRIORITY_LABELS[value] || value;
}

export function statusLabel(value) {
  return STATUS_LABELS[value] || value;
}
