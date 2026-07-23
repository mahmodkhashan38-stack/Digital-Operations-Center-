# Backend

Node.js, Express and MongoDB backend.

## Scripts

- `npm start` - runs the API server.
- `npm run migrate:users-organizations` - one-time/rerunnable data migration
  (DOC-39) that normalizes Sprint 1 user documents created before the
  User → Organization relationship (DOC-30) existed. It sets
  `organizationId = null` on any user document missing that field. It never
  assigns a user to an Organization, never touches passwords/email/role, and
  is safe to run multiple times. See the comment header in
  `scripts/migrateUsersToOrganizations.js` for full details.
- `npm run seed:system-admin` - bootstraps the single global System Admin
  account (DOC-31). Reads `SYSTEM_ADMIN_EMAIL`, `SYSTEM_ADMIN_PASSWORD` and
  `SYSTEM_ADMIN_FULL_NAME` from `backend/.env` (see `.env.example` for the
  placeholder keys - never commit real values), hashes the password with
  bcrypt exactly like public registration does, and creates a user with
  `role: 'system_admin'` and `organizationId: null`. The System Admin can
  **only** be created this way - the public `/api/auth/register` endpoint
  always forces `role: 'employee'` and ignores anything else the client
  sends. Safe to run more than once: if a System Admin already exists it
  does nothing (or reports a conflict if the existing one has a different
  email - it never guesses or promotes an existing account). See the
  comment header in `scripts/seedSystemAdmin.js` for full details.

## Roles

`employee` (default, created by public registration), `system_admin`
(global, created only via `npm run seed:system-admin`), `manager`
(organization-scoped, created only via the Organization-manager flow below)
and `operator` (organization-scoped, created only by an Organization
Manager promoting an existing employee - see "Organization User Role
Management (DOC-35)" below) exist.

## Company Code (DOC-41)

Every Organization has a `companyCode`: a short (6-character, uppercase
letters/digits) onboarding code that uniquely identifies it - for example
`A7K9P2`. It is **not** a credential: it never grants access or a role by
itself, and Login never uses it (Login is still Email + Password only).
An employee types their organization's Company Code during registration
(DOC-33, below) so the backend can look up the matching Organization and
set `organizationId` on their account - the code itself is never copied
onto the User document.

Generation, normalization (`abc123` and `ABC123` are the same code) and
validation all live in one reusable place, `backend/src/utils/companyCode.js`,
used by Organization creation/regeneration (DOC-32, below) - regenerating a
code never changes the Organization's `_id`, so existing members (referenced
by `organizationId`, not by companyCode) are unaffected.
`Organization.companyCode` also has a MongoDB unique index as a
database-level backstop against duplicates.

## Organization Management (DOC-32)

`POST/GET /api/organizations`, `GET/PATCH /api/organizations/:id` and
`POST /api/organizations/:id/regenerate-code` let the System Admin create,
list, view, update and re-code Organizations. Every route requires a valid
JWT **and** `role: 'system_admin'` (`middleware/requireRole.js`) - a regular
employee gets 401 if unauthenticated or 403 if authenticated but not an
admin, never access.

- **Create**: `name` is required from the client; an optional nested
  `manager: { fullName, email, password }` may also be included (DOC-34) to
  create the Organization's initial Manager in the same request.
  `companyCode` is always generated server-side (DOC-41, collision-checked
  against the database before use); `createdBy` is always the authenticated
  System Admin.
- **Update**: `PATCH /api/organizations/:id` only accepts `name` and
  `isActive` (an explicit allowlist) - `companyCode`, `createdBy`,
  `managerId`, `_id`, or anything else in the request body is ignored, so a
  client cannot mass-assign protected fields. `managerId` can never be set
  through this endpoint, on purpose.
- **Deactivation over deletion**: there is no delete endpoint. Organizations
  can carry users, and later tickets/history, so DOC-32 supports
  `isActive: true/false` (via the update endpoint) instead of a destructive
  hard delete. This avoids ever needing (or being tempted to add) a cascade
  delete.
