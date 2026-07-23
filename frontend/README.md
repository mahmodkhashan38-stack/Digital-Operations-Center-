# Frontend

React frontend application.

## System Admin Dashboard (DOC-37)

`role: 'system_admin'` gets a dedicated, global dashboard at `/admin`
(`pages/AdminDashboard.jsx`) - separate from the generic `/dashboard`
placeholder every other role still sees, and separate from the Manager
Dashboard (DOC-36, below). Because System Admin has
no `organizationId` (it is global, DOC-31), this page is not scoped to a
single tenant - it manages every Organization in the system through the
existing DOC-32/DOC-34/DOC-41 backend endpoints (`services/api.js`'s new
`organizationApi`): create Organization (optionally with its initial
Manager in the same request), list/view Organizations, activate/
deactivate, and regenerate a Company Code. There is no delete action -
the backend has none, and none was added.

- **Route protection is UX only.** `components/ProtectedRoute.jsx` accepts
  an optional `roles` prop; `/admin` is wrapped with
  `roles={['system_admin']}`, so any other authenticated role that
  navigates there directly is redirected to **their own** dashboard (see
  `utils/roleRoutes.js`, DOC-42), and an unauthenticated visitor is
  redirected to `/login`. The real security boundary remains the backend
  (`requireRole('system_admin')`, DOC-38's isolation middleware) - this
  component cannot grant access to anything the backend would refuse.
- **Login redirect**: after a successful login, a System Admin is sent to
  `/admin`; every role's own redirect destination is defined once in
  `utils/roleRoutes.js` (DOC-42).
  Login itself is still Email + Password only for every role.
- **Navbar**: a signed-in System Admin sees an "Admin Dashboard" link
  instead of the generic "Dashboard" link; no other role ever sees it.
- **Company Code / Manager password handling**: Company Codes are only
  ever displayed after the backend generates them (creation or
  regeneration) - the frontend never generates or lets the admin type one.
  A Manager's password (when created from this page) lives only in local
  component state for the duration of one submit attempt; it is cleared
  after success or failure, never logged, and never written to
  `localStorage`/`sessionStorage` (only the JWT is, exactly as before this
  task).

## Organization Manager Dashboard (DOC-36)

`role: 'manager'` gets its own dashboard at `/manager`
(`pages/ManagerDashboard.jsx`) - visually consistent with the Admin
Dashboard (same card/stat/badge styling) but functionally distinct and
Organization-scoped rather than global. A Manager sees and manages
**only their own Organization's** Employees and Operators; there is no
Organization-picker, no cross-tenant view, and no way to reach another
Organization's data from this page.

- **Tenant scoping is entirely backend-owned.** This page calls the
  existing DOC-35 endpoints (`services/api.js`'s new `userApi`:
  `GET /api/users`, `PATCH /api/users/:id/role`), which already derive the
  caller's Organization from their authenticated token (DOC-38) at the
  database query level. The frontend never sends `organizationId` on
  either call and never attempts to filter/scope data itself - React is
  not the security boundary here, same as everywhere else in this project.
- **Route/redirect**: `/manager` is wrapped in
  `ProtectedRoute roles={['manager']}` (the same mechanism DOC-37
  introduced for `/admin`) - employee, operator, and system_admin are all
  redirected to their own dashboard (`utils/roleRoutes.js`, DOC-42),
  unauthenticated visitors go to `/login`. Navbar shows a
  Manager-only "Manager Dashboard" link the same way it shows
  "Admin Dashboard" to System Admin - never both, never to the wrong role.
- **Employees vs. Operators** are shown as two separate, simple tables
  (name/email/role/status/action) rather than one mixed list - grouping by
  `role` also means the Manager's own account (and, structurally, any
  `system_admin`) never appears in either table, with no extra "is this
  me?" check required.
