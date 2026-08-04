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