- **Company Code regeneration**: `POST /api/organizations/:id/regenerate-code`
  generates and confirms a brand new unique code server-side and swaps it
  in - the Organization's `_id` never changes, so no `User` document needs
  to be touched.

## Organization Manager (DOC-34)

Every Organization has at most one initial/primary Manager, tracked both
ways: `Organization.managerId` points at the Manager's User document, and
`User.organizationId` points back at that same Organization - the schema
now rejects a `manager` document whose `organizationId` is missing, the same
way it already rejects a `system_admin` with one set.

A Manager is **always a brand-new account** created by the System Admin,
never an existing Employee promoted in place, and never self-service:

- `POST /api/organizations` with a nested `manager` object creates the
  Organization and its initial Manager together as one operation. If Manager
  creation fails for any reason (invalid input, duplicate email, a database
  error), the Organization that was about to be created is rolled back too,
  so a failed request never leaves a "half-created" Organization behind.
- `POST /api/organizations/:id/manager` assigns an initial Manager to an
  Organization that doesn't have one yet (e.g. one created before this task,
  or created without a `manager` payload). Rejected if the Organization is
  inactive, or already has a Manager (assignment happens once - replacing a
  Manager is not part of this task).
- Both endpoints share one internal helper, so there is only one
  manager-creation implementation. Manager passwords are hashed with bcrypt
  using the exact same rules as public registration; the password/hash is
  never returned in any response or logged.
- This project's MongoDB deployment is not guaranteed to support
  multi-document transactions in every environment, so instead of assuming
  that support, both flows use explicit compensating rollback: if a Manager
  account is created but cannot be linked back to its Organization, that
  account is deleted rather than left orphaned.
- The Manager logs in through the existing `POST /api/auth/login` (Email +
  Password only - no Company Code) and is identified afterwards by
  `role: 'manager'` / `organizationId` in the JWT-backed session, exactly
  like any other role. A Manager Dashboard is not part of this task
  (DOC-36).

## Employee Registration with Company Code (DOC-33)

`POST /api/auth/register` is public (no token required) and now requires
`fullName`, `email`, `password` **and** `companyCode`. It always creates
exactly one kind of account: `role: 'employee'`, joined to the Organization
that `companyCode` resolves to.

- **Company Code resolution**: the submitted code is normalized with the
  same `normalizeCompanyCode`/`isValidCompanyCode` helpers used everywhere
  else (`src/utils/companyCode.js` - no separate copy of this logic exists),
  then looked up with `Organization.findOne({ companyCode: normalizedCode })`.
  A missing, malformed, or unknown code, and a code that resolves to an
  Organization with `isActive: false`, all return the same generic 400
  response - the same anti-enumeration pattern Login already uses for
  "Invalid email or password", so a client can't distinguish "no such code"
  from "that org is disabled" from the response alone.
- **`organizationId` is never client-controlled**: it is only ever set from
  the resolved Organization's own `_id` (`organization._id`), never from
  `req.body.organizationId` - a request that includes an `organizationId`
  field is simply ignored. `companyCode` itself is never stored on the User
  document; only `organizationId` is.
- **`role` is never client-controlled**: the request body's `role` (if any)
  is never read. Registration never sets `role` explicitly, so the schema
  default (`'employee'`) always applies - there is no way for a public
  registration request to produce a `system_admin` or `manager` account,
  no matter what the client sends. Those two roles are only ever created by
  `seed:system-admin` and the Organization-manager flow (DOC-34) above.
- **Login is unchanged**: still Email + Password only. A `companyCode`
  field in a login request body is never read.
- **Existing Sprint 1 rules preserved as-is**: email format check, minimum
  password length, bcrypt hashing, duplicate-email handling (409, generic
  message), and the safe `sanitizeUser` response shape (never includes
  `passwordHash`) are all reused unchanged from Login/registration's
  original implementation - none of it is duplicated or re-implemented for
  this task.
- **Legacy/system accounts unaffected**: DOC-39's migrated pre-DOC-30 users
  (`organizationId: null`) are not touched by DOC-33 - this task only
  applies to brand-new registrations; there is no login-time or
  registration-time migration of existing accounts.
