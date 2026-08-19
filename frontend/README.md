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
deactivate, and regenerate a Company Code. Delete (DOC-47), Organization
Overview/Manager contact (DOC-49), and Manager edit/replace (DOC-49) were
all added later - see their own sections below.

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
  no user deletion, and no ticket/request functionality (later Sprints).
  Manager replacement was out of scope for DOC-36 specifically but has
  since been added at the System Admin level (DOC-49, below) - the
  Manager Dashboard itself still has no way to replace or reassign itself.

## Delete Organization Safely (DOC-47)

Added a **Delete Organization** button to `OrganizationCard.jsx`, visually
separated below the other actions with `.btn-danger`/`.org-card-actions-danger`
styling and its own confirmation dialog (`window.confirm`, matching the
pattern Regenerate Company Code already used) - Cancel sends no request at
all. Only System Admin ever sees this button, since only System Admin can
render the Admin Dashboard at all (`ProtectedRoute roles={['system_admin']}`,
unchanged) - the backend's `requireRole('system_admin')` on
`DELETE /api/organizations/:id` remains the real boundary regardless.

## Complete System Admin / Manager / Employee Management (DOC-49/50/51/52)

Sprint 3 integration tasks - completed and secured what the current backend
can already support; everything Request/Ticket-dependent stays an honest
placeholder (see the DOC-49-52 final report for the full dependency list).

- **Admin Dashboard (DOC-49)**: `OrganizationCard.jsx` now shows the
  Manager's name/email (not just "Assigned"), real Employee/Operator counts,
  and a Requests placeholder, in a new "Organization Overview" block. Two
  new actions next to Assign Manager: **Edit Manager** (fullName/email only,
  prefilled) and **Replace Manager** (a new account, with its own
  confirmation dialog since it deactivates the old Manager). A "Total
  Requests" placeholder card was added to the Platform Overview row for
  consistency with every other dashboard's honest-placeholder convention.
- **Manager Dashboard (DOC-50)**: each Employee/Operator row
  (`OrganizationUserRow.jsx`) now has two more actions alongside
  Promote/Demote: **Edit** (toggles an inline fullName/email form for that
  row) and **Activate/Deactivate**. Both call new `userApi.updateProfile`/
  `userApi.updateStatus` methods and only ever succeed within the Manager's
  own Organization - the backend enforces this the same way DOC-35's role
  endpoint always has. Company Code regeneration was NOT added to this
  dashboard - it remains System-Admin-only by existing, unchanged design.
- **Employee Dashboard (DOC-51)**: added a **Manager Contact** card
  (name/email) using the same `organizationApi.getMine()` call the
  Manager/Operator dashboards already use - loading/error/empty-manager
  states all handled explicitly. Create/View/Edit/Cancel Request and
  comments remain the existing honest placeholders - all blocked on
  DOC-10/11/12/13/43/45/46.
- **Operator Dashboard (DOC-52)**: no changes were needed or made. Every
  restriction the task asked to verify (no user/Organization management,
  no cross-organization access, no Manager/Admin functionality) already
  held via the existing route-level `requireRole`/`requireOrganizationMembership`
  checks - re-verified adversarially rather than assumed.
- **New shared-component change**: `ManagerFormFields.jsx` gained an
  optional `showPassword` prop (default `true`, backward compatible) so
  the Edit Manager form can reuse it without a password field - genuine
  reuse rather than a near-duplicate fieldset.

- **API client**: `organizationApi.delete(id, token)` added to
  `services/api.js` - no raw `fetch` calls added anywhere in the component.
- **On success**: `AdminDashboard.jsx` removes the Organization from local
  state (no separate refetch needed) and shows a confirmation message; the
  Platform Overview counts (`StatCard`s) update automatically since they
  are derived from the same organizations list via `useMemo`.
- **On failure** (most commonly the backend's `409` while dependent Users
  still exist): the Organization stays visible and unchanged, and the
  backend's own client-safe error message is shown inline on that specific
  card - deletion is never presented as having succeeded when it did not.

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

## Service Categories (DOC-43)

A new "Service Categories" section on the existing Manager Dashboard (not
a new page/route) - Organization-scoped, Manager-only, matching the
Employees/Operators tables already on the page.

- **`services/api.js`** - `serviceCategoryApi.list/create/update/
  updateStatus`, following the exact same `request()`-wrapped pattern as
  `organizationApi`/`userApi`. No raw `fetch()` calls anywhere for this
  feature. No call ever sends `organizationId` - the backend derives it
  from the authenticated Manager's own token (DOC-38), the same way
  `organizationApi.getMine()` (DOC-42) already does.
- **`components/ServiceCategoryRow.jsx`** (new) - one row per Category:
  Name/Status/Actions, mirroring `OrganizationUserRow.jsx`'s established
  inline-edit-and-async-action pattern exactly (its own `isEditing`
  state, an async `onUpdateName` prop for renames, an async
  `onToggleStatus` prop for Activate/Deactivate). Reuses the existing
  `StatusBadge` component and the `user-table-action-group`/
  `user-row-edit-form` CSS classes already introduced by DOC-50 - nothing
  here is a duplicate of existing UI. **There is no Delete button or
  action anywhere on this row** - Categories can only be deactivated,
  never removed, since a future Request may reference one by id.
- **`pages/ManagerDashboard.jsx`** - added an "Add Category" toggle button
  and form (name input, inline validation, submit/cancel), and the standard
  loading / error-with-Try-Again / empty ("No service categories have
  been created yet.") / populated-table states, placed after the existing
  Employees/Operators sections and before the Organization Requests
  placeholder. All four states reuse the same `card admin-panel`/
  `auth-subtitle`/`form-error form-error-server` styling already used
  everywhere else on this page - no new CSS classes were introduced for
  this feature.
- **Not implemented here (by design)**: Operator Specialties (DOC-44 - now
  implemented, see below), any Request/Ticket UI that would let an
  Employee pick a Category, and any Delete action for a Category.

## Operator Specialties (DOC-44)

Manager-facing specialty assignment, added directly into the Operators
section of the existing Manager Dashboard's user table - no new page.

- **`services/api.js`** - `userApi.updateSpecialties(id, categoryIds,
  token)`, following the same `request()`-wrapped pattern as every other
  API call. `categoryIds` is always the Operator's *complete* desired
  specialty set (an empty array clears everything) - this client never
  sends `organizationId` or `role`.
- **`components/OrganizationUserRow.jsx`** - extended, not duplicated: a
  new `showSpecialties` prop (the parent sets this `true` only for the
  Operators section, never Employees, and the Manager's own row is never
  rendered here at all) adds a specialty summary line under the Role cell
  ("Electricity, Maintenance" or "No specialties assigned yet.") and a
  "Manage Specialties" button in the action group. Clicking it replaces
  the row with a checkbox list of the Organization's *active* Service
  Categories (reusing the same row-takeover layout the existing inline
  Edit action already uses) - Save/Cancel, its own pending/error state,
  and it only ever reflects a change once the backend confirms it
  succeeded (same pattern as every other row action here).
- **`pages/ManagerDashboard.jsx`** - computes `activeCategories` (the
  existing DOC-43 `categories` state, filtered to `isActive`) and passes
  it, a `categoriesReady` flag, and a `handleUpdateSpecialties` handler
  down to the Operators `UserRoleSection` only.
- **States handled**: while Categories are still loading, the checkbox
  list shows "Loading service categories..." and Save is disabled; if the
  Organization has zero active Categories, it shows "No active service
  categories are available. Create a category first." instead of an empty
  checkbox list; a failed save shows the backend's own error message
  inline and leaves the Operator's stored specialties untouched (no fake
  success).
