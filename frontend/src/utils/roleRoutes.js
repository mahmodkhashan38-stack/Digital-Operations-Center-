// DOC-42: single source of truth for "which dashboard route does this
// role land on". Previously Login.jsx defined its own local
// DASHBOARD_ROUTE_BY_ROLE and ProtectedRoute.jsx redirected every wrong-role
// visitor to a hardcoded '/dashboard' - that hardcoding became a real bug
// once /dashboard became employee-only in DOC-42 (an Operator rejected from
// /admin would have been bounced to /dashboard, then rejected AGAIN there,
// producing a redirect loop). Both files now import from here instead, so
// there is exactly one place that maps a role to its destination and it can
// never drift out of sync with itself.
export const DASHBOARD_ROUTE_BY_ROLE = {
  system_admin: '/admin',
  manager: '/manager',
  operator: '/operator',
  employee: '/dashboard',
};

// Falls back to '/' (Home), not '/dashboard' - Home has no ProtectedRoute
// wrapping it, so this fallback can never itself trigger another redirect.
// It should only ever be reached defensively: every role in the schema's
// enum has an explicit mapping above.
export const destinationForRole = (role) => DASHBOARD_ROUTE_BY_ROLE[role] || '/';

// DOC-62 - "User Profile" (task spec section 8: "Display role in
// human-readable form"). Single shared source for the four role labels -
// OrganizationChat.jsx already has its own local, incomplete
// ROLE_LABELS (no 'system_admin' entry, since System Admin can never
// reach that page) which is left as-is rather than refactored here (out
// of scope for this ticket, and that one is deliberately incomplete for a
// good reason specific to Chat). This one is complete (all four roles),
// since Profile must render a label for every role that can view it.
export const ROLE_LABELS = {
  system_admin: 'System Admin',
  manager: 'Manager',
  operator: 'Operator',
  employee: 'Employee',
};

export const roleLabel = (role) => ROLE_LABELS[role] || role || 'Unknown';