- **Known, accepted limitation**: the Organization lookup and the User
  creation are two separate steps (this project does not use MongoDB
  transactions - see the Organization Manager section above for the same
  reasoning). In the narrow window between them, a System Admin could
  deactivate the Organization; the resulting user would belong to an
  Organization that is now inactive. This is exactly the state the
  isolation rules below (DOC-38) already handle for any Organization
  deactivated after it has active members.

## Organization Data Isolation (DOC-38)

The central security rule of this project: **a user belonging to
Organization A must never be able to read, modify, or manage Organization
B's data.** This is enforced entirely in the backend - the frontend never
decides what a user can see, it only reflects what the backend already
allowed.

- **`organizationId` is the authoritative tenant boundary.** Every
  isolation check compares `organizationId` values - never anything else
  (not email, not company name, not a URL segment).
- **Trusted organization context comes from `req.user` only**, which
  `middleware/auth.js` populates *after* verifying the JWT signature by
  re-reading the user's current `role`/`organizationId`/`isActive` from
  the database on every request. `req.body.organizationId`,
  `req.params.organizationId`, and `req.query.organizationId` are never
  treated as proof of anything - they are attacker-controlled input, not
  identity. (See "Stale JWT" below for why this is a fresh DB read rather
  than trusting the token's payload.)
- **`system_admin` is global by design.** It always has
  `organizationId: null` (enforced by the `User` schema validator, DOC-31)
  and its job - the Organization CRUD in this file's "Organization
  Management" section - is intentionally cross-Organization. None of the
  isolation middleware below apply to it; those routes stay protected by
  `requireRole('system_admin')` alone, exactly as before DOC-38.
- **`manager` and `employee` are organization-scoped.** Their
  `organizationId` defines their tenant boundary for any future
  organization-owned resource.
- **Legacy orgless users (`organizationId: null`, DOC-39) can still
  authenticate**, but are treated as unauthorized for any
  organization-scoped operation - the backend never guesses or
  auto-assigns an Organization for them.

### Reusable isolation middleware (`src/middleware/organizationScope.js`)

Three small, composable pieces - not a general permissions framework:

- **`requireOrganizationMembership`** - rejects (403) an organization-
  scoped caller (`manager`/`employee`) whose `organizationId` is `null`.
  `system_admin` always passes through.
- **`requireSameOrganization(getResourceOrganizationId)`** - a middleware
  factory: loads the target resource's `organizationId` (via a caller-
  supplied function, sync or async) and compares it to
  `req.user.organizationId`. A missing resource and a resource that
  exists but belongs to a different Organization both return the same
  404 - this project does not let a response reveal "that record exists,
  it's just not yours" (no cross-tenant enumeration). `system_admin`
  always passes through.
- **`requireActiveOrganization`** - rejects (403) an organization-scoped
  caller whose own Organization currently has `isActive: false`.
  `system_admin` always passes through (it must still be able to manage,
  including reactivate, an inactive Organization via the CRUD endpoints
  above).