- **Only two role actions exist, ever**: "Promote to Operator" on an
  Employee row (`{ role: 'operator' }`) and "Demote to Employee" on an
  Operator row (`{ role: 'employee' }`). There is no role dropdown and no
  way to request `manager` or `system_admin` from this UI - the backend
  would reject either anyway (DOC-35's explicit transition allowlist), but
  the option was never offered in the first place.
- **Failure handling**: a failed promotion/demotion never changes what is
  displayed - the row only reflects a new role once the backend has
  confirmed it. The backend's own client-safe error message is shown
  inline (covers 400 invalid-transition, 403 for a deactivated target or
  an inactive Organization, and 404 for a not-found/cross-org target).
- **Not part of this task** (unchanged/out of scope, on purpose): no
  Employee-creation UI (Employees self-register via Company Code, DOC-33),
  no user deletion, no Manager replacement/reassignment (DOC-34's
  Organization-Manager relationship is untouched), and no
  ticket/request functionality (later Sprints).

## Complete Role-Based Dashboards (DOC-42)

Sprint 3's first task. Establishes the FINAL four-way dashboard structure -
every role now has its own dedicated route, and nothing about it changes
again when the real Ticket/Request system is built later in Sprint 3; that
work only fills in sections that already exist as clean placeholders here.

- **Four routes, one per role**: `system_admin` → `/admin` (DOC-37),
  `manager` → `/manager` (DOC-36), `operator` → `/operator` (**new**),
  `employee` → `/dashboard` (repurposed - previously shared by both
  Employee and Operator; Operator now has its own route). No role can ever
  render another role's dashboard - `ProtectedRoute roles={[...]}` guards
  all four, and direct URL entry to a route you don't have redirects you to
  your own dashboard.
- **`utils/roleRoutes.js`** is the single source of truth for "which route
  does this role land on" - used by `Login.jsx` (post-login redirect) and
  `ProtectedRoute.jsx` (wrong-role redirect). This replaced two independent,
  locally-defined role→path maps that existed before DOC-42. That
  consolidation fixed a real bug this task would otherwise have introduced:
  `ProtectedRoute`'s wrong-role redirect was hardcoded to `/dashboard`,
  which was harmless while `/dashboard` accepted every authenticated role,
  but became a redirect loop the moment `/dashboard` became employee-only
  (an Operator rejected from `/admin` would have been bounced to
  `/dashboard`, then rejected there too). Every wrong-role redirect now
  goes to the visitor's own real dashboard instead.
- **`GET /api/organizations/me`** (new backend route, see `backend/README.md`
  "Organization Self-Lookup (DOC-42)") is what the Manager Dashboard uses
  for its new **Organization Information** section (Name / Company Code /
  Status) and what the Operator Dashboard uses for organization context in
  its header. It is derived exclusively from `req.user.organizationId` -
  this app never sends an `organizationId` to choose which Organization to
  fetch, on any dashboard.
- **Manager Dashboard additions**: Organization Information (as above),
  an Organization Overview stats row (real Employees/Operators counts,
  plus Open/In Progress/Closed Requests shown as an honest "Available when
  Request Management is enabled" placeholder, never a fake number), and an
  Organization Requests section with a clean "coming next" empty state.
  Existing Employee/Operator promotion-demotion management is unchanged.
- **Operator Dashboard (new, `pages/OperatorDashboard.jsx`)**: header with
  organization context, a Request Status Overview stats row (Assigned/Open/
  In Progress/Completed, all placeholders), and an Assigned Requests
  section with an honest empty state ("No requests are currently assigned
  to you.") - not a fake list.
- **Employee Dashboard (`pages/Dashboard.jsx`, rewritten)**: header, a
  disabled "Open New Request" action with an explanatory hint (Ticket
  creation does not exist yet, so the button does not pretend to work), a
  My Requests section with an honest empty state, and a Request Overview
  stats row (My Requests/Open/In Progress/Closed, all placeholders).
- **New shared components** (`components/DashboardHeader.jsx`,
  `StatCard.jsx`, `EmptyState.jsx`, `StatusBadge.jsx`): extracted because
  the welcome-banner, stat-card, and status-badge markup was genuinely
  duplicated across the Admin/Manager dashboards already and would have
  been duplicated a third and fourth time by Operator/Employee.
  `OrganizationCard.jsx` and `OrganizationUserRow.jsx` were updated to use
  `StatusBadge` instead of their own inline copies of the same markup.
- **What is intentionally still a placeholder, and why**: every
  Request/Ticket-related number, list, and action across all four
  dashboards. DOC-42's job was to build the final dashboard *surfaces*, not
  the Ticket system - no fake data, fake counts, or fake API calls exist
  anywhere in this change; every placeholder is a clearly labeled "not
  available yet" state ready to be wired to a real Ticket API in a later
  Sprint 3 task.
