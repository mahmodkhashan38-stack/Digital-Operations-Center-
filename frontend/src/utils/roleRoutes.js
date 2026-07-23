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