**Current usage**: as of DOC-38, the only endpoints that expose or mutate
organization-owned data are the System Admin Organization CRUD above
(correctly left ungated by this file - it's meant to be global) and the
self-scoped auth endpoints (`register`/`login`/`me`, which only ever
touch the caller's own single `User` document by `_id` - there is no
"another user in my organization" or "another organization's data" for a
tenant-boundary check to guard yet). `requireOrganizationMembership` and
`requireActiveOrganization` are exercised directly today only by the unit
tests in this task's verification; no route wires them in yet because no
organization-owned resource route exists yet. **This is deliberate, not
an oversight** - DOC-38 was scoped to the data that exists now, not to
inventing endpoints to exercise the middleware against.

### What future Ticket/Operator/Dashboard code MUST do

Any future controller that reads or writes an organization-owned resource
(Tickets, DOC-35 role management, DOC-36 Manager Dashboard, etc.) must:

1. Sit behind `verifyToken` (for trusted `req.user`) and
   `requireOrganizationMembership` (rejects orgless callers).
2. **Query with the tenant filter baked in**, e.g.
   `Ticket.find({ organizationId: req.user.organizationId })` -
   never `Ticket.find({})` followed by filtering in the controller or,
   worse, in the frontend.
3. For a single-resource route (`GET/PATCH /tickets/:id`), use
   `requireSameOrganization(async (req) => { const t = await
   Ticket.findById(req.params.id); return t && t.organizationId; })`
   rather than loading the document and manually comparing
   `String(t.organizationId) !== String(req.user.organizationId)` inline.
4. Never accept `organizationId` in the request body/query as authoritative
   for a normal (`manager`/`employee`) caller - it always comes from
   `req.user.organizationId`, the same rule DOC-33's Register already
   follows for `companyCode` resolution.
5. If the operation should be blocked while the caller's Organization is
   deactivated, add `requireActiveOrganization` to that route's chain.

### Stale JWT / deactivation

Before DOC-38, `middleware/auth.js` only decoded the JWT and copied
`{ userId, role }` out of its payload - it never included
`organizationId` at all, and never checked whether the account still
existed or was still active. A token issued before a role change, an
Organization change, or a deactivation would keep working exactly as
before until it naturally expired.

DOC-38 closes this by having `verifyToken` re-read the user from the
database on every authenticated request (one indexed lookup by `_id`) and
reject immediately (403) if the account has since been deactivated. This
also means `organizationId` in `req.user` is always current, not a
snapshot from login time. This is a deliberately small, safe improvement -
not full token revocation/refresh-token infrastructure, which was judged
unnecessary for the isolation guarantee this task requires.

### Inactive Organizations

- New registrations against an inactive Organization are already blocked
  (DOC-33).
- `requireActiveOrganization` is available for any future organization-
  scoped business operation that should be suspended while the tenant is
  deactivated (see above) - not wired into a route yet, since none such
  exists.
- System Admin management of Organizations (including reactivating one)
  is never blocked by this - `system_admin` bypasses all three isolation
  helpers.

### Known limitation (as of DOC-38; superseded by DOC-35 below)

At the time DOC-38 was implemented, no organization-owned resource
endpoint existed yet besides System Admin's own Organization records, so
its cross-tenant guarantees were proven by direct unit tests of the
middleware rather than a live "Manager A reads Manager B's data" HTTP
round trip. DOC-35 (below) is the first real route to consume this
infrastructure, and its own test suite includes exactly that live
cross-organization round trip.

## Organization User Role Management (DOC-35)

An Organization Manager can promote/demote users **within their own
Organization only**, through one narrow business flow - this is not a
generic role-permissions engine:

```
employee --(Manager promotes)--> operator
operator --(Manager demotes)---> employee
```

- **No separate Operator registration.** There is no "register as
  operator" and no role picker anywhere on the public Register form. The
  only way an account becomes `operator` is: register as `employee`
  (DOC-33), then have your Organization's Manager promote you through the
  endpoint below. Demotion reverses the exact same way.
- **`POST/GET /api/users` and `PATCH /api/users/:id/role`** are
  **Manager-only**. Every route on this router requires, in order:
  `verifyToken` (fresh DB-backed identity, DOC-38) → `requireRole('manager')`
  → `requireOrganizationMembership` → `requireActiveOrganization`. System
  Admin does **not** get access through this router - it already has
  global responsibilities via `/api/organizations`, and this is
  deliberately scoped to a single Organization. A Manager whose own
  Organization has been deactivated is blocked from all of it (System
  Admin can still reactivate the Organization globally).
- **`GET /api/users`** returns only users where
  `organizationId === req.user.organizationId` (a real database-level
  filter, never `User.find({})` followed by filtering) with the same safe
  fields as everywhere else (`sanitizeUser` - no `passwordHash`). Added
  because a Manager otherwise had no way to discover which user ids exist
  in their own Organization to manage in the first place; no pagination,
  search, or sorting beyond a stable order was added, since none of that
  is required for this task. Full dashboard UI is DOC-36's job, not this
  one.
- **`PATCH /api/users/:id/role`** accepts exactly one body field,
  `{ "role": "operator" }` or `{ "role": "employee" }`. Nothing else in
  the body (`organizationId`, `managerId`, `isActive`, `email`,
  `passwordHash`, ...) is ever read - there is no
  `targetUser.role = req.body.role` anywhere; every write is checked
  against an explicit transition allowlist first
  (`employee → operator`, `operator → employee`, nothing else).
- **The target user is always looked up with the tenant filter baked into
  the query itself**: `User.findOne({ _id: id, organizationId:
  req.user.organizationId })`, never `findById` followed by a manual
  comparison. A user that doesn't exist, belongs to another Organization,
  or (structurally impossible, but also explicitly rejected as defense in
  depth) is the global System Admin, all produce the identical 404 - the
  response never reveals "that user exists, just not in your Organization"
  (same anti-enumeration convention as DOC-38).
- **Protected targets, always rejected regardless of requested role**: the
  caller's own account (a Manager can never change their own role through
  this endpoint, even by targeting their own id), any `manager` (Manager
  replacement is not part of this task - only DOC-34's flow touches a
  Manager account), and any deactivated user (`isActive: false` - role
  management and account activation are treated as separate concerns; a
  role change never silently reactivates someone).