- **Not implemented here (by design)**: any Request/Ticket UI (DOC-10 -
  now implemented, see below), and any change to the Operator Dashboard's
  existing "coming next" placeholders - an Operator still cannot see any
  Request-related data through DOC-44.

## Create a New Request (DOC-10)

Replaces the disabled "Open New Request" placeholder on the existing
Employee Dashboard (`pages/Dashboard.jsx`, `/dashboard`) with a real form -
no new page or route.

- **`services/api.js`** - `requestApi.create(payload, token)` (only
  `title`/`description`/`categoryId`/`priority` are ever sent -
  organizationId/createdBy/status/assignedOperatorId are never part of
  this client's payload) and `serviceCategoryApi.listAvailable(token)`
  (hits the new read-only `GET /service-categories/available`, separate
  from the Manager-only `list`).
- **`pages/Dashboard.jsx`** - loads active Categories on mount via
  `listAvailable`. "Open New Request" toggles a form: Title (text),
  Service Category (select, populated from the loaded active Categories),
  Priority (select: Low/Medium/High, defaults to Medium), Description
  (textarea), Submit/Cancel. Frontend validation catches missing title/
  description/category before the request is even sent; the backend
  remains authoritative and re-validates independently.
- **States handled**: Categories "Loading...", a Try-Again error state,
  and - if the Organization genuinely has zero active Categories - "No
  service categories are currently available. Please contact your
  Organization Manager." (submission is disabled in this case, and the
  select is not rendered at all rather than rendered empty). A failed
  `POST /requests` shows the backend's own error message inline and
  leaves the form's typed input untouched - no fake success. On success,
  the form closes and a short message ("Request \"...\" was created
  successfully.") is shown; "My Requests" and "Request Overview" are
  deliberately left as their existing honest placeholders (DOC-11 owns
  listing/counting Requests) - the newly created Request is not secretly
  injected into a fake list.
- **Not implemented here (by design)**: any Request list/detail view
  (DOC-11 - now implemented, see below), status display or transitions
  (DOC-12), comments (DOC-13), image upload (DOC-45), or Employee edit/
  cancel of an existing Request (DOC-46).

## View Request Details and Status (DOC-11)

Replaces the "My Requests" and "Request Overview" placeholders on the
same Employee Dashboard with real data - still no new page or route.

- **`services/api.js`** - `requestApi.listMine(token)` (`GET /requests`)
  and `requestApi.getMineById(id, token)` (`GET /requests/:id`), both
  read-only - there is deliberately no `update`/`cancel`/`delete` call
  here yet (DOC-12/46 own those).
- **`components/RequestStatusBadge.jsx`** (new) - a small sibling to
  `StatusBadge.jsx`, not a modification of it: `StatusBadge`'s
  `isActive: boolean` contract is used identically by every existing
  caller for a genuinely binary Active/Inactive concept, and forcing a
  five-value Request status enum (`open | in_progress | resolved |
  closed | reopened`) through that same prop would either lose
  information or require changing `StatusBadge`'s contract and
  re-verifying every existing caller - not the "small safe change" this
  task calls for. `RequestStatusBadge` reuses the same visual language
  instead (the shared `.status-badge` base CSS class) with its own
  status-keyed modifier class and user-friendly labels ("In Progress",
  not "in_progress").
- **`components/RequestRow.jsx`** (new) - one row per Request (Title/
  Category/Priority/Status/Created At/"View Details"), mirroring the
  inline-expand pattern `OrganizationUserRow.jsx`/`ServiceCategoryRow.jsx`
  already use: clicking "View Details" toggles a row-takeover panel
  showing Description, Category, Priority, Status, Assigned Operator
  ("Not yet assigned" when null), Created At, and Updated At. This is the
  smallest maintainable detail view (no modal library, no dedicated
  `/requests/:id` route) - there is no Save/Cancel here and nothing is
  ever sent to the backend; it only toggles what is displayed. No edit/
  cancel/status-change/comment/image controls exist anywhere on this row.
- **`pages/Dashboard.jsx`** - loads "My Requests" on mount via
  `listMine`, with the standard Loading/error-with-Try-Again/empty
  ("You haven't opened any requests yet.")/populated-table states. After
  a successful `POST /requests` (DOC-10's form), the list is now
  refreshed from the real endpoint rather than just showing a success
  message - the newly created Request appears because it is really
  there, not because a fake local object was inserted. "Request Overview"
  now shows real counts (My Requests/Open/In Progress/Resolved/Closed/
  Reopened) computed client-side from the already-loaded list via
  `useMemo` - no backend analytics endpoint. `.dashboard-stats` is a
  responsive auto-fit CSS grid, so all six cards (including Resolved/
  Reopened, which the original 4-card placeholder layout didn't have)
  fit cleanly without any layout rework.
- **Not implemented here (by design)**: status-change controls (DOC-12),
  comments UI (DOC-13), image upload UI (DOC-45), and edit/cancel
  controls (DOC-46) - DOC-11 is read-only, even for a Request the
  Employee owns. Manager/Operator Request views (their own list/detail
  pages) are also not implemented - DOC-11 is specifically the
  Employee's own visibility.

## Update Request Information and Status (DOC-12)

Adds the Employee's two legal status actions to the same "My Requests"
table DOC-11 already built - no new page, no generic status dropdown
anywhere.

- **`services/api.js`** - `requestApi.updateStatus(id, statusValue,
  token)` (`PATCH /requests/:id/status`). The only field this client ever
  sends is `status` - never `assignedOperatorId`/`organizationId`/
  `createdBy`, even though the backend would ignore them anyway.
- **`components/RequestRow.jsx`** (modified) - a new `onUpdateStatus`
  prop. When `request.status === 'resolved'` **and** `onUpdateStatus` was
  passed, two buttons appear next to "View Details": **"Confirm
  Resolved"** (calls `onUpdateStatus(request, 'closed')`) and **"Problem
  Still Exists"** (calls `onUpdateStatus(request, 'reopened')`). No status
  other than `resolved` shows any button here - `open`, `in_progress`,
  `closed`, and `reopened` all stay exactly as read-only as DOC-11 left
  them, matching the Employee's transition matrix (`resolved -> closed`/
  `resolved -> reopened` only). While the call is in flight both buttons
  show "Updating..." and are disabled; on failure the backend's own error
  message is shown inline under the row and nothing about the row's
  displayed status changes (no optimistic update) - the row only reflects
  reality once the parent's refetch completes.
- **`pages/Dashboard.jsx`** - new `handleUpdateRequestStatus(request,
  nextStatus)` async handler: calls `requestApi.updateStatus`, then
  re-runs the existing `listMine` load on success so the table (and the
  real Request Overview counts, still DOC-11's `useMemo`) reflect the
  actual new state - never a locally patched object. Wired into
  `<RequestRow onUpdateStatus={handleUpdateRequestStatus} />`.
- **`pages/OperatorDashboard.jsx`** - **deliberately not modified.** It
  remains the same placeholder DOC-42 built, because there is still no
  API that returns "Requests assigned to me" - building status buttons
  here would mean either faking data or building that missing listing
  endpoint, both out of scope for DOC-12 (see the backend README's
  "Assignment dependency" note). `requestApi.updateStatus` is fully
  implemented and ready for whichever future task adds that listing.
- **`pages/ManagerDashboard.jsx`** - **deliberately not modified.** Its
  "Organization Requests" section is still the same `EmptyState`
  placeholder from DOC-42 - there is no Manager-facing Request list to
  attach a "close" action to yet, and DOC-12 does not secretly build one.
- **Not implemented here (by design)**: any Operator or Manager status UI
  (blocked on a Request-listing endpoint neither role has yet), comments
  (DOC-13), image upload (DOC-45), and Employee edit/cancel (DOC-46).

## Add Comments to a Request (DOC-13)

Adds a comment thread inside the same expanded "View Details" panel
DOC-11/12 already built on each `RequestRow` - no new page, no modal.

- **`services/api.js`** - `commentApi.list(requestId, token)` (`GET
  /requests/:id/comments`) and `commentApi.create(requestId, content,
  token)` (`POST /requests/:id/comments`, sending only `{ content }` -
  never `authorId`/`organizationId`/`requestId`, all server-derived
  regardless).
- **`components/RequestRow.jsx`** (modified) - two new props,
  `onLoadComments`/`onAddComment`. Comments are fetched **only the first
  time a row is expanded** (a `useEffect` keyed on `isExpanded` that
  no-ops once `comments` is no longer `null`) - never upfront for every
  row in the list, keeping `GET /api/requests` itself unchanged and light.
  While loading: "Loading comments...". Empty: "No comments yet." On
  error: the backend's own message, inline. Each comment shows author
  name, role, timestamp, and content. If `request.status !== 'closed'`, an
  "Add Comment" textarea + button appear below the thread; submitting
  calls `onAddComment`, and on success the real comment object returned by
  the backend is appended to the local list and the textarea is cleared -
  never a locally guessed comment (no fake success). On failure, the typed
  text is left exactly as the author wrote it and the backend's error
  message is shown inline. The button is disabled and reads "Adding..."
  while a request is in flight. If `request.status === 'closed'`, the form
  is replaced with "This request is closed and no longer accepts
  comments." - existing comments are still shown; the backend enforces
  this same rule independently (`canWriteRequestComments`), this is only
  the UI's honest reflection of it, not the actual security boundary.
- **`pages/Dashboard.jsx`** - two new thin async handlers,
  `handleLoadComments`/`handleAddComment`, each just forwarding to
  `commentApi` with the current `token` and returning the response's
  `data` - all loading/error/pending UI state lives in `RequestRow`
  itself, matching the same split already used for `onUpdateStatus`.
- **No comment edit/delete UI, no image/file upload UI, and no draft
  persisted to `localStorage`** anywhere - all deliberately out of scope
  (DOC-13 is create + view only; DOC-45 owns attachments).
- **`pages/OperatorDashboard.jsx` / `pages/ManagerDashboard.jsx`** -
  **deliberately not modified**, for the same reason DOC-12 left them
  alone: neither role has a Request-listing UI to attach a comment thread
  to yet. The Comment API itself is generic (Employee/Operator/Manager all
  already work against the same two endpoints, verified in the DOC-13
  test suite) and ready for whichever future task adds those listings -
  nothing here needs to change when that happens.

## Edit / Cancel Own Request (DOC-46)

Adds Edit and Cancel to the same expanded "View Details" panel DOC-11/12/
13 already built on each `RequestRow` - no new page, no modal library.

- **`services/api.js`** - `requestApi.updateMine(id, updates, token)`
  (`PATCH /requests/:id`, `updates` is any subset of `{ title,
  description, categoryId, priority }`) and `requestApi.cancelMine(id,
  token)` (`PATCH /requests/:id/cancel`, no body ever sent - the backend
  decides `status: 'cancelled'` entirely server-side).
- **`components/RequestStatusBadge.jsx`** (modified) - `cancelled ->
  'Cancelled'` added to the existing label map; a new `.status-request-
  cancelled` CSS modifier (muted gray, visually distinct from every
  workflow status) was added alongside the existing five.
- **`components/RequestRow.jsx`** (modified) - three new props,
  `onUpdateRequest`/`onCancelRequest`/`activeCategories`:
  - **Edit** - "Edit Request" appears only when `request.status ===
    'open'` AND `request.assignedOperator` is null (mirroring the
    backend's own 409-guarded eligibility exactly). Clicking it swaps the
    read-only detail grid for a form prefilled with the Request's current
    Title/Description/Category/Priority. Only fields the Employee
    actually changed from their original values are ever included in the
    PATCH payload - an untouched Category is never resent, which is what
    lets a title/description-only save succeed even when the Request's
    historical Category has since gone inactive (task spec section 21).
    The Category `<select>` is built from the same `activeCategories`
    list DOC-10's "Open New Request" form already fetches (`GET
    /service-categories/available` - no second category endpoint); if the
    Request's current Category is not in that active list, it is added
    as its own **disabled** option so the select still displays it
    correctly without letting the Employee re-select an inactive Category
    - they can only ever pick a different, active one, or leave it
      untouched. "Save" is disabled while pending and reads "Saving...";
      on success the parent's real API response drives a full refetch,
      edit mode closes, and a "Request updated successfully." message
      appears; on failure the form stays open with everything the
      Employee typed still in place and the backend's error shown inline
      (no fake success, nothing lost). "Cancel Editing" discards the form
      without calling the backend at all.
  - **Cancel** - "Cancel Request" appears under the same eligibility as
    Edit. Clicking it does **not** cancel immediately - it opens a
    dedicated confirm/keep panel ("Are you sure you want to cancel this
    request? This action cannot be undone." with **Keep Request** /
    **Cancel Request** buttons, task spec sections 22/23), never a single
    accidental click. Confirming calls `onCancelRequest`; on success the
    parent refetches the real list, so the row's badge becomes
    "Cancelled" and the Edit/Cancel actions and the comment form all
    disappear automatically because they are each already gated on the
    Request's real, current status/assignment - nothing is hidden by a
    local flag. On failure the confirm panel stays open with the
    backend's error shown inline (no fake cancellation).
  - The comment section's read-only check (`canWriteComments`) was
    widened from `status !== 'closed'` to also exclude `'cancelled'`,
    with wording that distinguishes the two ("...has been cancelled..."
    vs "...is closed...").
- **`pages/Dashboard.jsx`** - two new thin async handlers,
  `handleUpdateRequest`/`handleCancelRequest`, each forwarding to
  `requestApi` with the current `token` and then re-running `loadRequests`
  - the same "row owns pending/error UI, parent owns the real network
  call + refetch" split every other Request action on this page already
  uses. `activeCategories` (already loaded for the "Open New Request"
  form) is passed down to every `RequestRow`. "Request Overview" gains a
  **Cancelled** count via the same client-side `useMemo` DOC-11 already
  established - no backend analytics endpoint; a cancelled Request is
  still counted in "My Requests" (it is simply filtered by its own
  `createdBy`, unaffected by status) and was never counted as "Open" to
  begin with, since that bucket only ever counts `status === 'open'`.
- **Not implemented here (by design):** any hard-delete UI, comment edit/
  delete UI, image upload UI, and Manager/Operator edit-Request UI - all
  deliberately out of scope.

## Add Image Attachments to Requests (DOC-45)

Adds image selection to the "Open New Request" form, and a per-Request
image gallery with Add/Remove controls to `RequestRow`'s existing
expanded detail panel - no second create page, no modal library.

- **`services/api.js`**:
  - `export const API_BASE_URL` (previously module-private) - `RequestRow`
    needs it directly to build a full `<img src>` URL from an
    attachment's root-relative `url`.
  - The generic `request()` helper now detects `body instanceof
    FormData` and, when true, skips both `JSON.stringify` and the
    `Content-Type` header entirely - the browser generates its own
    `multipart/form-data; boundary=...` header, which manually setting
    `Content-Type` would break (it would omit the boundary). Every
    existing JSON caller is completely unaffected: `Content-Type:
    application/json` is still set exactly as before for anything that
    isn't `FormData`.
  - `requestApi.create` now takes a `FormData` instead of a plain object
    - `title`/`description`/`categoryId`/`priority` as text fields, plus
    zero or more `attachments` file fields. Creating with no images is
    still just a `FormData` with no `attachments` entries.
  - Two new calls: `requestApi.addAttachments(id, formData, token)`
    (`POST /requests/:id/attachments`) and
    `requestApi.removeAttachment(id, attachmentId, token)` (`DELETE
    /requests/:id/attachments/:attachmentId`, no body - the id alone
    identifies which attachment to remove).
- **`pages/Dashboard.jsx`** (modified) - the "Open New Request" form:
  - A new `<input type="file" accept="image/jpeg,image/png,image/webp"
    multiple>` control. Each newly chosen file is validated client-side
    (type against `ACCEPTED_IMAGE_TYPES`, size against a 5 MB cap) and
    queued in `selectedImages` state rather than uploaded immediately; a
    running total is capped at 5 images, with any rejected file/overflow
    surfaced as inline text (never a fake success). Selected images are
    listed with their filename and a per-item "Remove" button before
    submission.
  - `handleCreateRequest` was rewritten to build a `FormData` (the four
    text fields plus one `attachments` entry per queued file) and call
    `requestApi.create(formData, token)`; on success both the form fields
    and `selectedImages` are cleared, and the real "My Requests" list is
    refetched exactly as DOC-10 already did for a text-only create.
  - `handleAddAttachments`/`handleRemoveAttachment` - two thin async
    handlers forwarding to `requestApi.addAttachments`/`removeAttachment`
    and then re-running `loadRequests`, following the same "row owns
    pending/error UI, parent owns the real network call + refetch" split
    every other Request action on this page already uses. Both are passed
    down to every `RequestRow` as `onAddAttachments`/`onRemoveAttachment`.
- **`components/RequestRow.jsx`** (modified) - a new "Images" section,
  rendered **unconditionally** inside the expanded detail panel
  (independent of whether the row is currently in Edit-text mode, and
  never hidden on a cancelled/closed Request - existing images always
  stay visible):
  - A responsive gallery (`request.attachments`, already present on the
    already-loaded Request - no separate fetch the way DOC-13's comments
    needed one) - each item shows a click-to-open-full-image thumbnail
    (`<a target="_blank">` wrapping an `<img>`, built from `${API_BASE_URL}
    ${attachment.url}`), the image's original filename as both caption
    and `alt` text, and graceful broken-image handling (an `onError`
    handler that swaps in a distinct "broken thumbnail" style instead of
    a browser placeholder icon). An empty state ("No images attached.")
    covers a Request with none.
  - **Add Images** and each thumbnail's **Remove** button appear only
    under the exact same eligibility Edit/Cancel already use
    (`request.status === 'open'` AND no assigned Operator) - mirroring,
    not duplicating, DOC-46's `isEditableOrCancellable` flag.
  - Adding follows the same "queue locally, then submit together" pattern
    as the create form: chosen files are validated (type/size, plus a
    remaining-slots cap that accounts for the Request's existing
    attachment count) and listed with per-item pre-submit Remove buttons;
    "Upload" sends every queued file as one `FormData` via
    `onAddAttachments`, disabled/reading "Uploading..." while pending.
  - Removing an existing image calls `onRemoveAttachment(request,
    attachmentId)` directly from its own button (no separate confirm step
    - a single already-saved image is a much lower-stakes action than
    cancelling the whole Request); that button alone shows "Removing..."
    while its specific removal is in flight, tracked by attachment id so
    the rest of the gallery stays interactive.
  - Both flows show inline, non-blocking errors on failure (the backend's
    own client-safe message) - never a fake success, and never anything
    resembling raw JSON.
- **`index.css`** - new classes: `.request-attachments` (mirrors
  `.request-comments`'s border-top/flex-column pattern for visual
  consistency), `.attachment-gallery` (responsive auto-fill grid),
  `.attachment-item`/`.attachment-thumb`/`.attachment-caption`,
  `.attachment-thumb-broken` (the broken-image fallback style), and
  `.selected-image-list`/`.selected-image-item`/`.selected-image-name`
  (shared by both the create form's and `RequestRow`'s "queued but not
  yet submitted" image lists).
- **Not implemented here (by design):** any image cropping/editing UI,
  drag-and-drop reordering, a lightbox/carousel component (a plain new-tab
  full-image link is used instead), and attachments on comments.

> **Storage backend update**: the backend now additionally supports
> S3-compatible object storage (alongside MongoDB GridFS and legacy
> local disk) for where an image's actual bytes are stored - see
> `backend/README.md`'s "S3 Image Storage Migration" section for the
> full writeup. This required **zero changes here** - every image still
> loads through the exact same `AuthenticatedRequestImage.jsx`
> fetch-as-blob component and the exact same content-delivery URL
> (`attachment.url`) regardless of which backend actually stored it;
> the frontend has never needed to know or care where an image lives.

## Security & HTTPS

Full writeup lives in `backend/README.md`'s own "Security & HTTPS"
section - this is the short, frontend-specific summary.

- **Why your password appears in DevTools → Network → Login → Payload**:
  that's your own browser showing you the request it just built from
  what you typed - normal for every site, not something this project
  tries to hide. The real protection against another person on the same
  network reading it is HTTPS, not hiding it from your own DevTools.
- **`VITE_API_BASE_URL`** (`services/api.js`) is PUBLIC client
  configuration - every `VITE_`-prefixed variable is bundled into the
  browser build and visible to anyone who opens it. Never put a secret
  in a `VITE_*` variable. Local development uses
  `http://localhost:5000/api` (safe - same machine, no network in
  between); **production must use `https://...`** - an `https://`
  frontend calling an `http://` API is a browser mixed-content error,
  and separately sends every request, including login, unencrypted.
- **No password is ever persisted** to `localStorage`, `sessionStorage`,
  or anywhere else after a request completes - `context/AuthContext.jsx`
  only ever persists the JWT token (`doc_auth_token`), never a password
  value. This was verified again as part of the security hardening pass
  (repo-wide grep, no `console.log` of any form field anywhere in
  `src/`).
- **Optional dev-server HTTPS** (LAN testing): `DEV_HTTPS_ENABLED`,
  `DEV_SSL_CERT_PATH`, `DEV_SSL_KEY_PATH` in `frontend/.env` (see
  `.env.example`) - deliberately NOT `VITE_`-prefixed, since these
  configure the Vite dev server itself (read in `vite.config.js`'s own
  Node context), never the browser bundle. Off by default; `npm run dev`
  is unaffected unless you opt in.

## Request Activity Timeline (DOC-17)

Full backend writeup lives in `backend/README.md`'s own "Request
Activity Timeline" section - this is the short, frontend-specific
summary.

- **`components/RequestActivityTimeline.jsx`** - a small, self-contained
  component (mirrors `AuthenticatedRequestImage.jsx`'s own "reads
  `token` from `useAuth()` and calls the backend itself" shape): it only
  needs a `requestId` prop, and fetches
  `requestApi.getActivities(requestId, token)` itself the moment it
  mounts - which only happens once the row it lives in is actually
  expanded, never for a collapsed row. No new props or state were added
  to `Dashboard.jsx`/`OperatorDashboard.jsx`/`ManagerDashboard.jsx` for
  this feature at all.
- **Human-readable text is built entirely on the frontend**
  (`describeActivity`, inside the component) - the backend only ever
  sends structured `type`/`oldValue`/`newValue`/`metadata`, never a
  finished English sentence, so a future wording change or localization
  never requires a backend/database change.
- **Wired into `RequestRow.jsx`** (Employee/Operator dashboards) as a new
  block placed after the existing Comments block, inside the same
  expanded detail panel - no redesign of the row itself.
- **Wired into `ManagerRequestRow.jsx`** as its own "View Timeline"
  toggle button + its own `<tr>`, matching that row's existing "View
  Images" toggle shape exactly (that row has no single shared detail
  panel the way `RequestRow.jsx` does, so each independent read-only
  toggle gets its own boolean/row).
- **`index.css`** - new classes: `.request-timeline` (mirrors
  `.request-comments`'s border-top/flex-column pattern),
  `.timeline-list`/`.timeline-item`/`.timeline-item-header`/
  `.timeline-title`/`.timeline-timestamp`/`.timeline-detail`/
  `.timeline-actor` (`.timeline-item` reuses `.comment-item`'s card look
  so the two lists read as one visual family).
- **Empty state**: a Request with no activity yet (any Request created
  before this feature shipped, and never backfilled) shows "No activity
  recorded yet." - never a blank gap or a loading spinner stuck forever.

## In-App Notifications (DOC-18)

Full backend writeup (recipient rules, types implemented/deferred,
Timeline-vs-Notification distinction) lives in `backend/README.md`'s own
"In-App Notifications" section - this is the short, frontend-specific
summary.

- **`components/NotificationBell.jsx`** - a self-contained bell + dropdown
  panel, mounted once inside `Navbar.jsx` (itself mounted once at the top
  of `App.jsx`, outside every route - so the bell is present on every page
  while authenticated). Reads `token`/`user` from `useAuth()` and calls the
  backend itself, the same "own its own data" shape
  `RequestActivityTimeline.jsx` (DOC-17) already established - Navbar
  needed no new state/props for this feature.
- **Visibility**: hidden entirely for an unauthenticated guest (only ever
  rendered inside Navbar's `isAuthenticated` branch) AND for System Admin
  (no Request notification use case exists for that role - same choice
  already made for the Organization Chat link) AND during the forced-
  password-change state (the notification API itself requires
  `requirePasswordChangeCompleted`, so a bell that could never load
  anything would only be confusing).
- **Polling** (task spec section 31): reuses `OrganizationChat.jsx`'s own
  established shape - one `setInterval` + an in-flight guard ref, cleared
  on unmount - rather than a second polling convention. Every 20 seconds
  (within the requested 15-30s range), the unread count is always
  refreshed; the notification list is ALSO refreshed on the same tick, but
  only while the panel is currently open - never a second interval. The
  full list is otherwise only fetched on demand, when the panel opens
  (task spec: "notification list: fetch when panel opens"). Because this
  component only ever mounts while authenticated, logging out unmounts it
  entirely, which stops the interval automatically via its own cleanup
  function - no separate "stop polling on logout" code path was needed.
- **Panel**: shows title/message/relative time/unread indicator per
  notification, a "Mark All as Read" header action, and a per-item mark-
  read control; closes when clicking outside it (a `mousedown` listener
  scoped to while the panel is open only).
- **Click behavior** (task spec section 30): marks the notification read,
  then navigates. This application has no standalone Request URL and no
  query-param deep-link mechanism for "open this one row" (every Request
  is viewed inline inside a role's own dashboard table - see
  `RequestRow.jsx`/`ManagerRequestRow.jsx`) - inventing either would mean
  rewriting routing, which task spec explicitly says not to do. The
  existing, safest mechanism is reused instead: the caller is sent to
  THEIR OWN role's dashboard (`utils/roleRoutes.js`'s `destinationForRole`
  - the exact function `Navbar.jsx`/`ProtectedRoute.jsx` already use for
  this), landing an Employee in Employee-visible Request context, an
  Operator in Operator-visible context, a Manager in Manager-visible
  context - the Request's own title (already shown in the notification)
  is enough to find it via that dashboard's existing search/filter
  controls (DOC-54).
- **`services/api.js`** - new `notificationApi` object:
  `list(token, {before, limit})`, `getUnreadCount(token)`,
  `markRead(id, token)`, `markAllRead(token)` - reuses the exact same
  query-string builder and `request()` helper every other API object in
  this file already uses.
- **`index.css`** - new classes: `.notification-bell`/
  `.notification-bell-button`/`.notification-badge` (the bell + unread
  count), `.notification-panel`/`.notification-panel-header`/
  `.notification-mark-all-btn` (the dropdown shell), `.notification-list`/
  `.notification-item`/`.notification-item-unread`/
  `.notification-item-button`/`.notification-item-title`/
  `.notification-item-message`/`.notification-item-time`/
  `.notification-item-mark-read` (each row) - a plain absolutely-
  positioned panel, no modal/overlay library.

## Request Number / Human-Friendly ID (DOC-16)

Full backend writeup (counter architecture, concurrency, migration,
security) lives in `backend/README.md`'s own "Request Number /
Human-Friendly ID" section - this is the short, frontend-specific summary.

- **`components/RequestNumberBadge.jsx`** - a small, new sibling to
  `RequestStatusBadge.jsx`/`RequestSlaBadge.jsx`. Renders nothing at all
  (`null`) when `requestNumber` is absent/`null` (a historical, not-yet-
  migrated Request) - the title alone is shown in that case, exactly as
  before this ticket, never a raw ObjectId.
- **Where it's shown**: inline, immediately before the title, inside the
  existing title `<td>` in `RequestRow.jsx` (Employee + Operator
  dashboards, both reuse this one component) and `ManagerRequestRow.jsx`
  (Manager dashboard) - not as a new dedicated table column, which would
  also require updating each table's `<thead>` and the expanded detail
  row's `colSpan`. Also shown in the DOC-58 duplicate-request confirm
  dialog on `Dashboard.jsx`, next to each candidate's title.
- **`index.css`** - one new class, `.request-number-badge`: deliberately
  NOT built on the shared `.status-badge` base every workflow/SLA badge in
  this project uses (that base communicates state via color) - a
  `requestNumber` is a stable identifier, not a status, so it gets its own
  small, neutral, monospaced tag instead of borrowing a status color that
  would misleadingly suggest it means something about the Request's
  current state.
- **Notifications**: no frontend change was needed - `NotificationBell.jsx`
  already renders `notification.title`/`notification.message` verbatim;
  the backend now bakes `Request REQ-000123` directly into that message
  text (see `backend/README.md`), so the frontend picks it up for free.
- **Timeline**: no frontend change was needed either -
  `RequestActivityTimeline.jsx` never displayed Request identity in the
  first place (it only describes individual events like "Assigned to X"
  inside an already-expanded row that shows the title/requestNumber at the
  row level) - it still receives `requestId={request.id}` (the internal
  id, never `requestNumber`) as its one prop, unchanged.
- **Build verification**: `npx vite build` completed with no errors after
  this ticket's changes (69 modules transformed).

## Advanced Request History & Reassignment (DOC-15)

Full backend writeup (endpoint extension strategy, reason validation,
metadata shape, notification/SLA/status preservation, authorization) lives
in `backend/README.md`'s own "Advanced Request History & Reassignment"
section - this is the frontend-specific summary.

- **`ManagerRequestRow.jsx` - reassignment confirmation panel (new)**:
  reuses the row's existing mutually-exclusive `mode` state pattern
  (already used for DOC-59's Edit/Cancel/Remove-Operator panels), adding a
  new `'reassign'` mode. Changing the operator `<select>` on an
  already-assigned Request no longer submits immediately - it opens a
  confirmation panel (Current Operator, New Operator, a required Reason
  textarea, Cancel/Reassign Request buttons), matching the task spec's own
  example format exactly. A genuine FIRST assignment (no current operator)
  still submits immediately, exactly as before this ticket - no reason
  modal, no added friction.
- **`ManagerRequestRow.jsx` - unassign confirmation panel (extended)**:
  the pre-existing "Remove Operator" confirmation panel now also includes a
  required Reason textarea; client-side validation blocks submission on an
  empty/whitespace-only reason before the request is ever sent, matching
  the backend's own bounds.
- **`ManagerRequestRow.jsx` - Edit panel parity**: the combined Edit panel
  (DOC-59, priority/category/operator in one form) now also shows the
  Reason textarea, but ONLY when the operator field is both non-empty
  originally (a genuine current assignment exists) AND has actually been
  changed to a different operator - never for a first assignment made
  through this same panel.
- **`services/api.js`**: `assignOperator(id, operatorId, reason, token)` -
  `reason` is a new, optional third argument, sent as-is; the backend
  ignores it for a first assignment and requires it for reassignment/
  unassignment. `managerUpdate`'s `updates` object may now also include
  `reason` for parity with the same endpoint's assignment handling.
- **`RequestActivityTimeline.jsx` - reason display**: `describeActivity()`
  now returns an optional `reason` alongside each event's `title`/`detail`
  - populated only for `REASSIGNED`/`UNASSIGNED` events recorded after this
  ticket shipped (`null`, and simply not rendered, for older history or for
  `ASSIGNED` events, which never have a reason by design). Rendered as a
  separate "Reason: ..." line beneath the existing "Old → New" detail line,
  matching the task spec's own example format. `UNASSIGNED`'s title
  changed from the pre-DOC-15 "Operator unassigned" to "Operator removed"
  to match the spec's exact wording.
- **`index.css`**: `.reassign-operator-summary` (a small responsive grid
  for the Current/New Operator labels in the reassignment panel, reusing
  the existing `.cancel-confirm-panel` container styling); the timeline's
  new reason line reuses the existing `.timeline-detail` class, with
  `.timeline-reason`/`.timeline-reason-label` as light additive hooks - no
  new color/badge system was introduced.
- **`ManagerDashboard.jsx`**: `handleAssignOperator` now accepts and
  forwards the optional `reason` argument through to `requestApi.assignOperator`
  - no other change; the dashboard's own polling/refresh/error-handling
  behavior is untouched.
- **Build verification**: `npx vite build` completed with no errors after
  this ticket's changes.

## Request Reports & CSV Export (DOC-67)

Full backend writeup (endpoint, filter reuse, CSV columns, SLA
classification, escaping/formula-injection protection, UTF-8/BOM, export
size policy) lives in `backend/README.md`'s own "Request Reports & CSV
Export" section - this is the frontend-specific summary.

- **`ManagerDashboard.jsx` - "Export CSV" button**: added to the
  Organization Requests section's own header (`.admin-section-header`,
  already a `space-between` flex row - no new CSS needed), next to the
  existing Search/Filters/Sort controls (`RequestSearchControls`) rendered
  immediately below it. Deliberately NOT added to `RequestSearchControls`
  itself - that component is shared by all three dashboards, and the task
  spec explicitly requires this button on the Manager dashboard only
  (Employee/Operator never see it, since neither `Dashboard.jsx` nor
  `OperatorDashboard.jsx` was touched by this ticket at all).
- **Always sends the CURRENT filter state**: `handleExportCsv` calls
  `requestApi.exportOrganizationCsv(token, requestFilters)` - the exact
  same `requestFilters` state object already driving the visible table
  (search/status/priority/category/operator/creator/date range/sort) -
  never an unfiltered pull. A Manager who has not touched any filter
  simply exports the full Organization list (`DEFAULT_REQUEST_FILTERS`),
  which is the correct, expected behavior, not a special case.
- **`services/api.js` - `exportOrganizationCsv(token, filters)`**:
  deliberately does NOT reuse the shared `request()` helper - that helper
  always calls `response.json()`, which would break on this endpoint's
  real `text/csv` success response. Mirrors `request()`'s own error
  contract on failure (the backend still returns the project's normal JSON
  `{status, message}` error shape for a validation failure, e.g. exceeding
  `MAX_EXPORT_ROWS`), but on success returns `{ blob, filename }` - a raw
  `Blob` plus the filename parsed out of the backend's own
  `Content-Disposition` header.
- **Authenticated Blob download flow (task spec section 19 - a plain
  browser navigation would never attach the JWT this project requires)**:
  API call → `Blob` → `URL.createObjectURL(blob)` → a programmatically
  created, invisible `<a download>` element → `.click()` → cleanup
  (`document.body.removeChild` + `URL.revokeObjectURL`). The JWT is sent
  only in the `fetch` call's own `Authorization` header - it is never
  placed in a URL, a query parameter, or any link the browser itself
  renders or could leak.
- **Download UX**: `exportPending` state - button reads "Export CSV"
  normally and "Exporting..." (and is `disabled`) while the request is in
  flight; `handleExportCsv` also early-returns if a call is already
  pending, so a Manager cannot fire a second overlapping export by
  double-clicking. `exportError` state renders the backend's own safe
  error message (e.g. the `MAX_EXPORT_ROWS` "narrow your filters" message)
  directly above the search controls on failure - the previously-loaded
  Request table is never cleared or affected by an export failure.
- **DOC-53 Statistics / DOC-17 Timeline / DOC-18 Notifications - all
  untouched by this ticket**: exporting never calls `loadStats()`, never
  touches `RequestActivityTimeline.jsx`, and triggers no
  `NotificationBell.jsx` update - exporting a CSV is not a business event.
- **Build verification**: `npx vite build` completed with no errors after
  this ticket's changes (69 modules transformed).

## Error & UX Hardening (DOC-69)

A hardening pass, not a redesign - most of this codebase already had solid
loading states, empty states, confirmation panels, and disabled-during-
request buttons from earlier tickets (DOC-15/17/18/54/57/59/67 in
particular). This section documents the conventions this ticket
introduced or made consistent, not a rewrite of what already worked.

- **Shared API error handling**: `services/api.js`'s own `request()`
  helper was already the one place that turns a backend JSON error
  response into a safe `Error` (`data.message`) - most existing
  `catch (error) { setX(error.message) }` call sites were therefore
  already safe before this ticket. Two real gaps were fixed: (1)
  `request()`'s own `fetch()` call, and `exportOrganizationCsv`'s separate
  one (DOC-67), now both wrap the network call itself in `try/catch` - a
  genuine connection failure (offline, DNS failure, server unreachable)
  previously propagated the browser's own raw message ("Failed to fetch")
  straight to the UI; both now throw a clean "Unable to connect to the
  server..." message instead. (2) `utils/apiError.js`'s new
  `getApiErrorMessage(error, fallback)` is a small, additional
  last-line-of-defense helper - not a replacement for `request()`'s own
  centralization - applied at the genuinely edge-adjacent call sites
  (Login, Register, the CSV export failure handler) rather than
  retrofitted into all ~39 pre-existing `error.message` displays, which
  were already safe and would have been pure churn to touch.
- **Loading / disabled conventions**: every mutating action already
  followed (and continues to follow) the same shape - a `..Pending`
  boolean state, the trigger button's own `disabled={pending}`, and its
  label swapping to a clear present-participle string ("Signing in...",
  "Assigning...", "Exporting..."). This ticket did not change this
  pattern - it audited it broadly and found it already applied
  consistently (Login/Register/ChangePassword/Create Request/Assign/
  Reassign/Unassign/Cancel/Close/Upload/Remove Image/CSV Export/Chat Send/
  Mark Notification Read all already had it).
- **Destructive-action visual consistency**: `.btn-danger` (index.css)
  already existed and was already used for Delete Organization/Replace
  Manager. Three confirm-panel buttons that were behind a confirmation
  step but still colored like a neutral primary action were switched to
  `.btn-danger` for consistency: Manager's "Remove Operator" and "Cancel
  Request" (`ManagerRequestRow.jsx`), Employee's "Cancel Request"
  (`RequestRow.jsx`), and "Deactivate User" (`OrganizationUserRow.jsx`).
  Purely a CSS class change - every one of these already sat behind its
  own existing confirmation panel/step (DOC-15's reassignment/unassignment
  confirmation UI, in particular, was left completely untouched).
- **Centralized status/priority labels**: `utils/requestLabels.js` is the
  one place `PRIORITY_LABELS`/`STATUS_LABELS` now live, replacing four
  independent (previously identical, but drift-prone) copies in
  `RequestRow.jsx`, `ManagerRequestRow.jsx`, `ManagerDashboard.jsx`, and
  `RequestStatusBadge.jsx`.
- **Network-failure behavior**: see "Shared API error handling" above - a
  genuine connection failure now always reads "Unable to connect to the
  server. Please check your connection and try again.", never "Failed to
  fetch"/"Network Error" verbatim.
- **JWT-expiry behavior (new)**: `services/api.js` exports
  `setUnauthorizedHandler`; `AuthContext.jsx` registers a handler on
  mount that clears auth state (reusing the existing `logout()`) whenever
  `request()` detects an authenticated call rejected with one of the
  EXACT strings `backend/src/middleware/auth.js`'s `verifyToken` itself
  produces for a missing/expired/invalid token (401) or a deactivated
  account (403) - matched by exact message text, deliberately NOT "any
  401/403 on any authenticated call", because at least one endpoint
  (`changePassword`) legitimately returns 401 for a genuine business
  reason ("Current password is incorrect.") that must never trigger a
  forced logout. `ProtectedRoute.jsx`'s existing `isAuthenticated` check
  is what actually performs the redirect to `/login` (no new navigation
  logic was added) - this cannot produce an infinite redirect loop, since
  it only ever fires in reaction to a rejected API call, never in reaction
  to the redirect itself. `Login.jsx` shows a one-time "Your session has
  expired. Please sign in again." message via a `sessionStorage` flag the
  handler sets and Login reads-and-clears on its own first render.
- **Polling-failure behavior**: both existing pollers
  (`NotificationBell.jsx`'s 20s unread-count/list poll, `OrganizationChat.jsx`'s
  7s message poll) already failed silently on a single bad tick before
  this ticket - confirmed intact, not changed. Neither poller ever shows
  an error banner for a transient failure; the next tick simply tries
  again.
- **ErrorBoundary (new)**: `components/ErrorBoundary.jsx`, a top-level
  class component (React error boundaries cannot be functional as of
  React 18) wrapping the entire app in `main.jsx`, outside
  `BrowserRouter`. Catches a genuine RENDERING exception only (never a
  substitute for the API error handling above) and shows "Something went
  wrong. Please refresh the page." with a reload button - never a stack
  trace, never a `console.*` call (this project's own logging-hygiene rule
  applies to the frontend too, not just the backend).
- **404 page (new)**: `pages/NotFound.jsx` + a catch-all `<Route path="*">`
  in `App.jsx` (always the LAST route). Previously an unmatched URL
  rendered nothing at all inside `<main>`. Offers a real way back (the
  caller's own dashboard if signed in, Home otherwise) via the same
  `destinationForRole` helper `ProtectedRoute.jsx`/`Login.jsx` already use.
- **Backend error contract**: audited, not changed -
  `backend/src/middleware/errorHandler.js` already returns a generic
  "Internal Server Error" for any 5xx (the real error is only ever
  `console.error`'d server-side, never sent to the client) and
  `backend/src/middleware/notFound.js` already returns clean JSON for any
  unknown API route. Both were already exactly what this ticket asks for.
- **System Admin dashboard**: audited - the stale "Available when Request
  Management is enabled" placeholder this ticket's task spec warns about
  had already been removed in an earlier pass (see `AdminDashboard.jsx`'s
  own comment); confirmed absent, nothing to fix.
- **Regression note**: DOC-15/16/17/18/67's own UX (reassignment/
  unassignment confirmation UI, RequestNumberBadge, Timeline empty state
  and reassignment-reason line, notification unread badge/panel states,
  CSV export loading/disabled state) were all verified intact via the
  temporary test harness below - none were altered by this ticket.
- **Test summary**: a temporary static/logic test harness
  (`frontend/__doc69_test.mjs`, deleted after this run) - unlike prior
  backend tickets, this ticket has almost no backend logic to mock; it
  instead (1) unit-tests the two new pure utilities
  (`getApiErrorMessage`, `requestLabels.js`) directly under plain Node via
  ESM import, and (2) runs static source-scans confirming every new wiring
  point (network-failure handling, session-expiry message matching,
  ErrorBoundary/NotFound registration, btn-danger swaps, centralized label
  imports) and every regression point (DOC-15/16/17/18/67's own UX,
  System Admin placeholder absence) actually landed correctly - **58 of 58
  assertions passed, 0 failed**.
- **Frontend build verification**: `npx vite build` completed with no
  errors (73 modules transformed, up from 69 - the four new files). The
  production bundle was also grepped for `password`/`jwt_secret`/
  `mongodb_uri`/`aws_secret`/private-key markers - every match was
  ordinary UI label text ("Change Password", form field names, etc.),
  never an actual secret value.
- **Known limitations (task spec section 47's own required disclosure)**:
  no real browser was available in this environment - this pass verifies
  everything statically/logically (React build success, source-level
  wiring, pure-function correctness) but does NOT independently confirm
  actual rendered layout, real click-driven double-submit timing, CSS
  responsive breakpoints (320-400px/tablet/desktop), or keyboard-focus
  visuals in a live browser. This is disclosed rather than claimed as
  verified - genuine visual/responsive/accessibility confirmation still
  needs a manual pass in a real browser before this ticket is considered
  fully done in that dimension.

## Organization Settings for Manager (DOC-61)

The Manager Dashboard's "Organization Information" panel (DOC-42) is now
**"Organization Settings"** - the same panel, still on the Manager
Dashboard, no new route/page added. It is both the read view (unchanged
data source, `GET /api/organizations/me`) and, new in this ticket, an edit
form (`PATCH /api/organizations/me`, Manager-only on the backend - see
`backend/README.md` "Organization Settings for Manager (DOC-61)" for the
full authorization/validation contract).

- **Editable fields**: Organization Name, Description, Contact Email,
  Contact Phone - each a standard `.form-group` (label + input/textarea +
  inline `.form-error`), reusing this project's existing form styling
  rather than introducing a new form pattern. Description is rendered as
  plain text only (a controlled `<textarea>` value), never
  `dangerouslySetInnerHTML`.
- **Read-only fields**: Company Code, Organization Status, Created - shown
  in the same `.org-info-details`/`.org-card-detail` layout DOC-42 already
  used, never rendered as inputs, so there is no way to even attempt to
  edit them from this form. Regenerating the Company Code and activating/
  deactivating the Organization both remain exclusively System Admin
  actions elsewhere in the product; this panel never exposes either.
- **Client-side validation** (`validateOrgSettingsForm`, module-level pure
  function in `ManagerDashboard.jsx`) mirrors the backend's own rules -
  name required/2-100 chars, description max 1000 chars, contact email
  format (`EMAIL_REGEX`, the same shared regex `Login`/`Register` already
  use), contact phone max 30 chars / permissive international format. This
  is a UX convenience only; the backend re-validates everything
  authoritatively and is what actually enforces these rules.
- **Change tracking / Save button state**: `settingsForm` is a separate,
  editable copy of the loaded `organization` data. `hasSettingsChanges`
  (a `useMemo` comparing the current form values against `organization`'s
  own last-confirmed values) drives the Save button's `disabled` state -
  Save is disabled whenever nothing has actually changed, and again while
  `settingsPending` is true (button text toggles `"Save Changes"` /
  `"Saving..."`). Both conditions are re-checked inside the submit handler
  itself, not only via the button's `disabled` attribute, so a
  double-submit is prevented even if the disabled state were somehow
  bypassed.
- **Partial save**: only the fields that actually differ from
  `organization`'s current values are included in the `PATCH` body -
  re-saving unchanged values, or saving after editing only one field, both
  work exactly the same way the backend's own partial-update support
  expects.
- **Success/error UX reuses DOC-69's shared infrastructure** -
  `getApiErrorMessage(error, fallback)` from `utils/apiError.js` formats
  every failure (validation 400s, network failure, session expiry) into
  the same plain, user-safe sentence style already used everywhere else in
  the app (e.g. *"Organization name is required."*,
  *"Unable to connect to the server. Please try again."*) - a raw
  `AxiosError`/`MongoServerError`/`CastError` string is never shown. A
  successful save shows *"Organization settings updated successfully."*
  and clears itself the moment the Manager starts editing again.
- **No full page reload on save.** The backend's own response (the freshly
  saved Organization) replaces local `organization` state directly, which
  in turn re-syncs `settingsForm` - the same "update in place" pattern
  every other mutating action in this app already uses.
- **`organizationApi.updateMine(updates, token)`** (`services/api.js`) is
  the one new API call this ticket added - a thin `PATCH /organizations/me`
  wrapper, alongside the existing `organizationApi.getMine`.
- **Not built here, on purpose**: no logo/branding upload (the ticket
  explicitly allows deferring this; see `backend/README.md`'s own note on
  the decision), no new page/route (the panel lives inside the existing
  Manager Dashboard), no notification/timeline entry for a settings change
  (not a Request lifecycle action - would only add noise).

## User Profile (DOC-62)

A new, single, role-agnostic **`/profile`** page
(`src/pages/Profile.jsx`) - one page for every authenticated role
(`system_admin`/`manager`/`operator`/`employee`), not four separate role
variants. Reachable via a new **`My Profile`** link in the Navbar and shows
Account Information: Full Name (editable), Email, Role, Organization,
Account Status, and Member Since (all read-only). See
`backend/README.md`'s "User Profile (DOC-62)" section for the full
backend authorization/validation contract behind it.

- **Data source**: `GET /api/auth/me` (unchanged, DOC-33/DOC-57) for
  reading; a new `userSelfApi.updateMine({ fullName }, token)`
  (`PATCH /api/users/me`) for saving. Organization display reuses the
  existing `organizationApi.getMine()` (DOC-42) for
  Manager/Operator/Employee; System Admin (whose `organizationId` is
  always `null`) shows a fixed *"Platform-level account"* notice instead
  of attempting a call that would only ever 404.
- **Editable**: Full Name only. **Read-only**: Email (with an inline hint
  explaining why), Role (rendered in human-readable form via the new
  shared `roleLabel`/`ROLE_LABELS` in `utils/roleRoutes.js` - *"System
  Admin"*/*"Manager"*/*"Operator"*/*"Employee"*, never the raw enum
  value), Organization (the Organization's **name**, never the raw
  `organizationId`), Account Status (the existing `StatusBadge`
  component), Member Since (formatted `createdAt`). None of these five
  render as inputs - there is no editable role/organization/status/date
  control anywhere on this page, and the backend independently rejects a
  forged attempt at any of them regardless.
- **Change tracking / Save button state**: identical pattern to DOC-61's
  Organization Settings form - a `hasChanges` `useMemo` comparing the
  current input against the AuthContext's own `user.fullName` drives the
  Save button's `disabled` state (disabled when nothing changed, and again
  while a save is in flight), both re-checked inside the submit handler
  itself as well, not only via the button's `disabled` attribute.
- **AuthContext refresh, no logout/login, no page reload (task spec
  sections 16-17)**: on a successful save, the backend's own response
  replaces `user` via the existing `AuthContext.updateUser` (already used
  by the DOC-57 Change Password page) - never a locally-guessed update.
  Every component that reads `user.fullName` re-renders automatically as a
  normal consequence of React state changing, with no extra plumbing:
  confirmed for the Manager/Operator/Employee dashboards' own "Signed in
  as {fullName}" subtitles. **Note**: an audit for this ticket confirmed
  the Navbar itself does not currently render the user's name anywhere (it
  shows role-based dashboard links and a Logout button only) - there is
  nothing there to visibly refresh, so this is not a regression, simply
  nothing to update.
- **Success/error UX reuses DOC-69's shared infrastructure** -
  `getApiErrorMessage(error, fallback)` formats every failure into the
  same plain, user-safe sentence style used everywhere else (*"Full name
  is required."*, *"Unable to connect to the server. Please try again."*)
  - a raw `AxiosError`/`MongoServerError`/`CastError` string is never
  shown. A successful save shows *"Profile updated successfully."* and
  clears itself the moment the person starts editing again.
- **Change Password is a link, not a second implementation.** The page's
  `Change Password` button is a plain `<Link to="/change-password">` to
  the existing DOC-57 page - there is no second password-change form or
  endpoint anywhere in Profile.
- **Navbar**: one new `My Profile` link, shown to every authenticated role,
  hidden during the forced-password-change state the same way the
  Dashboard/Chat/Notifications links already are (`user?.mustChangePassword`)
  - a forced-change user is redirected away by `ProtectedRoute` before this
  page's content would ever render anyway, so a link that could never
  actually save anything yet would only be confusing.
- **Not built here, on purpose**: no email editing (see the backend
  README's own documented decision), no profile picture/avatar (no such
  support exists anywhere in this project), no role/organization/status
  selector of any kind, no second password-change flow.

## Audit Log (DOC-64)

A new `AuditLogPanel` component (`src/components/AuditLogPanel.jsx`),
shown on both the Manager Dashboard and the Admin Dashboard - one shared
component, not two near-duplicates, since the two views differ in exactly
two things: an Organization filter dropdown and an extra "Organization"
line per entry, both controlled by a single `isSystemAdmin` prop. See
`backend/README.md`'s "Audit Log (DOC-64)" section for the full
classification, sensitive-data-handling, and API contract this UI is
built on top of.

- **Data source**: a new `auditLogApi.list(token, params)`
  (`GET /api/audit-logs`) - Manager-only own-Organization results,
  System-Admin-only platform-wide results with an optional Organization
  filter; this component never filters results client-side to fake that
  boundary, the backend is the real one.
- **Human-readable labels** (task spec section 33): `utils/auditLogLabels.js`
  centralizes `AUDIT_ACTION_LABELS` (e.g. `USER_ROLE_CHANGED` → "User role
  changed") and `formatAuditChanges` (turns a backend `{ field: { from,
  to } }` object into ready-to-render rows, e.g. "Role: Employee →
  Operator") - the raw enum value or a JSON blob is never shown in the UI.
- **List display** reuses the exact same `.timeline-list`/`.timeline-item`
  visual family DOC-17's own `RequestActivityTimeline.jsx` already
  established, rather than inventing a second list style - each entry
  shows the action label + timestamp, the target's display name + type,
  every changed field as a "Label: from → to" line, and the actor's name +
  role.
- **Filters**: Action, Target Type, and a From/To date range are exposed
  in the UI for both roles; System Admin additionally gets an Organization
  dropdown (populated from `organizationApi.list`, id → name, loaded once).
  The backend also supports an `actor` (user id) filter, but this ticket
  deliberately does not expose a raw-id text input for it in the UI (task
  spec section 28: "Support useful filters without overengineering") - a
  clunky free-text id field was judged worse UX than simply omitting it;
  the API-level support is still fully tested.
- **Pagination**: a `Load More` button appends the next page (cursor-based,
  newest-first) - the same `limit`/`before` shape DOC-18's own
  `NotificationBell.jsx` already uses, never "load everything at once."
- **Loading / empty / error UX reuses DOC-65's shared patterns** -
  "Loading audit log..." while the first page is in flight, "No
  administrative activity recorded yet." for a genuinely empty result, and
  `getApiErrorMessage` for any failure - never a raw backend error string.
- **Not built here, on purpose**: no create/edit/delete UI of any kind
  (the backend has no such endpoints - task spec section 36), no Request
  operational data of any kind on the System Admin view (task spec section
  32 - this panel only ever calls `GET /api/audit-logs`).