- **Requesting the role a user already has is an explicit 400**, not a
  silent 200 no-op - the same as any other unsupported transition, so a
  caller always gets an unambiguous signal.
- **`organizationId` cannot change through this endpoint at all** - the
  controller never assigns to it, only to `role`. A request body
  containing `organizationId` has no effect on organization membership
  (verified by test: `{ "role": "operator", "organizationId":
  "<OrgB id>" }` only ever changes `role`).
- **Fresh role/organizationId after promotion** relies entirely on
  DOC-38's `verifyToken` change: a promoted Operator's very next
  authenticated request (including `GET /api/auth/me`) reflects
  `role: 'operator'` immediately, because that middleware re-reads the
  user from the database on every request rather than trusting anything
  from an older JWT.
- **Login is unaffected**: Operator uses the exact same Email + Password
  `POST /api/auth/login` as every other role - no Company Code, no
  separate Operator login.

Deliberately **not** built here (belongs to later tasks): the Manager
Dashboard UI that will consume this API (DOC-36), the System Admin
Dashboard (DOC-37), search/pagination/filtering beyond a stable list
order, and any generic/configurable permissions system - DOC-35 is one
narrow, explicit transition matrix, not a role-management framework.

## Organization Self-Lookup (DOC-42)

`GET /api/organizations/me` lets any authenticated, organization-scoped
user (Manager, Operator, or Employee) discover their **own** Organization's
safe details - it exists specifically so the Manager Dashboard can show
Organization Name / Company Code / Status without System Admin having to
expose its global `/api/organizations/:id` endpoint more broadly.

- **Middleware chain**: `verifyToken` → `requireOrganizationMembership`.
  Registered in `routes/organization.routes.js` *before* the router-wide
  `requireRole('system_admin')` gate that protects every other
  `/api/organizations/*` route, so it has its own, smaller, independent
  chain rather than being carved out as an exception to the System-Admin-only
  one.
- **No `:id` in the route at all.** The Organization returned is always
  `req.user.organizationId` - the same fresh, per-request, database-backed
  value every other DOC-38 isolation check uses. There is no
  `req.body.organizationId`, `req.query.organizationId`, or
  `req.params.organizationId` read anywhere in `getMyOrganization`, so this
  endpoint is structurally incapable of returning any Organization other
  than the caller's own, regardless of what a client sends.
- **`system_admin` gets 404, not an error page.** System Admin's
  `organizationId` is always `null` (DOC-31) - it has no "own Organization"
  of its own, and keeps using its existing global CRUD endpoints below,
  unaffected by this route.
- **Returns the same safe shape** as every other Organization response
  (`sanitizeOrganization` - `id`, `name`, `companyCode`, `isActive`,
  `createdBy`, `managerId`, `createdAt`, `updatedAt`). Nothing new was added
  to what an Organization exposes; this endpoint only changes *who* can
  fetch it and *how* the target Organization is chosen.
- **Does not gate on `requireActiveOrganization` on purpose** - a Manager
  whose Organization has been deactivated must still be able to see that
  it is inactive on their own dashboard, so this route only requires
  membership, not an active Organization.
