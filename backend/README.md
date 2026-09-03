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
  account (DOC-31). The FIRST time it runs (no System Admin exists yet), it
  reads `SYSTEM_ADMIN_EMAIL`, `SYSTEM_ADMIN_PASSWORD` and
  `SYSTEM_ADMIN_FULL_NAME` from `backend/.env` (see `.env.example` for the
  placeholder keys - never commit real values), hashes the password with
  bcrypt exactly like public registration does, and creates a user with
  `role: 'system_admin'` and `organizationId: null`. The System Admin can
  **only** be created this way - the public `/api/auth/register` endpoint
  always forces `role: 'employee'` and ignores anything else the client
  sends. Safe to run more than once: if a System Admin already exists, the
  script checks that FIRST and does nothing (or reports a conflict if the
  existing one has a different, explicitly-set email - it never guesses or
  promotes an existing account) - critically, this "already exists"
  no-op path never reads or requires `SYSTEM_ADMIN_PASSWORD` at all, so it
  is safe to remove that value from `backend/.env` once your System Admin
  has been created. `SYSTEM_ADMIN_PASSWORD` is never read by normal server
  startup (`npm start`) either - it is only ever used by this one,
  separate, manually-invoked script, and only when actually creating the
  first System Admin. See the comment header in `scripts/seedSystemAdmin.js`
  for full details.

## Password & Secrets Security

A full password/secrets audit was performed (no application code path was
found to leak any password/passwordHash/secret; see the fixes below for the
handful of small, additive improvements that came out of it):

- **`SYSTEM_ADMIN_PASSWORD`** is a one-time bootstrap/seed secret, read only
  by `scripts/seedSystemAdmin.js`, server-side, from `backend/.env` - and,
  as of the bootstrap-ordering refactor described above, only ever read
  when that script is about to create the FIRST System Admin. It is never
  read by normal server startup (`src/server.js` has no reference to it at
  all), never sent to the frontend, never included in any API response or
  JWT, and never logged (the seed script prints the created account's id/
  fullName/email/role/organizationId, and an explicit "(Password is not
  shown...)" line - never the password itself). It is genuinely "spent"
  once the System Admin account exists: the seed script's own existence
  check now runs BEFORE the password is ever read, so `SYSTEM_ADMIN_PASSWORD`
  **can be safely deleted from `backend/.env`** after that point (a future
  re-bootstrap of a fresh database would simply need it set again first).
  In a real deployment it should come from your platform's secret manager,
  not a committed file.
- **`backend/.env`** (the real one, with real values) is listed in both the
  root and `backend/.gitignore`, and is confirmed NOT tracked by git
  (`git ls-files` never lists it, and no commit in this repository's entire
  history has ever added a `.env` file - only `.env.example` files have
  ever been committed).
- **`backend/.env.example`** contains descriptive placeholders only
  (`your_mongodb_connection_string`, `your_long_random_jwt_secret`,
  `change_me_before_use`, ...) - never a real credential.
- **User passwords** are always bcrypt-hashed (`SALT_ROUNDS`, shared from
  `auth.controller.js`) before ever reaching MongoDB, on every account-
  creation/password-change path (public registration, System Admin seed,
  Manager-creates-Organization, Manager replaces Manager, self password
  change, Manager resets a user's password) - the `User` model has no
  plaintext `password`/`plainPassword`/`temporaryPassword` field, only
  `passwordHash`.
- **API responses** never include `passwordHash` - every User-serializing
  response in the whole codebase goes through one shared, explicit-
  allowlist sanitizer (`sanitizeUser` in `auth.controller.js`, reused by
  `sanitizeUserWithSpecialties` in `user.controller.js` and directly by
  `organization.controller.js`) or an equivalent explicit `{id, fullName,
  role}`-only pick (`request.controller.js`'s creator/operator maps,
  `comment.controller.js`'s `sanitizeComment`, `chat.controller.js`'s
  `sanitizeChatMessage`) - never a raw Mongoose document or `.toObject()`
  spread.
- **The JWT** contains only `{ userId, role }` (`auth.controller.js`'s
  single `jwt.sign` call) - no password, no passwordHash, no secrets.
- **Logging**: no `console.log`/`console.error` anywhere in the backend
  logs `req.body`, a password, a passwordHash, `JWT_SECRET`, or
  `MONGODB_URI`. The centralized `errorHandler.js` logs the full error
  server-side only, and always returns a generic "Internal Server Error"
  to the client for any 5xx - stack traces and internal details are never
  returned in a response.
- **Frontend**: `localStorage` stores only the JWT token (`doc_auth_token`)
  - never a password or the user object. There is no `console.log` anywhere
  in the frontend source. No backend secret (`JWT_SECRET`, `MONGODB_URI`,
  `SYSTEM_ADMIN_PASSWORD`) appears anywhere in frontend source, and the
  only Vite environment variable in use, `VITE_API_BASE_URL`, is public
  configuration (an API URL), never a secret - `VITE_`-prefixed variables
  are bundled into the browser build and must never hold a secret.
- **Password inputs** all use `type="password"`, with the appropriate
  `autoComplete` hint (`current-password` for Login, `new-password` for
  Register/Change Password/Manager Reset, `email`/`name` where relevant) so
  the browser's own password manager behaves correctly.
- **F12 / DevTools**: seeing `password` in Network → Request Payload during
  Login/Register/Change Password is expected and unavoidable - the browser
  must know the password to send it, and this is not a vulnerability by
  itself. What would be a real problem - a password or passwordHash in an
  API *response*, in the JWT payload, in `localStorage`, or in the
  console - was checked for and not found anywhere in this codebase.
- **HTTPS**: local development uses `http://localhost`, which is normal and
  acceptable for local development. A production deployment of this
  project must be served over HTTPS so credentials are encrypted in
  transit between the browser and the server - this was not (and cannot
  be) implemented as part of a local audit.

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
- **Deletion (DOC-47)**: `DELETE /api/organizations/:id` is a real, hard
  delete, but only when it is safe - see the dedicated section below.

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

## Organization Settings for Manager (DOC-61)

`PATCH /api/organizations/me` lets the Organization's own **Manager** (and
only the Manager - not Employee/Operator/System Admin) view-and-edit a
small set of organization-level profile fields, without granting Manager
any System Admin capability. This sits alongside `GET /api/organizations/me`
(DOC-42 above) - the two together are the Manager Dashboard's entire
"Organization Settings" panel.

**What a Manager can edit:** `name`, `description`, `contactEmail`,
`contactPhone`. **What a Manager can only view (never edit through this or
any Manager-facing endpoint):** `companyCode` (regeneration stays
System-Admin-only, `POST /:id/regenerate-code`), `isActive` (activation/
deactivation stays System-Admin-only, `PATCH /:id`), `createdAt`. Manager
can never create or delete Organizations, and this endpoint never turns
Manager into System Admin - it only ever touches the caller's own single
Organization document.

- **Middleware chain**: `verifyToken` → `requirePasswordChangeCompleted` →
  `requireRole('manager')` → `requireOrganizationMembership` →
  `requireActiveOrganization` → `updateMyOrganization`. Registered directly
  below `GET /me` in `routes/organization.routes.js`, with its own smaller
  chain, for the identical structural reason `GET /me` has one (it must be
  reachable by a Manager token and can never be swept into the router-wide
  `requireRole('system_admin')` gate a few lines below).
- **No `:id` in the route.** Exactly like `GET /me`, the target Organization
  is always `req.user.organizationId` - never read from
  `req.body`/`req.query`/`req.params`. A Manager cannot update another
  Organization by forging a URL, body, or query value; there is structurally
  nothing to forge, since this endpoint never looks at any of those for the
  target id.
- **`requireActiveOrganization` gates this route but not `GET /me`.** A
  Manager whose Organization has been deactivated can still see their
  settings (read-only, matches DOC-42) but cannot edit them until a System
  Admin reactivates the Organization - the same "read stays open, mutation
  requires active" pattern this project's other Manager business routes
  already use (e.g. `PATCH /:id/manager` and `/organization/export` in
  `request.routes.js`).
- **Explicit allowlist, never mass assignment.** The controller builds an
  `updates` object field-by-field (`name`/`description`/`contactEmail`/
  `contactPhone`, only if present in the body and only after passing
  validation), then applies it with
  `Object.assign(organization, updates)` - never
  `Object.assign(organization, req.body)`. This mirrors the same
  already-audited-safe shape System Admin's own `PATCH /:id`
  (`updateOrganization`) already uses.
- **Forbidden fields are hard-rejected, not silently dropped.** Before any
  allowed field is even looked at, the request body is checked against
  `FORBIDDEN_ORGANIZATION_SELF_UPDATE_FIELDS` - `companyCode`, `isActive`,
  `createdAt`, `updatedAt`, `createdBy`, `manager`, `managerId`,
  `organizationId`, `_id`, `id`, `users`. If the body contains **any** of
  these, the whole request is rejected with `400` and a clear message
  (`"<field> cannot be updated through this endpoint."`) - a request that
  mixes a legitimate field with a forged one (e.g.
  `{ name: "New Name", isActive: false }`) is rejected in full, never
  partially applied.
- **Field validation** (`400` on failure, same response shape as every
  other endpoint in this file):
  - `name` - required, non-empty after trim, 2-100 characters (same rule as
    Organization creation).
  - `description` - optional, plain text only (rejects arrays/objects/
    numbers), max 1000 characters. Rendered as plain text on the frontend,
    never `dangerouslySetInnerHTML`.
  - `contactEmail` - optional, must match the same `EMAIL_REGEX` used
    everywhere else in this project if provided. This is **presentation-only
    contact information** - it is never read from or written to any `User`
    document, never checked for uniqueness, and can never change a Manager's
    own login email (`User.email`, changed only via the existing DOC-57
    account-settings flow).
  - `contactPhone` - optional, max 30 characters, permissive international
    format (digits, `+`, spaces, parentheses, hyphens; at least one digit
    required) - deliberately not restricted to a single country's numbering
    plan.
  - An empty/whitespace-only string for any of the three optional fields
    normalizes to `null` (never stored as `''`), matching every historical
    Organization document that never had these fields at all.
  - A request whose body contains none of `name`/`description`/
    `contactEmail`/`contactPhone` (after the forbidden-field check passes)
    returns `400` - `"No valid fields to update. Allowed fields: ..."`.
- **Partial updates.** Only the fields actually present in the request body
  are validated/changed; omitted fields, and fields re-sent with their
  current value, are both safe no-ops.
- **Response shape is identical to every other Organization endpoint**
  (`sanitizeOrganization`/`enrichOrganization`) - `description`,
  `contactEmail`, `contactPhone` are now included on every Organization
  response project-wide (System Admin's list/detail/update endpoints too),
  each defaulting to `null` for a historical Organization created before
  this ticket, so no consumer needs special-case handling for "field might
  not exist yet".
- **Schema note (`models/Organization.js`).** `description`
  (trimmed, max 1000 chars), `contactEmail` (trimmed, lowercased, max-
  length none, format validated at the controller layer), `contactPhone`
  (trimmed, max 30 chars, format validated at the controller layer, not via
  a schema `match`) were added, all `default: null`. No migration is
  required - a document that never had these fields simply reads back
  `null`/`undefined`, which this schema and every consumer already treat
  identically.
- **Logo/branding - deliberately deferred, not built.** This ticket
  explicitly allows deferring an actual logo upload; no `logoUrl` field, no
  binary upload endpoint, and no reuse of the Request feature's S3 storage
  were added. If a simple logo capability is wanted later, the smallest
  safe next step is a validated `logoUrl` string field (same shape as
  `contactEmail`/`contactPhone` above) rather than binary upload
  infrastructure.
- **Not built here, on purpose:** no audit-log entry (DOC-64 is a separate,
  future ticket - `updateMyOrganization` is kept intentionally small and
  linear - validate, build `updates`, save, respond - so DOC-64 can later
  insert one audit-record call after the `.save()` without needing to
  restructure this function), no DOC-18 notification (would be noise for a
  non-Request action), no `RequestActivity`/timeline event (this is not a
  Request lifecycle action).
- **Frontend**: `ManagerDashboard.jsx`'s existing "Organization Information"
  panel (DOC-42) is now "Organization Settings" - the same panel, no new
  route/page. Name/Description/Contact Email/Contact Phone render as
  editable fields; Company Code/Organization Status/Created render as
  read-only display values (never inputs). Save is disabled while a save is
  already in flight and disabled again once saved values match what's
  loaded (nothing to save) - both checked in the submit handler itself, not
  only via the button's `disabled` attribute. Only the fields that changed
  are sent in the `PATCH` body. Errors reuse the same `getApiErrorMessage`
  helper (DOC-69) as the rest of the app - a raw `AxiosError`/
  `MongoServerError`/`CastError` is never shown to the user.

## User Profile (DOC-62)

`PATCH /api/users/me` lets ANY authenticated user (`system_admin`, `manager`,
`operator`, `employee` alike) edit exactly one thing about their own
account - their `fullName`. Reading a profile reuses the existing
`GET /api/auth/me` (DOC-33/DOC-57) unchanged - this ticket added no new
read endpoint, per its own "prefer reusing GET /api/auth/me" guidance.

**What a user can edit:** `fullName` only. **What a user can only view
(never edit through this or any self-facing endpoint):** `email`, `role`,
`organizationId`, `isActive`, `createdAt`. A user can never change their own
role, their own organization, or activate/reactivate themselves - both by
explicit hard rejection here and because no other self-facing endpoint in
this project grants any of those either.

- **Middleware chain**: `verifyToken` → `requirePasswordChangeCompleted` →
  `updateMyProfile`. Registered in `routes/user.routes.js` *before* that
  router's blanket `requireRole('manager')` gate, with its own smaller,
  independent chain - the same structural reason `GET/PATCH /organizations/me`
  (DOC-42/DOC-61) already have theirs registered ahead of their own
  routers' blanket gates. Deliberately **not** composed with
  `requireRole(...)` or `requireOrganizationMembership` - this is genuinely
  role-agnostic, self-scoped-only authorization, and `system_admin`'s own
  `organizationId` is always `null` (DOC-31), so it must still be able to
  reach this route.
- **`requirePasswordChangeCompleted` gates this route.** A user whose own
  `mustChangePassword` is `true` cannot use `PATCH /api/users/me` until they
  clear that flag via `PATCH /api/auth/change-password` first - the same
  "normal business route" treatment every other mutating endpoint in this
  project already gets. `GET /api/auth/me` (used to READ a profile)
  deliberately stays exempt, unchanged - only the new mutating endpoint
  adds this gate, so a forced-change user still cannot use Profile to dodge
  the forced change (task spec section 3/24).
- **No `:id` in the route.** The target user is always
  `req.user.userId` - the trusted identity `middleware/auth.js`'s
  `verifyToken` populates from a verified JWT, then re-confirmed with a
  fresh `User.findById` read inside the controller. There is no
  `req.params.id`/`req.body.userId`/`req.query.userId` read anywhere in
  `updateMyProfile`, so a client-supplied `userId` in the body is simply
  never read (structurally has zero effect) - this endpoint cannot update
  any User document other than the caller's own, regardless of what a
  client sends.
- **Explicit allowlist of exactly one field, never mass assignment.**
  `FORBIDDEN_SELF_PROFILE_FIELDS` is checked FIRST and rejects the entire
  request (`400`) if the body contains any of `role`, `organizationId`,
  `isActive`, `password`, `passwordHash`, `mustChangePassword`,
  `createdAt`, `updatedAt`, `_id`, `id`, `email`, `specialties` - never
  silently ignored, never partially applied. A request mixing a legitimate
  `fullName` with a forged field (e.g. `{ fullName: "New", role:
  "system_admin" }`) is rejected in full. Only `user.fullName = ...` is
  ever assigned - never `Object.assign(user, req.body)`.
- **`fullName` validation** (`400` on failure): required, non-empty after
  trim, 2-100 characters, rejects non-string (array/object) payloads
  outright via a `typeof` check before `.trim()` is ever called. This is a
  NEW, stricter rule than Register's own "just non-empty" check and DOC-50's
  Manager-facing `updateUserProfile`'s own "just non-empty" check - both of
  those are left completely unchanged; this bound applies only to the new
  self-service endpoint.
- **Email decision: kept read-only, deliberately (task spec section 7).**
  The audit for this ticket confirmed a self-service email change *could*
  be made technically safe - the JWT payload only ever carries
  `{ userId, role }` (never email - see `login` in
  `controllers/auth.controller.js`), and `verifyToken` re-reads the user by
  `_id` on every request, never by email, so a changed email would not
  invalidate any existing session or require a token refresh. However, no
  product requirement in this ticket calls for it, and enabling it would
  add a second live email-uniqueness/normalization/collision surface to
  reason about and test (on top of the one DOC-50's Manager-facing
  `updateUserProfile` already owns) for zero requested benefit, with no
  email-confirmation flow in this project to guard against a mistyped or
  hijacked address. A body containing `email` is therefore hard-rejected
  (`400`, `"email cannot be updated through this endpoint."`), the same
  shape as every other forbidden field, not silently ignored - matching
  the task spec's own "if read-only: forged email update rejected" test
  requirement. If a genuine product need for self-service email changes
  emerges later, the safest next step is to mirror `updateUserProfile`'s
  own already-audited pattern here (format validation + normalize +
  uniqueness check), not to invent a new one.
- **`specialties` is included in the forbidden list defensively**, even
  though nothing about this endpoint would otherwise touch it - DOC-44
  specialties remain exclusively Manager-managed (`PATCH
  /api/users/:id/specialties`), and this keeps that true even against a
  forged self-update payload.
- **Response shape is `sanitizeUser`** (`auth.controller.js`) - the exact
  same safe shape `GET /api/auth/me` already returns (`id`, `fullName`,
  `email`, `role`, `organizationId`, `isActive`, `mustChangePassword`,
  `createdAt`). Never `passwordHash`. The frontend's `AuthContext.updateUser`
  (already used by the DOC-57 Change Password page) accepts this shape
  directly with no adapter needed.
- **Password management is not duplicated here.** There is no
  password-related field this endpoint reads or writes at all - Profile's
  own frontend page only ever links to the existing `/change-password`
  route (DOC-57's `PATCH /api/auth/change-password`), never a second
  password-change implementation.
- **Not built here, on purpose:** no audit-log entry (DOC-64 is a separate,
  future ticket - `updateMyProfile` is kept intentionally small and linear -
  validate, save, respond - so DOC-64 can later insert one audit-record
  call after the `.save()` without needing to restructure this function),
  no DOC-18 notification and no `RequestActivity`/timeline event (a user
  renaming themselves is not a Request lifecycle action and would only be
  noise), no profile picture/avatar (no such support exists anywhere in
  this project prior to this ticket, and none was added - the ticket
  explicitly makes this optional and conditional on existing support).
- **Frontend**: a new, single, role-agnostic `/profile` page
  (`frontend/src/pages/Profile.jsx`) shown to every authenticated role,
  wrapped in the plain `<ProtectedRoute>` (no `roles` restriction) - a
  forced-password-change user is redirected to `/change-password` before
  ever seeing this page's content, unchanged existing behavior. Shows Full
  Name (editable), Email/Role/Organization/Account Status/Member Since
  (all read-only), a `Save Changes` button (disabled while pending or
  while nothing has changed, rechecked in the submit handler itself), and
  a `Change Password` link to the existing page. A new `My Profile` link
  was added to the Navbar for every authenticated role, hidden during the
  forced-password-change state the same way the Dashboard/Chat/
  Notifications links already are.

## Delete Organization Safely (DOC-47)

`DELETE /api/organizations/:id` (`system_admin` only, `verifyToken` →
`requireRole('system_admin')` on the same router as the rest of Organization
management) permanently removes an Organization - but only when doing so
cannot orphan anything.

- **Not a repurposed `PATCH`.** `UPDATABLE_FIELDS` never included a way to
  delete an Organization; this is its own dedicated route and controller
  function (`deleteOrganization`), consistent with how every other
  Organization action already has its own endpoint (regenerate-code,
  assign-manager, ...).
- **`:id` validated the same way as every other id-based route** -
  `mongoose.Types.ObjectId.isValid(id)` first (400 if not), then a real
  lookup (404 if no matching Organization exists).
- **The safety check: any dependent `User`, at all, blocks deletion.**
  Before deleting, the controller runs
  `User.countDocuments({ organizationId: organization._id })`. If that
  count is greater than zero, the Organization is left completely
  untouched and the response is `409 Conflict`: *"This organization cannot
  be deleted while users are still assigned to it."* This single check
  already covers the Organization's Manager (DOC-34's manager account
  always has `organizationId` set to that Organization - there is no
  separate "manager relationship" to check) as well as every Employee and
  Operator (DOC-33/35) - there is no scenario in this codebase where a
  User can be linked to an Organization without `organizationId` reflecting
  it.
- **No cascade, ever.** This endpoint never deletes or detaches a User to
  "make room" for the Organization delete to succeed. The System Admin
  must resolve that dependency through some other action first (there is
  currently no such action in this project - Users are never bulk-moved or
  bulk-deleted anywhere).
- **Both active and inactive Organizations may be deleted** once they have
  no dependent Users - deactivation is not a required precondition. This
  was a deliberate choice: an inactive Organization with lingering Users is
  exactly as unsafe to delete as an active one with the same Users, so
  `isActive` has no bearing on the safety check.
- **No cascading destructive deletion of any kind is implemented** - this
  was an explicit, non-negotiable requirement of DOC-47, not an oversight.
- **Future Ticket/Request data**: this project has no Ticket model as of
  DOC-47. If one is added later and stores `organizationId`, the safety
  check in `deleteOrganization` MUST be extended to also block deletion
  while that Organization has any Tickets - see the code comment directly
  above the function for the same warning in context.
- **Success response**: `200 { status: 'success', data: { id } }` - the
  same `{status, data}` shape as every other endpoint in this file, not a
  bare `204`, so nothing about how clients handle responses needs to
  special-case this one action.

## Complete System Admin / Manager Management (DOC-49/DOC-50)

Sprint 3 integration tasks. Most of DOC-49's required capabilities already
existed (DOC-32/34/37/42/47); this added the pieces that were genuinely
missing and buildable without absorbing an unrelated Jira task:

- **`sanitizeOrganization(org, extras)`** now optionally includes
  `manager: {id, fullName, email} | null`, `employeeCount`, and
  `operatorCount` - "Organization Overview" (DOC-49). `enrichOrganization`/
  `enrichOrganizations` compute these (batched for the list endpoint to
  avoid N+1 Manager lookups) and are used by every Organization-returning
  endpoint, so the response shape is identical everywhere. Request counts
  are deliberately NOT included anywhere - no Request/Ticket model exists
  yet (see the Sprint 3 dependency note below); the frontend shows an
  honest placeholder instead.
- **`PATCH /api/organizations/:id/manager`** (DOC-49) edits the CURRENT
  Manager's fullName/email only. 409 if the Organization has no Manager.
- **`PUT /api/organizations/:id/manager`** (DOC-49) replaces the CURRENT
  Manager with a brand-new account, reusing `createAndLinkManager`. The
  old Manager is deactivated, never deleted or detached - see the function's
  own doc comment for why this is "safe" the same way DOC-47's deletion
  safety check is.
- **`PATCH /api/users/:id`** (DOC-50) edits fullName/email for an Employee
  or Operator in the Manager's own Organization - reuses the same scoped-
  lookup + protected-target rules as DOC-35's role endpoint
  (`resolveManageableTarget` in `user.controller.js`).
- **`PATCH /api/users/:id/status`** (DOC-50) activates/deactivates an
  Employee or Operator. A deactivated account is rejected on its very next
  request via the existing DOC-38 fresh-read check - no separate
  revocation mechanism needed.
- **Company Code regeneration stays System-Admin-only.** DOC-50 asked for
  Manager-facing regeneration "if this is part of the approved existing
  architecture" - it is not (the existing `/api/organizations/:id/
  regenerate-code` route has always been gated to `system_admin`, DOC-32/41),
  so this was deliberately NOT changed; loosening it would have been
  weakening an existing security boundary without a concrete bug/security
  justification.
- **Service Categories (DOC-43) and Operator Specialties (DOC-44) are now
  implemented - see their sections below.** All Request/Ticket-scoped
  capabilities remain unimplemented - they depend on Jira tasks that do not
  exist in this codebase yet (see the DOC-49-52 final report for the full
  dependency list).

## Organization Employee Removal (DOC-48)

Jira's title is "Delete Organization Employee." An audit of the existing
codebase (done before writing any code, per the task's own instruction) found
that DOC-50's `PATCH /api/users/:id/status` already implements exactly the
safe, tenant-scoped, self/manager/system_admin-protected removal this ticket
asks for - a Manager sets `isActive: false` on an Employee or Operator in
their own Organization, which blocks login and every protected API call on
the very next request (DOC-38's fresh per-request `isActive` re-check),
while leaving every historical Request/Comment/attachment/assignment
reference completely intact. DOC-48 deliberately reuses that endpoint rather
than adding a second one.

- **No hard delete was added.** A real `DELETE /api/users/:id` would either
  have to cascade-delete Request/Comment history (explicitly disallowed) or
  leave dangling `createdBy`/`assignedOperatorId`/`authorId` references
  behind (a data-integrity bug, not a feature). Deactivation-over-deletion is
  the same philosophy already used for Organizations (DOC-47) and Managers
  (DOC-49's replace-manager flow).
- **New: an active-assignment warning.** `updateUserStatus` now checks, only
  when deactivating an `operator`, whether that Operator has any Request
  still in a non-terminal status (`open`/`in_progress`/`resolved`/
  `reopened`) assigned to them via `Request.countDocuments(...)`. If so, the
  deactivation still succeeds (never blocked), but the JSON response carries
  an additional top-level `warning` string so the Manager can choose to
  reassign the Request separately. `respondWithUser` gained an optional 4th
  `extra` parameter to carry this - a no-op for every other caller.
- **New: a confirmation step on the frontend.** Manager Dashboard's
  Deactivate button now opens an inline confirm panel ("Deactivate this
  user? They will no longer be able to sign in, but their request history
  will be preserved." / "Keep Active" / "Deactivate User") before the
  request fires, matching DOC-46's Cancel Request confirmation pattern.
  Reactivation (Inactive -> Active) stays a single direct action, as before.
- **Everything else DOC-48 asked for already existed from DOC-50/DOC-38 and
  was not rebuilt**: tenant-scoped lookup, self-protection, Manager/
  system_admin protection, `GET /api/users` always showing inactive users,
  specialties preserved on a deactivated Operator, `passwordHash` never
  exposed.
- **DOC-52 regression verified**: `assignRequestOperator`'s eligible-operator
  query already filters `isActive: true`, so a deactivated Operator is
  correctly excluded from assignment, and a reactivated one becomes eligible
  again immediately.

### Service Categories (DOC-43)

Each Organization defines and manages its own Service Categories
(Electricity, Plumbing, IT Support, ...) - a Manager-only, Organization-
scoped resource with no cross-Organization visibility and no global
uniqueness. A future Request/Ticket model (not implemented here) will
reference a Category by `_id`.

- **`models/ServiceCategory.js`** - `{ name, normalizedName, organizationId,
  isActive, timestamps }`. `name` is the Manager-facing display value
  (trimmed only, casing preserved). `normalizedName` is a derived,
  never-client-visible field kept in sync with `name` by a
  `pre('validate')` hook (`this.isNew || this.isModified('name')`), so it
  cannot drift out of sync through any code path. A compound unique index
  on `{ organizationId: 1, normalizedName: 1 }` enforces per-Organization
  (never global) uniqueness - "Electricity", " electricity ", and
  "ELECTRICITY" all collide inside one Organization, but two different
  Organizations may each have their own "Electricity" category. This is a
  deliberately different uniqueness shape from `Organization.companyCode`
  (globally unique, DOC-41) and `Organization.name` (no uniqueness at all,
  DOC-40) - see `utils/serviceCategoryName.js` and the model file's own
  comments for the reasoning.
- **`utils/serviceCategoryName.js`** - `normalizeCategoryName(name)`:
  trim + collapse internal whitespace + lowercase, used only to compute
  `normalizedName`. Unlike `utils/companyCode.js`'s
  `normalizeCompanyCode` (which rewrites the field in place, since a
  Company Code is a machine label), this normalizes into a *separate*
  field, since a Category's `name` is a human-typed display label whose
  casing must never be silently rewritten.
- **`controllers/serviceCategory.controller.js`** - `createServiceCategory`,
  `listServiceCategories`, `updateServiceCategory` (PATCH, `name` only via
  an explicit `UPDATABLE_FIELDS` allowlist), `updateServiceCategoryStatus`
  (PATCH `.../:id/status`, `{ isActive: boolean }`). There is **no delete
  endpoint anywhere** - deactivation is the only lifecycle action, on
  purpose, so a future Request can safely keep referencing a Category's
  `_id` forever (same deactivation-over-deletion philosophy as DOC-47's
  Organization deletion safety check and DOC-49's Manager replacement).
  `organizationId` is read exclusively from `req.user.organizationId`
  (DOC-38) on every one of these handlers - never from `req.body`,
  `req.query`, or `req.params` - so a payload like
  `{ "name": "X", "organizationId": "<another org>" }` still only ever
  creates/edits a Category inside the caller's own Organization. Every
  lookup is a single scoped query
  (`ServiceCategory.findOne({ _id, organizationId })`), never
  `findById()` followed by a manual comparison, so a well-formed id
  belonging to another Organization returns the exact same 404 as an id
  that does not exist at all (DOC-38 anti-enumeration convention).
  `sanitizeServiceCategory` never includes `normalizedName` in any
  response. A duplicate-key error (`error.code === 11000`) becomes a 409
  with a fixed client-safe message, never the raw Mongo error text.
- **`routes/serviceCategory.routes.js`** - `GET/POST /api/service-categories`,
  `PATCH /api/service-categories/:id`, `PATCH
  /api/service-categories/:id/status`. All four routes share one
  `router.use(verifyToken, requireRole('manager'),
  requireOrganizationMembership, requireActiveOrganization)` gate - the
  identical composition DOC-38 documents for every other org-scoped
  router. System Admin is deliberately NOT granted access through this
  router (403, same as `/api/users`) - Service Category management is a
  Manager-only capability by spec.
- **Not implemented here (by design):** Operator Specialties (DOC-44 - now
  implemented, see below), any Request/Ticket model or endpoint that would
  reference a `serviceCategoryId`, and enforcement of "only active
  Categories are selectable for a new Request" (that belongs to DOC-10,
  once it exists).

### Default Service Categories (Sprint 4 gap fix)

A brand-new Organization has zero Service Categories, and `POST
/api/requests` (DOC-10) has always correctly required a valid, active,
same-Organization `categoryId` - so before this fix, a fresh Organization
left every Employee unable to open a Request at all until a Manager
remembered to create one manually. This is deliberately NOT a Request
validation change (that requirement is correct and untouched) - it is a
missing onboarding step, fixed by seeding a small default Category set.

- **`utils/defaultServiceCategories.js`** - the one source of truth for
  both the default list and how it gets created:
  - `DEFAULT_SERVICE_CATEGORIES` = `['Computers', 'Electricity',
    'Plumbing', 'Network', 'Maintenance']` - a small, practical, generic
    starter set. A Manager remains free to rename, deactivate, or add
    their own via the existing DOC-43 endpoints.
  - `ensureDefaultServiceCategories(organizationId)` - idempotent: reads
    every existing Category (active AND inactive) for that Organization,
    then creates only the default names whose `normalizedName` is not
    already present - reusing `utils/serviceCategoryName.js`'s exact
    normalization, never a second copy of that logic. An inactive
    "Computers" blocks a second "Computers" from being created, exactly
    like the model's own compound unique index would. A duplicate-key
    error on an individual `create()` (a concurrent call racing this one)
    is treated as "already handled," not a failure - so this is safe to
    call twice in a row, or from two simultaneous requests. Returns
    `{ createdCount, categories }`, where `categories` is the
    Organization's full resulting list (defaults plus any pre-existing
    custom ones), so callers never need a second query.
- **New Organizations** - `organization.controller.js`'s
  `createOrganization` calls `ensureDefaultServiceCategories` immediately
  after creating the Organization document, before the optional initial-
  Manager step. Failure policy (this project does not use MongoDB
  multi-document transactions - see `createAndLinkManager`'s own
  "Atomicity note" for why): if default-Category seeding fails, or if a
  requested initial Manager subsequently fails to create/link, the new
  `rollbackOrganizationCreation(organizationId)` helper deletes every
  Category already created for that Organization, then the Organization
  itself - the caller never sees a half-configured Organization stuck
  without Categories or with a null Manager it cannot retry into. The
  success response gains one small, additive, optional field: `setup:
  { defaultCategoriesCreated }` - existing callers that don't read it are
  unaffected.
- **Existing Organizations** - `POST
  /api/service-categories/create-defaults` (Manager-only) is the explicit,
  user-triggered recovery action for an Organization that predates this
  feature, or whose only Categories are now all inactive. Same
  authorization chain as every other route on this router
  (`verifyToken`, `requireRole('manager')`, `requireOrganizationMembership`,
  `requireActiveOrganization`) - `organizationId` comes exclusively from
  `req.user.organizationId`, so a Manager can never initialize another
  Organization. Delegates entirely to `ensureDefaultServiceCategories`, so
  its idempotency/never-reactivate/never-duplicate guarantees are
  identical to what a brand-new Organization gets automatically. Returns
  `{ data: <full Category list>, createdCount }`.
- **Manager Dashboard** - the existing Service Categories empty state
  ("No service categories exist for this organization.") now offers a
  "Create Default Categories" button that calls the real endpoint above
  and refreshes the list on success; on failure the list is left exactly
  as it was and the error is shown inline (no faked success). All existing
  DOC-43 management (create custom, rename, activate/deactivate) is
  completely unchanged and still available once any Categories exist.
- **Employee Dashboard** - the "no active categories" message is now more
  actionable ("...Your Organization Manager must create or activate at
  least one category before requests can be opened."); Submit was already
  correctly disabled in this state (no change needed there). An Employee
  still cannot create, activate, or default-initialize Categories through
  any code path - this remains a strictly Manager-only capability.
- **Request creation security is completely unchanged** - `POST
  /api/requests` still independently requires categoryId to be a
  well-formed ObjectId, resolve to a Category, belong to
  `req.user.organizationId`, and be active, via the exact same scoped
  query as before. Nothing about this fix touches that validation.

### Operator Specialties (DOC-44)

A Manager assigns which of the Organization's Service Categories each
Operator is responsible for (Ahmad: Electricity + Maintenance; Amir:
Computers + Network; ...), so a later Request-matching feature can find
"which Operators handle Category X". This task implements only the
Operator <-> ServiceCategory relationship and its Manager-facing
management - no Request matching, no auto-assignment, no Operator-facing
Request visibility.

- **`models/User.js`** - added `specialties: [ObjectId ref ServiceCategory]`
  (default `[]`). References only - never a copy of a Category's
  name/isActive, the same "store the id, not the data" rule
  `organizationId` itself already follows. A role-conditional validator
  (mirroring the existing `organizationId` validator's shape) enforces
  that only `role: 'operator'` may ever have a non-empty `specialties`
  array - every other role is structurally guaranteed empty, not just
  "expected to be". No migration was needed: a pre-DOC-44 user document
  simply has no `specialties` field, which Mongoose treats as `[]` (the
  schema default), trivially satisfying the invariant.
- **`controllers/user.controller.js`**:
  - `updateUserRole` - demoting an Operator to Employee now clears
    `specialties = []` as part of the same transition (not a separate
    step a Manager could forget). Promoting an Employee to Operator
    intentionally leaves `specialties` empty; a Manager assigns them
    afterward.
  - **`updateUserSpecialties`** (new) - `PATCH /api/users/:id/specialties`,
    Manager-only, full-replacement contract: the entire `categoryIds`
    array becomes the Operator's new specialty set in one request
    (`[]` clears everything). Reuses `resolveManageableTarget` (DOC-50)
    for the self/system_admin/manager-target guard, then adds its own
    rule: the target must currently be `role: 'operator'` (403 for an
    Employee target - a real, visible, same-Organization user, so not a
    404). Every supplied id is deduplicated, validated as a well-formed
    ObjectId, then resolved via one scoped query -
    `ServiceCategory.find({ _id: { $in }, organizationId:
    req.user.organizationId, isActive: true })` - so a Category from
    another Organization, an inactive Category, and a nonexistent id are
    all indistinguishable in the response (anti-enumeration, DOC-38
    convention) and all produce the same 400. The ids actually **stored**
    come from the resolved documents, not the client's raw strings
    (defense in depth). `organizationId` and `role` are never read from
    the request body anywhere in this handler.
  - `buildSpecialtyCategoryMap` / `sanitizeUserWithSpecialties` (new) -
    every mutating User endpoint (role/profile/status/specialties) and
    `GET /api/users` now respond with a populated `specialties: [{id,
    name}]` array via one batched `ServiceCategory.find({ _id: { $in },
    organizationId })` query per response - never one query per Operator
    (no N+1 on the user list). `normalizedName`/`isActive`/
    `organizationId` of the Category are never included in this
    populated shape.
- **`routes/user.routes.js`** - `router.patch('/:id/specialties',
  updateUserSpecialties);` added to the existing Manager-only router
  chain (`verifyToken, requireRole('manager'), requireOrganizationMembership,
  requireActiveOrganization`) - no new auth system.
- **Inactive-Category policy**: a Manager cannot assign a currently
  inactive Category as a *new* specialty. If a Category already assigned
  to an Operator is later deactivated, the reference is left in place
  (history preserved, matching DOC-43's own deactivation-over-deletion
  rule) - it simply cannot be freshly selected again until reactivated.
- **Not implemented here (by design):** any Request/Ticket model
  (DOC-10 - now implemented, see below), Request-to-Operator matching
  (`User.find({ role: 'operator', organizationId, specialties: categoryId })`
  - the shape DOC-10's future sibling tasks can use, deliberately not built
  as an endpoint here), auto-assignment of Requests to Operators, and any
  change to the Operator Dashboard's existing Request placeholders.

### Create a New Request (DOC-10)

The first real Request/Ticket task. An Employee opens a Request against
one of their Organization's active Service Categories - creation only,
nothing else. DOC-11 (list/detail), DOC-12 (status transitions), DOC-13
(comments), DOC-45 (image attachments), and DOC-46 (Employee edit/cancel)
are all explicitly out of scope and not implemented, even partially.

- **`models/Request.js`** (new) - `{ title, description, categoryId,
  priority, status, organizationId, createdBy, assignedOperatorId,
  timestamps }`. `title` (5-150 chars) and `description` (10-2000 chars)
  are required/trimmed. `priority` is `low | medium | high` (default
  `medium`). `status` is `open | in_progress | resolved | closed |
  reopened` - DOC-10 only ever writes `open`, but the full future-workflow
  enum is defined now so DOC-12 never needs a schema migration to add
  values later. `organizationId`/`createdBy` are required refs;
  `assignedOperatorId` defaults to `null` and DOC-10 never writes anything
  else to it (see "Assignment" below). Indexes: `organizationId` and
  `createdBy` (DOC-11's future "My Requests" query) and `categoryId`
  (future Manager/Operator filtering by Category).
- **`controllers/request.controller.js`** (new) - `createRequest` reads
  exactly four fields from the body (`title`, `description`, `categoryId`,
  `priority`) via explicit destructuring/allowlist construction, **never**
  `Request.create({ ...req.body })`. Every trusted field is either derived
  from `req.user` (DOC-38's fresh per-request context) or hardcoded:
  `organizationId = req.user.organizationId`, `createdBy = req.user.userId`,
  `status = 'open'`, `assignedOperatorId = null` - a request body
  containing `organizationId`/`createdBy`/`assignedOperatorId`/`status`/
  `_id`/timestamps has zero effect on any of them, regardless of what it
  contains. `categoryId` is resolved via one scoped, active-only query
  (`ServiceCategory.findOne({ _id, organizationId: req.user.organizationId,
  isActive: true })`) - a cross-org id, an inactive Category, and a
  nonexistent id are all indistinguishable via the same generic 400
  (anti-enumeration, DOC-38 convention). `sanitizeRequest` returns
  `category: { id, name }` (populated from the already-resolved document,
  no second query) and never exposes `normalizedName`.
- **`routes/request.routes.js`** (new) - `POST /api/requests`, gated by
  `verifyToken, requireRole('employee'), requireOrganizationMembership,
  requireActiveOrganization` - the identical composition every other
  org-scoped router uses. Operator/Manager/System Admin all get 403;
  DOC-10 does not broaden this. There is deliberately no `GET /api/requests`
  yet (DOC-11's job) - a stray list attempt gets a plain 404 from this
  router, not an empty array.
- **`GET /api/service-categories/available`** (new, in
  `serviceCategory.routes.js`/`.controller.js`) - a read-only, active-only,
  Organization-scoped view of Categories, registered BEFORE the blanket
  Manager-only gate on that router (the same pattern
  `organization.routes.js`'s `GET /me` already uses). Authorization is
  `verifyToken, requireOrganizationMembership, requireActiveOrganization` -
  no role restriction beyond "belongs to an active Organization", so an
  Employee can discover which Categories they may pick for a new Request
  without gaining any of the Manager-only management endpoints (create/
  edit/activate/deactivate remain untouched and still 403 for a non-
  Manager). Operator/Manager can safely reuse this same endpoint for any
  future UI that also just needs "this Organization's active Categories" -
  it exposes nothing a Manager can't already see via the full
  `GET /api/service-categories`, and nothing an Employee/Operator
  shouldn't see about their own Organization's own Categories.
- **Not implemented here (by design):** `PATCH /api/requests/*` (status
  transitions - DOC-12), comments (DOC-13), image attachments (DOC-45),
  Employee edit/cancel (DOC-46), and any automatic or manual Operator
  assignment. `GET /api/requests` and `GET /api/requests/:id` are now
  implemented for the Employee's own Requests only - see DOC-11 below.

### View Request Details and Status (DOC-11)

Read-only Request access for the Employee who created it - no Manager/
Operator Request view is implemented here (later integration tasks add
those separately, the same way DOC-49-52 did not secretly build DOC-10).

- **`controllers/request.controller.js`** - two new handlers, both on the
  same Employee-only router as `createRequest`:
  - **`listMyRequests`** (`GET /api/requests`) - `Request.find({ createdBy:
    req.user.userId, organizationId: req.user.organizationId }).sort({
    createdAt: -1 })`. Both `createdBy` AND `organizationId` are in the
    query - `organizationId` is redundant given `createdBy` alone already
    identifies one User, but costs nothing and matches DOC-38's convention
    of never relying on a single field for a tenant boundary. Newest
    first; no user-configurable sort/filter (not part of DOC-11).
  - **`getMyRequestById`** (`GET /api/requests/:id`) - a single scoped
    query, `Request.findOne({ _id, createdBy: req.user.userId,
    organizationId: req.user.organizationId })` - never `findById()`
    followed by an ownership check. A Request that does not exist, one
    that belongs to another Employee in the same Organization, and one
    that belongs to another Organization entirely are all
    indistinguishable via this single query result and produce the exact
    same 404 message (DOC-38 anti-enumeration convention) - this endpoint
    never reveals "you do not own this Request." A malformed id is
    rejected with a clean 400 before any query runs (no raw Mongoose
    `CastError`).
  - **`buildRequestEnrichmentMaps`** (shared by both handlers) - batches
    the Category and assigned-Operator lookups for a page of Requests into
    at most two additional queries total, never one query per Request
    (N+1). Categories are looked up **without** an `isActive` filter -
    DOC-11 explicitly requires that a Request opened against a Category
    that has since been deactivated must still display that Category's
    historical name (only NEW Request creation, DOC-10, restricts to
    active Categories). Both lookups are scoped to
    `req.user.organizationId` as defense in depth.
  - **`sanitizeRequest(request, category, assignedOperator)`** - the one
    shared response shape for create/list/detail:
    `{ id, title, description, category: { id, name } | null, priority,
    status, assignedOperator: { id, fullName } | null, createdAt,
    updatedAt }`. `organizationId` and `createdBy` are deliberately
    **omitted** - the frontend never needs them (it is always "my own
    Organization" / "me"), matching DOC-11's own instruction not to expose
    `organizationId` unnecessarily. `assignedOperator` is never a raw User
    document - only `id`/`fullName`, exactly like DOC-49's Manager
    contact info shape.
- **`routes/request.routes.js`** - `router.get('/', listMyRequests);
  router.get('/:id', getMyRequestById);` added to the same Employee-only
  chain `POST /` already uses (`verifyToken, requireRole('employee'),
  requireOrganizationMembership, requireActiveOrganization`) - Operator/
  Manager/System Admin all still get 403; DOC-11 does not broaden this. A
  legacy orgless Employee (`organizationId: null`) is blocked by
  `requireOrganizationMembership`, the same as every other org-scoped
  endpoint.
- **Index review**: DOC-10 already indexes `organizationId`, `createdBy`,
  and `categoryId` individually. A compound index like `{ organizationId:
  1, createdBy: 1, createdAt: -1 }` was considered but NOT added - at this
  academic-project scale, with no real MongoDB connected to measure an
  actual query plan against, the existing single-field indexes are already
  sufficient for "My Requests" (a query scoped to one `createdBy` value
  plus a client-side/in-memory sort of a small result set) and adding a
  compound index without evidence it is needed would be exactly the kind
  of premature indexing DOC-11 explicitly warns against.

### Update Request Information and Status (DOC-12)

The controlled status workflow: `open -> in_progress -> resolved ->
closed`, with a `resolved -> reopened -> in_progress` branch if the
problem was not actually solved. No new statuses were added - the same
five-value enum DOC-10 already defined (`open`, `in_progress`, `resolved`,
`closed`, `reopened`) is reused as-is. Comments (DOC-13), image
attachments (DOC-45), and Employee edit/cancel (DOC-46) are still not
implemented here.

- **`utils/requestStatusTransitions.js`** (new) - the single source of
  truth for "who may move a Request from status A to status B", a small
  pure function, not scattered inline role checks across the controller:
  `canTransitionRequestStatus({ role, currentStatus, nextStatus, isCreator,
  isAssignedOperator })` returns a boolean. It never reads the database
  and never trusts `isCreator`/`isAssignedOperator` itself - the caller
  (`updateRequestStatus`) is responsible for deriving both from a freshly
  fetched, Organization-scoped document.
  - **Operator** (only if `isAssignedOperator`): `open -> in_progress`,
    `in_progress -> resolved`, `reopened -> in_progress`. Every other
    Operator transition (including `open -> resolved`, `open -> closed`,
    any transition out of `closed`) is rejected.
  - **Employee** (only if `isCreator`): `resolved -> closed` ("Yes,
    solved") and `resolved -> reopened` ("No, still broken"). An Employee
    can never move a Request out of `open`/`in_progress` themselves, and
    can never reopen a `closed` Request - that boundary belongs to DOC-46,
    not DOC-12.
  - **Manager**: `resolved -> closed` only (a conservative "administrative
    close" rule) - no arbitrary state jumps, and the Organization scope
    applied before this function is ever called already prevents a
    cross-org Manager from reaching another Organization's Request at all.
  - **System Admin**: always `false`. System Admin manages the platform,
    not day-to-day Organization workflow, and is additionally rejected
    explicitly inside `updateRequestStatus` itself (see below) rather than
    relying on this function alone.
- **`controllers/request.controller.js`** - new `updateRequestStatus`
  handler (`PATCH /api/requests/:id/status`):
  1. Rejects `role === 'system_admin'` explicitly, with its own 403 and
     message. This check exists because
     `requireOrganizationMembership`/`requireActiveOrganization`
     (middleware/organizationScope.js, DOC-31/38) both deliberately
     **bypass** System Admin, since it is a global, non-organization-scoped
     role - without this explicit rejection, a System Admin token would
     otherwise reach the transition logic.
  2. Validates the `:id` param as a well-formed ObjectId (400, not a raw
     Mongoose `CastError`) and validates `body.status` is a string that is
     one of the five known enum values (400 otherwise).
  3. Looks up the Request scoped by Organization **first** - `Request.
     findOne({ _id: id, organizationId: req.user.organizationId })` -
     never `findById()` followed by a manual comparison. A nonexistent
     Request and one belonging to another Organization both produce the
     same 404 (DOC-38 anti-enumeration convention), for every role.
  4. Rejects a same-status update as 400 ("Request is already
     '&lt;status&gt;'.") before any authorization check runs - this is a
     no-op request shape, not a permissions question.
  5. Derives `isCreator` (`String(requestDoc.createdBy) ===
     String(req.user.userId)`) and `isAssignedOperator`
     (`requestDoc.assignedOperatorId` truthy AND equal to
     `req.user.userId`) exclusively from the document just fetched in step
     3 - **never** from `req.body`. A payload of `{ status: 'closed',
     assignedOperatorId: '<attacker id>', organizationId: '<other org>',
     createdBy: '<attacker id>' }` has zero effect on anything except
     `status`, and only if `canTransitionRequestStatus` actually approves
     it.
  6. Calls `canTransitionRequestStatus`; a `false` result is a 403 ("You
     are not authorized to perform this status change."), not a 400 - the
     Request and the requested status are both individually valid, the
     caller just isn't allowed to make that specific move right now.
  7. On success, sets `requestDoc.status = nextStatus` and `.save()`s it
     (Mongoose's own `updatedAt` timestamp updates naturally - no separate
     status-history/audit-log collection was built, per the task's
     explicit instruction not to). Re-enriches and responds with the exact
     same `sanitizeRequest` shape DOC-11 already established - no new
     response contract for a status change.
- **Critical Operator-specialty note**: Operator Specialties (DOC-44)
  are **never** consulted anywhere in this flow. Being the Operator whose
  specialty matches a Request's Category is not the same as being the
  Operator *assigned* to that specific Request - only
  `assignedOperatorId === req.user.userId`, read fresh from the database,
  ever grants Operator-level status permissions. This was adversarially
  tested (see the DOC-12 report) by giving an unassigned Operator a
  matching specialty and confirming they are still rejected.
- **Assignment dependency (read before assuming Operator transitions
  work today)**: at the time DOC-12 was implemented, there is still no
  legitimate flow anywhere in this codebase that sets
  `assignedOperatorId` to a real Operator - DOC-10 always creates a
  Request with `assignedOperatorId: null`, and no Manager-assignment
  endpoint exists yet. The Operator-authorization mechanism above was
  built correctly and is structurally ready (verified with directly
  seeded test data), but it is **currently unreachable in real production
  data** until a future task implements Manager -> Operator assignment.
  This was not faked or worked around - see the final DOC-12 report for
  the full disclosure.
- **`routes/request.routes.js`** - `PATCH /:id/status` is registered
  **before** this router's blanket `router.use(verifyToken,
  requireRole('employee'), ...)` gate, the same pre-blanket-gate pattern
  `organization.routes.js`'s `GET /me` and `serviceCategory.routes.js`'s
  `GET /available` already use. Its own chain is intentionally smaller -
  `verifyToken, requireOrganizationMembership, requireActiveOrganization`
  - with **no** `requireRole`, because Employee, Operator, and Manager (three
  different rulesets) all need to reach this one endpoint; every
  role-specific rule lives in `canTransitionRequestStatus`/
  `updateRequestStatus`, not in the route's middleware chain.
- **Not implemented here (by design):** Comments (DOC-13), image
  attachments (DOC-45), Employee edit/cancel (DOC-46), automatic Operator
  assignment, a Manager-facing Request list/queue, and any status-history/
  audit-log collection.

### Add Comments to a Request (DOC-13)

A separate, referencing collection - **not** an array field embedded on
`Request` (see Request.js's own top comment, which reserved this exact
design). Create + view only - there is no comment edit/delete endpoint.

- **`models/Comment.js`** (new) - `requestId` (ref Request, required,
  indexed), `organizationId` (ref Organization, required, indexed),
  `authorId` (ref User, required), `content` (required, trimmed, 1-2000
  characters), `timestamps: true`. No attachment fields - DOC-45 owns
  those on its own future schema. A compound index,
  `{ organizationId: 1, requestId: 1, createdAt: 1 }`, was added
  deliberately (unlike DOC-11's compound-index question) because it
  directly matches the one query this feature actually runs - "all
  comments for one Request, inside one Organization, oldest first" - in a
  single index scan rather than a filter-then-sort.
- **`utils/commentAccess.js`** (new) - the single source of truth for who
  may read/write a Request's comments, the same centralized-helper pattern
  DOC-12's `canTransitionRequestStatus` already established:
  - **`canReadRequestComments({ role, userId, requestCreatedBy,
    assignedOperatorId })`** - Employee: creator only. Operator: only the
    Operator actually `assignedOperatorId` on this Request (specialty
    relevance, DOC-44, is never checked). Manager: any Request in their
    own Organization (already guaranteed by the Organization-scoped
    lookup that happens before this is ever called). Anything else
    (System Admin, or an unrecognized role): never. **Not** affected by
    Request status - a closed Request's history stays fully readable.
  - **`canWriteRequestComments({ ...same fields, requestStatus })`** -
    identical base rule, **plus** an explicit `requestStatus === 'closed'`
    check that rejects everyone regardless of role (task spec's chosen
    "closed Requests are read-only" rule). Kept as a genuinely separate
    function from `canReadRequestComments` (not a single function with a
    `mode` flag) specifically so read and write authorization can never
    accidentally drift out of sync with each other.
- **`controllers/comment.controller.js`** (new):
  - **`loadCommentableRequest(req, res)`** - shared by both handlers.
    Validates `:id` as a well-formed ObjectId (400 otherwise, no raw
    Mongoose `CastError`), then looks up the Request scoped by
    Organization first - `Request.findOne({ _id, organizationId:
    req.user.organizationId })` - never `findById()` + a manual
    comparison. A nonexistent Request and one belonging to another
    Organization both produce the identical 404 (DOC-38 anti-enumeration
    convention).
  - **`listComments`** (`GET /api/requests/:id/comments`) - rejects
    `system_admin` explicitly, before any Request lookup (System Admin is
    org-less by design and must never be given a fake/borrowed
    Organization to search against). Calls
    `loadCommentableRequest`, then `canReadRequestComments`; a `false`
    result is 403. On success: `Comment.find({ requestId,
    organizationId: req.user.organizationId }).sort({ createdAt: 1 })` -
    oldest first, scoped by both fields, never `requestId` alone.
  - **`createComment`** (`POST /api/requests/:id/comments`) - same
    System-Admin rejection and Request lookup, then
    `canWriteRequestComments` (which additionally rejects a `closed`
    Request for every role). Reads exactly one field from the body -
    `content` (validated: required string, trimmed, non-empty,
    ≤2000 characters) - `organizationId`, `authorId`, and `requestId` are
    always server-derived from `req.user`/the URL param, exactly the
    allowlist-construction pattern DOC-10/12 already established (never
    `Comment.create({ ...req.body })`).
  - **`buildAuthorMap`** - batches every distinct `authorId` in a page of
    Comments into at most one additional `User.find({ _id: { $in: [...] },
    organizationId })` query, never one query per comment (N+1),
    mirroring `request.controller.js`'s own `buildRequestEnrichmentMaps`.
    Deliberately does **not** filter by `isActive` - a comment written by a
    User who has since been deactivated must remain visible with their
    real name (task spec section 21), the same "history survives
    deactivation" rule DOC-11 already applies to Category names.
  - **`sanitizeComment(comment, author)`** - `{ id, content, author: { id,
    fullName, role } | { id, fullName: 'Unknown User', role: null },
    createdAt, updatedAt }`. `requestId`/`organizationId`/`authorId` are
    never in the top-level response - the caller already knows which
    Request this is, and the nested `author` object already carries
    identity. The `'Unknown User'` fallback only triggers if an
    `authorId` genuinely cannot be resolved to a User document (defensive
    only - every `authorId` is always written server-side from a real
    User at creation time, so this should not normally be reachable, but
    a resolution failure must never crash the response or hide the rest
    of a Request's comment history).
- **`routes/request.routes.js`** - `GET /:id/comments` and `POST
  /:id/comments` are registered **before** the blanket
  `requireRole('employee')` gate, on the same minimal chain (`verifyToken,
  requireOrganizationMembership, requireActiveOrganization`, no
  `requireRole`) DOC-12's status endpoint already uses - Employee,
  Operator, and Manager all reach the same two routes; every role-specific
  rule lives in `utils/commentAccess.js`, not in middleware or three
  duplicated endpoints.
- **Comments never affect Request status.** `createComment` never touches
  `requestDoc.status` - DOC-12's `canTransitionRequestStatus` remains the
  sole authority over status, completely independent of commenting.
- **Category status is irrelevant to commenting** - an existing Request's
  comments are unaffected by its Category being deactivated later (no
  Category lookup happens anywhere in this controller at all).
- **Not implemented here (by design):** comment edit/delete (no
  PATCH/DELETE endpoint - DOC-13 is create + view only), image/file
  attachments (DOC-45), and any notification (email/push/websocket/in-app)
  on a new comment.

### Edit / Cancel Own Request (DOC-46)

An Employee may edit their own Request's content while it is still
`open` and unassigned, and may cancel it under the same condition. No
hard delete anywhere - cancellation is represented as a sixth status
value, `cancelled`, which is terminal.

- **`models/Request.js`** - `STATUS_VALUES` grows to `['open',
  'in_progress', 'resolved', 'closed', 'reopened', 'cancelled']`.
  `cancelled` is deliberately outside DOC-12's open->in_progress->
  resolved->closed(/reopened) workflow entirely - it can only ever be
  reached through the new dedicated cancel endpoint below, never through
  DOC-12's generic status endpoint.
- **`utils/requestFieldValidation.js`** (new) - `validateTitle`,
  `validateDescription`, and `validatePriority`, extracted verbatim from
  `createRequest`'s original DOC-10 rules so create and edit can never
  quietly drift into two different rule sets for the same fields.
  `request.controller.js`'s `createRequest` was updated to import these
  instead of keeping its own private copies - a pure refactor, its
  behavior did not change.
- **`controllers/request.controller.js`** - two new handlers:
  - **`updateMyRequest`** (`PATCH /api/requests/:id`) - an explicit
    allowlist (`EDITABLE_FIELDS = ['title', 'description', 'categoryId',
    'priority']`), never `Request.findByIdAndUpdate(id, req.body)` and
    never `{ ...req.body }`. Order of checks: (1) validate `:id` as a
    well-formed ObjectId (400); (2) scoped ownership lookup - `Request.
    findOne({ _id, createdBy: req.user.userId, organizationId:
    req.user.organizationId })`, never `findById()` + a manual check, so
    a nonexistent Request, another Employee's Request, and another
    Organization's Request are all indistinguishable and produce the same
    404; (3) eligibility - `status === 'open'` AND `assignedOperatorId ===
    null`, each rejected with its own **409 Conflict** (not 403 - the
    caller IS the owner, the resource just cannot be edited right now);
    (4) **forbidden-field policy: explicitly reject** (400) any payload
    that contains `status`, `organizationId`, `createdBy`,
    `assignedOperatorId`, `createdAt`, `updatedAt`, `_id`, or `id` - none
    of these are ever read, not even to validate their shape (task spec
    section 8's recommended policy, chosen for being the clearer, safer
    signal to the caller over silently ignoring them); (5) at least one
    of the four editable fields must be present (400 otherwise - this is
    what makes an unknown-only payload like `{ "foo": "bar" }` a 400 too,
    since it supplies zero recognized editable fields); (6) each supplied
    field is validated with the shared validators above; (7) `categoryId`
    is looked up and validated (scoped, active-only, anti-enumeration -
    identical shape to `createRequest`) **only when it is actually being
    changed** - an Employee editing only title/description on a Request
    whose historical Category has since gone inactive is never blocked or
    forced to replace it (task spec section 21/35-37, verified by test).
  - **`cancelMyRequest`** (`PATCH /api/requests/:id/cancel`) - reads
    **no request body at all**; the server unconditionally sets
    `status = 'cancelled'`. Same ownership lookup and eligibility rule as
    `updateMyRequest` (`open` + unassigned, same 409s). Because the body
    is never read, an injected `{ "status": "cancelled" }` or any other
    payload has literally no code path that could act on it (verified by
    test - cancellation succeeds identically with or without a body).
  - Both handlers reuse `sanitizeRequest` unchanged for their response -
    no separate response shape for an edited or cancelled Request.
  - **Comments are never touched by either handler** - no Comment
    document is read, written, or otherwise referenced by
    `updateMyRequest`/`cancelMyRequest` (task spec section 10).
- **`routes/request.routes.js`** - `PATCH /:id` and `PATCH /:id/cancel`
  are added to the router's existing blanket Employee-only chain
  (`verifyToken, requireRole('employee'), requireOrganizationMembership,
  requireActiveOrganization`) alongside `POST /`/`GET /`/`GET /:id` -
  **not** a broadened chain, and **not** reachable by Operator, Manager,
  or System Admin (task spec sections 29-31), unlike DOC-12/13's
  multi-role status/comment endpoints.
- **`utils/requestStatusTransitions.js`** - `canTransitionRequestStatus`
  gained two explicit, unconditional guards ahead of every role check:
  `currentStatus === 'cancelled'` always returns `false` (cancelled is
  terminal - nobody may transition a cancelled Request anywhere through
  the generic status endpoint), and `nextStatus === 'cancelled'` always
  returns `false` (cancellation may only ever happen through the
  dedicated cancel endpoint above, never through DOC-12's generic PATCH
  `/api/requests/:id/status` - no role's transition map lists
  `'cancelled'` as a target anyway, but this makes the rule explicit
  rather than incidental).
- **`utils/commentAccess.js`** - `canWriteRequestComments`'s read-only
  check widened from a single `requestStatus === 'closed'` comparison to
  `COMMENT_READ_ONLY_STATUSES = ['closed', 'cancelled']` - a cancelled
  Request gets the exact same "readable forever, no new comments" policy
  `closed` already had (task spec section 18), not a second parallel
  concept. `canReadRequestComments` is unaffected either way - comment
  history is never hidden by either terminal status.
- **Not implemented here (by design):** hard delete (no `DELETE
  /api/requests/:id`, no `Request.deleteOne`, no comment cascade-delete),
  a status-history/audit-log collection, Manager or Operator editing of
  Request content, and any notification on edit/cancel.

### Add Image Attachments to Requests (DOC-45)

> **Storage backend update:** every rule described in this section
> (limits, ownership, eligibility, MIME types) is still exactly as
> written below and unchanged. What changed is WHERE a NEW image's bytes
> are stored: local disk (as described here) for every attachment created
> before the GridFS migration, MongoDB GridFS for every attachment created
> after it. Both kinds coexist and both work identically from the
> frontend's point of view. See "GridFS Image Storage Migration" near the
> end of this document for the full writeup.

An Employee may attach up to 5 image files (JPEG/PNG/WEBP only, 5 MB max
each) to their own Request - at creation, and afterward while it is still
`open` and unassigned (the exact same eligibility DOC-46 established for
editing/cancelling). Only image metadata lives in MongoDB; the actual
files live on local disk. No PDFs, archives, documents, or executables of
any kind are accepted, and attachments are never allowed on comments.

- **New dependency: `multer` (`^2.2.0`)** - the only package this task
  adds. No Cloudinary/AWS/Firebase/Sharp and no image
  transformation/compression of any kind (task spec section 21) - files
  are stored exactly as uploaded.
- **`middleware/upload.js`** (new) - the one place image-upload
  storage/validation is configured:
  - `UPLOAD_ROOT` resolves via an optional `UPLOAD_DIR` env var
    (documented in `.env.example` only - the real `.env` is never
    touched) with a default of `uploads/requests`, and is created
    automatically on module load (`fs.mkdirSync(..., { recursive: true
    })`) if it does not already exist.
  - `ALLOWED_MIME_TYPES` is an explicit map of exactly three types -
    `image/jpeg`, `image/png`, `image/webp` - each mapped to its own file
    extension. SVG is deliberately excluded even though it can render as
    an image, since it can embed script content.
  - Generated filenames are always `crypto.randomUUID()` plus an
    extension taken from `ALLOWED_MIME_TYPES` - **never** the client's
    original filename or its extension. A file named `virus.exe.jpg` sent
    with `Content-Type: image/png` is stored as `<uuid>.png`; nothing
    about the original name ever reaches the filesystem path, which is
    what makes path traversal via a crafted filename structurally
    impossible.
  - `fileFilter` rejects anything outside `ALLOWED_MIME_TYPES` before
    Multer ever writes a byte to disk. **Disclosed limitation:** this
    checks the multipart part's *declared* `Content-Type`, not the file's
    actual bytes - genuine content-sniffing would need an additional
    library, which task spec section 21 explicitly rules out. Combined
    with the generated-filename policy above, a file that lies about its
    type can still never be executed as anything by virtue of its name or
    extension once stored.
  - `limits: { fileSize: 5MB, files: 5 }` is Multer's own **static**
    per-call ceiling. It has no notion of how many images a specific
    Request already has - the **dynamic** "existing + new <= 5" rule
    lives in the controller instead (see below).
  - `handleUpload(multerMiddleware)` wraps any configured Multer
    middleware so a `MulterError` or `fileFilter` rejection becomes a
    clean, client-safe JSON response (400 for type/count, 413 for
    oversized) instead of an internal error reaching the generic handler
    - and immediately deletes any files Multer had already written to
    disk before the error occurred (Multer streams multipart parts one at
    a time, so an error on the 3rd file of 5 can otherwise leave the
    first two orphaned).
- **`models/Request.js`** - a new `attachments` field: `[attachmentSchema]`,
  defaulting to `[]`, never required. Each attachment stores
  `originalName` (display only), `storedName` (the actual on-disk
  filename - **never returned to the client**, see the sanitizer below),
  `mimeType` (enum-restricted to the same three types), `size`
  (schema-validated 1 byte - 5 MB, defense in depth alongside the
  controller/Multer checks), `url` (a root-relative path under the
  controlled static route, never an absolute filesystem path), and
  `uploadedAt`. A custom array validator caps the field at 5 entries.
  **No base64 image data is ever stored in MongoDB.**
- **`controllers/request.controller.js`**:
  - `sanitizeRequest` now maps `attachments` to a safe shape:
    `id`/`originalName`/`mimeType`/`size`/`url`/`uploadedAt` -
    `storedName` is deliberately never included, since it is an internal
    filesystem detail the frontend has no use for.
  - `buildAttachmentMetadata(files)` builds trusted attachment metadata
    **exclusively from Multer's `req.files`** - `originalName`,
    `mimeType`, and `size` all come from what Multer itself observed,
    `storedName`/`url` come from Multer's own generated filename. `req.body`
    is never read for any attachment field. Each attachment's `_id` is
    generated explicitly here (`new mongoose.Types.ObjectId()`) rather
    than relying on implicit subdocument auto-`_id` behavior, so the
    later remove-by-id lookup is deterministic.
  - **`createRequest`** (`POST /api/requests`) is now
    multipart/form-data-capable: Multer's `upload.array('attachments', 5)`
    (wrapped by `handleUpload`) runs first and populates `req.files`
    plus puts every text field onto `req.body` as a plain string - the
    same four text fields (`title`/`description`/`categoryId`/`priority`)
    are read exactly as before, so **creating a Request with zero images
    still works completely unchanged**. Every validation failure (bad
    title/description/category/priority) now routes through a
    `rejectWithCleanup` helper that deletes any already-uploaded files
    before responding, and the `catch` block does the same for a later
    database error - no failure path can ever leave an orphaned file on
    disk. `organizationId`/`createdBy`/`status`/`assignedOperatorId` are
    still hardcoded/derived from `req.user` exactly as DOC-10 established
    - a multipart payload that also includes those fields has zero effect
    on any of them (verified by test).
  - **`loadEditableRequestOrRespond(req, res)`** (new, shared) - the
    exact same ownership + eligibility shape DOC-46's
    `updateMyRequest`/`cancelMyRequest` already use (`Request.findOne({
    _id, createdBy: req.user.userId, organizationId:
    req.user.organizationId })`, 404 for nonexistent/not-owned/cross-org,
    409 if `status !== 'open'` or an Operator is already assigned), reused
    by both attachment endpoints below instead of inventing a second
    authorization model. Cleans up `req.files` on every early return.
  - **`addRequestAttachments`** (`POST /api/requests/:id/attachments`,
    Employee-only) - requires at least one file (400 otherwise); computes
    `remainingSlots = 5 - requestDoc.attachments.length` and rejects (with
    file cleanup) if the new upload would push the total over 5 - this is
    the dynamic per-Request check Multer's own static limit cannot
    express (e.g. 3 existing + 2 new is accepted, 3 existing + 3 new is
    rejected). On success, the new attachments are pushed onto the
    Request's `attachments` array and saved.
  - **`removeRequestAttachment`** (`DELETE
    /api/requests/:id/attachments/:attachmentId`, Employee-only) - the
    client supplies only an opaque `attachmentId`, **never** a filesystem
    path or filename. A nonexistent `attachmentId` on an otherwise-real,
    owned Request is a generic 404 (never reveals whether the Request or
    just the attachment doesn't exist). `storedName` is read back from
    the already-stored, server-generated metadata and reduced through
    `path.basename(...)` before being joined with `UPLOAD_ROOT` - defense
    in depth against path traversal, even though it is already a plain
    generated UUID filename with no path separators. Physical file
    removal is best-effort (`fs.unlink` with a no-op error callback) - a
    file that is somehow already missing from disk must not fail the
    response, since the metadata removal (what actually matters to the
    Request's stored state) has already succeeded by that point.
- **`routes/request.routes.js`** - `POST /:id/attachments` and `DELETE
  /:id/attachments/:attachmentId` are added to the router's existing
  blanket Employee-only chain alongside DOC-46's edit/cancel routes - not
  a broadened chain, and not reachable by Operator, Manager, or System
  Admin. `POST /` and `POST /:id/attachments` both run through the same
  `uploadAttachments` (`handleUpload(upload.array('attachments', 5))`)
  middleware.
- **`app.js`** - controlled static serving of uploaded images, mounted at
  `/api/uploads/requests` (the same `/api` namespace as every other
  route, chosen specifically so the frontend can build a full image URL
  with the exact same `VITE_API_BASE_URL` it already uses for every other
  call: `${API_BASE_URL}${attachment.url}`). Configured with `dotfiles:
  'deny'`, `index: false`, `redirect: false`. Only the one configured
  `UPLOAD_ROOT` directory is ever served, and every filename in it is an
  unguessable generated UUID - acceptable unauthenticated static serving
  for this academic/local project (nothing else ever lives in this
  directory, and an image filename carries no sensitive information).
- **Role-based visibility unchanged:** attachments are never given a
  separate authorization model - they are visible to whichever
  role/relationship can already read the parent Request at all (an
  Employee's own Request; later, once implemented, an assigned Operator
  or a Manager within the same Organization), and invisible otherwise, by
  virtue of riding along inside `sanitizeRequest`'s existing response
  shape. System Admin's existing exclusion from Request endpoints is also
  unchanged.
- **Cancelled/closed behavior:** existing attachments remain fully
  visible and stored on a `cancelled` or `closed` Request forever (never
  hidden, never deleted) - only *adding* or *removing* attachments is
  blocked once a Request leaves the `open`+unassigned eligibility window,
  identical to DOC-46's edit/cancel rule.
- **Not implemented here (by design):** Manager -> Operator assignment,
  notifications, general (non-image) file attachments of any kind,
  attachments on comments, hard-deleting a Request (removing an
  attachment only ever removes that one attachment), and any image
  transformation/compression/thumbnailing.
- **Testing note:** DOC-45's automated suite used real Multer middleware
  and a real, temporary filesystem directory for every multipart test
  (genuinely written, verified on disk, and deleted afterward) - only
  User/Organization/ServiceCategory/Request/Comment persistence was
  mocked in-memory, for the same reason as every prior Sprint 3 task: no
  live MongoDB connection is available in this environment. Request-model
  schema validation (the `attachments` field's own rules) was verified
  directly against the real Mongoose schema (`validateSync()`), with no
  mocking at all.

### Manager Request Administration (DOC-59)

Lets a Manager fully administer every Request inside their own
Organization - priority, category, and Operator assignment, plus closing
a resolved Request and cancelling any non-terminal one - without touching
Employee ownership (`createdBy` is never reassignable) or any previously
completed functionality. Three dedicated, Manager-only routes, none of
which reuse or overload the Employee-only endpoints DOC-46 already owns.

- **`PATCH /api/requests/:id/manager`** (`managerUpdateRequest`) - a
  single combined edit endpoint for `priority`, `categoryId`, and/or
  `assignedOperatorId`, any subset, read via an explicit allowlist
  (`MANAGER_EDITABLE_FIELDS`) - `status`/`organizationId`/`createdBy`/
  `attachments`/comments are never read here at all, regardless of what a
  payload contains. Each field's rule is independent and only enforced
  when that field is actually present in the body
  (`Object.prototype.hasOwnProperty`, not just truthy) - this is what
  lets a Manager change only `priority` on a Request that is not
  currently `open` without an untouched `assignedOperatorId` field
  looking like an illegal reassignment attempt. `priority`/`categoryId`
  are rejected (409) on an already-`closed`/`cancelled` Request.
  `categoryId` must resolve to an active, same-Organization Category (the
  same shape `createRequest` already uses). `assignedOperatorId` supports
  three intents: absent (leave assignment alone), a real Operator id
  (assign/reassign - Request must be `open`, Operator must be same-
  Organization/`role: 'operator'`/active/specialty-matching the
  *effective* category, reassigning the SAME Operator is rejected as a
  no-op exactly like DOC-22's `assignRequestOperator`), or explicit JSON
  `null` (remove - Request must be `open` and must currently have an
  Operator assigned).
- **`PATCH /api/requests/:id/manager/cancel`** (`managerCancelRequest`) -
  cancels any Request that is not already `closed`/`cancelled` (409
  otherwise) - deliberately broader than Employee's own DOC-46 cancel
  (open-and-unassigned only), since a Manager is administering the whole
  Organization's Requests. Requires a `reason` (`validateCancelReason`,
  3-500 characters) and always records who/when/why:
  `cancelledBy`/`cancelledAt`/`cancelReason` on the Request document
  itself - all three are new fields, `null` by default, and left
  completely untouched by every pre-existing cancel/status code path
  (Employee's own cancel never sets them). `cancelledBy` is resolved for
  display in the response the exact same way `assignedOperator` already
  is - never a raw id.
- **`PATCH /api/requests/:id/manager/close`** (`managerCloseRequest`) -
  `resolved -> closed`, and nothing else. Reuses the SAME centralized
  `canTransitionRequestStatus` helper DOC-12's generic status endpoint
  already uses (`MANAGER_TRANSITIONS = { resolved: ['closed'] }`,
  `utils/requestStatusTransitions.js`) rather than a second, parallel
  transition rule - this is the existing Manager-close rule, reached
  through its own dedicated URL instead of DOC-12's generic `{ status }`
  body shape.
- **Every lookup on all three routes is scoped by `organizationId` only**
  (never `createdBy` - a Manager administers Requests they did not
  create) via a single `Request.findOne({ _id, organizationId })` query,
  the same DOC-38 anti-enumeration convention used everywhere else in
  this codebase: a nonexistent Request and one belonging to another
  Organization both produce the identical 404.
- **Authorization chain** (all three routes): `verifyToken`,
  `requireRole('manager')`, `requireOrganizationMembership`,
  `requireActiveOrganization` - registered ahead of this router's blanket
  Employee-only gate, the same pattern DOC-52's Manager/Operator routes
  already established.
- **`models/Request.js`** gained three new, all-optional fields:
  `cancelledBy` (ObjectId ref User, default `null`), `cancelledAt` (Date,
  default `null`), `cancelReason` (String, trimmed, max 500 chars,
  default `null`). `sanitizeRequest` gained a sixth, optional
  `cancelledByUser` parameter (same
  "`undefined` for every pre-existing caller, response shape unaffected"
  contract as DOC-52's `createdByUser`) plus two always-present, harmless
  `cancelledAt`/`cancelReason` fields (`null` for every Request never
  Manager-cancelled).
- **`utils/requestFieldValidation.js`** gained `validateCancelReason` -
  pure, synchronous, no DB access, the same shape as this file's existing
  title/description validators.
- **Manager Dashboard** - `ManagerRequestRow.jsx` gained an Edit panel
  (priority/category/assigned-operator, diff-based: only fields the
  Manager actually changed are ever sent, computed client-side against
  the Request's current values), a "Remove Operator" confirm dialog, a
  "Cancel Request" confirm dialog with a required reason textarea, and a
  "Close Request" action - each only rendered when currently legal for
  that Request's status. The pre-existing DOC-52 inline Assign/Reassign
  form is left completely unchanged, on purpose - both paths independently
  go through the backend's own re-validation, and DOC-59 explicitly asks
  not to modify already-completed functionality unless strictly required.
  Every action replaces that one Request in the page's `requests` state
  with the real server response (never a locally-faked update), so the
  list is always showing exactly what the backend just confirmed.
- **Not implemented here (by design):** any change to Employee ownership
  (`createdBy` is never reassignable through any endpoint in this
  codebase), direct attachment or comment mutation through these routes
  (both remain exactly where DOC-45/DOC-13 already put them), and a
  Manager-facing "undo cancel"/restore action (cancellation is terminal,
  matching every other terminal-status rule already in this project).

### Request Search, Filters and Sorting (DOC-54)

- One shared helper, `utils/requestQueryBuilder.js`'s `buildRequestQuery`,
  used by all three existing Request list endpoints - `GET /api/requests`
  (Employee), `GET /api/requests/organization` (Manager), `GET
  /api/requests/assigned` (Operator) - rather than a fourth, duplicate
  "search" endpoint. It only ever ADDS restrictions on top of each
  endpoint's own trusted, role-scoped base query (`{ organizationId,
  createdBy }` for Employee, `{ organizationId, assignedOperatorId }` for
  Operator, `{ organizationId }` for Manager) - a query parameter can
  never remove or override a key the base query already set.
- **`q`** - case-insensitive text search across `title` OR `description`,
  built as a MongoDB regex. Every regex metacharacter in the caller's text
  is escaped first (`escapeRegExp`) so a search string is always treated
  as a literal substring, never as an injected pattern. Max 200
  characters (400 if exceeded). A whitespace-only `q` imposes no filter
  at all (documented, chosen behavior, not an accidental no-op).
- **`status`**/**`priority`** - exact match against the existing enums;
  an unsupported value is rejected with 400, never silently ignored.
- **`categoryId`** - valid ObjectId, must belong to the caller's own
  Organization. Deliberately NOT restricted to `isActive: true` - a
  historical Request may reference a since-deactivated Category, and
  filtering by it must keep working. Cross-Organization or nonexistent
  both collapse into the same generic 400 (the one consistent policy this
  file uses for every entity-id filter, per the task spec's stated
  preference over a silent empty result).
- **`assignedOperatorId`** (Manager only) - a real Operator id (same
  Organization, `role: 'operator'`, NOT required to be `isActive` -
  historical assignments to a since-deactivated Operator must remain
  filterable) or the literal string `"unassigned"` (`assignedOperatorId:
  null`). Employee/Operator tokens never reach this branch at all
  (`buildRequestQuery` only reads it when `role === 'manager'`) - the
  parameter is a structural no-op for them, not something requiring its
  own runtime rejection.
- **`createdBy`** (Manager only) - a real User id, same Organization,
  `role: 'employee'` (the only role that may create a Request), NOT
  required to be `isActive` for the same historical-filtering reason as
  above. Same structural no-op for Employee/Operator as
  `assignedOperatorId`.
- **`createdFrom`/`createdTo`** - optional date-range filter on
  `createdAt`, supported uniformly for all three roles (a time-range
  filter only ever narrows a role's existing scope, so there is no
  isolation reason to restrict it to Manager - only the Manager
  Dashboard's UI actually exposes date-range controls, see below). A
  bare date-only string (`"2026-08-01"`) is expanded to that UTC day's
  start (`00:00:00.000Z`) for `createdFrom` and end (`23:59:59.999Z`) for
  `createdTo`; a full ISO timestamp is used exactly as given. An invalid
  date, or `createdFrom` after `createdTo`, is rejected with 400.
- **`sortBy`**/**`sortOrder`** - allowlisted to `createdAt` / `updatedAt`
  / `priority` / `status` / `title`, and `asc` / `desc` - default
  `createdAt` / `desc` (identical to every endpoint's original, pre-DOC-54
  "newest first" behavior). Any other value is rejected with 400, never
  silently mapped to the default. `createdAt`/`updatedAt`/`title` sort at
  the database level (`.sort({...})`); `priority`/`status` are sorted
  in-memory AFTER fetching (`sortRequestDocs`, also in
  `requestQueryBuilder.js`) using a fixed BUSINESS order, not alphabetical
  - alphabetical would read "high, low, medium", which is meaningless for
  a priority queue:
    - `priority` asc: low -> medium -> high; desc: high -> medium -> low.
    - `status` asc: open -> reopened -> in_progress -> resolved -> closed
      -> cancelled (the Request lifecycle order from
      `utils/requestStatusTransitions.js`, with the terminal `cancelled`
      bucket sorted last regardless of direction - a display-ordering
      choice only, zero effect on any transition rule); desc is the exact
      reverse.
  A small in-memory sort was chosen over an aggregation pipeline
  deliberately (task spec: "keep it simple", "do not introduce a
  complicated analytics pipeline merely for status ordering") - acceptable
  at this project's scale, see the pagination note below.
- **Response shape is completely unchanged** - `sanitizeRequest` was not
  touched by this task. Search/filter/sort only changes WHICH Request
  documents are fetched and in what order, never what a single Request
  looks like in the response.
- **Pagination was deliberately NOT added.** This is an academic/local
  project; a single Organization's total Request count is not expected to
  reach a scale where returning the full filtered array is unsafe, and
  every dashboard already renders its full list in one table (no existing
  "load more"/page controls anywhere in this project to hook into).
  Adding `page`/`limit` now would also touch all three dashboards' fetch
  logic and response handling for no present benefit - deferred, not
  overlooked. If Organization sizes grow enough to need it, `page`/`limit`
  metadata can be layered onto `buildRequestQuery`'s existing return shape
  without changing its current contract for any existing caller.
- **Frontend** - one shared `RequestSearchControls.jsx` component, used by
  all three dashboards; the fields it renders differ by role
  (`showManagerFilters` prop) rather than three separate components. Text
  search is debounced 400ms locally before triggering a refetch; every
  other control (status/priority/category/operator/requester/date/sort)
  refetches immediately. Each dashboard owns its own `filters` state and
  its own fetch-on-change effect - `RequestSearchControls` never talks to
  the backend itself. `requestApi.listMine`/`listOrganization`/
  `getAssigned` all gained an optional second `filters` argument
  (`api.js`'s new `buildRequestQueryString` helper) - every pre-existing
  call site that omits it is completely unaffected. Manager's
  Operator/Requester filter dropdowns deliberately use the FULL (not
  active-only) operators/employees lists, so a historical, now-inactive
  Operator or Employee remains selectable. Every DOC-59 Manager action
  keeps using its existing "patch the one row in local state" refresh
  strategy (no refetch), which already satisfies "preserve the active
  filter state after an action" for free. The empty-list message changes
  to "No requests match the selected filters." whenever at least one real
  filter (not just a sort field) is currently set.

### Dashboard Statistics (DOC-53)

- Four dedicated statistics endpoints, one per role - never a generic
  analytics framework and never a full-Request-list download just to
  count things on the frontend:
    - `GET /api/organizations/statistics` (`system_admin` only) -
      platform-level Organization counts. Chain: `verifyToken`,
      `requireRole('system_admin')`.
    - `GET /api/requests/statistics/organization` (`manager` only) -
      whole-Organization Request statistics. Chain: `verifyToken`,
      `requireRole('manager')`, `requireOrganizationMembership`,
      `requireActiveOrganization`.
    - `GET /api/requests/statistics/assigned` (`operator` only) - the
      calling Operator's own assigned-Request statistics. Same chain
      shape as above with `requireRole('operator')`.
    - `GET /api/requests/statistics/mine` (`employee` only) - the calling
      Employee's own created-Request statistics. Same chain shape with
      `requireRole('employee')`.
  All three Request-statistics routes are registered in
  `request.routes.js`'s existing pre-gate Manager/Operator block,
  alongside `GET /organization` and `GET /assigned` - the same
  "two-segment path can never collide with the single-segment `/:id`"
  non-collision convention DOC-54/DOC-59 already established, just
  applied to a third pair of sibling paths.
- **Role scoping is 100% server-side, exactly like every other endpoint
  in this project (DOC-38):** each endpoint's base query -
  `{ organizationId, createdBy: req.user.userId }` (Employee),
  `{ organizationId, assignedOperatorId: req.user.userId }` (Operator),
  `{ organizationId }` (Manager) - is built from `req.user` alone. No
  query parameter can ever set or override `organizationId`, `createdBy`,
  or `assignedOperatorId` on these endpoints; the ONLY parameters they
  read at all are `createdFrom`/`createdTo`.
- **Filter interaction policy (deliberately chosen, documented once
  here):** Dashboard statistics represent a role's FULL authorized scope,
  optionally narrowed only by `createdFrom`/`createdTo` - they do NOT
  automatically follow whatever DOC-54 search/filter state a dashboard's
  Request list currently has active. Before this task, all three
  dashboards' stat cards were actually derived from the SAME (possibly
  DOC-54-filtered) `requests` array their search controls also drove -
  filtering the list down would silently shrink the overview cards too.
  This was a real bug this task fixes: statistics now always come from
  their own dedicated fetch, independent of the list's current search/
  filter/sort state.
- **Date range** - `createdFrom`/`createdTo` reuse the EXACT SAME
  validation and date-only-string interpretation DOC-54 already
  implemented (`utils/requestQueryBuilder.js`'s `buildCreatedAtRangeFilter`,
  extracted out of `buildRequestQuery` specifically so both DOC-54's list
  filter and DOC-53's statistics filter share one implementation - see
  that file's own comments for the exact start-of-day/end-of-day
  behavior). Invalid dates and `createdFrom` after `createdTo` both 400.
  The date range only ever narrows the query on top of the already-built
  base scope - it can never widen it.
- **Query strategy** (`utils/requestStatistics.js`) - `totals`/`byStatus`/
  `byPriority` are 10 small, fixed-count `countDocuments` calls run in
  parallel (never proportional to how many Requests exist, never a full
  document fetch). `byCategory` (and, for Manager, `byOperator`) need an
  actual GROUP BY that a fixed set of counts cannot express without
  knowing every distinct category/operator id up front - rather than
  query-per-group (which would be N+1), this runs exactly ONE additional
  `Request.find(query)` and groups the results in Node (the same "one
  query, group in memory" shape `buildRequestEnrichmentMaps` already uses
  elsewhere in this controller), and the SAME fetched array is reused for
  both `byCategory` and Manager's `byOperator` - never fetched twice. This
  is deliberately not a MongoDB aggregation pipeline (task spec: "keep it
  simple"), and deliberately not "load every Request merely to count
  simple statuses" either - the simple counts above never touch this one
  grouping query at all.
- **`byCategory`** - `[{ category: { id, name }, count }]`, never
  `normalizedName`. Historical INACTIVE categories are included with no
  special handling (a Request opened against a since-deactivated Category
  must still be counted under it, the same rule DOC-54's own `categoryId`
  filter already follows). A `categoryId` that no longer resolves to any
  Category document (the defensive/should-never-happen case) falls back
  to `{ category: { id, name: 'Unknown Category' }, count }` rather than
  throwing or silently dropping those Requests from the total.
- **`byOperator`** (Manager only) - `[{ operator: { id, fullName,
  isActive }, assignedCount, activeCount, completedCount }]`. EVERY
  Operator currently in the Organization is included, even one with zero
  currently-assigned Requests or one who has since been deactivated -
  `isActive` is returned for display, never used to filter an Operator
  out of this list (a historical, now-inactive Operator's past workload
  must remain visible). `activeCount` = status in {open, in_progress,
  reopened}; `completedCount` = status in {resolved, closed}; `cancelled`
  Requests count toward neither bucket. Unassigned Requests are NOT part
  of this array - they are counted once, separately, as
  `totals.unassigned`.
- **Employee/Operator/Active/Inactive USER counts** (Manager's "Employees/
  Operators" cards) are deliberately NOT part of the Manager statistics
  endpoint's response - the Manager Dashboard already loads the complete,
  unfiltered Organization user list via the existing `GET /api/users`
  (DOC-35/36), so these counts are computed there instead, extending an
  already-existing frontend derivation rather than duplicating it
  server-side (the task's own audit instructions: "Do not duplicate
  existing calculations.").
- **`totalManagers`** (System Admin) counts every User document with
  `role: 'manager'`, active or not - a deliberate, documented choice: a
  DOC-49 Manager replacement deactivates (never deletes) the old Manager,
  so a raw headcount of the role can include a historical, no-longer-in-
  service account. This mirrors "Total Organizations" itself already
  including inactive Organizations - the active/inactive BREAKDOWN is
  what `organizationsWithManager`/`organizationsWithoutManager` already
  provides for Organizations.
- **Refresh behavior** - every Dashboard re-fetches its own statistics
  after any action that could change them (create/edit/cancel/status
  Request, assign/reassign/unassign, promote/demote or activate/
  deactivate a user, create/activate/deactivate an Organization, create/
  replace a Manager) - never a locally-faked increment/decrement. A
  statistics fetch failure shows one small inline message with a Retry
  button and never blocks the rest of that Dashboard (the Request/user
  list keeps working normally).
- **Pagination was deliberately NOT added** to any statistics endpoint -
  every response is already an aggregated summary (a handful of numbers
  and small grouped arrays bounded by how many distinct categories/
  operators actually exist), never a Request-by-Request list, so there is
  nothing to paginate.
- **Frontend** - `StatCard` (already existing) is reused everywhere,
  never a duplicate card component; a new `StatBreakdownList.jsx`
  provides a small, dependency-free CSS bar list for every "Requests by
  X" grouped section (Manager: byStatus/byPriority/byCategory + a plain
  `Operator Workload` table; Operator: byCategory only, task spec "if
  clean"; Employee: no grouped section, task spec only asks for cards).
  No chart library was added.

## Operator Completion Proof Images (DOC-56)

> **Storage backend update:** same note as DOC-45 above - every rule below
> is unchanged; new completion images are now stored in MongoDB GridFS
> instead of local disk. See "GridFS Image Storage Migration" near the end
> of this document.

Before this task, an Employee could attach images to a Request BEFORE any
work happened (DOC-45's `attachments` array) - there was no way for the
Operator who actually did the work to attach proof of completion
afterward. DOC-56 adds a second, completely independent image
collection, `completionAttachments`, owned by the assigned Operator.

- **Schema** (`models/Request.js`) - a new `completionAttachments` array,
  sharing the exact same per-file rules as `attachments` (JPEG/PNG/WEBP
  only, 5 MB max, 5 images max) but with one additional required field,
  `uploadedBy` (the uploading Operator's own User `_id`). The two arrays
  are never merged, never share a subdocument schema, and are validated
  independently - adding 5 "before" images and 5 "completion" images to
  the same Request is legal (the two 5-image caps are entirely separate).
- **Endpoints** (Operator-only, registered ahead of this router's blanket
  Employee-only gate, exactly like every other non-Employee Request route
  - DOC-12/13/52/53/59's own routes already establish this pattern):
  - `POST /api/requests/:id/completion-images` - `multipart/form-data`,
    field name `completionAttachments` (deliberately different from
    `attachments`, so a client can never populate the wrong collection
    just by reusing a field name), reusing DOC-45's exact Multer
    configuration (`middleware/upload.js`, unchanged).
  - `DELETE /api/requests/:id/completion-images/:attachmentId` - removes
    exactly one completion image's metadata and its stored file, the
    same best-effort-disk-cleanup shape `removeRequestAttachment`
    already uses.
- **Permission model** - a new shared helper,
  `loadOperatorOwnedInProgressRequestOrRespond` (`controllers/
  request.controller.js`), used by both endpoints, returns a DIFFERENT
  HTTP status for each of three distinct failure kinds rather than
  collapsing them into one:
  - Nonexistent Request, or one belonging to another Organization -
    **404** (scoped by `organizationId` only, the same DOC-38 anti-
    enumeration convention every other lookup in this project uses).
  - Right Organization, but NOT assigned to the calling Operator
    (unassigned, reassigned to someone else, or an assignment that was
    since removed by a Manager while the Request was still `open`) -
    **403**. This deliberately mirrors `utils/commentAccess.js`'s
    identical "right org, wrong assignee -> 403" precedent (DOC-13), not
    DOC-38's broader cross-org-404 convention - the caller's own token
    already proves Organization membership, so there is no cross-tenant
    enumeration risk left to protect by hiding behind a 404 here.
  - Right Organization, right assigned Operator, but the Request is not
    currently `in_progress` - **409 Conflict** (the same "you ARE allowed
    to act on this resource in general, just not while it is in this
    state" shape `loadEditableRequestOrRespond`/DOC-46 already uses for
    its own status-based checks).
  - An inactive Operator account never reaches any of the above - it is
    rejected outright by `middleware/auth.js`'s existing fresh per-request
    `isActive` check (DOC-38), the same way every other endpoint in this
    project already handles a deactivated account.
- **Upload rules** - Operator-only, only while `assignedOperatorId`
  equals the caller AND `status === 'in_progress'` - no other status,
  including `open` (not started yet) or `resolved`/`closed` (already
  finished). The existing + newly-uploaded count must not exceed 5,
  mirroring `addRequestAttachments`'s exact remaining-slots arithmetic
  applied to the separate `completionAttachments` array.
- **View rules** - Employee (own Request), Operator (own assignment),
  and Manager (any Request in their Organization) all already receive
  `completionAttachments` for free: `sanitizeRequest` now always includes
  it (like `attachments`, never conditional), and every existing
  Employee/Operator/Manager-facing endpoint (`listMyRequests`/
  `getMyRequestById`/`listAssignedRequests`/`listOrganizationRequests`)
  was already correctly role-scoped by DOC-11/52 - no new "who may view"
  logic was needed. System Admin has no Request-viewing endpoint at all,
  so "no access" holds structurally, with nothing new to enforce.
  `uploadedBy` is resolved WITHOUT an extra query: DOC-59 already locked
  `assignedOperatorId` from changing once a Request leaves `open`, and
  completion images can only be uploaded while `in_progress` - so the
  SAME `assignedOperator` document every response already resolves can
  also resolve every completion image's uploader display name.
- **Remove rules** - identical eligibility to upload (assigned Operator,
  `in_progress` only). Once the Request is `resolved`, both endpoints
  start returning 409 - "read-only forever" is enforced simply because no
  later status ever satisfies the `in_progress` check again, not by a
  separate "is it resolved" flag.
- **Resolve validation** - `updateRequestStatus` now rejects (409) an
  Operator's own `in_progress -> resolved` transition when
  `completionAttachments.length === 0`. No additional role check was
  needed: `OPERATOR_TRANSITIONS` (`utils/requestStatusTransitions.js`) is
  the only map in this project that ever lists `resolved` as a reachable
  target, so `nextStatus === 'resolved'` already guarantees this branch
  is only ever reached by the Request's own assigned Operator.
- **Frontend**:
  - `RequestRow.jsx` (Employee default view) now shows "Before Images"
    and "After Images" side by side, both read-only for the Employee
    (view/download only, task spec - the props that would enable Add/
    Remove are simply never passed by `Dashboard.jsx`).
  - `RequestRow.jsx` (`viewerRole="operator"`) keeps its original
    read-only "Images" (before) gallery and adds a new "Completion
    Images" gallery with its own Add Images / Remove Image controls,
    shown only while `request.status === 'in_progress'` - every row
    `OperatorDashboard.jsx` renders is already scoped to the caller's own
    assignment (`GET /requests/assigned`, DOC-52), so no separate
    ownership check is needed in the UI.
  - `ManagerRequestRow.jsx` adds a "View Images" / "Hide Images" toggle
    revealing both galleries side by side, entirely read-only (no Add/
    Remove control on either one).
- **Security** - cross-organization, wrong-operator, inactive-operator,
  removed-assignment, and terminal-status edits are all covered by the
  permission model above; path traversal is structurally impossible
  (generated UUID filenames, never the client's own filename, `storedName`
  is always reduced to `path.basename(...)` before touching the
  filesystem - identical to DOC-45); protected-field injection
  (`uploadedBy`, `organizationId`, etc. sent as extra multipart fields)
  has no effect, since `buildCompletionAttachmentMetadata` never reads
  `req.body` at all, only the trusted `req.files` and server-side
  `req.user.userId`.
- **Tests** - `doc56.e2e.test.tmp.js` (temporary, deleted after the run):
  57 assertions covering upload/remove success, the full permission
  matrix (Employee/Manager/System Admin all blocked from both endpoints),
  status restriction (only `in_progress`), resolve-without-image
  rejected/resolve-with-image succeeds, cross-org (404) vs wrong-operator
  (403) vs wrong-status (409) as three distinct outcomes, inactive-
  operator rejection, the 5-image cap (independent of the Employee
  attachments cap), MIME/size validation, path-traversal and protected-
  field-injection attempts, plus a regression sweep across DOC-10/12/13/
  22/23/45/46/52/53/54/59. All 57 passed.

## Secure Password Management (DOC-57)

Before this task, there was no way for any user to change their own
password after registration, and no way for a Manager to help an
Employee/Operator who forgot theirs other than editing the database
directly. DOC-57 adds two flows: self-service password change (any
authenticated role) and Manager-controlled password reset (Employees/
Operators only, own Organization only) - both backed by a single shared
password-format validator, and a new `mustChangePassword` flag with real
backend enforcement, not just a frontend redirect.

- **Self-change endpoint** - `PATCH /api/auth/change-password`
  (`verifyToken` only - every role, including `system_admin`). Body:
  `{ currentPassword, newPassword, confirmPassword }` - only these three
  fields are ever read (`controllers/auth.controller.js`'s
  `changePassword`). Rules, in order: all three fields required,
  `newPassword === confirmPassword`, `currentPassword` matches the
  caller's real stored hash (`bcrypt.compare`, 401 if not - a genuine
  authentication failure, the same status Login already uses),
  `newPassword` passes the shared format validator, `newPassword` must
  differ from the current password (compared against the real hash, not a
  client claim). On success: `passwordHash` is re-hashed
  (`bcrypt.hash`), `mustChangePassword` is always set to `false`
  (regardless of what it was before), and the sanitized user is returned.
- **Manager-reset endpoint** - `PATCH /api/users/:id/reset-password`
  (`verifyToken`, `requirePasswordChangeCompleted`, `requireRole('manager')`,
  `requireOrganizationMembership`, `requireActiveOrganization` - the same
  full chain every other route on this router already uses). Body:
  `{ newPassword, confirmPassword }` - the Manager never supplies or
  learns the OLD password; this endpoint never reads or compares against
  it. Reuses `resolveManageableTarget` (already built for DOC-50/44)
  unchanged - the exact same self/system_admin/manager/cross-org
  protections `updateUserProfile`/`updateUserStatus`/
  `updateUserSpecialties` already enforce, so DOC-57 adds zero new
  target-resolution logic, only the password-specific validation and
  write. On success: `passwordHash` is re-hashed, `mustChangePassword` is
  always set to `true`, `isActive` is never touched.
- **Password policy** (`utils/passwordPolicy.js`, NEW) - the one shared
  `validatePassword(password)` function now used by registration, Manager
  account creation/replacement (`organization.controller.js`), self-
  change, and Manager reset - previously the length check was duplicated
  inline in two places. Audit finding: the project's existing policy was
  a bare minimum length (6) with no complexity requirements at all, so
  none were added (task spec: "Only add stronger complexity requirements
  if the current project already uses them" - it does not).
  `MIN_PASSWORD_LENGTH` stays at its existing value, 6, unchanged (raising
  it would retroactively make an already-registered password's original
  length "too short" the next time that same person tries to set a new
  one). `MAX_PASSWORD_LENGTH` (128) is new - the previous policy had no
  ceiling at all. Known, pre-existing, undocumented-until-now limitation:
  bcryptjs silently truncates any input over 72 bytes before hashing -
  true for every password this project has ever hashed, not something
  DOC-57 introduced or fixes.
- **`mustChangePassword`** (`models/User.js`, new field, default `false`)
  - `true` only immediately after a Manager reset; cleared back to
  `false` only by a successful self-change. Every pre-DOC-57 account
  simply defaults to `false` the first time it is loaded (no migration
  needed, the same pattern `specialties`/`attachments` already
  established). System-created initial Manager accounts (`assignManager`/
  `replaceManager` in `organization.controller.js`) deliberately keep
  their existing behavior and do NOT set this to `true` - task spec
  explicitly permits skipping this, and changing it was judged higher-
  risk than valuable for this task's scope.
- **Forced-change backend enforcement**
  (`middleware/requirePasswordChangeCompleted.js`, NEW) - reads
  `req.user.mustChangePassword` (populated fresh on every request by
  `middleware/auth.js`'s `verifyToken`, never trusted from the JWT
  payload) and returns 403 for any route it is composed into while that
  flag is `true`. Composed immediately after `verifyToken` (before any
  `requireRole`/organization check, since this gate is role-agnostic) on
  every protected route in `organization.routes.js`, `user.routes.js`,
  `serviceCategory.routes.js`, and `request.routes.js` - including every
  route registered ahead of a router's own blanket role gate (the same
  "pre-gate" routes DOC-12/13/52/53/56 already established). The two
  explicit exceptions - `GET /api/auth/me` and
  `PATCH /api/auth/change-password` - both live on `auth.routes.js` and
  simply never have this middleware composed into their chain at all.
  This is real backend enforcement, not just a frontend redirect: even a
  crafted request straight to a normal endpoint with a valid, unexpired
  token is rejected while the flag is `true`.
- **Login/JWT behavior** - login always succeeds regardless of
  `mustChangePassword` (task spec: "login still succeeds"); the sanitized
  login response now always includes `mustChangePassword` so the frontend
  can redirect appropriately. No token revocation or session table was
  built (task spec explicitly rules this out) - because `verifyToken`
  already re-reads the User document fresh on every single request
  (DOC-38), a Manager reset takes effect on the target's very next
  request with NO re-login required, and a successful self-change clears
  the block for the SAME still-valid JWT immediately, also with no
  re-login or token refresh required. This was verified directly in the
  test suite (a forced-change user's token is blocked, then the exact
  same token succeeds on the exact same route immediately after that
  user's own self-change, with zero token manipulation in between).
- **Safe response changes** - `sanitizeUser` (`auth.controller.js`) now
  always includes `mustChangePassword` (never conditional, like
  `attachments` was for DOC-45) - harmless for every pre-DOC-57 response
  shape. Still never returns `passwordHash`, a raw/new/reset password, a
  bcrypt salt, or any other internal Mongoose metadata - unchanged
  guarantee, verified explicitly in the test suite for both the self-
  change and Manager-reset response shapes.
- **Frontend**:
  - `pages/ChangePassword.jsx` (NEW) - one shared page for every role,
    reachable at `/change-password`, used identically whether the visit
    is voluntary (Navbar link) or forced (`ProtectedRoute.jsx` redirect).
    Current/New/Confirm Password fields, client-side required/match/
    length checks for fast feedback, backend errors shown inline, submit
    disabled while pending, fields cleared after success, and a
    role-aware post-success redirect (`utils/roleRoutes.js`'s existing
    `destinationForRole`, reused unchanged). Never writes any password
    value to `localStorage` - everything lives in local component state
    only, discarded once the component unmounts or a successful
    submission clears it.
  - `components/ProtectedRoute.jsx` - after the existing role check, a
    new check redirects to `/change-password` whenever
    `user.mustChangePassword === true` AND the current path is not
    already `/change-password` itself (the explicit path check is what
    prevents a redirect loop, since `/change-password` is wrapped in this
    same component with no `roles` restriction). This is a UX convenience
    only - the real boundary is `requirePasswordChangeCompleted` on the
    backend, unaffected by anything this component does.
  - `pages/Login.jsx` - the post-login destination is now
    `/change-password` whenever the just-logged-in user's
    `mustChangePassword` is `true`, instead of their normal role
    dashboard (`postLoginDestination`, wrapping the existing
    `destinationForRole`).
  - `components/Navbar.jsx` - a new "Change Password" link, always
    visible to any authenticated user regardless of
    `mustChangePassword`. The normal dashboard link is hidden while
    `mustChangePassword` is `true` (task spec: avoid exposing an action
    that would just bounce the person straight back via
    `ProtectedRoute.jsx` anyway) - Logout remains available in every
    state.
  - `components/OrganizationUserRow.jsx` - a new "Reset Password" button/
    panel (New Password / Confirm Password fields), rendered only when
    the parent actually passes `onResetPassword` - `ManagerDashboard.jsx`
    only ever does this for Employee/Operator rows (task spec: never
    Manager rows, System Admin, or the Manager themselves) - this
    component structurally never renders any of those three anyway (see
    `UserRoleSection`'s own Employee/Operator-only grouping), so no
    additional guard was needed. After success: shows "Password reset
    successfully. The user must change it at the next login.", clears
    both fields immediately, and never re-displays or logs the chosen
    password anywhere.
- **Inactive-user reset policy** (documented choice, task spec's
  recommended option): a Manager MAY reset an inactive Employee/
  Operator's password. The target still cannot log in until reactivated
  (`middleware/auth.js`'s `isActive` check is completely independent of
  this endpoint) - reset never auto-reactivates an account, `isActive` is
  never written by `resetUserPassword`. Once eventually reactivated by a
  separate action (`PATCH /api/users/:id/status`), the target is forced
  through the change-password flow at their very next login, exactly like
  any other Manager-reset target - `mustChangePassword` was already set
  to `true` at reset time and is untouched by reactivation.
- **Error handling** - wrong current password on self-change: 401
  (documented choice - a genuine authentication failure, matching Login's
  own convention, not a 400 validation error). Confirmation mismatch: 400
  on both endpoints. Weak/invalid-format password: 400 on both endpoints
  (`validatePassword`'s own message). Cross-org or nonexistent reset
  target: identical 404 (DOC-38 anti-enumeration - a Manager cannot tell
  "doesn't exist" from "belongs to another Organization" from the
  response). Protected reset target (self/manager/system_admin): 403 -
  deliberately a DIFFERENT status than the 404 above, since the Manager
  already knows these accounts exist (they can see them, or know their
  own identity) - hiding that would serve no purpose and 403 is the more
  honest signal, consistent with every other `resolveManageableTarget`-
  based action already in this file. Malformed id: 400. No raw Mongoose
  errors, stack traces, or password values are ever included in any
  response or log line.
- **Tests** - `doc57.e2e.test.tmp.js` (temporary, deleted after the run):
  63 assertions covering model/validation defaults, the shared password
  validator's accept/reject boundaries (weak, non-string, overlong), the
  full self-change flow (all four roles, wrong current password,
  mismatch, same-old-new, weak, no passwordHash leak, protected-field
  injection with zero effect, mustChangePassword clearing), the full
  Manager-reset flow (Employee/Operator targets, old password stops
  working, new password logs in with mustChangePassword reported,
  inactive target resettable-but-still-inactive, self/manager/
  system_admin/cross-org targets all correctly rejected, every wrong-role
  caller rejected, unauthenticated rejected, inactive-Manager-caller and
  inactive-Organization-caller both blocked, malformed/nonexistent id,
  mismatch, weak password, no leak in response), the forced-change
  enforcement end-to-end (login still succeeds and reports the flag, GET
  /me and PATCH /change-password both allowed, four different
  role-specific normal routes all blocked, and - critically - the SAME
  JWT reaching a normal route successfully immediately after that same
  token's own self-change, with no re-login), and a regression sweep
  across DOC-9/33 (login), DOC-11/36/37/42/52 (each dashboard's base
  list call), DOC-48 (activate/deactivate), DOC-52 (assignment), DOC-53
  (statistics), DOC-54 (search/filter), DOC-56 (completion image
  upload), DOC-59 (manager close), and organization isolation. All 63
  passed.
- **Frontend-only verification note**: the redirect-loop-avoidance and
  role-aware post-success-redirect behavior (items 52-54 of the task's
  own testing list) are UI navigation logic with no backend
  counterpart to exercise through this project's Node-based E2E harness
  (there is no browser/DOM test runner in this codebase) - these were
  verified by code review (`ProtectedRoute.jsx`'s explicit path check,
  `ChangePassword.jsx`'s `destinationForRole` call) and by the frontend
  production build succeeding with no errors, the same verification
  depth every prior frontend-only claim in this project's test reports
  has used.

## Duplicate Request Detection (DOC-58)

**Goal**: when an Employee creates a new Request, automatically warn them
if a very similar OPEN Request already exists in their own Organization,
without ever silently blocking a legitimate one. No AI, ML, embeddings,
Elasticsearch, notifications, SLA, or chat - deterministic string
comparison only.

- **When it runs** - exclusively inside `POST /api/requests`
  (`createRequest`, `controllers/request.controller.js`), AFTER every
  other field validation (title/description/categoryId/priority) has
  already passed and BEFORE `Request.create()` actually runs. It never
  runs during edit (`PATCH /api/requests/:id`, DOC-46) - that endpoint is
  completely untouched by this task.
- **Matching algorithm** (the one, documented, deterministic choice - see
  `utils/duplicateRequestDetection.js`'s own top comment for the full
  writeup): both titles are normalized identically (trim, lowercase,
  strip all non-letter/non-number characters via a Unicode-aware regex,
  collapse whitespace, trim again), then classified as:
  1. **exact** - the two normalized titles are identical.
  2. **contains** - one normalized title is a substring of the other, in
     either direction (`"wifi down"` matches `"wifi down on second
     floor"`).
  3. **overlap** - neither of the above, but at least 60% of the
     SHORTER title's own distinct words also appear in the other title
     (`matching words / MIN(setA.size, setB.size)`, deliberately not the
     union/Jaccard index - a short, generic title should not be diluted
     by a longer candidate's extra words).

  Only the **title** is compared - the task spec explicitly lists
  description as optional, and it is left out to keep the one algorithm
  simple, deterministic, and easy to test.
- **Scope** - always scoped to `req.user.organizationId` AND the exact
  same `categoryId` as the new Request, both enforced at the database
  query level (never filtered client-side afterward). A Request in a
  different Organization or a different Category is never compared,
  no matter how similar its title is.
- **Only active statuses** - candidates are restricted to
  `open`/`in_progress`/`reopened` (`ACTIVE_DUPLICATE_STATUSES`).
  `resolved`/`closed`/`cancelled` Requests are completely invisible to
  this check.
- **Endpoint behavior (Option A, the task spec's recommended shape)** -
  if one or more candidates match, `createRequest` returns **409
  Conflict** with `{ status: 'error', message, duplicateDetected: true,
  duplicates: [...] }` and does **not** create the Request. Each entry
  in `duplicates` is exactly `{ id, title, status, createdAt, createdBy:
  { fullName } }` - nothing else about the candidate (never its
  description, attachments, or any other field) is exposed. The backend
  never rejects outright on its own judgment - "the frontend decides"
  (task spec), by asking the Employee and re-submitting if they still
  want to proceed.
- **Force-create flow** - the Employee's confirmed retry sends the exact
  same payload again with `forceCreate: true` (or the string `"true"`,
  since this endpoint is multipart-capable since DOC-45 and Multer
  always sends text fields as strings). When set, `createRequest` skips
  duplicate detection for that one call only and proceeds straight to
  the same validation + creation path every other Request already goes
  through. **Only duplicate detection may be skipped this way** - title/
  description/category/priority validation runs identically whether or
  not `forceCreate` is set (verified directly by test #22 below: a too-
  short title with `forceCreate: true` still gets rejected).
- **Files created**: `utils/duplicateRequestDetection.js` (the one
  shared helper - `findDuplicateRequests`, `normalizeText`,
  `ACTIVE_DUPLICATE_STATUSES`, `WORD_OVERLAP_THRESHOLD`).
- **Files modified**: `controllers/request.controller.js` (wired into
  `createRequest`, reusing the pre-existing `buildCreatorMap` helper -
  originally built for DOC-52's listing endpoints - to resolve each
  candidate's `createdBy.fullName` rather than writing a second,
  parallel creator-lookup function); `frontend/src/services/api.js`
  (the shared `request()` helper now attaches `.status` and `.data`
  onto every thrown `Error`, so callers can distinguish a 409 duplicate
  conflict from any other failure without a second fetch wrapper);
  `frontend/src/pages/Dashboard.jsx` (Employee Dashboard only - see
  below); `frontend/src/index.css` (new modal/overlay styling, built
  from this project's existing design tokens since no modal styling
  existed anywhere in this codebase before now).
- **Frontend changes** (Employee Dashboard only, task spec: "Frontend:
  Employee Dashboard only") - "Open New Request"'s submit handler was
  refactored into a shared `submitCreateRequest(forceCreate)` function,
  called both by the form's normal submit (`forceCreate: false`) and by
  the new dialog's "Create Anyway" button (`forceCreate: true`), so the
  actual `POST /api/requests` call and its `FormData`-building exist in
  exactly one place. On a 409 with `duplicateDetected: true`, a modal
  dialog appears showing each candidate's title, status
  (`RequestStatusBadge`, reused unchanged), created date, and creator's
  full name, with **Cancel** (dismisses the dialog, no request sent) and
  **Create Anyway** (resubmits with `forceCreate: true`) buttons. The
  dialog is dismissed automatically on a successful creation, on
  Cancel, or when the Employee opens a brand-new "Open New Request"
  form.
- **Security** - only duplicate detection is ever skippable via
  `forceCreate`; every other protection is completely unaffected:
  `organizationId`/`createdBy`/`status`/`assignedOperatorId` are still
  never read from `req.body` (DOC-10's original explicit-construction
  pattern, untouched); the Category lookup is still scoped and
  active-only; any uploaded images are still cleaned up
  (`cleanupUploadedFiles`) on a duplicate-conflict response, exactly
  like every other rejection path in `createRequest`, so a blocked
  attempt never orphans a file on disk; a duplicate candidate response
  never exposes any field beyond the documented five, never another
  Organization's data (enforced at the query level, not filtered after
  the fact).
- **Tests** - `doc58.e2e.test.tmp.js` (temporary, deleted after the
  run): 39 assertions covering exact duplicate (plain and
  case/punctuation/whitespace-insensitive), near-duplicate via
  "contains" and via word-overlap, a dissimilar title correctly NOT
  flagged, identical title in a different Category not flagged,
  identical title in a different Organization not flagged,
  resolved/closed/cancelled candidates all ignored while
  in_progress/reopened candidates still correctly flag, `forceCreate`
  as both a real boolean and the string `"true"`, `forceCreate` NOT
  bypassing ordinary field validation, title/description/categoryId/
  priority validation all unchanged, cross-org isolation in both
  directions (an Org B Employee's own duplicate check working
  correctly, and an Org A Employee never being affected by Org B's
  data), the exact `duplicates[]` response shape (`id`/`title`/
  `status`/`createdAt`/`createdBy` and nothing else), and a regression
  sweep spot-checking DOC-10 (plain creation), DOC-45 (zero-attachment
  creation), DOC-46/DOC-11 (get-by-id), DOC-54/DOC-11 (list "My
  Requests"), DOC-52 (Manager-only route still rejects an Employee
  token), DOC-53 (statistics endpoint), DOC-57 (a `mustChangePassword`
  Employee is still blocked from `POST /api/requests` by the existing
  forced-change gate), and DOC-59 (Manager-only `/:id/manager/cancel`
  still rejects an Employee token). All 39 passed.
- **Frontend-only verification note**: "Frontend modal" and "Frontend
  build" (two items on the task's own testing list) have no backend
  counterpart to exercise through this project's Node-based E2E
  harness - verified by code review of `Dashboard.jsx`'s new dialog
  JSX/handlers and by `npx vite build` completing with no errors, the
  same verification depth every prior frontend-only claim in this
  project's test reports has used.

## Request SLA and Due Dates (DOC-55)

**Goal**: give every Request a clear, deterministic SLA deadline (v1:
continuous clock time - no working hours, weekends, holidays, or paused
clocks). No notifications, email reminders, escalation workflows,
auto-assignment, chat, new roles, or new statuses.

- **SLA policy** (`utils/slaPolicy.js`, the ONE source of truth - no
  controller/route/frontend file hardcodes an hour count):
  `SLA_HOURS_BY_PRIORITY = { high: 4, medium: 24, low: 72 }`.
  `calculateSlaDueAt({ priority, createdAt })` is the one place
  "priority + creation time -> deadline" is computed; every caller
  (creation, Manager priority-change, Employee priority-change, the
  migration script) goes through this exact function.
- **Clock-start policy**: the SLA clock starts at Request creation.
  `createRequest` computes `createdAt` explicitly (rather than leaving it
  to Mongoose's automatic timestamp) so the exact same instant is used
  both as the document's own `createdAt` and as the base
  `calculateSlaDueAt` computes `slaDueAt` from - the two can never
  silently disagree.
- **Request model changes**: `slaDueAt` (Date, required for new
  documents), `slaPolicyHours` (Number, required for new documents),
  `slaBreachedAt` (Date, default null - reserved for a LATER scheduled-
  job/notification task, never written by this version at all),
  `resolvedAt`/`closedAt` (Date, default null). **Compatibility policy**
  (documented choice, the task spec's own recommended option): these
  fields are only ever `required` at SAVE time - Mongoose's `required`
  validator never runs retroactively against documents already persisted
  before DOC-55, so every pre-existing Request simply has no
  `slaDueAt`/`slaPolicyHours` at all and remains perfectly readable
  (`sanitizeRequest`'s `sla` field reports a safe `null` - "SLA not
  available" - for exactly this case) until the optional one-time
  migration script is deliberately run against it.
- **Creation behavior**: `createRequest` always computes and stores
  `slaPolicyHours`/`slaDueAt`/`slaBreachedAt: null`/`resolvedAt: null`/
  `closedAt: null` server-side - none of these five fields is ever read
  from `req.body`, regardless of what a payload contains (test #7:
  injected `slaDueAt`/`slaPolicyHours`/`slaBreachedAt`/`resolvedAt`/
  `closedAt` values on create have zero effect on the actual response).
- **Priority-change behavior**: both the Manager's combined edit endpoint
  (`PATCH /api/requests/:id/manager`, DOC-59) and the Employee's own edit
  endpoint (`PATCH /api/requests/:id`, DOC-46 - the task's priority-
  change section only names DOC-59, but DOC-46 also permits editing
  `priority` while `open`, so it must recalculate too or `priority` and
  `slaPolicyHours`/`slaDueAt` would silently fall out of sync) recalculate
  `slaPolicyHours`/`slaDueAt` from the Request's **original** `createdAt`
  whenever `priority` actually changes - never from "now" (task spec:
  "Managers must not gain extra SLA time by repeatedly changing
  priority."). This can immediately make a Request overdue (worked
  example verified directly by test #17) - `isOverdue` is purely computed
  from `status` + `slaDueAt`, so no separate "mark overdue" step is
  needed. A historical, pre-DOC-55 Request with no SLA data at all is
  opportunistically brought up to date the first time its priority is
  ever touched (a reasonable, low-risk side effect, not a requirement).
  **Category changes never touch SLA** - `managerUpdateRequest`'s
  `categoryId` branch never writes `slaDueAt`/`slaPolicyHours` (test #18).
  Editing priority/category on a resolved/closed/cancelled Request still
  follows the exact, unmodified DOC-59 terminal rules (`closed`/
  `cancelled` blocked entirely; `resolved` remains editable) - SLA
  recalculation on an already-resolved Request never makes it "overdue"
  again, since `isOverdue` only ever applies to open/in_progress/reopened.
- **Status-transition behavior** (`updateRequestStatus` and the dedicated
  `managerCloseRequest` endpoint): `resolvedAt` is set to server time the
  first time `status` becomes `'resolved'` (guarded by "if not already
  set" - defensive only, since the sole path that reaches `'resolved'` is
  `in_progress -> resolved`, which by definition means it was null going
  in); `resolved -> reopened` clears `resolvedAt` back to `null` while the
  original `slaDueAt` is left completely untouched - if "now" is already
  past that deadline, the Request is immediately overdue again, entirely
  as a side effect of `reopened` being an active SLA status, with zero
  extra code; `closedAt` is set the first time `status` becomes
  `'closed'` (from either the generic status endpoint or the dedicated
  Manager close endpoint), and `resolvedAt` is never touched by that
  branch, so it is preserved automatically. Cancellation (`cancelMyRequest`/
  `managerCancelRequest`) never writes to any SLA field at all - "SLA
  stops" is achieved structurally, by `cancelled` simply never being a
  member of `ACTIVE_SLA_STATUSES`.
- **Overdue calculation** (`computeSlaSummary`, `utils/slaPolicy.js`):
  `isOverdue = (status is open/in_progress/reopened) AND (now > slaDueAt)`
  - computed fresh on every read from real server time, NEVER stored or
  trusted from a prior calculation. `overdueByMinutes` is 0 when not
  overdue; `remainingMinutes` is never negative (pinned at 0 once
  overdue). **SLA breach recording policy** (documented choice, the task
  spec's own preferred/"safer" option): `slaBreachedAt` is NOT
  auto-populated by this version at all - silently writing on an ordinary
  GET/read was explicitly flagged by the task spec as the riskier choice;
  `slaBreachedAt` stays optional/null on every Request until a later,
  dedicated scheduled-job/notification task (out of scope here - "Do not
  add background schedulers").
- **Safe response shape**: `sanitizeRequest` adds `sla`, either `null`
  (historical Request with no `slaDueAt`) or
  `{ policyHours, dueAt, isOverdue, overdueByMinutes, remainingMinutes,
  resolvedAt, closedAt }` - `slaBreachedAt` and every other internal-only
  field are never exposed (test #13 verifies the exact key set).
- **Search/filter/sort integration** (`utils/requestQueryBuilder.js`,
  extending DOC-54): a new `slaStatus` filter (`all` (default) /
  `overdue` / `due_soon` / `on_track` / `unavailable`), validated against
  an explicit allowlist (`utils/slaPolicy.js`'s `SLA_STATUS_VALUES` - an
  unrecognized value is rejected with 400, never silently ignored), and a
  new `slaDueAt` `sortBy` value. Every one of the four real `slaStatus`
  buckets is restricted to a still-**active** SLA status
  (open/in_progress/reopened) that already has a `slaDueAt` - mirroring
  `computeSlaSummary`'s own "isOverdue only applies to an active status"
  rule exactly, so a stat card and its equivalent filtered list can never
  silently disagree; only a genuinely historical Request with no
  `slaDueAt` at all matches `unavailable`. `slaDueAt` sorting is computed
  IN-MEMORY (like DOC-54's existing `priority`/`status` sorts) rather than
  a plain MongoDB `.sort()`, specifically so Requests without a due date
  can be forced to sort LAST in **either** direction (task spec) - a plain
  field sort cannot express that (Mongo's own comparison order treats a
  missing field as the lowest value, so ascending would put them FIRST).
  Role scope itself is completely unaffected by any of this - `slaStatus`/
  `slaDueAt` sort only ever ADD a restriction on top of the caller's own
  trusted, already-role-scoped base query, exactly like every other DOC-54
  filter.
- **Manager statistics** (`GET /api/requests/statistics/organization`):
  adds `sla: { overdueCount, dueSoonCount, slaComplianceRate,
  averageResolutionMinutes }`. **SLA Compliance Rate** definition (task
  spec's own): eligible completed Requests are `status` in
  resolved/closed AND real SLA data (`slaDueAt` AND `resolvedAt` both
  present); compliant means `resolvedAt <= slaDueAt`; the rate is
  `compliant / eligible * 100`, or `null` (never a misleading 0%) when
  there are zero eligible Requests (test #50). Cancelled Requests are
  structurally excluded (their status is never resolved/closed);
  historical Requests without SLA data are excluded by the `slaDueAt`
  check. **Average Resolution Time** definition (task spec's own): every
  Request with both `createdAt` and `resolvedAt`, excluding cancelled -
  deliberately NOT restricted to a specific current status (a
  resolved-then-reopened-then-resolved-again Request still has a
  meaningful, real `resolvedAt`); `null` when nothing is eligible, never
  `0`. Both numbers are computed IN-MEMORY from the same `scopedDocs`
  array `computeRequestStatistics` already fetches for `byCategory` - no
  second/third database round trip.
- **Operator statistics** (`GET /api/requests/statistics/assigned`): adds
  `sla: { overdueCount, dueSoonCount }` (no compliance rate/average
  resolution time - Manager-only), scoped to only this Operator's assigned
  Requests via the exact same `baseQuery` every other number on that
  response already uses.
- **Employee statistics** (`GET /api/requests/statistics/mine`): adds
  `sla: { overdueCount }` only (task spec: "My Overdue Requests" - no
  `dueSoonCount` on this one response), scoped to only this Employee's own
  Requests.
- **System Admin**: unchanged and untouched - none of the three
  statistics endpoints was ever reachable by a `system_admin` token before
  DOC-55 (each is gated to exactly one of employee/operator/manager in
  `routes/request.routes.js`), so System Admin continues to receive no
  operational SLA data at all (still a 403 on all three - test #55).
- **Migration script** (`scripts/migrateRequestSla.js`, `npm run
  migrate:request-sla`): an OPTIONAL, idempotent, one-time backfill for
  Requests missing `slaDueAt` entirely - computes `slaPolicyHours`/
  `slaDueAt` from each Request's own CURRENT `priority` and OWN
  `createdAt` (the exact same `calculateSlaDueAt` every live code path
  uses), never overwrites a Request that already has SLA data (the query
  filter itself, `slaDueAt: { $exists: false }`, makes an already-migrated
  Request structurally unreachable), never invents a `resolvedAt` for an
  already-resolved/closed historical Request with none on record (task
  spec), and safely SKIPS (reports, never guesses) a legacy document with
  an unsupported/invalid `priority`. Never runs automatically on server
  startup.
- **Manager Dashboard changes**: a new "SLA" column
  (`RequestSlaBadge.jsx`) in the Organization Requests table showing the
  due date, a status badge (On Track/Due Soon/Overdue/Completed On
  Time/Completed Late/SLA Unavailable), and remaining/overdue duration;
  four new stat cards (Overdue, Due Soon, SLA Compliance, Average
  Resolution Time - `N/A` rather than a misleading number when nothing is
  eligible yet); a new SLA-status filter and `slaDueAt` sort option in the
  shared search controls. Since `handleManagerUpdateRequest` already
  refreshes both the real Request list AND statistics after every
  priority/category/operator edit (pre-existing DOC-59 wiring, unchanged),
  a priority change automatically shows the recalculated SLA with no new
  wiring needed.
- **Operator Dashboard changes**: the same new SLA column
  (`RequestRow.jsx`, shared with the Employee Dashboard,
  `viewerRole="operator"`) and two new stat cards (Overdue, Due Soon).
  Urgency is visually emphasized via the badge's own color coding (red
  overdue / amber due soon / green on track) rather than a separate
  highlighting mechanism; the existing default sort (`createdAt desc`) is
  completely unchanged unless the Operator explicitly selects the new SLA
  sort option.
- **Employee Dashboard changes**: the same shared SLA column
  (`RequestRow.jsx`, `viewerRole="employee"`, labeled "Target resolution
  time" per the task's own suggested wording - never phrased as a
  guarantee) and one new stat card ("My Overdue Requests").
- **`RequestSlaBadge.jsx`** (new, shared by all three dashboards - "do not
  duplicate badge logic across three dashboards"): accepts the already-
  sanitized `sla` object and the Request's own `status`; never calculates
  a trusted deadline itself. Renders one of the six documented badge
  states, plus a human-readable duration ("3h 20m remaining" / "45m
  overdue" / "2d 4h remaining" - no date library). Cancelled Requests
  display "SLA Unavailable" (a documented choice - SLA tracking stops for
  cancelled work, and neither "overdue" nor "on-time/late" is a meaningful
  label for it) while still showing the original target date for
  historical reference. **Refresh policy** (documented choice): no
  internal `setInterval`/countdown - the badge always renders the last-
  fetched `sla` data and refreshes naturally on every dashboard reload
  that already happens after a mutating action; no background poller was
  added (task spec explicitly rules out background schedulers elsewhere
  in this ticket).
- **Timezone policy**: every date is stored and calculated in UTC
  (`Date`/Mongoose `Date` fields are UTC internally regardless of server
  locale - verified directly by test #6, which checks the serialized
  `sla.dueAt` ends in `"Z"`). The frontend formats these in the browser's
  own local timezone for display only (`toLocaleString()`) - never a
  stored or calculated value. No organization-specific timezone setting
  exists.
- **Security**: `slaDueAt`/`slaPolicyHours`/`slaBreachedAt`/`resolvedAt`/
  `closedAt`/`isOverdue` are never settable by a client on any endpoint -
  creation and both priority-change endpoints construct these fields
  explicitly server-side, never from `req.body` (test #7, #19).
  Organization isolation, Employee ownership scope, Operator assignment
  scope, and Manager own-Organization scope are all completely unchanged -
  every new filter/sort/statistic only ever narrows an already-scoped
  base query, never widens it (tests #38/#39/#46).
- **Tests** - `doc55.e2e.test.tmp.js` (temporary, deleted after the run):
  84 assertions covering the SLA policy table and `calculateSlaDueAt`
  (including invalid-priority rejection and real UTC serialization),
  creation for all three priorities plus client-injection rejection,
  Manager AND Employee priority-change recalculation (including "repeated
  edits never reset the clock" and "can immediately become overdue"),
  category-only edits leaving SLA untouched, the full status-transition
  matrix (resolved/reopened/closed/cancelled, each verified against
  `resolvedAt`/`closedAt`/`isOverdue`), overdue/due-soon/on-track/
  completed-on-time/completed-late/unavailable classification, the
  `slaStatus` filter for all four real values plus rejection of an invalid
  one, `slaDueAt` ascending/descending sort (including "missing values
  always sort last, both directions"), cross-organization exclusion,
  Manager/Operator/Employee statistics (including the null-compliance-rate
  and real-average-resolution-time cases), the migration script run
  directly (with a fake DB bootstrap and fake Request store) covering
  backfill/original-createdAt-anchoring/correct-policy/never-overwrite/
  idempotency/invalid-priority-skip/never-invent-resolvedAt, and a
  regression sweep across DOC-10, DOC-11, DOC-12, DOC-13, DOC-22, DOC-23,
  DOC-46, DOC-52, DOC-53, DOC-54, DOC-56, DOC-57, DOC-58, DOC-59,
  organization isolation, and an existing-session `GET /api/auth/me`
  check. All 84 passed. (One test-harness bug was found and fixed during
  authoring, not an application bug: the mocked `Request.find`'s query
  matcher originally short-circuited on a field with BOTH `$exists` and a
  `$lt`/`$gte` operator in the same object - exactly the shape
  `buildSlaStatusQuery` produces - returning as soon as `$exists` matched
  without ever checking the date comparison; fixed to evaluate every
  operator on a field as a single combined AND.)
- **Frontend-only verification note**: items 63-74 of the task's own
  testing list (SLA cards/badges rendering, duration display, priority-
  edit-refreshes-deadline, filter/sort control rendering, loading/error
  states, historical-unavailable handling, production build) have no
  backend counterpart to exercise through this project's Node-based E2E
  harness - verified by code review of `RequestSlaBadge.jsx`,
  `RequestSearchControls.jsx`, and all three dashboard files, and by
  `npx vite build` completing with no errors, the same verification depth
  every prior frontend-only claim in this project's test reports has
  used.

## Organization Chat (DOC-60)

A single, organization-wide text channel: every Manager, Operator, and
Employee in an Organization shares one chat with everyone else in that same
Organization. There is no System Admin participation, no private messages,
no multiple rooms/groups, no attachments, no reactions, and no edit/delete -
messages are immutable once sent. This is a deliberately separate feature
from Request Comments (DOC-13): Comments are scoped to one Request and
visible only to that Request's participants; Organization Chat is scoped to
the whole Organization and has nothing to do with any individual Request.

- **Audit finding**: no chat/message infrastructure existed anywhere in the
  project before this ticket, and no WebSocket infrastructure exists either
  (confirmed by inspecting `package.json` and `app.js`) - so, per the task's
  own Real-Time Policy, this feature uses simple polling rather than
  introducing WebSockets.
- **Model - `ChatMessage`** (`backend/src/models/ChatMessage.js`): exactly
  three meaningful fields - `organizationId` (ref `Organization`, required),
  `authorId` (ref `User`, required), `content` (String, required, trimmed,
  1-2000 characters) - plus Mongoose's own `createdAt`/`updatedAt`
  timestamps. No `roomId`, no `receiverId`, no `edited`/`deleted` flags, no
  read receipts, and no redundant copy of the author's name or role (always
  resolved live from `User` at read time, exactly like `Comment.js`
  already does for Request Comments). No separate "Chat" document/collection
  exists or is needed - a channel is simply "every `ChatMessage` with this
  `organizationId`"; an Organization with zero messages just renders an
  empty state.
- **Endpoints** (`backend/src/routes/chat.routes.js`, mounted at
  `/api/chat`):
  - `GET /api/chat/messages` - lists the caller's Organization's messages,
    oldest-first, paginated via `?before=<ISO timestamp>&limit=<1-100,
    default 50>`. An invalid `before` (unparseable date) or invalid `limit`
    (non-integer, or outside 1-100) returns `400`. A `limit` above 100 is
    **rejected**, not clamped - the same "reject a bad value loudly"
    convention this project already uses for DOC-54's status/priority/
    sortBy validation and DOC-55's `slaStatus` validation. Response:
    `{ status: 'success', data: [...], meta: { hasMore } }`.
  - `POST /api/chat/messages` - body is `{ content }` only; every other
    field (`organizationId`, `authorId`, `role`, `createdAt`, anything
    else) is silently ignored - `organizationId` always comes from
    `req.user.organizationId`, `authorId` always from `req.user.userId`.
    Rejects (`400`) empty, whitespace-only, or over-2000-character content.
    Returns `201` with the created message in the same safe shape as the
    list endpoint.
- **Authorization chain** (identical composition style to every other
  route file in this project - no second authorization system was
  created): `verifyToken` -> `requirePasswordChangeCompleted` ->
  `requireRole('manager', 'operator', 'employee')` ->
  `requireOrganizationMembership` -> `requireActiveOrganization`, applied
  via `router.use(...)` to both endpoints. This is the first route file in
  the project where `requireRole` is actually called with more than one
  role - previously only shown as a hypothetical example in that
  middleware's own comment header.
- **Organization isolation**: every query is built as
  `{ organizationId: req.user.organizationId, ... }`, where the
  `organizationId` always comes from the authenticated user's own JWT-
  derived record - never from the request body, query string, or route
  params. Messages are never loaded globally and filtered in memory.
- **Safe response shape**: `{ id, content, author: { id, fullName, role },
  createdAt, updatedAt }`. Raw `organizationId`/`authorId`, `passwordHash`,
  email, and Mongoose internals (`__v`, etc.) are never present. Author
  resolution batches every distinct `authorId` on a page into one
  `User.find({ _id: { $in: [...] }, organizationId })` call (never N+1),
  mirroring `comment.controller.js`'s existing `buildAuthorMap` pattern. A
  deactivated author's historical messages still show their real name and
  role (author lookup deliberately never filters by `isActive` - only the
  deactivated user's own ability to read/send is blocked, by the
  pre-existing `verifyToken` check). If an author document genuinely
  cannot be found (should not normally happen - Users are never hard-
  deleted in this project), the response falls back to
  `{ id: null, fullName: 'Unknown User', role: null }`.
- **Pagination**: fetches `limit + 1` documents sorted
  `{ createdAt: -1, _id: -1 }` (secondary key for stable ordering when two
  messages share a timestamp), uses the extra document only to cheaply
  detect `hasMore` without a second `countDocuments` call, then reverses
  the page into ascending order for the response. "Load older" on the
  frontend passes `before` as the oldest currently-loaded message's
  `createdAt`.
- **Real-time / polling**: no WebSockets (none exist in this project).
  `OrganizationChat.jsx` polls `GET /api/chat/messages` every 7 seconds,
  guarding against overlapping requests with a ref-based in-flight flag,
  and merges new results into existing state by `id` (via a `Map`,
  re-sorted by `createdAt` then `id`) rather than ever replacing or
  clearing the message list.
- **Frontend** (`frontend/src/pages/OrganizationChat.jsx`, routed at
  `/chat`): one shared page for Manager/Operator/Employee (no per-role
  variants) with a message history pane, a text input with a live
  2000-character counter, and a Send button disabled while empty,
  whitespace-only, over-limit, or a send is already in flight. A sent
  message is never faked locally before the server responds - the real
  `201` response is what gets merged into the list; on a failed send, the
  typed draft is preserved (not cleared) so nothing is lost. Scrolls to
  the newest message once on first load, and auto-scrolls on new messages
  only if the user was already near the bottom (so reading old history
  during a poll tick is never interrupted). A "Load Older Messages" button
  appears whenever the server reports `hasMore: true`; there is no
  infinite scroll. The "Organization Chat" Navbar link and the `/chat`
  route are both restricted to `manager`/`operator`/`employee` and are
  both hidden/blocked during a forced password change (DOC-57), reusing
  the same `mustChangePassword` guard and `ProtectedRoute` component every
  other route already uses - System Admin is redirected to `/admin`, the
  same "own dashboard" redirect every other wrong-role route visit
  already produces.
- **Inactive Organization / deactivated user behavior**: a deactivated
  user (DOC-48) gets `403` on both endpoints via the existing `verifyToken`
  check; a member of a deactivated Organization gets `403` via
  `requireActiveOrganization` - both are pre-existing middleware, unchanged.
- **No edit/delete**: messages are immutable - there are no `PATCH`/
  `DELETE` routes for chat messages at all.
- **No chat attachments**: the existing Request attachment upload routes
  (Multer-based) are never reused or referenced by chat in any way.
- **Rate limiting**: audited - this project has no rate-limiting framework
  anywhere. Per the task's own stated preference, production-grade rate
  limiting was deliberately deferred rather than bolted on as a mismatched
  one-off; this is a documented limitation, not an oversight.
- **Database indexes**: `{ organizationId: 1, createdAt: -1 }` (declared
  directly on the schema) supports both the list endpoint's per-organization
  query and its sort/pagination in one index.
- **Real database limitation**: this environment has no live MongoDB
  connection, so all behavior was verified through a mocked E2E harness -
  the model was intercepted with an in-memory fake for the HTTP-level
  tests, and validated separately and for real via Mongoose's own
  `validateSync()` (which needs no DB connection) for schema-level tests.
  No test was run against an actual MongoDB instance.
- **Test summary**: `backend/doc60.e2e.test.tmp.js` (temporary, deleted
  after this run) covered MODEL validation (valid message accepted;
  organizationId/authorId/content required; whitespace-only and over-2000-
  character content rejected; real timestamps confirmed via the live send
  response), SEND (Employee/Operator/Manager succeed; System Admin,
  unauthenticated, deactivated, inactive-Organization, orgless, and
  forced-password-change users all rejected; organizationId/authorId/role/
  createdAt injection all ignored; empty/whitespace/oversized content
  rejected; exact safe response shape; no passwordHash leakage), LIST (each
  role sees only their own Organization's messages; cross-organization
  isolation; the same five rejection cases as SEND; oldest-to-newest
  ordering; default limit of 50 with `hasMore`; a custom limit; the
  boundary at 100 accepted and 101 rejected; invalid `limit`/`before`
  rejected; `before`-based pagination returns strictly older messages only;
  a deactivated author's historical message keeps their real name; a
  message from a since-deleted author falls back to "Unknown User"; no
  `organizationId`/`passwordHash` ever present in the list response), and a
  regression sweep spot-checking DOC-27 (organization self-lookup), DOC-48
  (deactivate), DOC-52 (Operator Dashboard), DOC-53 (statistics), DOC-54
  (search/filter), DOC-55 (SLA field still present on created Requests),
  DOC-57 (forced password change still blocks unrelated routes), DOC-59
  (Manager Dashboard), organization isolation on Requests, and System Admin
  Organization management. All 60 assertions passed, 0 failed.
- **Frontend-only verification note**: the task's FRONTEND testing items
  (route rendering per role, Navbar link visibility, loading/empty/error
  states, send-uses-real-server-response, failed-send-preserves-draft,
  successful-send-clears-draft, polling start/stop and dedup-by-id, Load
  Older Messages, character-limit display, Send-disabled logic, no
  `dangerouslySetInnerHTML`) were verified by code review of
  `OrganizationChat.jsx`, `Navbar.jsx`, and `App.jsx`, and by `npx vite
  build` completing with no errors - the same verification depth every
  prior frontend-only claim in this project's test reports has used.

## GridFS Image Storage Migration

Request image attachments (DOC-45 Before Images, DOC-56 Completion
Images) moved from local-disk-only storage to **MongoDB GridFS** as their
storage backend. This was a compatibility-first migration: every existing
Sprint 1-5 feature (Request creation, editing, cancellation, assignment,
comments, SLA, search, statistics, duplicate detection, password
management, organization isolation, chat) keeps working exactly as
before, no existing uploaded file or attachment record was deleted, and
attachments created before this migration continue to work forever
without ever being migrated.

- **Why GridFS, and why not base64-in-MongoDB**: storing raw image bytes
  as a base64 string directly on the Request document was explicitly
  ruled out (bloats the document, breaks the existing 16 MB BSON
  document-size ceiling at scale, and makes the `attachments` array
  slower to load even when a caller only wants the metadata). GridFS
  stores each image as its own set of chunk documents in a dedicated
  bucket, referenced from the Request document by a small ObjectId
  (`fileId`) - the Request document itself stays exactly as small as it
  was before.
- **One bucket, no second connection**: `src/services/gridFsStorage.js`
  is the single, sole owner of all GridFS access in this project. It
  obtains a `GridFSBucket` (bucket name **`requestImages`**, so its
  underlying collections are `requestImages.files`/`requestImages.chunks`)
  via `mongoose.mongo.GridFSBucket`, reached through the SAME Mongoose
  connection `src/config/db.js` already opens - no second MongoDB
  connection is ever created. There is exactly one bucket for the whole
  application; there are no per-Organization or per-Request buckets. The
  bucket is created lazily (on first real use, after `connectDB()` has
  already run) and cached.
- **File metadata**: every GridFS file's own `metadata` field records
  `{ organizationId, requestId, attachmentType, uploadedBy }`, where
  `attachmentType` is always exactly `"before"` or `"completion"`. All
  four values are always derived server-side from `req.user`/the Request
  document being acted on - never trusted from the client.
- **Request attachment schema** (`models/Request.js`) - both
  `attachmentSchema` and `completionAttachmentSchema` gained a new
  optional field, `fileId` (ObjectId, references a file in the
  `requestImages` bucket). `storedName` (the legacy local-disk filename)
  is now optional instead of required - a NEW attachment never populates
  it, an attachment created before this migration still has it and no
  `fileId`. A `pre('validate')` hook on both schemas enforces that every
  saved attachment has at least one of the two storage references. `url`
  is likewise no longer required/trusted as a stored value - see below.
- **`url` is always computed dynamically**: `sanitizeRequest`
  (`controllers/request.controller.js`) no longer returns an attachment's
  own stored `url` field. Instead it always computes
  `/requests/:requestId/attachments/:attachmentId/content` fresh, for
  BOTH legacy and GridFS-backed attachments alike. This is what lets the
  frontend treat every attachment identically regardless of which storage
  backend actually produced it - it never needs to know about GridFS file
  ids, bucket names, chunk collections, or local filesystem paths at all.
- **Upload pipeline**: `middleware/upload.js` gained a second Multer
  instance, `uploadMemory` (`multer.memoryStorage()`), reusing the exact
  same `fileFilter`/`ALLOWED_MIME_TYPES`/`MAX_FILE_SIZE_BYTES` (5 MB)/
  `MAX_FILES_PER_REQUEST` (5) as the original disk-storage `upload`
  instance. `routes/request.routes.js` now wires every upload route
  (`POST /`, `POST /:id/attachments`, `POST /:id/completion-images`) to
  `uploadMemory` instead - a new upload's bytes exist only in
  `req.files[i].buffer` in memory, streamed straight to GridFS, and never
  touch local disk at all. The legacy `upload` (disk-storage) instance is
  still exported from `middleware/upload.js` unchanged, purely so nothing
  that still depends on reading a pre-migration local file breaks.
- **Before Image / Completion Image rules unchanged**: every DOC-45 rule
  (ownership, `open`+unassigned eligibility, 5-image cap, MIME/size
  limits) and every DOC-56 rule (assigned-Operator-only,
  `in_progress`-only, independent 5-image cap, resolve-requires-a-
  completion-image gate) still apply exactly as documented above - the
  migration only changed WHERE the bytes are stored, never WHO may
  upload/remove an image or WHEN.
- **Image delivery endpoint (new)**: `GET
  /api/requests/:requestId/attachments/:attachmentId/content` -
  authenticated (`verifyToken` + `requirePasswordChangeCompleted` +
  `requireOrganizationMembership` + `requireActiveOrganization`, the same
  chain every other cross-role Request endpoint uses), registered ahead
  of this router's blanket Employee-only gate so Employee, Operator, AND
  Manager tokens can all reach it (System Admin is explicitly rejected -
  403, no operational Request image access at all, same rule as every
  other Request endpoint). Looks the target attachment up inside EITHER
  `attachments` or `completionAttachments` on a Request the caller is
  independently authorized to view (Employee: only their own Request;
  Operator: only a Request assigned to them; Manager: any Request in
  their own Organization) - a nonexistent Request, a cross-Organization
  Request, and a nonexistent attachment id are all indistinguishable
  404s (the same DOC-38 anti-enumeration convention used everywhere
  else); an existing Request the caller simply isn't allowed to view is a
  403. Streams the image directly (GridFS `openDownloadStream` or a local
  `fs.createReadStream`, whichever storage reference the specific
  attachment has) - never buffers a whole file into memory, and only ever
  sets `Content-Type`/`Content-Length`, never GridFS bucket/chunk
  internals or a filesystem path.
- **Why not a plain `<img src>` to that endpoint**: this project has no
  cookie-based session - every API call authenticates via a JWT in an
  `Authorization: Bearer <token>` header (`frontend/src/services/api.js`),
  and a plain `<img src="...">` has no way to attach a custom header to
  its own request. The frontend's new `AuthenticatedRequestImage.jsx`
  component performs the authenticated `fetch()` itself, turns the
  response into a `Blob`, and renders a `URL.createObjectURL(blob)`
  instead (revoked on unmount/url change to avoid leaking memory across a
  gallery) - the JWT is never placed in a query string or any other
  weaker/permanent location. `RequestRow.jsx` (3 call sites) and
  `ManagerRequestRow.jsx` (2 call sites) were updated to use it in place
  of the old raw `<img src={...}>` markup; no other frontend file needed
  to change.
- **Legacy compatibility**: an attachment created before this migration
  (`storedName` set, `fileId` absent) is never migrated automatically and
  needs no server restart/backfill to keep working - the content-delivery
  endpoint above reads straight from local disk for it, exactly as the
  old `express.static` mount did. The old `/api/uploads/requests` static
  mount (`app.js`) is left in place, completely unused by any new
  response's `url` - a deliberate, low-risk "don't remove working code
  before its replacement is proven" choice, not an oversight.
- **Failure/rollback handling**: if a multi-file upload's GridFS write
  succeeds for file 1 but fails for file 2, only file 1's just-uploaded
  GridFS file is deleted (never anything from a previous, already-saved
  upload). If every file uploads successfully but the following
  `Request.create()`/`requestDoc.save()` fails, every GridFS file just
  uploaded for that one attempt is deleted before the error response is
  sent - no orphaned GridFS files are ever left behind by a failed
  request. Deleting an attachment (`removeRequestAttachment`/
  `removeCompletionImage`) always uses the fileId/storedName already
  stored on the AUTHORIZED Request's own attachment subdocument - never a
  client-supplied identifier - so it can never delete a file belonging to
  a different Request.
- **Migration script (optional, non-destructive)**:
  `backend/scripts/migrateRequestImagesToGridFs.js`
  (`npm run migrate:request-images-to-gridfs`) copies every remaining
  legacy (local-disk-only) attachment's bytes into GridFS and sets its
  `fileId`, while leaving `storedName`/`url`/every other field completely
  untouched and NEVER deleting the original local file. Idempotent (an
  attachment that already has a `fileId` can never be matched again on a
  later run); a missing local file or a failed upload is reported and
  skipped, never crashes the rest of the run; a `Request.save()` failure
  after a successful GridFS upload rolls back just that document's
  newly-uploaded GridFS files. This script is never run automatically -
  `src/server.js` never requires it.
- **File limits (unchanged)**: JPEG/PNG/WEBP only, 5 MB per image, 5
  images per Request per collection (Before and Completion Images have
  independent 5-image caps). Multer's `memoryStorage()` is safe to use
  given this existing 5 MB ceiling - no file is ever read into memory
  beyond what the original disk-storage path already accepted.
- **Cleanup behavior**: this migration deliberately does NOT delete
  `backend/uploads/requests/`, any historical image, or `.gitkeep` - the
  directory remains required for as long as any legacy attachment still
  references it (i.e. until every Organization has run the migration
  script AND a separate, deliberate future decision is made to remove
  local-disk support entirely). No file was deleted by this migration's
  own testing.
- **Known limitations / technical debt**: (1) the old unauthenticated
  `/api/uploads/requests` static mount still exists in `app.js` - safe
  (nothing advertises URLs pointing at it anymore) but not yet removed;
  removing it is a separate, later cleanup once every Organization's
  legacy attachments have actually been migrated. (2) There is currently
  no scheduled/automatic run of the migration script - it is a manual,
  explicit command. (3) GridFS chunk-level storage overhead (each file is
  split into 255 KB chunks by default) was not benchmarked against raw
  disk storage - not expected to matter at this project's scale, but not
  measured.
- **Real MongoDB / real GridFS limitation**: this sandboxed development
  environment has no outbound network access at all (confirmed directly -
  a DNS resolution attempt to the project's own MongoDB Atlas hostname,
  and even to a plain `google.com` lookup, both failed with
  `ECONNREFUSED`), so live GridFS persistence against the real project
  database was NOT exercised. `services/gridFsStorage.js` was instead
  tested against a fake, in-memory `GridFSBucket` substituted for
  `mongoose.mongo.GridFSBucket` (the exact same substitution point a real
  MongoDB driver instance would occupy) - this proves the service
  module's own logic (upload/download/find/delete, streaming, metadata
  handling, best-effort missing-file deletion) is correct, but does NOT
  by itself prove the real MongoDB Atlas GridFS integration behaves
  identically. This mirrors every other ticket in this project's session
  history, all of which disclosed the same sandbox limitation.
- **Test summary**: a temporary E2E suite (`backend/gridfs.e2e.test.tmp.js`,
  deleted after this run) combined the project's established mocked-model
  HTTP harness (`Module._load` interception, real unmodified `src/app.js`
  served via `http.createServer` + native `fetch`) with the fake-GridFSBucket
  substitution described above, covering: GridFS Storage (upload/download
  roundtrip byte-for-byte, findFile metadata, delete, best-effort delete of
  an already-missing file, correct bucket name - 9 checks); Before Images
  (multi-image creation, response never leaks `fileId`/`storedName`, GridFS
  actually receives the files, owner can view, a different same-org
  Employee is rejected 403, adding more images to an existing Request - 9
  checks); Completion Images (non-assigned Operator rejected, assigned
  Operator succeeds, `uploadedBy` correct, Manager/Employee(owner) can view,
  cross-org Manager gets 404, System Admin gets 403, remove deletes the
  GridFS file - 12 checks); Failure Cleanup (a simulated `Request.create()`
  failure and a simulated `requestDoc.save()` failure each roll back
  exactly the GridFS file(s) that attempt just uploaded, with zero orphans
  left behind - 4 checks); Legacy Compatibility (a hand-seeded
  `storedName`-only/no-`fileId` attachment still gets a normal content URL,
  streams correctly from local disk, and removing it deletes the local file
  rather than attempting a GridFS lookup - 6 checks); and a Regression sweep
  (unauthenticated access still 401, DOC-13 comments route still reachable,
  DOC-12 status route still wired, Employee/Manager/Operator list and
  statistics endpoints unaffected, organization isolation still holds on
  the new image endpoint, malformed/nonexistent ids handled cleanly, the
  legacy disk-storage Multer instance and static mount are both still
  exported/present, and the full backend module graph still loads cleanly
  - 15 checks). **All 55 assertions passed, 0 failed.**
- **Frontend build verification**: `npx vite build` completed with no
  errors after adding `AuthenticatedRequestImage.jsx` and updating
  `RequestRow.jsx`/`ManagerRequestRow.jsx` - same verification depth as
  every prior frontend change in this project.

## Security & HTTPS

This section explains the password-security model end to end, and the
transport-security (HTTPS/TLS) architecture added on top of it. It exists
because of a real question that came up during review: "why can I see my
own password in DevTools → Network → Login → Payload?"

### 1-3. Why the password appears in your own DevTools, and why that's not a leak

When you type a password into the Login form and submit it, your
browser builds the actual HTTP request your own click just triggered -
and DevTools lets you inspect requests *your own browser* made. This is
true of every website with a password field, not something specific to
this project, and it is not a bug: DevTools can only ever show you
*your own* browser's own traffic to and from the server it's currently
talking to. It cannot show you anyone else's traffic. **This is
deliberately not "fixed"** - not hidden, obfuscated, Base64-encoded, or
hashed client-side - because none of those would add real security
(see point 4 below) and all of them would make debugging harder for no
benefit.

The actual risk the instructor was pointing at is different: **could
someone ELSE, on the same network, read that same password while it
travels from your browser to the server?** Over plain HTTP, yes -
that's exactly what a packet-capture tool like Wireshark is for. That
is the problem HTTPS/TLS solves.

### 4. Why client-side password hashing/encryption was NOT implemented

It was considered and deliberately rejected, for the same reason
security professionals generally reject it: hashing or "encrypting" the
password in the browser before sending it (SHA256 in React, AES with a
key embedded in the frontend bundle, Base64, a custom cipher) does not
protect it from network interception - the transformed value becomes
the new "password" an attacker just needs to capture and replay, and
because the frontend's source is always downloadable by anyone, any key
or algorithm baked into it is not a secret at all. **The correct,
standard fix for network interception is HTTPS/TLS**, which encrypts
the entire connection (not just the password field) using a proper key
exchange the browser and server negotiate fresh for every connection -
not a project-specific implementation detail. This project's actual
architecture is:

```
Browser  --(HTTPS/TLS, when configured)-->  Backend  -->  bcrypt.compare()  -->  MongoDB passwordHash
```

### bcrypt storage architecture

Every password-creation and password-change path in this project (public
registration, Manager/Organization-manager creation, Manager password
reset, self password change, and the System Admin bootstrap script) goes
through the same `bcrypt.hash(password, SALT_ROUNDS)` call
(`SALT_ROUNDS = 10`, exported once from `controllers/auth.controller.js`
and reused everywhere else - never a second, parallel hashing
implementation). MongoDB's `User` documents only ever contain
`passwordHash` - there is no `password` field on the schema at all, so a
plaintext password cannot be accidentally persisted even by a bug
elsewhere in the codebase. Login (`bcrypt.compare`) and Change Password
both compare against this same field.

### JWT behavior

A JWT is issued only at login, signed with `JWT_SECRET`
(`jsonwebtoken`), and its payload contains exactly `{ userId, role,
iat, exp }` - never a password, a password hash, or any other secret.
`organizationId` and the account's active/must-change-password status
are deliberately NOT put in the token at all: `middleware/auth.js`
re-reads them from MongoDB on every request instead, so a token cannot
go stale if a user's role, Organization, or active status changes after
it was issued (see that middleware's own comment for the full
reasoning). Expiry (`JWT_EXPIRES_IN`, default `1h`) is unchanged by this
hardening pass.

### Password response restrictions

Every endpoint that returns a User - Login, Register, `GET /auth/me`,
the Manager user-management list, Change Password, and Manager Password
Reset - passes its result through the same `sanitizeUser()` function
(`controllers/auth.controller.js`), which returns only
`id/fullName/email/role/organizationId/isActive/mustChangePassword/
createdAt`. `passwordHash` is structurally never included in any of
these response shapes; there is one function that decides the safe
response shape, not one per endpoint, so a future endpoint cannot
accidentally leak it by forgetting to strip it manually.

### Environment secret handling

`backend/.env` (real `MONGODB_URI`, `JWT_SECRET`, and - only during
first-time bootstrap - `SYSTEM_ADMIN_PASSWORD`) is gitignored and was
never committed. `backend/.env.example` and `frontend/.env.example`
contain placeholder values only. `SYSTEM_ADMIN_PASSWORD` is read exactly
once, only by `scripts/seedSystemAdmin.js`, only when no System Admin
account exists yet - normal server startup (`src/server.js`) never reads
it, so it is safe to delete from `.env` immediately after the first
bootstrap. See this repo's own git history/prior security-audit reports
for the full original writeup of this behavior - unchanged by this
pass, only re-verified.

### Local development HTTP/HTTPS behavior

By default, nothing changes: `npm start` (backend) serves plain
`http://localhost:5000`, and `npm run dev` (frontend) serves plain
`http://localhost:5173`, exactly as before this hardening pass. This is
expected and safe for same-machine local development, where "the
network" is just your own loopback interface.

Optional local/LAN HTTPS is available for both sides, entirely opt-in:

- **Backend**: set `HTTPS_ENABLED=true` plus `SSL_CERT_PATH`/
  `SSL_KEY_PATH` (see `backend/.env.example`) pointing at a local
  certificate/key pair (e.g. one generated with `mkcert` or `openssl`).
  `src/server.js` then serves HTTPS directly via Node's own `https`
  module instead of `http`. Missing or unreadable cert/key files cause a
  clear, fast startup failure (checked BEFORE the MongoDB connection
  attempt) rather than a silent fallback to plain HTTP.
- **Frontend**: set `DEV_HTTPS_ENABLED=true` plus `DEV_SSL_CERT_PATH`/
  `DEV_SSL_KEY_PATH` in `frontend/.env` (see `frontend/.env.example`).
  `vite.config.js` reads these directly (never `VITE_`-prefixed, since
  they configure the dev server itself, not the browser bundle) and
  enables Vite's own HTTPS dev-server mode.

### Production HTTPS expectations

Two architectures are supported:

```
A) Reverse proxy / hosting platform terminates TLS (recommended):
   Internet --HTTPS--> [nginx / Render / Railway / etc.] --HTTP--> Express

B) Express terminates TLS directly (no proxy in front):
   Internet --HTTPS--> Express (HTTPS_ENABLED=true)
```

Architecture (A) is preferred whenever the hosting platform already
provides it - Express keeps speaking plain HTTP on its own internal
network, which is simpler and lets the platform handle certificate
renewal. In that case, leave `HTTPS_ENABLED` unset and instead set
`TRUST_PROXY` (see `.env.example`) so `req.secure`/forwarded-proto
detection works correctly, and set `FRONTEND_ORIGIN` to the real
deployed frontend's `https://` origin (CORS). `FORCE_HTTPS=true` can
then be enabled to redirect any plain HTTP request that still reaches
the app to HTTPS - it is a no-op unless explicitly turned on, and
exempts `/api/health` so uptime checks never get redirected into a
failure. `HSTS_ENABLED=true` should only be turned on once HTTPS is
confirmed working for every visitor (HSTS is sticky in the browser).

Architecture (B) is for a deployment with no reverse proxy at all - set
`HTTPS_ENABLED=true` plus the certificate variables directly.

The frontend's `VITE_API_BASE_URL` must use `https://` in production -
an `https://` frontend calling an `http://` API is a browser
mixed-content error, and separately would send every request
unencrypted regardless of what the backend supports.

### Certificate/private-key handling

No certificate or private key is ever hardcoded in source, committed,
or logged - only a local file *path* is read from the environment, at
startup, into memory. `.gitignore` (both root and `backend/`) ignores
`*.pem`, `*.key`, `*.p12`, `*.pfx`, a conventional `certs/` directory,
and `*.crt`, so a locally-generated or `mkcert`-issued certificate can
live on disk without ever being accidentally committed. Production
certificates should come from your hosting platform or a real
certificate authority (Let's Encrypt, etc.) - this project never
generates or ships one.

### CORS

`FRONTEND_ORIGIN` (comma-separated) controls which browser origins may
call this API; it defaults to this project's own local Vite dev origins
so local development needs no configuration. `cors()` with no options
(the previous configuration) reflected every origin - now only exact,
explicitly-listed origins are allowed, and a disallowed origin gets a
clean 403. Requests with no `Origin` header (server-to-server calls,
health checks, curl) are unaffected, since CORS is a browser-enforced
mechanism with nothing to check in that case.

### Security headers

`helmet()` is now applied to every response, providing its standard
safe defaults (`X-Content-Type-Options: nosniff`, a frame-protection
header, `Referrer-Policy`, etc.). Two things are deliberately NOT
enabled automatically: Content-Security-Policy (this backend serves
JSON plus one binary image route, never HTML, so a CSP tuned for an
HTML server adds complexity with no protective benefit here), and HSTS
(sticky in the browser - only turn on `HSTS_ENABLED=true` once HTTPS is
confirmed to work for every visitor, including local development, which
must NEVER have HSTS enabled).

### What remains to be configured manually for a real deployment

- A real TLS certificate (platform-provided or from a real CA) - this
  project never generates or ships one.
- `FRONTEND_ORIGIN` set to the real deployed frontend's `https://`
  origin.
- `TRUST_PROXY` set correctly for the real reverse proxy/platform in
  front of the app, if any.
- `VITE_API_BASE_URL` set to the real deployed backend's `https://`
  origin at frontend build time.
- A decision on `FORCE_HTTPS`/`HSTS_ENABLED`, made only after confirming
  HTTPS actually works end to end in that real environment.

### Known limitations

- This sandboxed development environment has no outbound network access
  to the project's real MongoDB Atlas instance (confirmed during the
  GridFS migration work), so the HTTPS tests below prove a genuine TLS
  handshake against this backend, but do not prove behavior against a
  real production MongoDB connection string over TLS (MongoDB's own
  driver-level TLS to Atlas was already in use before this pass and is
  unaffected by it - it is a separate connection from the browser-to-
  backend one this pass focuses on).
- No automated certificate renewal (e.g. Let's Encrypt's ACME protocol)
  is implemented - a real deployment should use its platform's own
  renewal mechanism.

## S3 Image Storage Migration

Request image attachments (DOC-45 Before Images, DOC-56 Completion
Images) can now additionally be stored in **S3-compatible object
storage** - AWS S3, or a compatible provider (MinIO, Cloudflare R2,
Backblaze B2, etc.) via an optional custom endpoint. This was, like the
GridFS migration before it, compatibility-first: nothing was removed.
Local-disk attachments (pre-GridFS-migration) and GridFS attachments
(pre-this-migration, or created while `IMAGE_STORAGE_PROVIDER=gridfs`)
both continue working forever, with no required backfill, no server
restart, and no existing image ever deleted.

- **Architecture before**: MongoDB stored attachment metadata plus one
  of two storage references (`storedName` for local disk, `fileId` for
  GridFS); the actual image bytes lived either on the backend's own
  filesystem or inside MongoDB's `requestImages` GridFS bucket.
- **Architecture after**: a third storage reference, `objectKey`, is
  now also possible - the actual image bytes live in an S3-compatible
  bucket, and MongoDB stores only safe metadata: `originalName`,
  `mimeType`, `size`, `uploadedAt` (+`uploadedBy` for Completion
  Images), and `objectKey` (the S3 key) - never the AWS secret key,
  never a permanent/presigned URL, never raw image bytes or base64.
- **Why S3 over GridFS for production**: GridFS is a real, working
  MongoDB feature and remains fully supported here, but a dedicated
  object-storage service is the more conventional production
  architecture for user-uploaded binary content - it decouples image
  storage from the application database entirely (no chunk-collection
  read/write load on MongoDB itself), scales and is priced
  independently, and every major cloud/self-hosted platform speaks the
  same S3 API, so this project is not locked into any one provider.
- **Storage abstraction (new)**: `src/services/requestImageStorage.js`
  is now the ONE place that decides which backend (S3, GridFS, or
  legacy local disk) handles a given operation. Controllers never touch
  the AWS SDK, `mongoose.mongo.GridFSBucket`, or `fs` directly for image
  storage anymore - they call three generic operations:
  `uploadImage(buffer, context)`, `getImageStream(attachment)`, and
  `deleteImage(attachment)`. Which backend an EXISTING attachment uses
  is never stored as a separate field - it is derived from which
  reference is populated (`objectKey` -> S3, `fileId` -> GridFS,
  `storedName` -> legacy local disk), the same "derive, don't
  duplicate" principle the GridFS migration already established for
  `fileId` vs. `storedName`.
- **Which backend NEW uploads use**: controlled by the optional
  `IMAGE_STORAGE_PROVIDER` environment variable (`"s3"` or `"gridfs"`).
  **Defaults to `"gridfs"` when unset** - deliberately NOT `"s3"` by
  default, so a deployment that has not yet configured S3 credentials
  keeps working with zero new configuration. Set
  `IMAGE_STORAGE_PROVIDER=s3` (plus the S3 env vars below) to switch new
  uploads to S3; existing GridFS/local attachments are completely
  unaffected either way, since reads and deletes always follow each
  attachment's own stored reference, never this setting.
- **S3 client / provider configuration**: uses the official
  `@aws-sdk/client-s3` (AWS SDK v3). Required env vars (only when
  `IMAGE_STORAGE_PROVIDER=s3`): `S3_BUCKET`, `S3_REGION`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Optional: `S3_ENDPOINT`,
  for any S3-compatible provider other than real AWS S3 (MinIO,
  Cloudflare R2, Backblaze B2, ...) - when set, the client also enables
  `forcePathStyle`, which virtual-hosted-style AWS bucket URLs generally
  need to work correctly against non-AWS endpoints. No provider URL or
  credential is ever hardcoded in source; `backend/.env.example` lists
  every variable as a placeholder only (see there for the full list),
  and the real `backend/.env` is never modified automatically and stays
  git-ignored exactly like every other secret in this project. The S3
  client itself is constructed lazily (only the first time a real S3
  operation is attempted, mirroring `gridFsStorage.js`'s own lazy bucket
  pattern) and cached - a deployment that never actually uses S3 never
  even needs the env vars set, and no error occurs at startup either
  way.
- **Object key design**: never derived from anything client-supplied
  (not the original filename, not a client-chosen path). Server-
  generated: `organizations/{organizationId}/requests/{requestId}/
  before/{uuid}.ext` or `.../completion/{uuid}.ext`, where
  `organizationId`/`requestId` are always the trusted server-side
  context (never `req.body`), `uuid` is `crypto.randomUUID()`, and the
  extension is derived only from the already-validated MIME type
  (`.jpg`/`.png`/`.webp`) - a file uploaded with a hostile original
  filename (e.g. `../../etc/passwd.jpg`) can never influence the actual
  storage key.
- **Request attachment schema** (`models/Request.js`) - both
  `attachmentSchema` and `completionAttachmentSchema` gained a new
  optional field, `objectKey` (String). The existing `ensureStorageReference`
  `pre('validate')` hook was extended to accept any ONE of `fileId`
  (GridFS), `storedName` (legacy local disk), or `objectKey` (S3) - a
  pure-S3 attachment legitimately has neither of the other two. No
  database migration is required before server startup; every existing
  document keeps validating and loading exactly as before.
- **New upload flow (Before and Completion Images alike)**: Frontend ->
  authenticated API -> Multer `memoryStorage` (unchanged, reused as-is
  from the GridFS migration - no new Multer instance was needed) ->
  MIME/size/count validation (unchanged: JPEG/PNG/WEBP only, 5 MB per
  image, 5 images per Request per collection) -> `requestImageStorage
  .uploadImage()` (routes to S3 or GridFS per `IMAGE_STORAGE_PROVIDER`)
  -> attachment metadata (with `objectKey` or `fileId`, whichever was
  used) pushed onto the Request document and saved. No new upload ever
  writes to local disk first, and while `IMAGE_STORAGE_PROVIDER=s3`, no
  new GridFS file is ever created for a successful upload.
- **Image authorization / delivery flow (unchanged contract, new
  backend support)**: `GET /api/requests/:requestId/attachments/:attachmentId/content`
  is completely unchanged from the outside - same authentication chain,
  same Employee/Operator/Manager authorization rules
  (`canViewRequestImages`), same anti-enumeration 404s, same 403 for
  System Admin. Internally it now calls
  `requestImageStorage.getImageStream(attachment)`, which transparently
  streams from S3, GridFS, or local disk depending on that specific
  attachment's own reference - the frontend, and this endpoint's own
  request/response shape, never need to know or care which backend
  actually served a given image (`AuthenticatedRequestImage.jsx`,
  `RequestRow.jsx`, `ManagerRequestRow.jsx` needed ZERO changes for this
  migration). The bucket itself is never made public and no permanent or
  presigned S3 URL is ever returned in any API response - every image
  byte is proxied through this one authenticated backend endpoint,
  exactly like GridFS/local images already were. A presigned-URL
  approach was deliberately NOT adopted (task decision, documented here
  per that decision's own requirement): the existing backend-proxied
  streaming architecture already satisfies every authorization
  requirement with zero frontend changes, whereas presigned URLs would
  add complexity (short-lived generation, careful never-persisted
  handling) for no clear benefit at this project's scale.
- **S3 security**: the bucket is expected to be fully private (no
  public-read ACLs) - this project only ever uses authenticated
  `PutObject`/`GetObject`/`DeleteObject` calls via the AWS SDK with the
  configured credentials, never a public URL. `S3_ACCESS_KEY_ID`/
  `S3_SECRET_ACCESS_KEY` are never sent to the frontend, never logged,
  and never included in an error response - only clear "which env var is
  missing" messages are ever thrown, never the values themselves.
  Recommended least-privilege IAM policy for the credentials used here:
  `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject`, scoped to the
  one configured bucket (and ideally further scoped to the
  `organizations/*` key prefix this project always writes under) -
  actual cloud IAM configuration is a manual, external step, not
  something this codebase can or does perform.
- **Content-Type / download security**: MIME type is validated before
  any upload (unchanged three-type allowlist), the S3 object's stored
  `ContentType` is set from that same validated value, and the download
  response's `Content-Type` is likewise always set from trusted,
  already-validated attachment metadata - never re-derived from a
  client-supplied filename or header. The content-delivery endpoint now
  also sets `Content-Disposition: inline` (renders in-browser rather
  than forcing a download), built from a static string, never from
  `originalName`.
- **GridFS preservation**: `services/gridFsStorage.js`,
  `requestImages.files`/`requestImages.chunks`, and every existing
  `fileId` field are completely untouched by this migration. GridFS is
  now simply one of three supported storage providers - fully supported
  for both existing images (forever) and new uploads (while
  `IMAGE_STORAGE_PROVIDER=gridfs`, the default).
- **Legacy local-disk preservation**: `middleware/upload.js`'s legacy
  disk-storage `upload` instance, `backend/uploads/requests/`, and every
  existing `storedName` field are likewise completely untouched - reads
  and deletes for a `storedName`-only attachment work exactly as they
  did before either migration.
- **Migration script (optional, non-destructive, GridFS -> S3 only)**:
  `backend/scripts/migrateRequestImagesToS3.js`
  (`npm run migrate:request-images-to-s3`) copies every remaining
  GridFS-backed attachment's bytes into S3 and sets its `objectKey`,
  while leaving `fileId`/every other field completely untouched and
  NEVER deleting the original GridFS file (rollback safety, matching the
  GridFS migration script's own "never delete the original on first
  pass" decision). It deliberately does NOT touch legacy local-disk
  (`storedName`-only) attachments at all - that remains a separate,
  future, deliberate decision. Fails fast with a clear message if S3 is
  not configured, before touching MongoDB at all. Idempotent (an
  attachment that already has an `objectKey` can never be matched again
  on a later run - reported as "skipped", not "migrated"); a missing
  GridFS file or a failed upload is reported and skipped, never crashes
  the rest of the run; a `Request.save()` failure after a successful S3
  upload rolls back just that document's newly-uploaded S3 objects
  (never the original GridFS files, never a different document's
  attachments). This script is never run automatically - `src/server.js`
  never requires it.
- **Failure/rollback handling**: mirrors the GridFS migration's own
  rollback design, generalized across all three backends via
  `requestImageStorage.deleteImage()`. If a multi-file upload's storage
  write succeeds for file 1 but fails for file 2 (S3 or GridFS,
  whichever `IMAGE_STORAGE_PROVIDER` is active), only file 1's just-
  uploaded object is deleted - never anything from a previous, already-
  saved upload. If every file uploads successfully but the following
  `Request.create()`/`requestDoc.save()` fails, every object just
  uploaded for that one attempt is deleted before the error response is
  sent - no orphaned S3 objects (or GridFS files) are ever left behind
  by a failed request. Deleting an attachment always uses the
  `objectKey`/`fileId`/`storedName` already stored on the AUTHORIZED
  Request's own attachment subdocument - never a client-supplied
  identifier.
- **Organization isolation (unchanged)**: every existing access rule
  (Employee: only their own Request; Operator: only an assigned
  Request; Manager: any Request in their own Organization; System
  Admin: no operational Request image access at all) applies identically
  regardless of which storage backend a given image actually uses. A
  user can never retrieve an S3 object simply by guessing an
  `objectKey` - the content-delivery endpoint only ever resolves an
  `objectKey` from an attachment it already independently authorized on
  a specific, already-authorized Request; there is no route that accepts
  an `objectKey`/`fileId` directly from a client.
- **File limits (unchanged)**: JPEG/PNG/WEBP only, 5 MB per image, 5
  images per Request per collection (Before and Completion Images have
  independent 5-image caps).
- **Real S3 limitation**: this sandboxed development environment has no
  outbound network access (the same limitation disclosed during the
  GridFS migration work) and no real S3-compatible credentials were
  ever configured in this environment's `backend/.env`, so live
  persistence against a real S3-compatible bucket was **not** exercised
  - `@aws-sdk/client-s3` installs and loads correctly, but this is a
  **STRUCTURAL/MOCK TEST ONLY** disclosure, not a claim that real cloud
  storage was tested. `services/requestImageStorage.js` was instead
  tested against a fake, in-memory S3 client substituted for
  `@aws-sdk/client-s3`'s `S3Client`/`PutObjectCommand`/`GetObjectCommand`/
  `DeleteObjectCommand` (the exact same substitution point a real AWS
  SDK client would occupy), combined with the same fake-GridFSBucket
  substitution the GridFS migration already established. This proves the
  abstraction's own logic (routing by `IMAGE_STORAGE_PROVIDER`, object
  key generation, streaming, rollback, cross-provider coexistence) is
  correct, but does not by itself prove behavior against a real AWS S3
  (or MinIO/R2/B2) bucket over the network.
- **Test summary**: a temporary E2E suite (`backend/s3-migration-test.tmp.js`,
  deleted after this run) extended the project's established mocked-model
  HTTP harness (`Module._load` interception, real unmodified `src/app.js`
  served via `http.createServer` + native `fetch`) with the fake-S3-client
  and fake-GridFSBucket substitutions described above, covering: Storage
  (JPEG/PNG/WEBP upload succeeds, invalid MIME/oversized rejected, safe
  server-generated `objectKey`, a hostile original filename never
  influences the key, response never exposes `objectKey`/`fileId`/
  internal storage fields - 9 checks); Before Images (Employee views own,
  Manager views, assigned Operator views, a different same-org Employee
  rejected 403, another Organization rejected 404, removal deletes the
  S3 object - 7 checks); Completion Images (assigned Operator upload
  works, wrong Operator/Employee/Manager all rejected 403, upload outside
  `in_progress` rejected 409, removal deletes the S3 object - 6 checks);
  Failure/Rollback (a simulated `requestDoc.save()` failure after a
  successful S3 upload rolls back only the new object and leaves the
  pre-existing attachment/object untouched, a simulated mid-batch S3
  failure leaves zero net-new orphaned objects, an unknown attachment id
  cannot be deleted, a since-deleted S3 object is handled as a clean 404
  rather than a 500 - 6 checks); Cross-Provider Compatibility (a single
  Request with a legacy local-disk attachment, a GridFS attachment, AND
  an S3 attachment all coexisting and all rendering correctly through the
  identical `url` contract - 3 checks); and a Regression sweep (Request
  creation with zero images still works, the SLA field is still present,
  `IMAGE_STORAGE_PROVIDER=gridfs` still correctly uploads to GridFS
  instead of S3, the unrelated health endpoint is unaffected - 4 checks).
  **All 42 assertions passed, 0 failed.**
- **Frontend build verification**: `npx vite build` completed with no
  errors - this migration made zero frontend source changes (Phase 11's
  own "prefer minimal frontend change" decision: the existing
  `AuthenticatedRequestImage.jsx` fetch-as-blob pattern already works
  identically regardless of backend).
- **Known limitations / technical debt**: (1) no real S3-compatible
  credentials were available in this environment - see "Real S3
  limitation" above; a real deployment should perform a small, isolated
  smoke test (upload/read/delete one temporary test object, never a real
  Request image) after configuring real credentials, before relying on
  this in production. (2) the optional migration script only covers
  GridFS -> S3, not legacy-local -> S3 - a future, separate task may add
  that path once needed. (3) There is currently no scheduled/automatic
  run of the migration script - it is a manual, explicit command, exactly
  like the GridFS migration script before it.

## Request Activity Timeline (DOC-17)

A chronological, organization-isolated history of everything that
happens to a Request - who did what, and when - viewable by anyone who
could already view that Request (Employee/own, Operator/assigned,
Manager/any-in-org). Does **not** replace or restructure the existing
Request workflow, Comments, or role permissions in any way - it is a
purely additive, read-mostly audit trail layered on top of the
already-shipped Request lifecycle.

- **Architecture**: a separate `RequestActivity` collection
  (`models/RequestActivity.js`), **not** an embedded array on `Request` -
  the same reasoning that already put `Comment` (DOC-13) and
  `ChatMessage` (DOC-60) in their own collections applies here: an
  unbounded, ever-growing list embedded on the parent document risks the
  16MB BSON document ceiling on a long-lived, heavily-edited Request, and
  a separate collection lets `{requestId, createdAt}` be indexed and
  paginated properly. Shape: `{_id, organizationId, requestId, actorId,
  type, oldValue, newValue, metadata, createdAt, updatedAt}` -
  `organizationId`/`requestId` are always derived server-side from the
  already-loaded, already-authorized Request document, never from
  `req.body`/`req.query`. Only `actorId` is stored for "who" (never a
  copied snapshot of sensitive User fields) - the API layer resolves it
  to a safe `{id, fullName, role}` at read time, and a since-deactivated
  actor's real name is still shown (this project never hard-deletes a
  User - DOC-48 is soft-deactivation only); only a User document that
  somehow no longer resolves at all falls back to `"Unknown user"`.
- **Activity type enum** (`RequestActivity.ACTIVITY_TYPES`, enforced by
  the schema's own `enum` validator - never an arbitrary free-text
  event): `REQUEST_CREATED`, `REQUEST_UPDATED`, `PRIORITY_CHANGED`,
  `CATEGORY_CHANGED`, `ASSIGNED`, `REASSIGNED`, `UNASSIGNED`,
  `STATUS_CHANGED`, `REQUEST_CANCELLED`, `REQUEST_REOPENED`,
  `REQUEST_CLOSED`, `BEFORE_IMAGE_ADDED`, `BEFORE_IMAGE_REMOVED`,
  `COMPLETION_IMAGE_ADDED`, `COMPLETION_IMAGE_REMOVED`.
- **One meaningful event per user action** (never two for the same
  transition): closing a Request always records `REQUEST_CLOSED` -
  whether it happened via the generic `PATCH /requests/:id/status`
  endpoint or the dedicated `PATCH /requests/:id/manager/close` endpoint
  - never `STATUS_CHANGED resolved->closed` as well. Reopening
  (`resolved -> reopened`, the only status this project's transition
  rules ever allow into `reopened`) similarly always records
  `REQUEST_REOPENED`, never a generic `STATUS_CHANGED` alongside it.
  Every other transition (`open->in_progress`, `in_progress->resolved`,
  `reopened->in_progress`) records the generic `STATUS_CHANGED`.
  `cancelled` can never be reached through the generic status endpoint at
  all (`utils/requestStatusTransitions.js` already refuses it
  unconditionally) - only the two dedicated cancel endpoints
  (`cancelMyRequest`/`managerCancelRequest`) ever record
  `REQUEST_CANCELLED`.
- **Display-value resolution: write-time snapshot, not read-time
  lookup.** For reference-typed events (`CATEGORY_CHANGED`, `ASSIGNED`,
  `REASSIGNED`, `UNASSIGNED`), the human-readable name of the
  category/operator involved is resolved ONCE, at the moment the event
  is written, and stored directly in that event's own `metadata`
  (`oldCategoryName`/`newCategoryName`, `previousOperatorName`/
  `newOperatorName`) - never re-resolved live every time the timeline is
  later read. This was a deliberate choice over live resolution: it is
  more historically honest (a category rename or an Operator's later
  deactivation can never silently rewrite what an old timeline entry
  displays) and it avoids extra N+1 batch lookups on every future read of
  a long timeline. `oldValue`/`newValue` for these event types still
  store the raw ObjectId internally (for any future programmatic use);
  the API layer (`buildActivityDisplayValues` in
  `controllers/request.controller.js`) is what ever chooses between the
  raw scalar (for `STATUS_CHANGED`/`PRIORITY_CHANGED`/
  `REQUEST_CANCELLED`/`REQUEST_REOPENED`/`REQUEST_CLOSED`) and the
  snapshotted display name (for the four reference-typed events) - a raw
  Mongo ObjectId for a category/operator is never sent to the client.
- **`requestActivity.service.js` - the one place activities are ever
  written.** No controller function ever calls
  `RequestActivity.create(...)` directly - every write goes through
  `recordRequestActivity({request, actorId, type, oldValue, newValue,
  metadata})`, which derives `organizationId`/`requestId` from the
  already-saved `request` document and never accepts them as separate,
  independently-trustable arguments. This mirrors the same
  "one owner of write logic" discipline `services/requestImageStorage.js`
  already established for image storage.
- **Failure strategy: best-effort, never blocks the primary Request
  write.** `recordRequestActivity` is always called AFTER the
  corresponding `requestDoc.save()`/`Request.create()` has already
  succeeded, and it swallows its own errors internally (`console.error`,
  never throws) - a rare activity-log write failure produces a Request
  whose real business state is fully correct but has one gap in its
  displayed timeline, never a Request update that gets silently rolled
  back or blocked by a logging failure. A real MongoDB multi-document
  transaction was deliberately **not** used to make the pair atomic:
  transactions require a replica set (or mongos), and would throw
  immediately ("Transaction numbers are only allowed on a replica set
  member or mongos") against a standalone `mongod` - a completely normal
  local/development configuration this project must not break. This is a
  documented trade-off, not an oversight - see
  `services/requestActivity.service.js`'s own top comment.
- **Write sites** (every place a Request-mutating controller function
  now also calls `recordRequestActivity`, always after its own successful
  save): `createRequest` (`REQUEST_CREATED`), `updateRequestStatus`
  (`STATUS_CHANGED`/`REQUEST_CLOSED`/`REQUEST_REOPENED`),
  `updateMyRequest` (up to three independent events per call -
  `REQUEST_UPDATED`/`PRIORITY_CHANGED`/`CATEGORY_CHANGED` - each only if
  that specific field's value actually changed, never a `medium->medium`
  no-op event), `cancelMyRequest` (`REQUEST_CANCELLED`, no reason),
  `addRequestAttachments`/`removeRequestAttachment`
  (`BEFORE_IMAGE_ADDED`/`BEFORE_IMAGE_REMOVED` - one event per upload
  *action*, not one per file), `addCompletionImages`/
  `removeCompletionImage` (`COMPLETION_IMAGE_ADDED`/
  `COMPLETION_IMAGE_REMOVED`), `assignRequestOperator`
  (`ASSIGNED`/`REASSIGNED`), `managerUpdateRequest` (up to three events -
  `PRIORITY_CHANGED`/`CATEGORY_CHANGED`/`ASSIGNED`|`REASSIGNED`|
  `UNASSIGNED`), `managerCancelRequest` (`REQUEST_CANCELLED`, with
  `cancelReason` in metadata - already normal, non-sensitive,
  already-visible data on this same Request's own response shape),
  `managerCloseRequest` (`REQUEST_CLOSED`, the identical type
  `updateRequestStatus`'s own closed branch uses).
- **DOC-15 separation**: assignment-related events
  (`ASSIGNED`/`REASSIGNED`/`UNASSIGNED`) only ever record the four fields
  this ticket itself asks for - old operator, new operator, actor,
  timestamp. No mandatory reassignment reason, approval workflow, or
  analytics field exists here by design, so a future DOC-15 ("Operator
  Reassignment Workflow") can extend this event's `metadata` later
  without a schema redesign.
- **Comments stay separate from the timeline, on purpose.** No comment is
  ever automatically duplicated into `RequestActivity` - Comments
  (DOC-13) remain the communication surface; the Activity Timeline remains
  the lifecycle/system-activity surface. They are two different
  concerns that happen to both render inside the same Request detail
  view.
- **`GET /api/requests/:requestId/activities`** (Employee/Operator/Manager
  only - System Admin is rejected 403 unconditionally, before any Request
  lookup even runs, mirroring the image-content-delivery endpoint's own
  convention; System Admin gains no new day-to-day operational Request
  access just because this endpoint exists). Authorization mirrors this
  Request's existing visibility rules exactly (a small, deliberately
  independent `canViewRequestActivities` helper - Employee/own Request
  only, Operator/assigned Request only, Manager/any Request in their
  Organization): Employee A can never view Employee B's Request timeline,
  Operator A can never view an unassigned Request's timeline, Manager A
  can never view Organization B's Request timeline (a cross-organization
  or nonexistent `requestId` both collapse into the same 404 - the DOC-38
  anti-enumeration convention already used everywhere else in this
  controller; wrong-role/wrong-assignee within the caller's own
  organization is an honest 403, since organization membership is already
  established by that point). Returns activities **oldest-first**
  (matching the ticket's own worked example, which reads top-to-bottom -
  "Request created -> Priority changed -> Assigned -> ..."), even though
  the underlying query runs newest-first internally (so an optional
  `limit` naturally keeps the most recent N events of whichever window is
  selected) and is reversed immediately before responding. Pagination is
  deliberately simple (task spec: "avoid overengineering") - an optional
  `limit` (integer, 1-200, default 100) and an optional `before` (an
  activity id already returned by an earlier call, fetching the next
  OLDER page) - `before` must itself belong to the same, already-
  authorized Request, so it can never be used to probe another Request's
  activity timing. Response shape per activity: `{id, type, actor:{id,
  fullName, role}, oldValue, newValue, metadata, createdAt}` - never
  `organizationId`, `__v`, or any internal Mongo/storage/credential field.
- **Frontend**: `RequestActivityTimeline.jsx` is a small, self-contained
  component (mirrors `AuthenticatedRequestImage.jsx`'s own
  "reads `token` from `useAuth()` and calls the backend itself" shape) -
  it needs only a `requestId` prop and fetches
  `requestApi.getActivities(requestId, token)` itself the moment it
  mounts (i.e. only once the row it lives in is actually expanded - it is
  never rendered, and therefore never fetches, for a collapsed row).
  `type`/`oldValue`/`newValue`/`metadata` are mapped to a human-readable
  English sentence entirely on the frontend (`describeActivity`) - the
  database never stores a finished UI sentence, only structured data, so
  future localization/reformatting never requires a data migration. Wired
  into `RequestRow.jsx` (Employee/Operator dashboards, as a sibling block
  after Comments inside the same expanded detail panel) and
  `ManagerRequestRow.jsx` (its own "View Timeline" toggle + own `<tr>`,
  matching that row's existing "View Images" toggle shape, since that
  row has no single shared detail panel the way `RequestRow.jsx` does).
  A Request with zero activity (any Request created before this feature
  shipped, and never backfilled) shows "No activity recorded yet." -
  never a blank gap or a crash.
- **Optional historical backfill**: `npm run backfill:request-activity`
  (`scripts/backfillRequestActivity.js`) - manual command only, never run
  on server startup, safe to run any number of times (idempotent - a
  Request that already has at least one activity record, from live usage
  or an earlier run of this exact script, is left completely untouched).
  For every Request with zero activity records, creates exactly ONE
  `REQUEST_CREATED` event using only data already honestly on that
  Request document (`createdBy` as the actor, `createdAt` as the
  timestamp) - it never invents who assigned an operator, who changed
  status, or when priority changed, because no honest record of exactly
  when/by-whom those real historical changes happened exists to backfill
  from. Every backfilled event carries `metadata.backfilled: true`, so it
  stays distinguishable from a genuinely live-recorded `REQUEST_CREATED`.
- **Indexes**: `{requestId: 1, createdAt: 1}` and `{organizationId: 1,
  requestId: 1, createdAt: 1}` - no others added (task spec: "do not add
  unnecessary indexes").
- **Immutability**: `RequestActivity` documents are audit-like historical
  data - there is no `PATCH`/`DELETE` endpoint for an individual activity
  anywhere in this project, and none is planned; once written, an
  activity is never edited or removed through the API (the same "prefer
  preserving history over destructive deletion" principle this project
  already applies to Organizations - DOC-47 - and Employees - DOC-48).
- **Test summary**: a temporary mocked-controller test harness
  (`backend/__doc17_test.js`, deleted after this run) injected fake
  in-memory `Request`/`ServiceCategory`/`User`/`RequestActivity` models
  and a fake `requestImageStorage` directly into Node's `require.cache`
  before requiring the REAL, unmodified
  `controllers/request.controller.js` and
  `services/requestActivity.service.js` - every other dependency
  (`utils/requestStatusTransitions`, `utils/requestFieldValidation`,
  `utils/requestQueryBuilder`, `utils/requestStatistics`,
  `utils/duplicateRequestDetection`, `utils/slaPolicy`, `mongoose` itself)
  ran as real, unmocked production code. Covered: Model/Service (schema
  validation, enum enforcement, Mixed-type null round-tripping,
  `recordRequestActivity` deriving ids server-side and never throwing -
  9 checks), Request Creation (5 checks), Edit (5 checks), Assignment
  (5 checks), Status workflow (6 checks), Images (8 checks), Cancel
  (3 checks), Authorization/organization isolation (11 checks, including
  cross-org 404, System Admin 403, an unresolvable actor rendering
  "Unknown user", pagination `limit`/`before` validation, and a
  simulated activity-write failure never blocking the underlying Request
  update), and a Regression sweep (22 checks covering existing
  creation/status/edit/assignment/cancel/image-upload validation rules,
  anti-enumeration behavior, SLA recalculation, and the image-storage
  abstraction) - **74 of 74 assertions passed, 0 failed.**
- **Backend module-graph verification**: `node -e "require('./src/app')"`
  loads cleanly with the new model, service, and route wired in - no
  circular dependency, no startup migration runs automatically.
- **Frontend build verification**: `npx vite build` completed with no
  errors.
- **Known limitations**: (1) no real MongoDB was available in this
  environment (same disclosed limitation as every prior ticket here) - the
  suite above is a mocked-model verification of the real controller/
  service logic, not a live-database integration test; the model's own
  schema (required fields, enum, `timestamps`) was additionally verified
  in isolation via real Mongoose schema validation (`validateSync()`,
  no DB connection needed for that). (2) The optional backfill script
  only ever creates `REQUEST_CREATED` - a historical Request's assignment/
  status/priority history before this feature shipped is permanently
  unrecoverable and intentionally never fabricated.

## In-App Notifications (DOC-18)

A per-recipient notification inbox - "what does THIS user need to know?" -
layered on top of the existing Request lifecycle. Deliberately **not**
email/SMS/push, **not** WebSockets, and **not** a rewrite or replacement of
DOC-17's Request Activity Timeline ("what happened to this Request?") -
the two answer different questions and are stored in two completely
separate collections, written independently from the same successful
controller transition.

- **Timeline vs. Notification, precisely**: DOC-17's `RequestActivity` is
  one shared, chronological, append-only record per Request, visible to
  everyone currently authorized to view that Request. This ticket's
  `Notification` is one row per **(event, recipient)** pair, visible ONLY
  to that recipient, with its own independent read state. A single
  business event (e.g. a Manager reassigning an Operator) writes exactly
  one `RequestActivity` entry but may write up to three `Notification`
  documents (Employee, previous Operator, new Operator). Neither is
  generated FROM the other - both are written directly, once, from the
  same successful transition (`recordRequestActivity(...)` and
  `createRequestNotification(...)` called back-to-back at the same call
  site - task spec section 34: "Do NOT read the Timeline collection after
  every mutation just to decide notifications").
- **Not every activity becomes a notification** (task spec section 5): a
  title/description edit, a category change, and Before/Completion image
  events never notify anyone in this version - only genuinely
  "you-need-to-know-this" events do (see the recipient rules below).
  "Notifications should be useful, not noisy."
- **Model**: `models/Notification.js` - `{organizationId, recipientId,
  actorId, requestId, type, title, message, metadata, readAt,
  createdAt, updatedAt}`. `organizationId` is always derived server-side
  from the already-authorized Request (or, for a hypothetical future
  non-Request event, from `req.user.organizationId`) - never from
  `req.body`/`req.query`/frontend state. `actorId`/`requestId` are
  optional (`null`) for schema forward-compatibility with a future
  non-Request or system-generated notification type - every type actually
  implemented today always sets both. `readAt` is `null` while unread and
  set to a real timestamp the moment the recipient marks it read (never a
  plain Boolean - task spec section 12).
- **Request identification (task spec section 10)**: DOC-63 "Human-
  Friendly Request ID" does not exist yet, so no fake permanent request
  number is ever invented here. A notification identifies its Request via
  the real `requestId` plus a plain snapshotted `metadata.requestTitle`
  string - if DOC-63 ships later, it can add a `requestNumber` to
  `metadata` (already a free-form field for exactly this reason) with zero
  schema change.
- **Notification types implemented** (`Notification.NOTIFICATION_TYPES`,
  schema-enforced enum, never arbitrary free text): `REQUEST_ASSIGNED`,
  `REQUEST_REASSIGNED`, `REQUEST_UNASSIGNED`, `REQUEST_STATUS_CHANGED`
  (used only for the open/reopened -> in_progress "work started"
  notification), `REQUEST_RESOLVED`, `REQUEST_REOPENED`,
  `REQUEST_CANCELLED`. **Deliberately NOT implemented in this version**
  (task spec explicitly permits deferring all of these, each documented
  here rather than silently omitted): `REQUEST_CLOSED` (see the Closed
  rule below), `REQUEST_PRIORITY_CHANGED` (a priority edit is treated the
  same as a minor field edit - not inherently notification-worthy, no
  concrete recipient rule was given for it), `REQUEST_OVERDUE` (see SLA/
  overdue below), `ROLE_CHANGED`/`PASSWORD_RESET_REQUIRED` (task spec
  section 27 explicitly allows deferring these - Request notifications are
  the ticket's priority, and touching `user.controller.js`'s role/password
  code at all was judged an unnecessary scope/risk increase for this
  Sprint), `USER_DEACTIVATED` (a deactivated user is immediately locked
  out of login - DOC-48 - so an in-app notification would never actually
  be seen by them; not useful).
- **`notification.service.js`** - the sole owner of all Notification
  writes and read-state changes; no controller calls
  `Notification.create(...)`/mutates `readAt` directly anywhere. Exposes
  exactly four functions: `createNotification` (the transport-layer
  primitive - validates required fields, the type enum, and applies the
  actor-exclusion safety net below), `createRequestNotification` (a thin
  convenience wrapper deriving `organizationId`/`requestId` from an
  already-saved Request document, mirroring `recordRequestActivity`'s own
  ergonomics), `markNotificationRead` (idempotent, recipient-scoped),
  `markAllNotificationsRead` (recipient-scoped bulk update). This service
  deliberately does NOT decide who should be notified or build message
  text - see the next point.
- **Recipient decisions and message text live in the controller, not the
  service** - the same place DOC-17's own metadata-building already lives,
  right next to the already-resolved User/Category documents and old/new
  values a given transition already has in hand. Unlike DOC-17 (which
  never stores a finished sentence), storing a safe, already-built
  `title`/`message` snapshot IS acceptable here (task spec section 11) -
  a notification is read once, briefly, in a small dropdown, with no
  future "reformat every historical notification" requirement the way a
  longer-lived Timeline has.
- **Actor-exclusion safety net** (task spec section 9: "Do NOT notify a
  user about an action they themselves performed"): every call site in
  this project is already written so a recipient never equals the actor
  who caused the event (e.g. the Manager who assigns an Operator is never
  one of the three possible recipients) - but `createNotification` ALSO
  enforces this centrally as defense in depth: if `actorId` and
  `recipientId` ever resolve to the same user, the notification is
  silently skipped (`null`, not an error), never delivered.
- **Recipient rules implemented**:
  - **Assignment** (`assignRequestOperator` and
    `managerUpdateRequest`'s assignment branch - both reach the identical
    underlying transition through different routes): Employee (creator)
    AND the newly-assigned Operator, always. An unrelated Operator never
    receives anything.
  - **Reassignment** (Operator A -> Operator B): Employee, Operator A
    ("You were removed from a request"), AND Operator B ("A request was
    assigned to you") - three notifications from one transition. The
    Manager who performed it receives none (actor-exclusion).
  - **Unassignment** (`managerUpdateRequest` removing an Operator with no
    replacement): Employee AND the removed Operator only - never every
    Operator in the Organization.
  - **In Progress** (`open`/`reopened` -> `in_progress`): Employee only -
    "Work started on your request" - judged useful (task spec section 21)
    and implemented; fires only once, on the real transition (this
    endpoint already rejects a same-status resubmission with 400 before
    this code is ever reached, so no duplicate/no-op notification is
    possible).
  - **Resolved** (`in_progress` -> `resolved`): Employee only - REQUIRED
    (task spec section 22). A Manager notification on resolve was
    considered and deliberately NOT implemented - the Manager Dashboard's
    own DOC-53 statistics already surface resolved-request counts, so an
    individual push-style notification for every resolution was judged
    unnecessary noise (task spec explicitly allows this as optional).
  - **Reopened** (`resolved` -> `reopened`, Employee-only action): the
    assigned Operator - REQUIRED (task spec section 23) - AND the
    Organization's Manager (task spec section 8's own "good candidate" -
    implemented, since a request regressing after being marked resolved
    is a genuinely meaningful organization-level event). The Employee who
    performed the reopen is never notified about their own action.
  - **Closed** (`updateRequestStatus`'s closed branch AND
    `managerCloseRequest` alike): **deliberately silent, no notification
    at all** - the documented rule task spec section 24 asks for. By the
    time a Request reaches `closed`, the Employee (who either closed it
    themselves or already saw it resolved) and the Operator (who already
    received the resolved-time notification) already know the Request's
    lifecycle is complete - a further notification would be redundant
    noise, not new information.
  - **Cancelled** (`managerCancelRequest` - the only cancellation path
    that ever notifies anyone; Employee self-cancel via `cancelMyRequest`
    is only reachable while open+unassigned, so there is never an Operator
    to notify and the Employee is the actor of their own cancellation):
    Employee AND the assigned Operator (if one exists) - REQUIRED (task
    spec section 25). `metadata.cancelReason` is included safely - both
    recipients can already see this exact same field on this exact same
    Request's own response shape (`sanitizeRequest`), so repeating it in
    the notification exposes nothing new.
  - **System Admin**: never a possible recipient of any Request
    notification (task spec section 8/37) - structurally true because
    System Admin never creates, is assigned to, or manages any individual
    Request at all; no special-case check was needed anywhere in the
    controller to enforce this.
- **SLA / Overdue - explicitly deferred** (task spec section 26): this
  project has never added a background scheduler (see `utils/slaPolicy.js`'s
  own long-standing "Do not add background schedulers" scope note, `isOverdue`
  is always computed dynamically at read time, never persisted) - and DOC-18
  does not introduce one either. A `REQUEST_OVERDUE` notification requires
  a genuine trigger (a periodic sweep, or a lazy check on some other
  request) that does not exist in this codebase today. Rather than
  half-implement a fragile lazy-trigger (which risks either missing
  overdue Requests no one happens to view, or firing duplicate
  notifications on every view), this version makes **no claim** of overdue
  alerting - there is no `REQUEST_OVERDUE` type, and the Manager Dashboard
  does **not** receive an overdue-Request notification in this Sprint. A
  future ticket introducing a real scheduled job (or confirming a safe
  lazy-trigger design) is the correct place to add this, cleanly, without
  DOC-18 pretending a trigger exists when it does not.
- **API endpoints** (`routes/notification.routes.js`, same auth chain as
  `chat.routes.js`: `verifyToken -> requirePasswordChangeCompleted ->
  requireOrganizationMembership -> requireActiveOrganization` - the last
  two structurally exclude System Admin, since its own `organizationId` is
  always `null`):
  - `GET /api/notifications?limit=<1-100>&before=<id>` - the caller's own
    notifications, **newest-first** (task spec section 14 - the opposite
    reading order from DOC-17's own Timeline, a deliberate, documented
    difference: a Timeline reads top-to-bottom as history; an inbox reads
    top-to-bottom as "what's new"). `limit`/`before`-by-id cursor
    pagination mirrors DOC-17's own endpoint shape exactly (`before` must
    itself be a notification id already belonging to this recipient -
    never a bare timestamp, so it can never be used to probe another
    user's notification timing). Response: `{status, data: [...], meta:
    {hasMore, nextCursor}}`.
  - `GET /api/notifications/unread-count` - `{unreadCount}`, counting only
    `recipientId === req.user.userId AND readAt === null` within the
    caller's own organization - the client can never supply/override
    `recipientId`.
  - `PATCH /api/notifications/:id/read` - only the recipient may mark
    their own notification read; idempotent (a second call for an
    already-read notification succeeds without changing `readAt`);
    another user (even in the same Organization) gets 404, never a 403
    that would confirm the notification's existence.
  - `PATCH /api/notifications/read-all` - only ever affects the caller's
    own notifications, returns `{modifiedCount}`.
  - No `DELETE` endpoint exists (task spec section 13 - not required this
    Sprint, and historical notifications are treated the same "prefer
    preserving history" way this project already treats `RequestActivity`
    - immutable after creation, no user-facing edit/delete of the
    title/message/metadata fields either).
- **Failure strategy**: identical, documented choice to DOC-17's own
  `requestActivity.service.js` - the underlying Request/business write is
  always primary and never rolled back or blocked by a notification
  failure; every notification write happens AFTER the business write
  already succeeded and swallows its own errors (`console.error`, never
  throws). The same rejection of MongoDB multi-document transactions
  applies for the same standalone-`mongod`-compatibility reason.
- **Indexes**: `{recipientId: 1, createdAt: -1}` (the notification LIST
  query) and `{recipientId: 1, readAt: 1, createdAt: -1}` (the unread-
  count/unread-list query) - both lead with `recipientId` since every real
  query this feature runs is scoped to one recipient's own inbox. No
  separate `organizationId`-only index was added (task spec: "do not add
  excessive indexes" - no query here is ever organization-wide, only
  recipient-scoped with organizationId as defense-in-depth).
- **Historical Requests**: no backfill of any kind exists or is planned
  for notifications (task spec section 35 - unlike DOC-17's own OPTIONAL,
  narrowly-scoped `REQUEST_CREATED` backfill) - a Request's history before
  DOC-18 shipped simply has zero historical notifications, and none are
  ever fabricated. This is not considered a gap: notifications are
  inherently forward-looking ("what do you need to know, going forward"),
  unlike a Timeline, which is inherently a historical record.
- **Test summary**: a temporary mocked-controller test harness
  (`backend/__doc18_test.js`, deleted after this run), extending DOC-17's
  own established harness (fake in-memory `Request`/`ServiceCategory`/
  `User`/`RequestActivity`/`Notification` models + a fake
  `requestImageStorage`, injected directly into Node's `require.cache`
  before requiring the REAL, unmodified `controllers/request.controller.js`,
  `controllers/notification.controller.js`, `services/requestActivity.service.js`,
  and `services/notification.service.js`). Covered: Model/Service (schema
  validation, actor-exclusion self-notification guard, unrecognized-type
  guard - 10 checks), Assignment (6 checks), Reassignment (5 checks),
  Status workflow (7 checks, including the documented "closed is silent"
  rule and "rejected transition creates nothing"), Read state (7 checks,
  including idempotent mark-read and "another user cannot mark read"),
  Pagination (4 checks, including cross-recipient cursor rejection),
  Organization isolation (4 checks, including a direct notification-id
  guessing attack), a dedicated DOC-17 regression pass (5 checks
  confirming the Timeline still records exactly one activity per action
  and is never duplicated by a notification write), and a general
  regression pass (10 checks covering creation/status/edit/assignment/
  cancel validation, anti-enumeration, a simulated notification-write
  failure never blocking the underlying Request update, and response-shape
  safety) - **53 of 53 assertions passed, 0 failed.**
- **Backend module-graph verification**: `node -e "require('./src/app')"`
  loads cleanly with the new model, service, controller, and route wired
  in - no circular dependency, no startup migration or scheduler runs
  automatically.
- **Frontend build verification**: `npx vite build` completed with no
  errors.
- **Known limitations**: (1) no real MongoDB was available in this
  environment (same disclosed limitation as every prior ticket here) - the
  suite above is a mocked-model verification of the real controller/
  service logic, not a live-database integration test; the model's own
  schema was additionally verified in isolation via real Mongoose schema
  validation (`validateSync()`, no DB connection needed). (2) No overdue-
  SLA notification exists in this version - see "SLA / Overdue" above.
  (3) No `ROLE_CHANGED`/`PASSWORD_RESET_REQUIRED` notifications exist in
  this version - see "Notification types implemented" above. (4) There is
  no way for a user to permanently delete an old notification in this
  Sprint (by design, matching this project's "prefer preserving history"
  posture) - an inbox will grow over time; a future ticket could add
  either a bulk "clear read notifications" action or a retention policy if
  this becomes a real product need.

## Request Number / Human-Friendly ID (DOC-16)

A stable, human-friendly Request identifier (`REQ-000001`) shown to every
role alongside MongoDB's own `_id` - `_id` remains the sole internal
database identifier everywhere in this project (routing, foreign keys,
authorization); `requestNumber` is purely presentation metadata layered on
top of it.

- **`_id` vs. `requestNumber`, precisely**: `id` (the raw ObjectId,
  unchanged) is what the frontend still uses for every API call and every
  foreign key (`RequestActivity.requestId`, `Notification.requestId`,
  Comment's own request reference, image storage object keys) - none of
  those were touched by this ticket. `requestNumber` is a NEW, separate,
  purely display-oriented field - a user reading `REQ-000123` can never use
  it to bypass authorization (see "Security" below).
- **Format**: `REQ-` + the sequence number zero-padded to 6 digits
  (`REQ-000001` ... `REQ-999999`). A sequence beyond 999999 simply produces
  a longer numeric portion (`REQ-1000000`) rather than truncating or
  wrapping - this project has no realistic path to seven-digit Request
  volume; this is a defensive, not a functional, consideration. Uppercase,
  fixed prefix, immutable once assigned, generated server-side only - the
  frontend can never supply or edit it (`createRequest` never reads
  `body.requestNumber`; the schema field is also `immutable: true`,
  defense in depth).
- **Global, not per-Organization sequence**: one shared counter
  (`{key: 'request', seq}`) across the whole system, not one per
  Organization. Chosen deliberately (this ticket's own stated preference):
  simpler, no duplicate visible IDs across Organizations, easier
  cross-Organization support/debugging, and no need to combine an
  Organization code into every identifier. This is orthogonal to and does
  not weaken DOC-38's own Organization-isolation boundary anywhere - that
  boundary is still enforced entirely by `organizationId`, never by
  `requestNumber`. A future org-scoped identifier could reuse the exact
  same generic `Counter` collection with a different `key`, without
  disturbing any already-assigned, immutable `requestNumber`.
- **Atomic counter architecture**: `models/Counter.js` - a small, generic
  `{key, seq}` collection (not `RequestCounter` - intentionally reusable by
  any future feature needing its own atomic sequence, via a different
  `key`). `services/requestNumber.service.js` is the sole owner of turning
  it into a formatted `requestNumber`:
  - `getNextRequestNumber()` - a single atomic
    `Counter.findOneAndUpdate({key}, {$inc:{seq:1}}, {new:true, upsert:true})`.
    MongoDB guarantees single-document writes are atomic even on this
    project's own standalone (non-replica-set) `mongod` (see
    `config/db.js` - no transaction/session setup exists or is needed here,
    unlike the multi-document-write cases DOC-17/DOC-18 deliberately avoid
    making atomic). `upsert: true` means the very first call ever made
    creates the counter automatically, starting at `seq: 1` - no separate
    seed/bootstrap step. Never `Request.countDocuments() + 1` or "last
    Request + 1" - both are unsafe read-then-write races.
  - `ensureCounterAtLeast(minimumSeq)` - MIGRATION-ONLY, never used by live
    Request creation. Deliberately a simple read-then-conditionally-write
    (not a single atomic operation) - safe only because it is exclusively
    invoked by the manual, one-time migration script against a quiescent
    database. A naive atomic-looking
    `findOneAndUpdate({key, seq:{$lt:minimumSeq}}, {$set:{seq:minimumSeq}}, {upsert:true})`
    was deliberately NOT used - if the counter already exists with
    `seq >= minimumSeq`, the filter matches nothing, and `upsert: true`
    would then attempt to INSERT a second document, colliding with the
    existing unique `key` index. The safe read-then-write version avoids
    this entirely.
- **Sequence gaps are acceptable, duplicates are NOT (documented policy)**:
  `requestNumber` is allocated after every other validation/duplicate-
  detection check in `createRequest` has already passed, but before
  `Request.create()` runs - if allocation itself fails, no number was ever
  wasted on a Request that was never going to be created; if
  `Request.create()` fails AFTER a number was allocated, that exact number
  is simply never reused (`REQ-000101`, `REQ-000103` is a normal, expected
  outcome if 102's save failed) - uniqueness is the only guarantee this
  project makes, continuity is explicitly not one.
- **Request schema**: `requestNumber: {type: String, unique: true,
  sparse: true, immutable: true, trim: true, default: null}`. NOT
  `required: true` - Mongoose's `required` validator only runs on save,
  never retroactively against already-persisted documents, so every
  historical, pre-DOC-16 Request remains fully readable with zero startup
  migration (the same "COMPATIBILITY POLICY" pattern this project already
  established for `slaDueAt`/`slaPolicyHours`, DOC-55). `unique + sparse`
  together (not `unique` alone) is what allows many historical documents to
  simultaneously lack the field without violating uniqueness - MongoDB
  indexes a missing field as `null`, and a plain non-sparse unique index
  would incorrectly reject every Request after the first one missing it.
- **Creation flow failure handling**: if `getNextRequestNumber()` itself
  fails, Request creation is aborted safely (any already-uploaded S3/GridFS
  images for this attempt are cleaned up, matching this endpoint's existing
  rollback pattern) - a Request is never silently created without a
  `requestNumber` once this feature is active. If `Request.create()` then
  fails with a MongoDB duplicate-key error (code 11000) specifically on the
  `requestNumber` index (should not happen in practice - the counter is
  atomic and monotonically increasing - but handled defensively), the
  client receives a safe, generic message; the raw MongoDB error is never
  exposed.
- **API responses**: `requestNumber` is included in `sanitizeRequest` (the
  one shared response shape every list/detail endpoint already reuses -
  `GET /requests`, `GET /requests/:id`, `GET /requests/assigned`,
  `GET /requests/organization`, and every mutation response that already
  returns a Request) - `null` for a not-yet-migrated historical Request.
  `id` (the raw ObjectId) is still always included too - the frontend still
  needs it for API routing (task spec: "do not remove `_id` if internal
  frontend behavior depends on it"). The DOC-58 duplicate-detection
  candidate shape also now includes each candidate's own `requestNumber`.
- **Frontend display**: `RequestNumberBadge.jsx` - a small sibling to
  `RequestStatusBadge.jsx`/`RequestSlaBadge.jsx`, rendering nothing at all
  for a `null` `requestNumber` (the title alone is shown, exactly as before
  this ticket). Displayed inline within the existing title table cell in
  `RequestRow.jsx` (Employee + Operator dashboards) and
  `ManagerRequestRow.jsx` (Manager dashboard) - not as a new dedicated
  column, which would also require updating each table's `<thead>` and the
  expanded detail row's `colSpan`, a larger, riskier change than this
  ticket needs. Also shown in the DOC-58 duplicate-request confirm dialog.
  Raw ObjectIds were never displayed to any user anywhere in this project
  before this ticket (confirmed via a full frontend audit) - this feature
  is purely additive, not a fix for an existing leak.
- **Search**: `utils/requestQueryBuilder.js`'s existing `q` parameter's
  `$or` array (previously `[title, description]`) now also includes
  `requestNumber`, reusing the exact same case-insensitive,
  regex-escaped SUBSTRING match already established for title/description
  - no new query parameter, no special-casing. Searching the full
  `REQ-000123` matches exactly; searching a bare fragment like `000123`
  ALSO matches (a plain substring match), which is the same predictable
  "contains" semantics this search box already has for title/description -
  a deliberate, documented choice for consistency, not a numeric-specific
  rule. A historical Request with no `requestNumber` yet simply never
  matches this clause. Sorting was NOT extended to `requestNumber` -
  existing sort behavior (`createdAt`/`updatedAt`/`priority`/`status`/
  `title`/`slaDueAt`) is unaffected, per the task spec's "not required if
  it complicates current business sorting."
- **DOC-58 Duplicate Detection**: unaffected - still entirely
  title/category-based (EXACT/CONTAINS/OVERLAP normalized-title
  comparison). `requestNumber` is never used for duplicate matching; each
  duplicate Request created via "Create Anyway" still gets its own unique
  `requestNumber`.
- **DOC-55 SLA**: unaffected - `requestNumber` has no relationship to
  `createdAt`/`slaDueAt`/`slaPolicyHours`; the migration script never
  recalculates or touches any SLA field.
- **DOC-56/GridFS/S3 image storage**: unaffected - attachment storage
  continues referencing the internal Request `_id`; no image path/key was
  renamed because of this ticket.
- **DOC-13 Comments**: unaffected - Comments continue referencing
  `requestId` (the internal id); only human-facing UI may display
  `requestNumber`.
- **DOC-18 Notifications**: notification message TEXT now prefers
  `Request REQ-000123` over the pre-DOC-16 `"${title}"` quoted-title shape
  (a small shared `requestNotificationLabel(requestDoc)` helper in
  `request.controller.js`, used at every one of the existing DOC-18
  message call sites - assignment, reassignment, unassignment, work
  started, resolved, reopened, cancelled), falling back to the quoted
  title for a historical Request without a `requestNumber` yet. The
  notification's own `requestId` field (internal FK, used for
  navigation/authorization) is completely unchanged - still always the
  real ObjectId, never replaced by `requestNumber` (task spec: "do NOT
  replace requestId foreign-key behavior - requestNumber is presentation
  metadata").
- **DOC-17 Request Activity Timeline**: unaffected - `RequestActivity`'s
  own foreign keys were never touched, and `RequestActivityTimeline.jsx`
  does not display Request identity at all today (it only shows individual
  event descriptions like "Assigned to X" within an already-expanded row
  that shows the title/requestNumber at the row level) - so there was
  nothing to change here, and `requestNumber` was deliberately NOT
  duplicated into every timeline record (task spec: "do not duplicate
  requestNumber into every timeline record unless there is a real snapshot
  requirement" - there is not one here).
- **Security - human-friendly IDs are NEVER an authorization mechanism**:
  sequential numbers are inherently guessable. Knowing `REQ-000123` grants
  a user precisely nothing - every Request access path continues to run
  through the exact same authenticated-user + Organization-isolation +
  Request-access-rule chain as before this ticket, entirely independent of
  whether the caller knows a Request's `requestNumber`. No new
  `GET /requests/by-number/:requestNumber` (or similar) endpoint was
  added - the task spec explicitly prefers not adding one unless required,
  and no existing feature needed it. System Admin gains no new operational
  Request visibility through this ticket.
- **Migration script (optional, manual)**: `npm run migrate:request-numbers`
  (`scripts/migrateRequestNumbers.js`) - backfills `requestNumber` on every
  historical Request currently missing it. Ordered `createdAt` ascending,
  `_id` ascending as a tie-breaker (older Requests get lower numbers).
  Never runs automatically on server startup. Never overwrites a Request
  that already has a `requestNumber`. Never touches SLA or any other
  business field. Idempotent - a second run changes nothing, migrates
  nothing, and (because `ensureCounterAtLeast` only ever writes when the
  counter is genuinely behind) advances the counter zero additional times.
  After migrating, the shared counter is advanced to at least the TRUE
  maximum `requestNumber` across the entire Request collection (not merely
  the numbers this run happened to assign) - a small extra safety margin
  beyond the task spec's own minimum ask, so the very next NEW Request
  always continues the sequence correctly even if the counter and the
  Request collection were ever out of sync for any reason. A document that
  fails to save is reported (id + reason), left completely untouched, and
  is safely picked up (with a freshly-allocated number, never a reused
  one) the next time the script runs.
- **Test summary**: a temporary mocked test harness
  (`backend/__doc16_test.js`, deleted after this run) with fake in-memory
  `Counter`/`Request` stores injected directly into Node's `require.cache`
  before requiring the REAL, unmodified `services/requestNumber.service.js`,
  `scripts/migrateRequestNumbers.js`, `controllers/request.controller.js`,
  and `utils/requestQueryBuilder.js`. Covered: Model/Counter (8 checks -
  format/padding, atomic upsert-on-first-call, monotonic uniqueness,
  sequence-gap-never-repaired, `ensureCounterAtLeast`'s create/never-
  downgrade behavior, and a static schema/source-scan confirming
  `unique`+`sparse`+`immutable` and that the frontend can never supply
  `requestNumber`), Concurrency (4 checks - 10 concurrent allocations all
  unique, all format-valid, covering exactly `REQ-000001`..`REQ-000010`
  with no gaps/collisions, plus one check that explicitly DISCLOSES this
  mock cannot prove real MongoDB write atomicity - see Known limitations),
  Migration (9 checks - full backfill, skip-already-numbered, createdAt-
  ascending ordering, `_id` tie-break, field preservation, SLA
  untouched, counter correctly continues past the TRUE collection-wide
  maximum after migration, idempotent rerun, and a partial-failure case
  that leaves the failed Request unnumbered without blocking the rest or
  ever duplicating its allocated number), API response shape (6 checks -
  `requestNumber` present/`null`-fallback in `sanitizeRequest`, full
  pre-DOC-16 response shape regression, `sanitizeRequest` reuse breadth,
  duplicate-candidate shape, and the duplicate-key-11000 safe-error-message
  path), Search (5 checks - full-number match, bare-fragment substring
  match, title/description regression, combined `$or` correctness, and
  role/Organization base-scope preservation), Notification integration (5
  checks - label preference, historical fallback, non-empty regression,
  every message call site converted, and the internal `requestId` FK
  regression), Timeline integration (5 checks, all static/regression -
  `recordRequestActivity` call sites intact, the Timeline component
  deliberately unchanged, `RequestActivity`/its service untouched, the
  DOC-17 endpoint handler unrenamed, and the Timeline still keyed by
  internal `id` never `requestNumber`), and full regression/module-load (6
  checks - Counter/Request/migration-script/controller/routes all load
  cleanly, and a static check confirming no `by-number` lookup route was
  added) - **48 of 48 assertions passed, 0 failed.**
- **Backend module-graph verification**: `node -c` syntax-checked every
  modified/new file individually
  (`controllers/request.controller.js`, `models/Request.js`,
  `models/Counter.js`, `services/requestNumber.service.js`,
  `utils/requestQueryBuilder.js`, `scripts/migrateRequestNumbers.js`,
  `app.js`, `routes/request.routes.js`) - all passed. The test harness
  above additionally required `app.js`, both Request/Notification route
  files, and the full controller dependency graph directly (Category H) -
  no circular dependency, no startup migration or scheduler runs
  automatically, zero new routes were registered.
- **Frontend build verification**: `npx vite build` completed with no
  errors (69 modules transformed).
- **Known limitations**: (1) no real MongoDB was available in this
  environment (same disclosed limitation as every prior ticket here) - the
  concurrency test above proves `getNextRequestNumber()`'s OWN LOGIC is
  correct (called N times, in-memory, it produces N unique sequential
  results); it does NOT independently re-verify MongoDB's own
  `findOneAndUpdate` atomicity guarantee under genuine concurrent writes
  from multiple real connections/processes - that guarantee is
  well-established, documented MongoDB behavior (single-document writes
  are atomic even on a standalone `mongod`), relied upon here but not
  reproven by a mock, exactly as the task spec itself anticipates ("If real
  MongoDB isn't available, disclose the limitation"). (2) `requestNumber`
  sorting was not added to Request search/filter/sort (see "Search"
  above) - deliberately out of scope, not a bug. (3) The optional
  migration script was exercised only against the mocked test harness
  above, never against a real MongoDB instance, for the same reason as
  (1).

## Advanced Request History & Reassignment (DOC-15)

Extends DOC-17's existing Request Activity Timeline with an auditable
reassignment/unassignment workflow. Deliberately does NOT replace DOC-17,
does NOT introduce a second competing history collection, and does NOT
redesign Request assignment from scratch - it extends the two pre-existing
assignment endpoints in place.

- **Audit findings (before any code changed)**: two independent,
  overlapping endpoints already implemented assignment logic -
  `PATCH /:id/assign` (`assignRequestOperator`) and `PATCH /:id/manager`
  (`managerUpdateRequest`, DOC-59's combined priority/category/operator
  edit endpoint). Both already recorded DOC-17 `ASSIGNED`/`REASSIGNED`/
  `UNASSIGNED` activity with basic operator name metadata, both already
  sent DOC-18 notifications, both were already restricted to
  `status === 'open'` only, and both already rejected reassigning to the
  identical currently-assigned operator as a no-op (DOC-22, pre-existing,
  not new here). Removing either endpoint would violate "do not redesign
  assignment from scratch"; extending only one would let the other bypass
  the new reason requirement entirely - so DOC-15 extends BOTH, in
  parallel, with byte-for-byte-identical reason-enforcement rules, rather
  than consolidating them into one.
- **Backend determines the operation, never the client**: the request body
  is simply `{operatorId, reason}` (`operatorId` may be a valid ObjectId
  string, or explicit `null` for unassignment; `reason` is optional/ignored
  unless the classification below requires it). The controller classifies
  ASSIGNED vs. REASSIGNED vs. UNASSIGNED purely by comparing `operatorId`
  against the Request's OWN current `assignedOperatorId` (server-side,
  trusted) - the frontend can never claim "this is a reassignment" and can
  never send `previousOperatorId`, `actorId`, `organizationId`, activity
  `type`, or `createdAt`; all of those are derived server-side.
  - No current operator + `operatorId` → **ASSIGNED** (first assignment;
    `reason` ignored even if sent).
  - Current operator + a DIFFERENT `operatorId` → **REASSIGNED**
    (`reason` required).
  - Current operator + `operatorId: null` → **UNASSIGNED** (`reason`
    required).
  - Current operator + the SAME `operatorId` → rejected as a no-op before
    any reason validation, `RequestActivity`, or `Notification` is ever
    touched (DOC-22, preserved unchanged).
- **Reason validation** - `utils/requestFieldValidation.js`'s new
  `validateAssignmentReason`, deliberately mirroring the project's existing
  `validateCancelReason` (DOC-59) bounds exactly: required, must be a
  string, trimmed, `3`-`500` characters, whitespace-only rejected. Never
  exposes a raw Mongoose/MongoDB validation error to the client - always a
  generic, safe message. Enforced identically in both
  `assignRequestOperator` and `managerUpdateRequest`.
- **Status gating - preserved exactly, no new transitions invented**: the
  audit above found assignment/reassignment/unassignment were ALL already
  restricted to `status === 'open'` in both pre-existing endpoints; DOC-15
  changes nothing here - an `in_progress`/`resolved`/`closed`/`cancelled`
  Request still cannot be assigned, reassigned, or unassigned, exactly as
  before this ticket.
- **Operator validation - unweakened**: the existing eligibility query
  (same Organization, `role === 'operator'`, `active`, `specialties`
  containing the Request's `category`) is completely unchanged. DOC-15
  adds zero new bypass paths - an ineligible operator is rejected with the
  same generic error as before, before reason validation is ever reached.
- **`RequestActivity.metadata` shape** (a pre-existing free-form Mongoose
  `Mixed` field - no schema migration needed):
  - `ASSIGNED`: `{newOperatorId, newOperatorName}` - unchanged from
    pre-DOC-15 (a first assignment has no previous operator or reason to
    record).
  - `REASSIGNED`: `{previousOperatorId, previousOperatorName,
    newOperatorId, newOperatorName, reason}` - extended with `reason` and
    explicit `previousOperatorId`/`newOperatorId` (previously name-only).
  - `UNASSIGNED`: `{previousOperatorId, previousOperatorName, reason}` -
    extended with `reason`.
  - Only id + display-name snapshots are ever stored - never a full `User`
    document, never an email, never a password. Storing the display-name
    snapshot (not just the id) is deliberate, for timeline readability even
    if the operator's name/status later changes - the task spec explicitly
    accepts this trade-off.
- **Notifications (DOC-18) - reason is deliberately NEVER included in
  message text.** All three existing notification recipients/triggers are
  unchanged (Employee always notified; new Operator always notified;
  previous Operator notified only on a genuine reassignment, never on a
  first assignment). The reassignment/unassignment `reason` lives ONLY in
  `RequestActivity.metadata`, visible on the Timeline - not duplicated into
  notification text. This was a deliberate choice (task spec's own stated
  preference), not an oversight: a reassignment reason ("Ahmad is
  unavailable") can reference sensitive operational/performance context
  that is appropriate for a Manager-visible audit trail but not necessarily
  for a push-style notification the affected Operator/Employee receives.
  `requestNotificationLabel()` (DOC-16) is still used at every call site
  unchanged, so messages continue reading "Request REQ-000123 ...".
- **SLA (DOC-55) - untouched by design**: reassignment/unassignment never
  writes `createdAt`, `slaDueAt`, or `slaPolicyHours`. Verified explicitly
  in the test suite (Category F) - the SLA clock never resets on
  reassignment.
- **Status - never silently changed**: DOC-15 does not alter
  `Request.status` as a side effect of assignment/reassignment/
  unassignment - this matches the pre-existing, audited behavior; no new
  status transition was invented.
- **Images (DOC-56) / Comments (DOC-13) - untouched**: reassignment never
  deletes or alters Before/Completion Images (`uploadedBy` metadata
  preserved) or Comments; no automatic comment is inserted for an
  assignment change - the Timeline entry is the sole record.
- **Audit immutability**: once a `REASSIGNED`/`UNASSIGNED` activity is
  created, there is no endpoint that can edit its `reason` or any other
  field afterward - history remains strictly append-only, exactly like
  every other DOC-17 activity type.
- **Failure strategy - unchanged from DOC-17/DOC-18's existing best-effort
  pattern**: the assignment/reassignment/unassignment business operation
  (updating `assignedOperatorId`) is primary; `RequestActivity` creation and
  `Notification` creation remain secondary, best-effort side effects - a
  failure to write the Timeline entry or send a notification never causes
  the assignment operation itself to be reported as failed to the client.
  No new transaction architecture was introduced.
- **Authorization**: unchanged - only the Request's own Organization's
  Manager may assign/reassign/unassign; Employee, Operator, and System
  Admin are all rejected (role check, pre-existing); a Manager from a
  different Organization is rejected (Organization-isolation check,
  pre-existing). DOC-15 adds no new authorization surface - it only adds
  validation (`reason`) on top of the exact same authorization gate both
  endpoints already had.
- **Test summary**: a temporary mocked test harness
  (`backend/__doc15_test.js`, deleted after this run) with fake in-memory
  `Request`/`User`/`ServiceCategory` stores and fake `requestActivity.service`/
  `notification.service` spies injected into Node's `require.cache` before
  requiring the REAL, unmodified `request.controller.js`. Covered: First
  Assignment (7 checks), Reassignment including reason edge cases - empty/
  whitespace-only/too-short/too-long/valid (14 checks), Same-Operator
  no-op rejection (4 checks), Unassignment including reason edge cases (9
  checks), Operator validation - inactive/wrong-specialty/wrong-role/
  cross-org (8 checks), Status-gating regression across all non-`open`
  statuses (6 checks), Authorization/role/Organization-isolation (3
  checks), `managerUpdateRequest` parity with `assignRequestOperator` (7
  checks), DOC-16 `requestNumber` integration (4 checks), audit
  immutability/failure-strategy/notification-reason-exclusion (3 checks),
  and full regression/module-load (7 checks) - **72 of 72 assertions
  passed, 0 failed.**
- **Backend module-graph verification**: `node -c` syntax-checked
  `controllers/request.controller.js` and `utils/requestFieldValidation.js`
  individually - both passed; `app.js` and the full controller dependency
  graph load cleanly (see "Backend verification" below).
- **Known limitations**: (1) no real MongoDB was available in this
  environment (same disclosed limitation as every prior ticket here) - the
  mocked harness proves the controller's OWN logic (classification, reason
  enforcement, metadata shape, notification/timeline call sites) is
  correct; it does not independently reprove MongoDB's own read/write
  guarantees. (2) The optional "Assignment History" view (task spec section
  18) was not built as a separate UI - the existing
  `RequestActivityTimeline.jsx` (extended, not replaced) already serves
  this purpose by filtering to `ASSIGNED`/`REASSIGNED`/`UNASSIGNED` events
  inline; a dedicated standalone view was judged unnecessary scope beyond
  what the ticket requires.

## Request Reports & CSV Export (DOC-67)

Manager-only CSV export of Organization Requests, reusing DOC-54's existing
search/filter/sort query logic exactly - not a second, competing reporting
system.

- **Audit findings**: DOC-54's `buildRequestQuery` (`utils/requestQueryBuilder.js`)
  already centralizes every filter (`q`, `status`, `priority`, `categoryId`,
  `assignedOperatorId`, `createdBy`, `createdFrom`/`createdTo`, sort) behind
  one function, shared by `listMyRequests`/`listOrganizationRequests`/
  `listAssignedRequests`. DOC-53's statistics endpoints are entirely
  separate and untouched. This ticket adds a fourth caller of the exact
  same helper rather than building a parallel filter implementation.
- **Endpoint**: `GET /api/requests/organization/export`, registered
  immediately alongside `GET /api/requests/organization` in
  `routes/request.routes.js`, ahead of the blanket Employee-only gate (same
  reason as every other Manager-only pre-gate route on this router). Query
  parameters are the identical DOC-54 vocabulary (`q`, `status`, `priority`,
  `categoryId`, `assignedOperatorId` including `"unassigned"`, `createdBy`,
  `createdFrom`/`createdTo`, `sortBy`/`sortOrder`) - e.g.
  `GET /api/requests/organization/export?status=open&priority=high&q=network`.
- **Authorization**: `requireRole('manager')` + `requireOrganizationMembership`
  + `requireActiveOrganization` - the exact same three-part chain
  `GET /organization` already uses. Employee/Operator/System Admin tokens
  never reach the controller at all. `organizationId` is read only from
  `req.user.organizationId` (the authenticated Manager's own, DB-verified
  Organization) - never from the query string or body; the controller's
  `baseQuery` hardcodes it as the very first key, exactly like
  `listOrganizationRequests`.
- **DOC-54 consistency (critical, explicitly verified in tests)**: the
  export handler calls `buildRequestQuery`/`fetchSortedRequests`/
  `buildRequestEnrichmentMaps`/`buildCreatorMap` - the SAME functions,
  called the SAME way, as `listOrganizationRequests` - so the normal
  Manager list and the exported CSV return the identical logical Request
  set for identical filters. There is no second query-interpretation layer
  anywhere in this feature.
- **CSV columns** (in order): Request Number, Title, Employee, Operator,
  Category, Priority, Status, Created At, Updated At, SLA Due At, SLA
  Status, Resolved At, Closed At, Cancellation Reason. Deliberately
  excludes: raw MongoDB ObjectId as a primary identifier, password/
  passwordHash/JWT, organization internal id, S3 objectKey/GridFS fileId/
  image binary, Comments, and full RequestActivity history - this is a
  high-level Request report, not an attachment or audit-log export.
- **RequestNumber (DOC-16)**: `requestNumber || 'N/A'` - a historical
  Request without one yet exports safely with the neutral fallback, never
  the raw ObjectId.
- **User/Operator/Category population**: human-readable names only -
  `createdBy.fullName` (Employee), `assignedTo.fullName` (Operator, or
  `'Unassigned'` if none), Category `name` - never an id. A reference that
  can no longer be resolved (deleted/unreachable, defensive-only - Users
  and Categories are never hard-deleted in this project) exports
  `'Unknown User'`/`'Unknown Category'` rather than crashing the export.
- **SLA integration (DOC-55) - no second calculation**: `SLA Due At` reuses
  `computeSlaSummary`'s own `dueAt`. `SLA Status` is a new, six-value
  export-specific classification (`on_track`/`due_soon`/`overdue`/
  `completed_on_time`/`completed_late`/`unavailable`) added to
  `utils/slaPolicy.js` as `classifyExportSlaStatus` - a thin wrapper around
  the EXISTING `classifySlaBucket` (on_track/due_soon/overdue/unavailable
  pass through unchanged) that only further splits its `'completed'`
  bucket into on-time/late, reusing the EXACT SAME `resolvedAt <=
  slaDueAt` comparison `utils/requestStatistics.js` already uses for SLA
  compliance - never a second, independent SLA implementation. Falls back
  to `closedAt`, then `cancelledAt`, when `resolvedAt` is absent (e.g. a
  cancelled Request); defaults to `completed_late` in the (should-not-occur)
  case none of the three exist, a deliberately conservative choice - an
  indeterminate row is flagged for review rather than silently marked
  compliant.
- **CSV escaping**: `utils/csvExport.js`'s `escapeCsvField` - RFC 4180
  rules (a field containing a comma, double quote, or any newline is
  wrapped in double quotes, with embedded double quotes doubled). No
  third-party CSV library was added (none was already a project
  dependency, and RFC 4180 escaping is a handful of well-known rules -
  see that file's own header comment).
- **Formula-injection protection (task spec section 13)**: `sanitizeCsvCell`
  prefixes a cell with a leading apostrophe when its text begins with `=`,
  `+`, `-`, `@`, a tab, or a carriage return - the task spec's own
  suggested strategy, extended slightly beyond its minimum `=`/`+`/`@` list
  to match the standard, widely-cited OWASP CSV Injection mitigation list
  at zero cost to any ordinary value. Applied before RFC 4180 quoting, so
  the apostrophe itself is correctly escaped/quoted like any other
  character.
- **UTF-8 / Hebrew / Arabic**: the response body is UTF-8 throughout; a
  leading UTF-8 BOM (`﻿`) is prepended specifically for Microsoft
  Excel compatibility (Excel does not reliably auto-detect a BOM-less
  UTF-8 CSV and can mis-render non-ASCII text otherwise) - every other
  modern CSV consumer tolerates a leading BOM without issue. Verified in
  tests with real Hebrew and Arabic titles round-tripping byte-for-byte.
- **Export size policy (documented, deliberate choice)**: `MAX_EXPORT_ROWS
  = 5000`. A matched-count that exceeds this ceiling is rejected up front
  with a clear 400 error asking the Manager to narrow their filters -
  never a silently truncated file that looks complete but omits data (task
  spec's own explicit preference: "report clearly rather than silently
  truncating"). No pagination-driven partial export either - a
  filter combination matching 5,000 or fewer Requests always returns the
  COMPLETE matching set in one file.
- **Streaming vs. memory (documented, deliberate choice)**: generated as a
  single in-memory string and sent directly as the HTTP response body - no
  chunked streaming pipeline, matching this project's own established
  "keep it simple, this project's scale doesn't need it" precedent (the
  same reasoning `requestQueryBuilder.js` already documents for avoiding
  an aggregation pipeline). No temporary file is ever written to disk.
- **Empty-result behavior (documented, deliberate choice)**: a filter
  combination matching zero Requests still returns HTTP 200 with a valid,
  headers-only CSV (the column header row, zero data rows) - never a
  404/empty-body response. Chosen as the cleaner of the two options the
  task spec itself offers for a reporting endpoint.
- **Date format**: ISO 8601 throughout (`2026-08-16T14:25:00.000Z`) for
  every timestamp column - deliberately machine-friendly, never
  locale-formatted server-side (that remains a frontend-only presentation
  choice elsewhere in this project, e.g. `RequestActivityTimeline.jsx`'s
  own `toLocaleString()`). Frontend/users may open the file directly in
  Excel or Google Sheets, both of which parse this format correctly.
- **DOC-53 Statistics - untouched**: the export shares zero code with the
  statistics endpoints; exporting never recalculates or refreshes the
  dashboard's stat cards.
- **DOC-18 Notifications / DOC-17 Timeline - untouched**: exporting a CSV
  is not a business event and creates no Notification and no
  RequestActivity entry - verified directly in tests (zero calls to either
  service across every export scenario tested, including filtered and
  empty-result exports).
- **DOC-15 regression**: the Operator column always reflects the Request's
  CURRENT `assignedOperatorId` (exactly like every other read path in this
  project) - a prior reassignment's own reason/history is never read or
  exposed by this export; RequestActivity's own append-only audit trail is
  completely unaffected.
- **Test summary**: a temporary mocked test harness
  (`backend/__doc67_test.js`, deleted after this run) with fake in-memory
  `Request`/`User`/`ServiceCategory` stores and fake `requestActivity.service`/
  `notification.service` spies injected into Node's `require.cache` before
  requiring the REAL, unmodified `request.controller.js` and
  `utils/requestQueryBuilder.js`. Covered: Authorization (6 checks -
  `requireRole('manager')` for all four roles, route-chain static
  verification, cross-Organization isolation with a forged
  `organizationId` query param), Filters (9 checks - every DOC-54 filter
  individually, combined filters, sorting), CSV Data (10 checks - every
  column populated correctly), CSV Format (9 checks - comma/quote/newline
  escaping, Hebrew, Arabic, UTF-8 byte-level BOM verification, formula-
  injection neutralization, Content-Type/Content-Disposition headers),
  Edge Cases (8 checks - zero results, missing requestNumber/Operator/
  User/Category references, cancelled/closed/open Requests), DOC-54
  consistency (3 checks, including a byte-for-byte Request-set comparison
  between the list endpoint and the export for identical filters), DOC-55
  SLA regression (4 checks - overdue/due-soon/completed-on-time/completed-
  late all matching the existing SLA calculation), DOC-16 regression (3
  checks), DOC-17/DOC-18 regression (4 checks - zero Timeline events,
  zero Notifications, across normal/filtered/empty-result exports), DOC-15
  regression (3 checks, including a simulated reassignment proving the
  export always reflects current, not historical, assignment), and full
  regression/module-load (7 checks, including the `MAX_EXPORT_ROWS`
  ceiling actually rejecting a 5,001-row matched set with a clear error) -
  **66 of 66 assertions passed, 0 failed.**
- **Backend module-graph verification**: `node -c` syntax-checked
  `controllers/request.controller.js`, `routes/request.routes.js`,
  `utils/csvExport.js`, and `utils/slaPolicy.js` individually - all
  passed; `app.js` loads cleanly with the new route registered, no
  circular dependency, no startup job.
- **Frontend build verification**: `npx vite build` completed with no
  errors (69 modules transformed).
- **Known limitations**: (1) no real MongoDB was available in this
  environment (same disclosed limitation as every prior ticket here) - the
  mocked harness proves the controller's own filter/CSV-building logic is
  correct; it does not independently reprove `Request.countDocuments`'s
  real-MongoDB behavior at the `MAX_EXPORT_ROWS` boundary. (2) PDF/Excel
  export were explicitly out of scope for this ticket (task spec: "Do NOT
  add PDF or Excel export in this ticket. CSV only.") and were not built.
  (3) DOC-68 Audit Log (recording that an export happened) was explicitly
  out of scope (task spec section 25) and was not built.

## Error & UX Hardening (DOC-69)

Frontend-focused ticket (see `frontend/README.md`'s own "Error & UX
Hardening" section for the full writeup) - backend changes were audited,
not made, because the existing error contract already satisfied every
backend-facing requirement in the task spec:

- **`middleware/errorHandler.js`** (pre-existing, unchanged): any error
  resolving to a 5xx always returns the generic `{status: 'error',
  message: 'Internal Server Error'}` - the real error (stack trace
  included) is only ever `console.error`'d server-side, never sent to a
  client. A 4xx keeps its real, already-client-safe message (every
  controller in this project already writes 4xx messages meant to be
  shown to a user - see e.g. `utils/requestFieldValidation.js`). Verified
  directly in this ticket's own test pass: a simulated 500 through this
  handler produces exactly `{"message":"Internal Server Error"}`, with no
  trace of the original error text anywhere in the response body.
- **`middleware/notFound.js`** (pre-existing, unchanged): any unmatched
  API route already returns clean JSON (`{status: 'error', message:
  'Route not found: ...'}`), never an HTML 404 page - task spec section
  36's own ask was already satisfied.
- **No logging changes were needed**: this project's existing logging
  discipline (`console.error` only, server-side only, only for genuine
  5xx-worthy failures) already excludes passwords/tokens/secrets/request
  bodies from ever being logged - audited, not touched.

## Audit Log (DOC-64)

A separate, immutable, administrative-only collection answering "who
performed an administrative action, what changed, on which entity, and
when?" - Organization lifecycle, Manager account-management actions,
Organization Settings, and self-service Profile changes.

**NOT the Request Activity Timeline.** DOC-17's `RequestActivity` answers
"what happened to THIS Request?" and stays completely untouched by this
ticket - no file under that feature was modified, and `AuditLog.
AUDIT_ACTIONS` shares zero values with `RequestActivity.ACTIVITY_TYPES`
(verified by an automated test). The default classification rule this
ticket applied throughout: **Request operational history stays in
RequestActivity; administrative account/Organization changes go in
AuditLog; never both, without a documented strong reason** - none was
found for any Request lifecycle action (assignment, reassignment, cancel,
close, status, images, comments all remain RequestActivity-only, exactly
as before).

### Classification (task spec section 1)

| Action | Where it's recorded |
| --- | --- |
| System Admin: create/activate/deactivate/delete Organization, regenerate company code, assign/replace Manager | **AuditLog** |
| Manager: role change, deactivate/reactivate user, reset password, change specialties, create/rename/activate/deactivate Service Category, Organization Settings update | **AuditLog** |
| Self-service: Profile `fullName` update (DOC-62) | **AuditLog** |
| Self-service: Change Password | **Deferred** - see below |
| Manager-edited Employee/Operator `fullName`/`email` (DOC-50) | **Neither** - see below |
| Request creation/assignment/reassignment/status/cancel/close/images/comments (Manager or otherwise) | **RequestActivity only** (DOC-17) - never duplicated |

**Deliberately deferred**: self-service `PATCH /api/auth/change-password`
does **not** record an audit entry in this pass (task spec section 24
explicitly allows deferring "if this expands scope too much" - it does not
touch `auth.controller.js` at all, keeping this already-critical,
already-audited security file completely unmodified by this ticket). A
`USER_PASSWORD_RESET` entry (the Manager-driven equivalent) IS recorded -
see below - so password-reset activity by a Manager is fully covered; only
a person changing their own password voluntarily is not yet logged. If
this is wanted later, `changePassword`'s own `.save()` success is the one
place to add it, following the exact same pattern `USER_PASSWORD_RESET`
already establishes (`changes: null`, safe identity-only metadata).

**Deliberately NOT logged**: DOC-50's `updateUserProfile` (a Manager
editing an Employee/Operator's own `fullName`/`email`) is not in the task
spec's own action enum and was not in its section-1 audit-scope list
either - left out to avoid "adding actions blindly" (task spec section 6).
It can be added later as a new action type following the same pattern used
throughout this ticket, without any architectural change.

### AuditLog model (`models/AuditLog.js`)

```
{
  _id,
  organizationId,   // the AFFECTED Organization when one exists, else null
  actorId,          // always req.user.userId - never req.body
  action,           // controlled enum, AUDIT_ACTIONS
  targetType,       // 'Organization' | 'User' | 'ServiceCategory'
  targetId,
  changes,          // { field: { from, to } } for ONLY changed fields, or null
  metadata,         // small, safe, structured extra context
  createdAt,        // server time only (timestamps: { createdAt: true, updatedAt: false })
}
```

Three indexes, matching the task spec's own suggested set exactly:
`{ organizationId: 1, createdAt: -1 }`, `{ actorId: 1, createdAt: -1 }`,
`{ action: 1, createdAt: -1 }`.

**19 action types implemented** (`AUDIT_ACTIONS`): `ORGANIZATION_CREATED`,
`ORGANIZATION_UPDATED`, `ORGANIZATION_ACTIVATED`,
`ORGANIZATION_DEACTIVATED`, `ORGANIZATION_DELETED`,
`COMPANY_CODE_REGENERATED`, `MANAGER_ASSIGNED`, `MANAGER_REPLACED`,
`USER_ROLE_CHANGED`, `USER_DEACTIVATED`, `USER_REACTIVATED`,
`USER_PASSWORD_RESET`, `USER_SPECIALTIES_CHANGED`,
`SERVICE_CATEGORY_CREATED`, `SERVICE_CATEGORY_UPDATED`,
`SERVICE_CATEGORY_ACTIVATED`, `SERVICE_CATEGORY_DEACTIVATED`,
`ORGANIZATION_SETTINGS_UPDATED`, `PROFILE_UPDATED`. All 18 of the task
spec's own "at minimum consider" list are implemented, plus one deliberate,
justified addition - `ORGANIZATION_DELETED` - covering DOC-47's real,
existing hard-delete functionality, which the task spec's own audit
instructions explicitly asked to be inspected ("any Organization deletion
behavior if it exists").

### Audit service (`services/auditLog.service.js`)

The sole owner of every `AuditLog.create(...)` call - no controller calls
the model directly. `recordAuditLog({ actorId, organizationId, action,
targetType, targetId, changes, metadata })`:

- Validates `action` against `AUDIT_ACTIONS` and `targetType` against
  `TARGET_TYPES` - an unrecognized value is rejected (logged server-side,
  never written).
- Runs both `changes` and `metadata` through `sanitizeStructuredData` - a
  recursive, depth-limited filter that drops any key whose lowercased name
  contains a sensitive substring (`password`, `secret`, `jwt`, `token`,
  `credential`, `mongodb_uri`/`mongo_uri`, `aws`, `accesskey`,
  `privatekey`, `tls`, `apikey`, ...) - defense in depth on top of every
  call site already passing small, hand-curated, safe objects (never
  `req.body`).
- **Never throws.** Mirrors DOC-17/DOC-18's own documented failure
  strategy exactly (task spec section 12/30): the underlying administrative
  business write is always already fully committed BEFORE this is ever
  called, and any failure here (a bad action/targetType, a database error)
  is caught, logged via `console.error` server-side (never leaking
  metadata to the client - the caller's own response is independent of
  this outcome), and resolved to `null`. A rare audit-write failure
  therefore never rolls back, blocks, or falsely reports failure for an
  administrative action that actually succeeded - this project
  deliberately does not use MongoDB multi-document transactions to make
  the pair atomic, for the same standalone-`mongod`-compatibility reason
  DOC-17/DOC-18 already documented.

### Sensitive-data handling (task spec sections 7/8/10 - CRITICAL)

- **`USER_PASSWORD_RESET`**: `changes` is always `null` (there is no safe
  "from/to" for a password); `metadata` is limited to
  `{ targetUserId, targetUserName }` only. Never a plaintext password,
  temporary password, or `passwordHash`, anywhere.
- **`COMPANY_CODE_REGENERATED`**: `changes` is always
  `{ companyCodeChanged: true }` - the actual old/new company code values
  are never stored, verified directly by an automated test that serializes
  the entry and confirms neither code string appears anywhere in it.
- **Central sanitization** (`sanitizeStructuredData`) is a second,
  independent safety net beyond "every call site already passes safe data"
  - see above.

### Organization audit behavior

Every real System Admin Organization action records exactly one audit
event per distinct fact (task spec section 13: "prefer one meaningful
audit event per administrative action") - a single `PATCH
/api/organizations/:id` that changes both `name` and `isActive` in one
call correctly produces TWO entries (`ORGANIZATION_UPDATED` +
`ORGANIZATION_ACTIVATED`/`DEACTIVATED`), never one vague combined event.
`createOrganization` records `ORGANIZATION_CREATED` always, plus a
separate `MANAGER_ASSIGNED` only when an initial Manager was actually
created in the same call. `assignManager`/`replaceManager` record
`MANAGER_ASSIGNED`/`MANAGER_REPLACED` with safe manager identities
(`fullName`/`id`) only. `deleteOrganization` records
`ORGANIZATION_DELETED` with the Organization's own id/name (the id is
retained in the audit entry even though the document itself no longer
exists - the read API's target-display logic already degrades gracefully
for this, reading the name from the entry's own snapshotted `metadata`,
never a live lookup).

### Manager assignment / user-management audit behavior

`updateUserRole` (`USER_ROLE_CHANGED`), `updateUserStatus`
(`USER_DEACTIVATED`/`USER_REACTIVATED`, only when the value genuinely
changed - the endpoint's own idempotent-retry behavior never produces
duplicate entries), `resetUserPassword` (`USER_PASSWORD_RESET`, see above),
and `updateUserSpecialties` (`USER_SPECIALTIES_CHANGED`, storing resolved
Category **names** before/after, never full Category documents or ids
alone) all record one entry each, after their own business write already
succeeded. A rejected/invalid request (bad role transition, malformed
`isActive`, etc.) never reaches the `recordAuditLog` call at all - verified
directly by automated tests asserting zero new entries after a 400
response.

### Organization Settings (DOC-61) audit behavior

`updateMyOrganization`'s audit entry (`ORGANIZATION_SETTINGS_UPDATED`)
includes **only the fields that actually changed** - a before/after
snapshot is taken for every field present in the request BEFORE the
update is applied, then compared against the saved value; a field
re-sent with its already-current value is silently excluded from
`changes`, and if NOTHING genuinely changed, no audit entry is written at
all (verified: exactly one entry for one genuine settings change). The
existing DOC-61 protections (`companyCode`/`isActive`/`createdAt`/etc.
hard-rejected before any field is even looked at) are completely
unaffected by this addition - a rejected forbidden-field request still
creates zero audit entries.

### User Profile (DOC-62) audit behavior

`updateMyProfile`'s audit entry (`PROFILE_UPDATED`) is recorded only when
`fullName` genuinely changed (an unchanged re-save creates no entry).
`actorId` and the target User are the SAME person here by design - unlike
Notification's own actor-exclusion rule, Audit Log has no such
restriction: "Manager Mahmoud updated own profile" is exactly the fact
this collection exists to answer. `organizationId` is
`req.user.organizationId` (`null` for System Admin's own self-profile
edit, which is genuinely platform-level). No DOC-18 Notification is
created for this (unchanged - this endpoint never created one before this
ticket either).

### Read API (`GET /api/audit-logs`)

Manager and System Admin only - `routes/auditLog.routes.js` composes
`requireRole('manager', 'system_admin')`; Employee/Operator are
structurally rejected before the controller is ever reached.

- **Manager**: always scoped to `req.user.organizationId` - any
  `?organization=` query value a Manager sends is simply never read (task
  spec section 27: "Do not accept arbitrary organizationId from Manager").
- **System Admin**: platform-wide by default; may narrow to one
  Organization via a validated `?organization=<id>` (400 if malformed or
  unresolvable).
- **Filters**: `action`, `targetType`, `actor` (a user id), `createdFrom`/
  `createdTo` (reuses DOC-54's own `buildCreatedAtRangeFilter` - the exact
  same date-range semantics every Request search control already uses).
- **Pagination**: `limit` (1-100, default 20) / `before` (cursor by audit
  log id), newest-first - the identical shape DOC-18's own
  `GET /api/notifications` already established. The `before` cursor is
  re-validated against the SAME scoping query the rest of the request
  already uses, so a Manager can never use a cursor id from another
  Organization to page past their own boundary, even if they somehow
  obtained a real id belonging to it.
- **Response shape**: `{ id, action, actor: {id, fullName, role},
  targetType, target: {id, displayName}, changes, metadata, organizationId,
  createdAt }`. `actor` is resolved via one batched `User.find({_id:
  {$in:...}})` per page (never N+1); a historical actor that cannot be
  resolved falls back to `{fullName: 'Unknown user', role: null}`, the
  same defensive shape DOC-18's own actor resolution already uses. `target
  .displayName` is read directly from the entry's own already-safe
  `metadata` (`organizationName`/`targetUserName`/`categoryName`, each
  snapshotted at write time by the call site that created it) rather than
  a live lookup by `targetId` - this is what lets a DELETED target (e.g. an
  `ORGANIZATION_DELETED` entry) still show a meaningful name.

### Immutability (task spec section 36)

`routes/auditLog.routes.js` defines exactly one route - `GET /`. There is
no `PATCH`/`PUT`/`POST`/`DELETE` anywhere on this router, for any role,
including System Admin - verified directly by an automated test that reads
the route file's own source and confirms none of those method calls are
present.

### Historical data (task spec section 37)

Administrative actions performed before this ticket shipped have no
corresponding AuditLog entry - there is no backfill script, and nothing
runs automatically on startup (`app.js` requires no migration for this
model).

### Failure strategy (task spec section 12)

See `services/auditLog.service.js`'s own top comment (summarized above) -
every audit write happens strictly AFTER its business operation has
already succeeded, never blocks or conditions the client's response on
its own outcome, and never throws. **Known limitation, disclosed rather
than hidden**: in the rare case an audit write itself fails (e.g. a
transient database error at exactly the wrong moment), the underlying
administrative action still fully succeeds and is reported to the client
as successful, but that one action will have no corresponding AuditLog
entry - there is no retry queue or dead-letter mechanism in this version.
This mirrors the identical, already-accepted trade-off DOC-17/DOC-18 made
for Request activity/notifications, for the identical reason (no MongoDB
multi-document transaction support assumed).

## DOC-66 - Final Security & End-to-End Hardening

A system-wide, read-mostly audit and verification pass over the entire
application - not a new feature. Goal: validate authorization boundaries,
multi-organization isolation, and close any remaining security gaps before
final review. Full methodology and the 63-item structured result are in
the DOC-66 final report delivered in-conversation; this section records
only the findings that change what an operator/reviewer needs to know.

**Result: no critical or high-severity defect was found.** The
DOC-38/DOC-56/DOC-57 isolation and authorization conventions documented
throughout this README were re-verified, both by static source audit
(every `Request`/`Comment`/`ChatMessage`/`AuditLog` lookup in the
codebase) and by a consolidated mocked attack/regression test harness (63
assertions: role escalation, cross-Organization IDOR, mass assignment,
MongoDB-operator-injection-shaped payloads, CSV formula injection, Manager
audit-log isolation and cursor-boundary rejection) - all passed. No code
changes were required as a result of this ticket.

**Dependency audit (`npm audit`, task spec section 48).** Backend: 0
vulnerabilities across 144 production dependencies. Frontend: 6
vulnerabilities (2 high, 4 moderate), all in `devDependencies` (`vite`/
`esbuild`, dev-server-only - never shipped in the production `dist/`
build, confirmed by grepping the built output for the affected packages)
or requiring a breaking major-version upgrade to fix (`react-router-dom`
6.x -> 7.x for a moderate open-redirect advisory; `vite` 5.x -> 8.x). Per
this ticket's own constraint ("do not introduce breaking dependency
upgrades automatically"), none of these were applied - they are disclosed
here for a maintainer to schedule deliberately, tested against the app,
outside this ticket's scope.

**Rate limiting (task spec section 43) - audited, not added.** No
`express-rate-limit` (or equivalent) dependency exists in this project.
This is a deliberate decision, not an oversight: this is an academic/
local-deployment project with no current evidence of abuse, and the task
spec explicitly permits leaving this unaddressed if adding it would risk
breaking development/tests. Login brute-forcing remains a known,
disclosed gap for a future ticket to address deliberately.

**Live/real-environment testing - explicitly disclosed (task spec section
53).** This audit's environment had no reachable MongoDB instance (the
real `MONGODB_URI` in this deployment's own `.env` points at a live
Atlas cluster with no network egress from the audit sandbox) - real-
database, real-HTTPS, and real-S3 tests were **not** performed live.
What WAS verified live: the frontend production build (`npm run build`
succeeds, output grepped clean of secret variable names), and `npm audit`
against real installed dependency trees for both backend and frontend.
Everything else in this pass is either a static source audit or a
mocked-model test (see the harness described above) - never claimed as a
live test it wasn't.

**Secrets.** No hardcoded secret value exists anywhere in tracked source
(`JWT_SECRET`/`MONGODB_URI`/AWS credentials are only ever read from
`process.env`, never logged, never returned in any API response).
`backend/.env` is confirmed gitignored and was not modified, read into
this report, or printed anywhere during this audit.

## DOC-70 - Forgot Password / Password Recovery via Manager Approval

**No email delivery.** This feature has no SMTP, no third-party email
provider, and no public password-reset link of any kind - a standing,
explicit constraint. Recovery is instead routed through the requesting
User's own Organization Manager, the same trusted-approval-point pattern
DOC-57's "Manager Reset Password" already established for this project.

**Flow.** `POST /api/auth/forgot-password` (public, no token) accepts only
`{ email, companyCode }`. On success it creates a `PasswordResetRequest`
document (`models/PasswordResetRequest.js`) - it never itself touches a
password. A Manager then reviews the request on their Dashboard
("Password Reset Requests" panel) and either approves it (choosing a new
password for the user, exactly like the existing Manager Reset Password
flow) or rejects it. Approving a request calls the SAME
`performPasswordReset` function the existing `PATCH /api/users/:id/reset-
password` endpoint already used - there is only ever one password-reset
mechanism in this codebase, never a second, parallel one.

**`mustChangePassword` integration.** Unchanged. An approved request sets
`mustChangePassword = true` on the target User exactly the way a direct
Manager reset already did - the user is forced through the existing
`PATCH /api/auth/change-password` screen at their next login, and clearing
it works exactly as before. No second Change Password screen was built.

**Account-enumeration decision (documented, per task spec's own
instruction to "choose a reasonable balance").** A Company Code is not a
secret (it is already shared openly with every employee for registration,
and `register` already reveals company-code validity via an identical
lookup) - so an unknown/inactive company code returns the same specific
400 message `register` already returns. Once a real, active Organization
is identified, whether a SPECIFIC EMAIL belongs to an account in it is the
genuinely sensitive fact: "no matching account", "this account belongs to
a Manager" (see below), and "a request was successfully created" all
return the exact same generic 200 message, byte-for-byte indistinguishable
from one another. Two narrow, deliberate exceptions, each directed by the
task spec itself: an INACTIVE account gets a distinct, honest message
(task spec explicitly requires this so deactivation can never be silently
bypassed), and an ALREADY-PENDING request gets the task spec's own literal
example message ("A password reset request is already pending review.").

**Duplicate-request protection.** Checked in the controller first (fast,
clear message) and enforced at the database level by a partial unique
index (`{userId, status}` unique WHERE `status === 'pending'`) - the same
pattern `models/User.js` already uses for "at most one system_admin" -
closing the narrow race-condition window between the check and the
insert.

**Inactive-user behavior.** An inactive Employee/Operator's Forgot
Password submission never creates a request at all - they are told to
contact their Organization Manager directly. This is a deliberate, minor
trade-off against pure enumeration-resistance (it does distinguish
"exists but deactivated" from "no such account"), directed explicitly by
the task spec, which is more important than allowing deactivation to be
silently bypassed through this flow.

**System Admin decision.** System Admin recovery is entirely outside this
feature, by construction rather than a special case: `system_admin.
organizationId` is always `null` (DOC-31), so the org-scoped
`User.findOne({ email, organizationId })` lookup this endpoint uses can
never match a System Admin account, regardless of what email is
submitted.

**Manager account decision.** A Manager whose own account needs recovery
cannot use this flow either - folded into the same generic "no matching
account" response (never a distinguishing message). This is a direct
consequence of reusing the existing Manager Reset Password mechanism for
approval: that mechanism's own `resolveManageableTarget` helper already
refuses to let a Manager reset another Manager's password ("Managers
cannot modify another Manager."), so a request targeting a Manager could
never be fulfilled by anyone in the Organization. A Manager who is locked
out should contact their System Administrator (who already owns Manager
account creation/replacement - DOC-34/DOC-49).

**Temporary-password behavior.** This project's existing Manager Reset
Password flow requires the Manager to TYPE a new password (never
auto-generates one) - approval reuses that exact same UX and mechanism.
No temporary password is ever generated, displayed, logged, or stored in
plaintext anywhere; only its bcrypt hash is ever persisted (unchanged from
the pre-existing flow).

**Audit Log.** Two new actions, `PASSWORD_RESET_REQUEST_APPROVED` and
`PASSWORD_RESET_REQUEST_REJECTED` (`models/AuditLog.js`), recorded IN
ADDITION TO (never instead of) the existing `USER_PASSWORD_RESET` entry
`performPasswordReset` already writes - the two document different facts
(a password was reset vs. a specific pending request was formally
closed out). Creating the `PasswordResetRequest` itself is NOT
audit-logged: it is a public, pre-authentication action with no actor to
attribute it to, and the request document itself is already the durable,
timestamped record of that event.

**Notifications.** A new `PASSWORD_RESET_REQUESTED` type
(`models/Notification.js`) notifies every active Manager in the
requesting User's Organization when a request is created - system
generated (`actorId: null`), since the requester is not authenticated at
that point. **Deliberately deferred, and documented rather than built**:
notifying the requesting user when their request is approved/rejected.
The Notification routes require `requirePasswordChangeCompleted`, so a
user who has just had their password reset cannot see notifications until
AFTER they complete the forced Change Password flow - by which point they
already know the outcome directly (they either successfully logged in
with the new password, or a rejected request simply means they still
cannot log in). Building a notification for a state the recipient cannot
reach yet was judged unnecessary complexity for this ticket.

**Known limitations.** Rejected/approved requests are terminal - both
review endpoints re-check `status === 'pending'` before acting, so a
request cannot be replayed after it leaves the pending state; a genuinely
new Forgot Password submission is required to try again. There is no
self-service "cancel my own pending request" endpoint in this version
(the `cancelled` status value exists in the schema for a future ticket to
use without a migration, but nothing sets it yet).

## DOC-68 - Employee Satisfaction Rating

**Who may rate, and when.** Only the Employee who created a Request may
rate it - never a Manager or Operator on the Employee's behalf, and never
another Employee in the same Organization. Rating is allowed ONLY once the
Request's status is `closed`. `cancelled` gets its own explicit 409
message rather than being folded into the generic "must be closed"
wording. Every other non-terminal status (`open`/`in_progress`/`resolved`/
`reopened`) shares one generic 409 message. `resolved` was deliberately
NOT chosen as the eligibility point: `resolved` still allows the Employee
to send the Request back with "Problem Still Exists" (DOC-12), so rating
at that point could describe a service outcome that is not yet final. No
stronger reason to deviate from `closed` was found during the audit.

**"Reopened before closing" is structurally impossible to hit.**
`utils/requestStatusTransitions.js`'s own transition maps have no entry at
all for `currentStatus: 'closed'` in any role's map - `closed` has zero
outbound transitions in the current lifecycle. The single `if
(requestDoc.status !== 'closed') return 409` check in `createRating` is
therefore already complete protection; there is no separate "was this
reopened after closing" state to special-case.

**Score and comment.** `score` is a required whole number, 1-5 inclusive,
validated authoritatively on the backend (`utils/
requestFieldValidation.js`'s `validateScore`) - `0`, `6`, `2.5`, `"5"`
(string), arrays, objects, and `NaN` are all rejected with a 400. `comment`
is optional, plain text only (never HTML), trimmed, max 500 characters; an
empty or whitespace-only comment normalizes to `null` rather than being
stored as an empty string. Comments are always rendered as plain text on
the frontend (`{comment}` in JSX, never `dangerouslySetInnerHTML` or
`innerHTML`) - there is no formatting/markup support at all, by design.

**Data model.** A separate `RequestRating` model
(`models/RequestRating.js`), not a field embedded on `Request` - the same
"separate model + separate endpoints" precedent `Comment`/
`RequestActivity`/`Notification` already established in this project.
Fields: `organizationId`, `requestId`, `employeeId`, `operatorId`
(nullable), `score`, `comment`, `createdAt` only (`updatedAt` is disabled
- a rating is immutable, see below). `organizationId`/`employeeId` are
always derived server-side from `req.user`, never accepted from the
request body.

**One rating per Request, enforced twice.** A fast, clean controller-level
check (`RequestRating.findOne({ requestId })`) runs first for the common
case; a PLAIN unique index on `requestId` alone is the real, final,
database-level guarantee for a genuine race between two concurrent
submissions. This is deliberately a plain unique index, not a partial one
- unlike `PasswordResetRequest`'s `{userId, status}` partial index (which
allows many non-pending requests per user), every `RequestRating`
document, by definition, belongs to exactly one Request, with no status
carve-out needed. A duplicate-key error (Mongo code `11000`) from the rare
race is caught and returned as the exact same clean "This request has
already been rated." message - never raw Mongo internals.

**Operator attribution.** `operatorId` is derived directly from the
Request's own `assignedOperatorId` at the moment of rating, never accepted
from the client. Audited before relying on this: `assignRequestOperator`
structurally refuses any assign/reassign/unassign attempt unless
`status === 'open'` (409 otherwise) - so by the time a Request reaches
`closed`, its `assignedOperatorId` is already fixed and correct, and no
extra safeguard beyond making the field nullable (for a historical Request
that was closed while unassigned) was needed.

**Endpoints.**
- `POST /api/requests/:id/rating` (Employee only, own Request) - accepts
  only `{ score, comment }`. `employeeId`/`operatorId`/`organizationId`/
  `requestId`/`createdAt`/`role`/`status` are never read from the body,
  even if present.
- `GET /api/requests/:id/rating` (Employee only, own Request) - returns
  `{ data: null }` (never a 404) when the Request has not been rated yet;
  a 404 is reserved for "this Request does not exist, or is not yours."
- `GET /api/requests/ratings/organization` (Manager only, own
  Organization) - paginated (`limit`/`before`, the same cursor shape
  `notification.controller.js`/`auditLog.controller.js` already use),
  with optional `score`/`operator`/date-range filters. Registered ahead of
  this router's blanket Employee-only gate, the same way every other
  Manager-only route on this router already is. `/ratings/organization`
  and `/:id/rating` can never collide regardless of registration order -
  their second path segments are always different literal strings.

**Cross-organization / anti-enumeration.** Every lookup uses the same
scoped `Request.findOne({ _id, organizationId, createdBy })` pattern this
project uses everywhere else - a Request that does not exist, belongs to
another Organization, or was created by a different Employee, all produce
the identical 404. The Manager list endpoint's `before` cursor is
re-validated against the same organization-scoped query, so it can never
be used to page into another Organization's ratings.

**Immutability.** There is no PATCH or DELETE route for a `RequestRating`
- once submitted, a rating cannot be edited or withdrawn. No requirement
for editing was found during the audit, and immutability keeps the
Manager-facing satisfaction numbers meaningful (a score cannot quietly
change after being reported on).

**Manager statistics.** `GET /api/requests/statistics/organization`
(existing DOC-53/DOC-55 endpoint) now also returns a `satisfaction` key -
`averageScore`, `totalRated`, a `distribution` by star count (5 down to
1), and a `byOperator` breakdown - added alongside the existing `totals`/
`byStatus`/`byPriority`/`byCategory`/`byOperator`/`sla` keys, mirroring
exactly how DOC-55's own `sla` block was added to this same response,
rather than a redundant second statistics endpoint. `averageScore` is
`null` (never a fake `0`/`0.0`) when nothing has been rated yet; the same
`null`-not-`0` rule applies per-Operator, and an Operator with zero
ratings still appears in `byOperator` (active or inactive) rather than
being silently omitted.

**Activity Timeline.** A new `SATISFACTION_SUBMITTED` type
(`models/RequestActivity.js`), recorded once, immediately after a
successful rating - actor is the Employee, `metadata.score` holds the
numeric score. The comment text is deliberately NEVER copied into the
Timeline; `RequestRating` itself is the only place the comment is ever
stored. A rejected submission (wrong status, duplicate, failed validation)
creates no Timeline entry at all.

**Notifications: none.** No notification is sent for an ordinary
satisfaction rating - it is a passive, Manager-pull-facing signal (visible
via the statistics panel and ratings list), not something requiring
push-style awareness the way a new pending item does.

**Audit Log: none.** Ordinary Employee satisfaction ratings are not
Audit-Logged. The Audit Log (DOC-64) exists for administrative/security-
relevant mutations; `RequestActivity`'s new `SATISFACTION_SUBMITTED` type
is already the appropriate, complete history record for this action.

**CSV Export (DOC-67).** Two new trailing columns, `Satisfaction Score`
and `Satisfaction Comment`, added to the existing Organization Requests
CSV export - implemented, not deferred. Ratings are batch-fetched once
per export (`RequestRating.find({ requestId: { $in: [...] }, organizationId
})`), never one query per row. An unrated Request gets an empty string in
both columns (matching the existing `Cancellation Reason` column's own
"nothing to say" convention), never `N/A`/`null`. The existing
RFC4180/formula-injection escaping (`utils/csvExport.js`) is unchanged and
applies to these two new columns exactly as it does to every other column.

**Historical/inactive users.** `RequestRating` only ever stores
`employeeId`/`operatorId` references, resolved to a display name at read
time - Users are never hard-deleted in this project, but a rating whose
employee/operator can no longer be resolved (defensive only) falls back to
a safe "Unknown user" rather than crashing the response, the same
convention `RequestActivity`/`Comment` already use.

**Request deletion.** Audited: this project never hard-deletes a Request
anywhere, so no cascade-delete behavior for `RequestRating` was needed or
added. If that ever changes, `RequestRating` documents would need an
explicit decision at that time (currently, an orphaned rating referencing
a deleted Request is not a case this codebase can produce).

**Frontend.** Employee: a "Rate Service" star control (1-5, keyboard
accessible - each star is a real `<button>` with its own "N out of 5
stars" `aria-label`, filled/empty state carried by glyph, not color alone)
appears in the expanded detail panel of a closed, own Request
(`RequestRatingSection.jsx`, dropped into `RequestRow.jsx` gated on
`viewerRole === 'employee' && request.status === 'closed'`). After
submission it swaps to a read-only "Your Rating ★★★★★ + comment" display
with no full page reload, and persists correctly across a revisit/refresh
(re-fetched via `GET /api/requests/:id/rating`). No "Rated ★★★★★" badge
was added to the COLLAPSED row - doing so would require either an N+1
rating fetch per row, or enriching the existing Request list endpoint, a
larger change outside this ticket's scope; the rating is instead only
ever shown in the expanded panel, matching how Comments/Activity on the
same row already behave. Manager: a "Service Satisfaction" section on the
Manager Dashboard shows average rating (or "N/A"), total rated count, a
star-count distribution, and a per-Operator ratings table (also "N/A" for
zero-rating Operators) - all sourced from the existing organization
statistics fetch, no separate network call needed.

**Test coverage.** A mocked test harness (in-memory fake `Request`/
`RequestRating`/`User` models injected via Node's own module cache, no
real MongoDB needed) exercised `createRating`/`getMyRating`/
`listOrganizationRatings` and the statistics helpers directly: 52 targeted
assertions across valid submission, every non-closed status rejection,
cancelled-request rejection, role authorization (Manager/Operator/another
Employee all rejected, the real creator accepted), cross-organization
isolation (including the `before`-cursor cross-org paging attempt),
backend-authoritative score/comment validation (0, 6, 2.5, string,
array, object, NaN, oversized comment), duplicate protection at both the
controller and unique-index layers, Activity Timeline integration
(recorded once, score-only, never on a rejected submission), and Manager
statistics (null-not-zero for an empty organization, correct aggregation,
per-Operator N/A for zero ratings, organization scoping) - all 52 passed.

## DOC-69 - Login History & Active Sessions

**Architecture: server-side sessions alongside JWT, not a redesign.**
Before this ticket, authentication was 100% stateless JWT - once signed, a
token stayed valid for its whole lifetime (`JWT_EXPIRES_IN`, default 1h)
with no way to invalidate it early; `middleware/auth.js` could only check
the token's own signature/expiry and re-read the account's `isActive` flag
(DOC-38). This ticket adds a `UserSession` record for every login, and
embeds that session's id in the JWT's own `jti` claim. The JWT still does
exactly what it always did (its signature proves who is asking); the new
`UserSession` document is what makes ONE specific login revocable without
touching the account or any other login.

**JWT / session relationship.** `jwt.sign({ userId, role, jti }, ...)` -
the only payload change is the added `jti`, a bare random UUID
(`crypto.randomUUID()`) that is not sensitive on its own (see
`models/UserSession.js`'s own header comment for why a leaked `tokenId`
alone grants no access). `middleware/auth.js`'s verification order is now:
JWT signature -> `jti` present (see compatibility decision below) -> user
exists -> user active -> session exists -> session belongs to the same
user -> session not revoked -> session not expired. A session's own
`expiresAt` is decoded from the just-signed JWT's real `exp` claim, never
independently re-parsed from `JWT_EXPIRES_IN` - the two can never drift
apart.

**Pre-DOC-69 token compatibility (documented decision).** A JWT signed
before this ticket shipped has no `jti` and therefore no corresponding
`UserSession`. Rather than silently exempting such tokens from revocation
forever (which would quietly weaken the whole feature for exactly the
population most likely to still be logged in at deploy time), `verifyToken`
rejects any token with no `jti` outright, with the exact same
401 "Invalid authentication token." response as any other invalid token.
The person simply logs in again once; their account, password, and data
are completely unaffected. Given this project's default 1-hour JWT
lifetime, any pre-DOC-69 token still in use at deploy time would have
expired naturally within the hour regardless - this only makes that
cutover immediate and unambiguous instead of silently partial.

**Session creation (login).** `auth.controller.js`'s `login` generates a
fresh `tokenId` (`services/userSession.service.js`'s `generateTokenId` -
the ONLY place a tokenId is ever produced, once per successful login,
never client-suppliable - task spec's session-fixation requirement),
creates the `UserSession` document, then signs the JWT referencing it. The
login response contract (`{ token, user }`) is completely unchanged.

**IP / User-Agent handling and limitations.** `ipAddress` is always
`req.ip` (server-observed only - never accepted from the request body).
`req.ip` already respects this app's existing, explicitly opt-in
`TRUST_PROXY` configuration (`app.js`) - if a production deployment sits
behind a proxy that is NOT declared via `TRUST_PROXY`, `req.ip` will show
the proxy's own address rather than the real client IP; this is an
accepted, pre-existing limitation of this app's proxy configuration, not
new to this ticket. `userAgent` is `req.get('user-agent')`, capped at 300
characters, stored and displayed as-is - it is DISPLAY METADATA ONLY and
is never read by any authorization decision anywhere in this project.

**lastActiveAt throttling.** Updated on an authenticated request only if
more than 5 minutes have passed since the last write (`services/
userSession.service.js`'s `LAST_ACTIVE_THROTTLE_MS`) - a single targeted
`updateOne` by `_id`, never a write on every request.

**Session expiry.** No scheduler, no cron, no TTL index. `active = revokedAt
is null AND expiresAt > now`, computed identically everywhere
(`classifySessionStatus`/`isSessionActive` in `services/userSession.
service.js` - "centralize logic"). A naturally-expired session is simply
classified `EXPIRED` at read time and remains in Login History; nothing
deletes it.

**Endpoints** (`routes/auth.routes.js`):
- `POST /api/auth/logout` - revokes the CURRENT session. A third explicit
  exception to `requirePasswordChangeCompleted` (alongside `GET /me` and
  `PATCH /change-password`) - a user forced to change password must always
  be able to log out.
- `GET /api/auth/sessions` - up to the 30 most recent sessions (active +
  historical) for the caller, newest first, each with a computed `status`
  (`ACTIVE`/`REVOKED`/`EXPIRED`) and `isCurrent` flag. Never returns a JWT,
  `tokenId`/`jti`, or `passwordHash`.
- `DELETE /api/auth/sessions/:sessionId` - revokes exactly one of the
  caller's OWN sessions. Scoped `{ _id, userId }` (never just `_id`) - a
  nonexistent id and another user's id both produce an identical 404
  (task spec's anti-enumeration requirement). Idempotent: revoking an
  already-inactive session is a safe no-op, never a second error, and
  never overwrites the original `revokedAt`/`revokedReason`.
- `POST /api/auth/sessions/logout-others` - revokes every OTHER active
  session for the caller; the current session is always excluded.
- `POST /api/auth/sessions/logout-all` - revokes EVERY active session for
  the caller, including the current one; the frontend treats a successful
  call exactly like pressing Logout.

**User isolation (stricter than organization isolation).** Every one of
the four endpoints above is scoped by `userId: req.user.userId` ONLY -
never by `organizationId`, never by role. Not even a Manager can list or
revoke another user's sessions through any endpoint in this project,
regardless of Organization membership - a deliberately stricter boundary
than this project's usual DOC-38 organization-scoped isolation.

**Password-change revocation policy.** `changePassword` (self-service)
revokes every OTHER active session (`PASSWORD_CHANGED` reason) - the
current session (the one that just proved the current password) is
excluded and may remain valid, so the person who just correctly
authenticated is never forced to immediately re-login on the same device.

**Password-reset revocation policy.** `performPasswordReset`
(`user.controller.js` - the ONE shared function both a direct Manager
reset and a DOC-70-approved `PasswordResetRequest` reset call) revokes
ALL of the target's active sessions (`PASSWORD_RESET` reason) - there is
no "current session" to protect here, since the ACTOR is the Manager, not
the target. Runs identically regardless of which of the two callers
invoked it. A new `SESSIONS_REVOKED_AFTER_PASSWORD_RESET` Audit Log entry
is recorded when at least one session was actually revoked.

**Deactivation revocation policy.** `updateUserStatus` revokes ALL of the
target's active sessions (`USER_DEACTIVATED` reason) only on a GENUINE
deactivation (not an idempotent re-deactivation of an already-inactive
account, and never on reactivation). A new
`USER_SESSIONS_REVOKED_ON_DEACTIVATION` Audit Log entry is recorded when
at least one session was actually revoked. Reactivation only flips
`isActive` back - it never restores sessions revoked at deactivation time;
the user simply logs in again for a fresh one.

**Profile UI (`frontend/src/pages/Profile.jsx` +
`ActiveSessionsPanel.jsx`).** A new "Security / Active Sessions" section:
the current session is shown with a `Current` badge and no revoke control
(a dedicated Logout already exists in the Navbar for ending it - the same
"prevent it, provide separate Logout" choice as the task spec's own
example UI); every other active session gets its own `Log out` button,
plus a shared `Log out of all other sessions` button and (for
completeness, since the backend endpoint exists) a `Log out of all
sessions` button. Below that, a "Recent Login History" list shows up to
30 entries with a human-readable device label (`utils/userAgentLabel.js`
- a small, dependency-free User-Agent -> "Chrome on Windows"-style parser,
display-only, never used for any authorization decision) and a status
label (`utils/sessionStatusLabel.js` - centralizes the REVOKED reason ->
label mapping, e.g. "Logged out (password reset)", using only the
backend's own controlled `revokedReason` enum, never arbitrary text).

**Existing Logout upgraded, not replaced.** `AuthContext.jsx`'s `logout()`
now calls the new `POST /api/auth/logout` endpoint with the token about to
be discarded, wrapped in try/catch, and ALWAYS falls through to clearing
local state regardless of outcome - a network failure or an already-
revoked token can never leave a person stuck mid-logout (existing Logout
UX is unchanged from the caller's point of view).

**Audit Log decision.** Two new actions,
`SESSIONS_REVOKED_AFTER_PASSWORD_RESET` and
`USER_SESSIONS_REVOKED_ON_DEACTIVATION` (`models/AuditLog.js`) - both
security-sensitive, OTHER-directed events (one person's action ending
ANOTHER user's sessions). Ordinary, everyday, SELF-directed session
activity (login, logout, revoking one's own session, logging out one's
own other sessions) is deliberately NOT Audit-Logged - it is fully visible
to the acting user themselves via their own Login History
(`GET /api/auth/sessions`), and recording it there is a better fit than a
second, administrative-facing copy of the same fact.

**Notifications: none.** No notification is sent for an ordinary login,
logout, or self-service session revoke - matching this ticket's own
explicit default ("do not create a notification for every login").

**Indexes.** Exactly three on `UserSession` (task spec: "do not add
excessive indexes"): a unique index on `tokenId` (the one lookup
`verifyToken` performs on every authenticated request), `{ userId: 1,
createdAt: -1 }` (list/history, newest first), and `{ userId: 1,
revokedAt: 1, expiresAt: 1 }` (the "which of my sessions are active" shape
used by both the list endpoint and the bulk-revoke endpoints).

**No plaintext token storage.** `UserSession` never stores the JWT itself,
never stores a plaintext refresh/access token - only `tokenId` (the `jti`,
a bare random identifier with no authentication power on its own; see this
model's own header comment).

**Test coverage.** A mocked test harness (in-memory fake `User`/
`UserSession`/`Request` models injected via Node's own module cache, real
`bcryptjs`/`jsonwebtoken` packages, no real MongoDB needed) exercised
`login`/`logout`/`changePassword`, `middleware/auth.js`'s full verification
chain, all four session-management endpoints, `performPasswordReset`, and
`updateUserStatus` directly: 42 targeted assertions across session
creation (jti/tokenId linkage, org-null-safety for System Admin, userAgent/
createdAt/expiresAt correctness, no raw JWT persisted), multiple
independent sessions per user, listing (own-only, current flagged,
ACTIVE/REVOKED/EXPIRED classified correctly, no raw tokenId/JWT exposed),
revocation (cross-user 404, invalid-id 400, idempotent repeat, immediate
JWT rejection), logout-others (correct count, already-inactive sessions
never double-counted), logout (immediate JWT rejection, fresh session on
re-login), password change (other sessions revoked, current session
policy honored), Manager/DOC-70 password reset (ALL target sessions
revoked, `mustChangePassword` still required, another user unaffected,
Audit Log entry recorded), deactivation (all sessions revoked, old JWT
rejected, reactivation does not restore old sessions, fresh session on
new login, Audit Log entry recorded), role isolation (Employee/Operator/
Manager/System Admin can each only manage their own sessions), the
pre-DOC-69 no-`jti` compatibility rejection, and session-fixation
resistance (a client-supplied `jti` has zero effect on login) - all 42
passed.

## DOC-71 - Enhanced User Profile: Profile Picture + Bio

**What this adds.** Two new self-service fields on top of the existing My
Profile feature (DOC-62): a short plain-text **Bio** (optional, trimmed,
max 250 characters) and a **Profile Picture** (one current image per
user, JPEG/PNG/WEBP, 5 MB max). Both are edited only by the account
itself - a Manager cannot set an Employee's bio/photo, and nobody can set
role/organizationId/isActive/email/specialties through this or any other
self-service path (those remain permanently out of scope for
`PATCH /api/users/me`, unchanged from DOC-62).

**Bio validation (`backend/src/utils/userFieldValidation.js`).**
`validateBio` mirrors the existing `validateRatingComment` (DOC-68)
shape: `undefined`/`null`/empty-after-trim all normalize safely to `null`
(clearing a bio is a normal action, not an error); a non-string
(object/array/number) is rejected outright, checked before `.trim()` is
ever called; over 250 characters is rejected with a client-safe message.
**Bio is plain text only, by construction, not by sanitization** - this
project never strips HTML or scripts from it, because the frontend never
renders it through `dangerouslySetInnerHTML`/`innerHTML` (see
`frontend/src/pages/Profile.jsx` - it only ever appears inside a
`<textarea>` value and, on display, as an escaped React text node). A
value like `<script>alert(1)</script>` is stored and returned completely
unmodified and is therefore always inert.

**Profile image storage architecture - the audit decision.** The task's
own explicit instruction was "do NOT reuse Request image metadata blindly
without auditing whether a shared storage abstraction is appropriate."
`services/requestImageStorage.js` was read in full before writing any new
code, and its three operations turned out to be Request-*shaped*, not
generic: `buildObjectKey` hardcodes
`organizations/{orgId}/requests/{requestId}/before|completion/{uuid}.ext`,
and every function signature requires a `requestId`/`attachmentType`
neither of which a profile image has. Forcing a fake `requestId` through
that module just to satisfy its signature would have been exactly the
"blind reuse" the ticket warns against. The resolution: a new, independent
`services/profileImageStorage.js` module (S3 + GridFS, same dual-provider
shape, its own small S3-client cache and MIME-to-extension map) was
written instead, and the ONE piece that genuinely was safely generalizable
- `services/gridFsStorage.js`'s single hardcoded `'requestImages'` bucket
- was extended with an **optional** `bucketName` parameter on all five of
its exported functions, defaulting to `'requestImages'` everywhere so
every existing Request-image call site is completely unaffected. No Base64
is ever stored in the `User` document - only a small reference/metadata
subdocument (`objectKey`/`fileId`/`mimeType`/`size`), the actual bytes
always live in GridFS or S3.

**Storage namespace.** S3 key prefix: `profiles/{userId}/{uuid}.ext` -
keyed by `userId` alone, deliberately NOT `organizationId` the way Request
attachments are, because System Admin's own `organizationId` is always
`null` (DOC-31); a userId-only scheme works uniformly for every role with
no null special-case. GridFS bucket: a dedicated `'profileImages'` bucket
(`profileImages.files`/`profileImages.chunks`), completely separate from
Request images' own `'requestImages'` bucket - a profile image and a
Request attachment can never collide, be listed together, or be
cross-referenced by id.

**One current image per user, safe replacement order.** Uploading a new
image: (1) upload the new bytes to storage, (2) save the new reference on
the `User` document, (3) **only after both of those have already
succeeded**, best-effort delete the OLD image's bytes. A cleanup failure
at step 3 is logged and swallowed - it never undoes or fails the
already-successful new upload (task spec: "failure to delete old image
must not destroy new update"). The very first upload for a user
(no previous image) never attempts a delete at all.

**Endpoints.**
- `POST /api/users/me/profile-image` - self only, `multipart/form-data`
  field name `profileImage`, reuses the EXACT SAME Multer instance/
  fileFilter/size-limit (`middleware/upload.js`'s `uploadMemory`) Request
  images already use - no separate, looser validation was introduced.
  Returns the caller's full sanitized user object.
- `DELETE /api/users/me/profile-image` - self only, idempotent (calling it
  with no image already set still returns 200, never an error).
- `GET /api/users/:userId/profile-image` - streams the image bytes through
  an authenticated proxy (never a raw/public storage URL) - the same
  pattern `AuthenticatedRequestImage.jsx`/`getRequestAttachmentContent`
  already established for Request images, necessary because this project
  has no cookie-based session and a plain `<img src>` cannot attach the
  required `Authorization` header.

**Self-service derivation, never trusts a URL param.** Both write
endpoints take no `:userId` in their route at all - the target is always
`req.user.userId`, the same trusted, database-backed identity
`middleware/auth.js` already establishes on every request. There is
structurally no way to upload or delete on another user's behalf,
regardless of what a client sends in the body.

**Read authorization - same-organization visibility.** `GET
/api/users/:userId/profile-image` allows exactly two cases: viewing your
OWN image (always), or viewing an image belonging to a user who shares
your own **non-null** `organizationId`. A System Admin's own
`organizationId` is always `null`, so this rule naturally means nobody
else can ever view a System Admin's avatar, and a System Admin can never
view anyone else's - each can still always view their own. A nonexistent
user, an unauthorized (cross-organization) user, and a user with no image
set all return the identical `404 Profile image not found.` - never a
distinguishing `403`, so a caller can never use this endpoint to enumerate
which user ids exist in another Organization.

**`sanitizeUser` extensions.** `bio` (string or `null`), `hasProfileImage`
(boolean), and `profileImage` (`{ url, updatedAt }` or `null`) - `url` is
always the authenticated content-proxy path above, **never** the raw
`objectKey`/`fileId`/storage credentials. `url` carries its own
`?v=<updatedAt-timestamp>` cache-busting query parameter, computed from
the profile image subdocument's own `updatedAt` (its `timestamps:
{ updatedAt: true }` bumps this exactly when - and only when - the image
itself is replaced), so a browser/CDN can cache the image aggressively
without ever serving a stale one after a replacement.

**Frontend.** `Profile.jsx` gained an avatar section above the existing
Full Name field: `Avatar.jsx` (large size) shows the current image or
falls back to initials (e.g. "Mahmoud Khashan" -> "MK", via
`utils/initials.js`) - **never a broken-image icon**, whether there is no
image at all, the fetch is still in flight, or it fails for any reason.
Choosing a new file shows a local, client-only preview (via
`URL.createObjectURL`, client-side MIME/size validation - the backend
remains authoritative) before the user confirms "Save Photo"; "Remove
Photo" is idempotent and only shown once an image actually exists. The
Bio field is a `<textarea>` with a live character counter, saved together
with Full Name through the same existing `PATCH /api/users/me` call.
`AuthContext`'s existing `updateUser(...)` (unchanged from DOC-57/DOC-62)
is reused for every one of these mutations - the new bio/avatar appear
immediately everywhere `user` is read, with **no logout/login and no page
reload** required.

**Navbar avatar - deliberately deferred.** The task spec's own minimum
requirement is the Profile page only ("Navbar/Dashboard avatar display -
optional"). Given the scope already covered here, a Navbar avatar was
left out of this pass rather than rushed; `Avatar.jsx` was built as a
fully reusable, prop-driven component (`{ profileImageUrl, fullName }`)
specifically so adding one later is a small, low-risk follow-up.

**Chat-readiness, without building Chat.** `Avatar.jsx`'s entire public
contract is `{ profileImageUrl, fullName }` - exactly the two fields
`sanitizeUser` already returns for any user. A future Organization Chat
feature (DOC-60 already exists read/write for messages) could render an
avatar next to a message by reusing this component completely unchanged,
passing whatever minimal shape the Chat API already carries - no new
avatar component, and no storage-architecture change, would be needed.
Direct Messages were explicitly NOT implemented (out of scope, per the
task's own instruction).

**Audit Log - no noisy entries.** An ordinary bio-only or photo-only
change creates **zero** Audit Log entries. `bioChanged: true` (a boolean
flag only - never the bio text itself) rides along as extra `metadata`
**only** on an already-triggered `PROFILE_UPDATED` entry, i.e. only when
`fullName` also changed in the very same request. Profile image
upload/delete never touch the Audit Log at all - there was no existing
`PROFILE_UPDATED`-shaped trigger for them to safely ride along on without
inventing a new, noisier logging path the task explicitly warned against.

**Notifications - none.** No Notification is generated for a bio or
profile-image change, matching this ticket's own explicit instruction.

**Old image cleanup - documented tradeoff.** Deleting the old image's
bytes after a successful replace/remove is always best-effort: a failure
is logged server-side via `console.error` and otherwise ignored. This
means a very rare storage failure can leave an orphaned file in GridFS/S3
that nothing will ever reference again - an accepted tradeoff (identical
in spirit to `requestImageStorage.js`'s own `deleteImage`) because the
alternative (blocking or failing the user's own successful upload/delete
on a cleanup failure) would be strictly worse.

**Security - filenames and MIME.** The stored object's name/key is always
server-generated (`crypto.randomUUID()` plus an extension taken only from
an internal MIME-to-extension map) - the client's original filename is
never read or trusted for anything, including for the extension. MIME
type is validated against `middleware/upload.js`'s existing
`ALLOWED_MIME_TYPES` allowlist (the multipart part's declared
Content-Type, not the filename) - the exact same check, and the exact
same 5 MB size limit, Request images already use.

**Test coverage.** A mocked test harness (fake `User` model and
`profileImageStorage` service injected via Node's own module cache, the
real `updateMyProfile`/`uploadMyProfileImage`/`deleteMyProfileImage`/
`getUserProfileImageContent`/`sanitizeUser` production code running
unmodified against them, no real MongoDB/S3/GridFS needed) ran 71 targeted
assertions: bio validation (9), profile image upload (9), replacement (6,
including the ordering guarantee that the old image is only deleted after
the new one is confirmed saved), delete (4, including idempotency),
authorization (10, covering the self/same-organization/System-Admin
edge cases and confirming upload/delete never read `req.params`/
`req.body` for identity), image read isolation (5, including the missing-
bytes-is-still-a-clean-404 case and response headers), AuthContext
contract (5, mixing a runtime response-shape check with static source
checks that `Profile.jsx`/`AuthContext.jsx`/`Avatar.jsx` never touch
`localStorage`/the token and never render a broken-image icon), and
regression coverage for DOC-62 (5), DOC-69 (4), DOC-67/DOC-68 (4), and
storage isolation (5, including a live assertion that
`gridFsStorage.js`'s zero-argument call sites still throw the exact same
error as before the `bucketName` parameter was added). All 71 passed.

## DOC-70 - Organization Chat Attachments

**What this adds.** Organization Chat (DOC-60) messages can now carry 0-3
file attachments alongside (or instead of) text. A message is valid
whenever its trimmed text is non-empty OR at least one attachment was
uploaded - an empty-text, zero-attachment submission is still rejected,
exactly as before this ticket.

**Supported file types.** A conservative, useful set: `image/jpeg`,
`image/png`, `image/webp`, `application/pdf`, and `text/plain` -
executables, scripts, HTML, SVG (no existing sanitization policy to point
to), and archives are all deliberately excluded.

**Size/count limits.** 10 MB per attachment (`middleware/chatUpload.js`'s
own `MAX_CHAT_ATTACHMENT_SIZE_BYTES`, deliberately larger than the 5 MB
Request/Profile image ceiling - a PDF is often bigger than a compressed
photo), and a maximum of 3 attachments per message
(`MAX_ATTACHMENTS_PER_MESSAGE`) - enforced by Multer's own `limits`
option AND, defensively, a second check inside `chat.controller.js`'s
`createMessage` in case this handler is ever reached a different way.
Both limits are backend-authoritative; the frontend validates the same
values early for UX only.

**Storage architecture - the audit decision.** Before writing any new
storage code, `services/requestImageStorage.js` was read in full again:
its `buildObjectKey` hardcodes a Request-shaped path
(`organizations/{orgId}/requests/{requestId}/before|completion/{uuid}.ext`)
and every function signature requires a `requestId`/`attachmentType` a
chat attachment simply does not have. Reusing it directly would have been
exactly the "blind reuse" the task spec warns against. The resolution -
identical in shape to DOC-71's own `profileImageStorage.js` decision - is
a new, independent `services/chatAttachmentStorage.js` module (S3 +
GridFS, its own small S3-client cache and MIME-to-extension map), reusing
only the one piece that is genuinely generic: `services/gridFsStorage.js`'s
`bucketName` parameter (added in DOC-71, now used by a SECOND caller with
its own distinct value, exactly as that ticket anticipated). No Base64 is
ever stored in a `ChatMessage` document, and no attachment binary is ever
embedded there - only a small reference/metadata subdocument
(`originalName`/`mimeType`/`size`/`objectKey`/`fileId`/`uploadedAt`).

**GridFS bucket / S3 prefix.** A dedicated GridFS bucket,
`'chatAttachments'` (`chatAttachments.files`/`chatAttachments.chunks`),
completely separate from `'requestImages'` and `'profileImages'`. S3 key
prefix: `chat/{organizationId}/{userId}/{uuid}.ext` - unlike
`profileImageStorage.js`'s userId-only scheme (needed there specifically
for System Admin's null `organizationId`), every Organization Chat
participant is guaranteed to have a real `organizationId` (System Admin
never participates in chat - unchanged from DOC-60), so the prefix safely
includes it, mirroring the Organization isolation already enforced at the
query level.

**Message-create flow.** `POST /api/chat/messages` remains ONE atomic
multipart endpoint (task spec's own recommended shape, avoiding an
orphaned-upload-prone separate upload-first flow): validate text/files
first -> upload each file to storage -> create the `ChatMessage` with the
resulting reference metadata -> return the sanitized response. If the
`ChatMessage.create()` call itself fails after files were already
uploaded, every attachment already uploaded for that request is
best-effort deleted (logged and swallowed on failure, matching DOC-71's
own documented cleanup tradeoff) so a rare failure never leaves more than
the unavoidable minimum of orphaned storage.

**Attachment-read endpoint.**
`GET /api/chat/messages/:messageId/attachments/:attachmentId/content` -
authenticated, same chain as list/create (manager/operator/employee,
active Organization). Streams bytes through Node - never a raw GridFS/S3
URL.

**Organization isolation / IDOR protection.** The `ChatMessage` is always
looked up FIRST as `{ _id: messageId, organizationId:
req.user.organizationId }` in one query - a nonexistent message and one
belonging to another Organization produce the identical 404, so a caller
can never distinguish "wrong id" from "right id, wrong Organization" (the
same DOC-38 anti-enumeration convention this project's other cross-tenant
lookups already use). The attachment is then resolved ONLY from that
already-organization-scoped message's own `attachments` subdocument array
- never a separate global lookup by attachment id alone, which is exactly
the pattern the task spec warns against (it would let a leaked
attachmentId from another Organization skip the Organization check
entirely). A valid attachment id paired with the WRONG message id (even
within the same Organization) is also rejected.

**Filename/header safety.** The stored attachment's `originalName` is
kept and displayed verbatim (always as plain React text, never HTML) but
is passed through `sanitizeContentDispositionFilename` before ever
reaching an HTTP header - CR/LF/NUL and quote/backslash characters are
stripped, preventing header injection via a crafted filename. Images get
`Content-Disposition: inline`; PDF/text get `attachment` - both include an
RFC 5987 `filename*=UTF-8''...` value alongside the plain `filename="..."`
one, so non-ASCII names round-trip safely too.

**Frontend composer.** OrganizationChat.jsx gained an 📎 Attach button
(hidden file input, `accept` aligned with the backend's allowlist),
a selected-file list with per-file Remove (reusing the existing
`.selected-image-list` convention from Request image uploads), a small
local image preview via `URL.createObjectURL` for image files, and a
disabled Send button while a submission is pending or nothing valid is
selected. `chatApi.send` now always posts `FormData` (a text-only message
is simply a FormData object with zero `attachments` entries).

**Image/PDF rendering.** A new `AuthenticatedChatAttachment.jsx`
component (deliberately independent from `AuthenticatedRequestImage.jsx`/
`Avatar.jsx` - the same "mirror the pattern, don't couple" precedent
DOC-71 established) fetches an image attachment's bytes via an
authenticated `fetch()` and renders an object-URL thumbnail; a PDF/text
attachment renders a lightweight file card (icon, filename, size, "Open")
with ZERO network activity until the person actually clicks Open - a
further optimization beyond what was asked, since a chat full of PDF
links then costs nothing extra until opened.

**Polling/memory behavior.** Attachment metadata is polled every 7
seconds exactly like the rest of a message (unchanged interval) - never
the bytes themselves. `AuthenticatedChatAttachment`'s own fetch effect is
keyed on the attachment's `url` STRING, not the parent message object's
identity; since a chat attachment is immutable and write-once, that URL
string never changes across polls for an unchanged attachment, so React's
by-value dependency comparison means an unaffected attachment is never
re-fetched, regardless of how many times the surrounding message object
is replaced by a fresh poll response. Object URLs are revoked on
unmount/replacement in every code path that creates one (selected-file
preview, rendered image, opened PDF/text).

**Failure UX.** Unsupported file type, oversized file, and
too-many-attachments all surface as clear, specific messages (never a raw
Multer/S3/GridFS error - the same DOC-65 safe-error discipline every
other upload feature in this project already follows). A chat image that
fails to load shows "Unable to load attachment" plus its filename, never
the browser's own broken-image icon.

**Storage cleanup.** Best-effort only, exactly like DOC-71's own
profile-image cleanup: a failure is logged server-side via
`console.error` and never surfaces storage internals (bucket names,
object keys, credentials) to the client. There is no attachment-only
delete - chat messages remain fully immutable (no PATCH/DELETE route was
added, task spec section 32), so there is no "replace" or "remove one
attachment" flow to protect either.

**Avatar integration - deferred.** Displaying an Avatar next to each chat
message was audited and NOT implemented in this pass: doing so safely
would require a new, chat-specific safe-fields sanitizer for the resolved
author (the existing DOC-71 `sanitizeUser` exposes `email`/`bio`/
`organizationId`/`isActive` - fields that must never leak into an
Organization-wide feed every member polls every few seconds) plus the
same polling-safe-fetch design attachments already needed - a second,
independent scope of work the task spec explicitly permitted deferring.

**Notification/Audit Log decisions.** No Notification is generated for a
chat attachment (chat is Organization-wide, not targeted - DOC-72
@Mentions will later provide targeted notifications). No Audit Log entry
is created for a normal chat message/attachment - this is not an
administrative action, the same category DOC-64's own Audit Log scope
already excludes ordinary business activity from.

**Direct Message readiness.** `chatAttachmentStorage.js`'s public
functions (`uploadAttachment`/`getAttachmentStream`/`deleteAttachment`)
take only `{ organizationId, userId, mimeType }` - no `ChatMessage`- or
"channel"-specific concept is baked into the storage key or function
signatures. A future DOC-73 Direct Message feature could call these exact
same functions unchanged for a private conversation's attachments, at
most adding its own distinct GridFS bucket constant if isolation from
Organization Chat's own attachments is later desired - no redesign of
this module would be required. Direct Messages themselves were **not**
implemented in this ticket.

**Test coverage.** A mocked test harness (fake `ChatMessage`/`User`
models and `chatAttachmentStorage` service injected via Node's own module
cache, the real `createMessage`/`listMessages`/`getChatAttachmentContent`/
`sanitizeContentDispositionFilename` production code running unmodified
against them, no real MongoDB/S3/GridFS needed) ran 68 targeted
assertions: text/attachment combinations (6), file validation (8),
metadata (8), read authorization (7), storage/provider abstraction and
failed-save cleanup (6), frontend composer/rendering static contract
checks (11), a consolidated cross-Organization attack test (1), and
regression coverage for Organization Chat (8), DOC-71 (4), Request
storage (5), and DOC-67/68/69 (4). All 68 passed.

## DOC-72 - @Mentions in Organization Chat

**What this adds.** A person composing an Organization Chat message
(DOC-60) can type `@` to open a suggestion dropdown of same-Organization,
active, chat-eligible coworkers, pick one, and send the message. Every
person mentioned that way receives an in-app `CHAT_MENTION` notification
(DOC-18) - unless they mentioned themselves.

**Mentions are userId-based, never name-based.** The task's own core
design constraint: a mention's canonical identity is a validated MongoDB
`ObjectId`, never a `fullName`/email string. Names are not unique and can
change; an id is stable forever. `ChatMessage.mentionedUserIds` (new
field, `models/ChatMessage.js`) stores ONLY an array of `ObjectId`
references (`ref: 'User'`, max 10, defaulting to `[]`) - never a copy of
the mentioned user's name, role, or profile image. The human-readable
`@Full Name` text the message actually displays lives in `content`
itself, typed once at send time and never rewritten afterward.

**Fresh-resolution-at-read-time, not a frozen snapshot.** Every time a
message is listed (`GET /api/chat/messages`), `mentionedUserIds` is
resolved against the CURRENT `User` documents (batched into one query per
page via `buildUserLookupMap`, covering both message authors and
mentioned users together - never N+1) and returned as
`mentions: [{ id, fullName }]`. If a mentioned person is later renamed,
the frozen `@OldName` text inside `content` and the freshly-resolved
current name in `mentions` can legitimately disagree - this is documented
and intentional (task spec: "Do not rewrite historical chat content"). A
mention of a since-DEACTIVATED user is resolved the exact same way an
author already is (`buildUserLookupMap` never filters by `isActive`), so
a historical mention keeps showing that person's real name, never
"Unknown user" or a placeholder, purely because they were later
deactivated.

**Who can be mentioned.** Exactly the same population that can
participate in Organization Chat at all: active members of the sender's
own Organization with role `manager`, `operator`, or `employee`
(`utils/chatMentionValidation.js`'s `ALLOWED_MENTION_ROLES`) - System
Admin is structurally excluded, the same way it already cannot read or
send chat messages at all.

**Same-organization enforcement, twice.** The composer's own suggestion
endpoint (`GET /api/chat/mention-users?q=`) only ever searches
`req.user.organizationId`, and `createMessage` independently
re-validates every submitted id against the database at send time
(`User.find({ _id: { $in: ... }, organizationId: req.user.organizationId,
isActive: true, role: { $in: ALLOWED_MENTION_ROLES } })`) - the dropdown
is a convenience, never the source of authorization. A hand-crafted
request that spoofs a cross-Organization, inactive, System Admin, or
simply nonexistent id is rejected with the exact same generic message,
`"One or more mentioned users could not be found."`, so a prober can
never learn which of those reasons applied to a given id (the same
DOC-38 anti-enumeration discipline this project already applies to every
other cross-tenant lookup).

**Reject-entirely, never partially apply.** If even one id in a
submitted `mentionUserIds` list fails validation, the WHOLE message is
rejected with that one generic 400 - never silently dropping the bad
mention and sending the rest with the valid ones applied.

**Payload shape.** `POST /api/chat/messages` (already multipart since
DOC-70) gained one more optional text field: `mentionUserIds`, a
JSON-stringified array of user id strings (e.g. `'["<id1>","<id2>"]'`).
Parsed via `JSON.parse` inside a try/catch (`parseMentionUserIdsField`) -
never `eval`. Malformed JSON, a non-array, non-string entries, or more
than 10 raw entries are all rejected before any database round trip;
valid entries are deduplicated (case-sensitive string dedup, sufficient
since every surviving entry is already a canonical 24-character hex
`ObjectId` string) before the same-organization/active/role check runs
against the database.

**Duplicate mentions and the 10-user cap.** The same user id listed more
than once in one message produces exactly one notification, never one
per occurrence - deduplication happens before both the database
validation query and the notification-dispatch loop. A message may
mention at most 10 unique users (`MAX_MENTIONS_PER_MESSAGE`), enforced at
three independent layers: the raw-JSON-array-length check (before any
DB work), the deduplicated-count check (after resolution), and a schema-
level `mentionedUserIds` validator on `ChatMessage` itself (defense in
depth against a future code path that might construct a document without
going through the controller).

**Self-mentions.** A person mentioning themselves is accepted and stored
structurally (their own message can visually show `@Sam Sender`) but
never generates a self-notification - checked twice, independently:
`createMessage`'s own dispatch loop explicitly filters the sender out of
the recipient list before ever calling `createNotification`, AND
`createNotification` (`services/notification.service.js`) itself
separately re-checks `actorId === recipientId` and silently no-ops -
neither guard depends on the other being correct.

**Notification type: `CHAT_MENTION`.** Added to
`models/Notification.js`'s `NOTIFICATION_TYPES`. Title is always "You
were mentioned in Organization Chat"; message is always
`"{sender's current fullName} mentioned you in a chat message."`;
`metadata` carries only `{ chatMessageId }` - never a copy of the
message's actual text or attachments (task spec: "Do not duplicate full
chat message contents unnecessarily"). `requestId` is always `null` -
this notification type has no Request association. Clicking a
`CHAT_MENTION` notification (`NotificationBell.jsx`) navigates to `/chat`
- this project has no message-anchor/scroll-to-message mechanism, so it
intentionally just opens the chat page, exactly like `chatMessageId`
being present-but-unused today for that possible future enhancement.

**Notification failures never fail the message.** `createNotification`
was already unconditionally best-effort (never throws) before this
ticket; `createMessage`'s own dispatch loop runs AFTER the message has
already been saved and is additionally wrapped in its own try/catch
purely so a hypothetical bug in the dispatch loop itself could never turn
an already-successful send into a 500. Message persistence is always the
primary, non-negotiable outcome.

**Mention suggestion endpoint.** `GET /api/chat/mention-users?q=<text>`
(same manager/operator/employee + organization-membership + active-
organization gate as the rest of `chat.routes.js`) returns up to 8
same-Organization, active, allowed-role candidates matching a
case-insensitive substring of `fullName` (reusing
`utils/requestQueryBuilder.js`'s existing `escapeRegExp`, never a second
copy of that escaping logic), sorted alphabetically. Response fields are
deliberately minimal: `{ id, fullName, role, hasProfileImage }` - never
`email`, `bio`, `isActive`, `organizationId`, or any other User-document
internal. A missing/empty `q` returns a same-Organization browse list
rather than an error; an over-long `q` (>100 characters) is rejected with
400. No existing endpoint could safely serve this: `GET /api/users` is
Manager-only and returns far more fields than a mention chip ever needs.

**Frontend mention UX (`OrganizationChat.jsx`).** Typing `@` (at the
start of the message or right after whitespace, with no whitespace typed
since) opens a debounced (200ms) suggestion dropdown querying the new
endpoint; ArrowUp/ArrowDown/Enter/Tab/Escape navigate, select, or dismiss
it without disrupting the existing Enter-sends/Shift+Enter-newline
composer behavior. Selecting a suggestion inserts the CURRENT
`@Full Name ` text into the draft (stable display text) while separately
tracking the real userId in a `selectedMentions` `Map<userId, fullName>`
- the id is never later reconstructed by parsing the typed text. If the
person deletes an inserted `@Full Name` substring before sending, that
entry is pruned from `selectedMentions` automatically. On send, only
`Array.from(selectedMentions.keys())` - the real, tracked ids - is passed
to the backend as `mentionUserIds`; the backend re-validates every one of
them regardless; this is UX convenience only, never the authorization
boundary. The dropdown shows initials-only "avatars" (no per-keystroke
authenticated image fetch - `hasProfileImage` is returned by the backend
but intentionally unused, the same performance-first choice DOC-70 made
for the message list's own Avatar integration).

**Safe mention rendering, never `dangerouslySetInnerHTML`.** A message's
`content` and its server-resolved `mentions: [{ id, fullName }]` array
are passed through `renderContentWithMentions` - a plain, greedy,
left-to-right scan using `String.prototype.startsWith` (longest name
first, so "Ahmad" can never incorrectly "win" inside "Ahmad Saleh") that
produces an array of plain strings and `<span className="chat-mention">`
React elements. This is a pure DISPLAY tokenizer only - it is never
consulted for authorization or notification decisions, both of which
already happened server-side at send time using the real, validated
`mentionedUserIds`.

**Attachment compatibility.** Mentions work identically whether a
message is text-only, attachment-only, or both together - an
attachment-only message with `mentionUserIds` set still creates real
mentions and real notifications (no "invisible mentions" limited to
text-only messages). An empty-text, zero-attachment, mentions-only
submission is still rejected exactly as before DOC-72 - a mention alone
does not satisfy the "must have text or an attachment" rule.

**Historical/compatibility.** `mentionedUserIds` defaults to `[]` for
every message sent before this ticket - no migration is required, and
`sanitizeChatMessage` always returns `mentions: []` for such a message
rather than `undefined`, so the frontend's rendering path never needs a
special case for old data.

**Polling unchanged.** No new polling process was introduced -
`CHAT_MENTION` notifications ride the existing DOC-18
`NotificationBell.jsx` polling interval exactly like every other
notification type, and mentioned messages ride the existing 7-second
Organization Chat poll exactly like every other message.

**Test coverage.** A second mocked test harness (the same require.cache-
injection pattern: fake `ChatMessage`/`User` models and a fake
`notification.service`, the real `createMessage`/`listMessages`/
`searchMentionUsers`/`parseMentionUserIdsField` production code running
unmodified against them) ran 55 targeted assertions: pure
`parseMentionUserIdsField` parsing/shape validation (12), valid/multiple/
duplicate mentions and notification dispatch (5), self-mention behavior
(2), invalid-mention rejection including the identical-error cross-org/
inactive/System-Admin/nonexistent/partial-invalid cases (7), attachment
compatibility across text-only/attachment-only/both/neither (5),
notification-dispatch failure resilience (1), `listMessages` fresh-
resolution and historical-compatibility (3), `searchMentionUsers`
behavior including the result-count cap and organization isolation (8),
security/spoofing checks (3), frontend static contract checks confirming
no `dangerouslySetInnerHTML` usage and consistent mention wiring across
`OrganizationChat.jsx`/`api.js`/`NotificationBell.jsx` (6), and regression
coverage confirming plain/attachment-only/both-empty sends behave exactly
as DOC-70 left them (3). All 55 passed.

## DOC-73 - Private Direct Messages

**What this adds.** Secure, private 1:1 messaging between exactly two
members of the same Organization - reachable at `/messages`, separate from
Organization Chat (`/chat`). A conversation is visible and writable ONLY
to its own two participants; nobody else - not a Manager, not System
Admin - can read or send into it without being one of those two people.

**A dedicated architecture, deliberately NOT merged into Organization
Chat.** The read-only audit (this ticket's own mandatory first phase)
concluded the two features have fundamentally incompatible authorization
models: Organization Chat's entire point is "any active same-Organization
member may read everything"; a DM's entire point is the opposite -
"exactly these two people, and only these two people, may ever read this
thread". Conflating the two collections/routers would mean every single
read/write query needs an extra conditional branch forever, for no
benefit. Two new models were introduced instead:
`DirectMessageConversation` (the small, per-pair parent document) and
`DirectMessage` (one document per message, its own collection - never
embedded inside the conversation, so message volume never threatens the
16MB BSON ceiling the same way Notification/RequestActivity/ChatMessage
already avoid it).

**Exactly two distinct participants, no group chat.** Enforced at the
schema level, not just by controller convention -
`DirectMessageConversation.participantIds` has its own validator that
rejects any document without exactly two entries, or with the same id
twice.

**No duplicate conversations - the participantKey.** `participantKey` is
`[userIdA, userIdB].sort().join(':')` - identical regardless of who
started the conversation - carrying a UNIQUE `{organizationId,
participantKey}` index. "Alice messages Bob" and "Bob messages Alice"
always resolve to the exact same document; a race between two concurrent
"start conversation" requests is handled by catching the index's own
duplicate-key error and re-reading the now-existing conversation, rather
than failing the second request.

**Same-Organization, active-user, allowed-role enforcement - twice.**
`POST /api/direct-messages/conversations` accepts ONLY `{ recipientId }` -
never `participantIds`/`senderId`/`organizationId`/`role`. The recipient
is independently re-validated against the database
(`organizationId: req.user.organizationId, isActive: true, role: { $in:
['manager','operator','employee'] }`) with a SINGLE generic rejection
message covering every failure reason (nonexistent, cross-Organization,
inactive, System Admin/disallowed role) - the same DOC-38/DOC-72
anti-enumeration convention this project already uses, so a prober can
never learn which specific reason applied to a crafted id.

**System Admin is excluded with NO special-case code.** System Admin's
`organizationId` is always `null` (enforced by `models/User.js`'s own
schema validator, unrelated to this ticket) - and is additionally
structurally rejected before ever reaching a single line of this
controller, since `routes/directMessage.routes.js`'s own `requireRole(
'manager', 'operator', 'employee')` never includes it, exactly the same
gate Organization Chat already uses. There is no
`if (role === 'system_admin')` bypass anywhere in this feature.

**The one rule every conversation-scoped endpoint shares:
`loadAuthorizedConversation`.** A single function in
`directMessage.controller.js` is the ONLY place that decides "may this
caller touch this conversation" - `listMessages`, `sendMessage`,
`markConversationRead`, and `getAttachmentContent` all call it first, none
of them re-implements the check inline. It requires BOTH
`organizationId: req.user.organizationId` AND `req.user.userId` present in
`participantIds` - a conversation that does not exist, one from another
Organization, and one the caller simply is not a participant of (even a
Manager, even for two of their own Employees) all resolve to the
IDENTICAL generic 404, `"Conversation not found."` - verified directly by
a dedicated test that a non-participant Manager and a cross-Organization
user get byte-identical status/message for the same conversation id.
**There is no Manager-bypass and no System-Admin-bypass anywhere in this
feature** - confirmed by dedicated tests (a Manager who is not one of the
two participants is rejected exactly like a random Employee would be).

**Conversation list, user search, message pagination.**
`GET /api/direct-messages/users?q=` mirrors DOC-72's own mention-search
shape (case-insensitive substring on `fullName`, same-Organization,
active, allowed-role only, minimal `{id, fullName, role, hasProfileImage}`
fields, capped at 8 results) but additionally excludes the caller
themselves. `GET /api/direct-messages/conversations` returns only
conversations where the caller is a participant - never full message
history, just `{id, otherParticipant, lastMessagePreview, lastMessageAt,
unreadCount}` per conversation.
`GET /api/direct-messages/conversations/:id/messages` uses the identical
`before`/`limit` cursor-pagination shape `chat.controller.js`'s own
`listMessages` already established (newest-first internally, reversed to
chronological order for the response).

**Send: text/attachment/both, sender always server-derived.**
`POST /api/direct-messages/conversations/:id/messages` accepts multipart
`content` (optional text) + `attachments` (0-3 files) - valid whenever
trimmed text is non-empty OR at least one attachment exists, rejected only
when both are empty (identical rule to DOC-70's own ChatMessage). `senderId`
is ALWAYS `req.user.userId` - there is no code path that ever reads a
sender identity from the request body; a forged `senderId`/`organizationId`
in the payload is simply never read, confirmed by a dedicated test. If the
OTHER participant has since been deactivated, a NEW send is blocked with a
safe `409 "This user is currently inactive."` - checked fresh on every
send, never cached from conversation-creation time - while the
conversation and every historical message remain fully intact and
readable for the still-active participant.

**Attachments: reused upload middleware, independent storage namespace.**
The read-only audit found DM attachment rules to be byte-for-byte
identical to Organization Chat's own (JPEG/PNG/WEBP/PDF/TXT, 10MB/file,
3 files/message) - `middleware/chatUpload.js`'s existing Multer instance
is reused UNCHANGED for DM uploads (creating a second, identical Multer
config would be pure duplication). The underlying STORAGE is still fully
independent: a new `services/dmAttachmentStorage.js` (mirroring
`chatAttachmentStorage.js`'s own already-DM-ready
`{organizationId, userId/conversationId, mimeType}` contract, exactly as
that file's own DOC-70 comment anticipated) writes to its own dedicated
GridFS bucket (`directMessageAttachments`) and S3 prefix
(`dm/{organizationId}/{conversationId}/{uuid}.ext`) - never mixed with
`chatAttachments`/`requestImages`/`profileImages`. The attachment content
endpoint (`GET .../messages/:messageId/attachments/:attachmentId/content`)
reuses the exact same IDOR-protection shape as DOC-70: participant check
first, then message scoped to that conversation, then the attachment
resolved ONLY from that message's own subdocument array - never a global
lookup by attachment id alone.

**Per-participant read state, not a global boolean.**
`DirectMessageConversation.readStates` is a structured array
(`[{userId, lastReadAt}]`, exactly two entries) rather than a single
`read` boolean (which cannot represent "read by A but not yet by B") or a
Map keyed by a dynamic ObjectId (which the task's own spec flagged as
awkward). `POST /api/direct-messages/conversations/:id/read` updates ONLY
the caller's own entry - the other participant's entry is never read or
written by that call. Unread count for a conversation is `messages where
senderId != me AND createdAt > my own lastReadAt` (`null` lastReadAt =
"never opened, everything is unread"); the conversation LIST computes this
for every conversation in ONE batched aggregation query (grouping by
conversationId across an `$or` of per-conversation thresholds) rather than
one `countDocuments` call per conversation.

**Denormalized preview - no per-conversation N+1 on the list.**
`lastMessageAt`/`lastMessagePreview` live directly on
`DirectMessageConversation`, updated once whenever a message is
successfully sent - so listing conversations never needs a second query
per conversation to find "what was the last message". The preview is
always a short, already-truncated, already-safe plain-text string; an
attachment-only message previews as the fixed string `"Sent an
attachment"`, never a filename or MIME type.

**Notification: `DIRECT_MESSAGE`, generic wording, best-effort.** Added to
`models/Notification.js`'s `NOTIFICATION_TYPES`. Title is always "New
message"; message is always `"{sender's current fullName} sent you a
private message."` - the actual private message text is never copied into
the notification. `metadata` carries only `{conversationId, messageId}`.
Dispatched AFTER the message has already been saved, wrapped in its own
try/catch even though `createNotification` itself already never throws
(defense in depth) - a notification failure never loses the message
(verified by a dedicated test that forces the notification call to
throw). Self-notification is prevented twice, independently: the
controller never targets the sender, and `createNotification`'s own
`actorId === recipientId` guard is a second backstop. Clicking a
`DIRECT_MESSAGE` notification (`NotificationBell.jsx`) navigates to
`/messages` - `metadata.conversationId` is present but intentionally
unused today (this project has no scroll-to-conversation mechanism, the
same documented limitation `CHAT_MENTION`'s own `chatMessageId` already
has).

**No @mentions inside a DM.** A 1:1 conversation has only one other
possible participant, so a structural mention concept would be pure
ceremony - a literal `@text` a person types remains completely ordinary
text, never tokenized or highlighted.

**No admin surveillance endpoints.** There is no "list all conversations",
"read any conversation", or "export DM history" endpoint anywhere in this
feature, for any role including System Admin - this ticket is
intentionally, permanently participant-private. No DM content, filename,
or participant pairing is ever written to the Audit Log (DOC-64) - normal
private messaging is not an administrative action.

**Immutable, like Organization Chat.** No edit/delete endpoint exists for
either a conversation or a message - `routes/directMessage.routes.js` has
no PATCH/DELETE route at all.

**User-state transitions.** A role change (Employee → Operator, etc.)
never breaks an existing conversation - the conversation is keyed by
`userId`, not role. Reactivating a previously-deactivated participant
lets the SAME conversation resume (the unique `participantKey` index
guarantees no duplicate is ever created). This project has no
organization-transfer feature for an existing User (audited and
confirmed: `models/User.js`'s `organizationId` is only ever set once, at
account-creation time, for every role) - so a DM becoming cross-
Organization-accessible after the fact is not a reachable state today; if
such a feature is ever introduced, every read/write in this controller
already re-derives and re-checks `organizationId` fresh on every request
rather than trusting a cached value, so it would fail closed rather than
silently leak.

**Frontend `/messages`.** A two-pane layout (conversation list + active
conversation) reusing Organization Chat's own proven polling/auto-scroll/
attachment-selection patterns wherever the underlying UX problem is
identical (task spec: "Reuse Organization Chat behavior if suitable") -
conversation list polls every 15 seconds, the open conversation polls
every 5 seconds (skipped entirely while the tab is hidden), auto-scroll
only fires when the viewer is already near the bottom, and attachments
reuse `AuthenticatedChatAttachment.jsx` UNCHANGED (it was already fully
generic - only `{url, mimeType, originalName, size}` - no new component
needed). Avatars reuse `Avatar.jsx` UNCHANGED: the backend only ever
returns `hasProfileImage` (never a full URL, mirroring DOC-72's own
mention-dropdown minimalism), and the frontend builds the
`/users/:userId/profile-image` URL itself, since that endpoint already
authorizes any same-Organization viewer. On narrow viewports exactly one
pane is shown at a time with a back button - it is a CSS-only
responsive change, never a desktop-width requirement. A "Messages" Navbar
link shows its own independent unread badge (`DirectMessageNavBadge.jsx`)
- deliberately never merged visually with `NotificationBell.jsx`'s own
count, per the task's own explicit instruction.

**Test coverage.** A third mocked test harness (the same require.cache-
injection pattern as DOC-70/72: fake `DirectMessageConversation`/
`DirectMessage`/`User` models and a fake `notification.service`, the real
`directMessage.controller.js` production code running unmodified against
them) ran 67 targeted assertions: conversation creation across every
allowed role pair plus reverse-pair idempotency/self/inactive/cross-org/
System-Admin rejection (11), privacy enforcement including the critical
Manager-non-bypass and identical-404-shape checks (7), send validation
including forged sender/organization fields (8), attachment upload/
authorization/IDOR checks (8), per-participant read-state and unread-count
behavior (5), notification dispatch/privacy/failure-resilience (7),
user-state transitions - deactivation blocks new sends while preserving
history, reactivation resumes the same conversation, role change is a
no-op (5), a consolidated security-attack simulation (Manager/cross-org
conversation-id guessing, mismatched attachment/message pairing, forged
recipientId/senderId/organizationId) (6), frontend static contract checks
(5), and regression confirming Organization Chat/DOC-70/DOC-72/notification
infrastructure remain structurally untouched (5). All 67 passed.

## DOC-74 - Organization Policies & Guidelines

A centralized, per-Organization knowledge/compliance area: Managers create
and maintain policies scoped to their own Organization; Employees/
Operators read the currently-published ones and may optionally record
that they have read a given policy; Managers can see adoption/compliance
statistics for the policy's current version.

**Two dedicated models, never an embedded array.** `OrganizationPolicy`
(`organizationId`, `title`, `content`, `category`, `isPublished`,
`version`, `status`, `archivedAt`, `createdBy`, `updatedBy`) and
`PolicyAcknowledgement` (`organizationId`, `policyId`, `userId`,
`policyVersion`, `acknowledgedAt`) are both top-level collections, the
same "unbounded child data lives in its own collection" reasoning
Notification/RequestActivity/ChatMessage/DirectMessage already
established for this project - the read-only audit confirmed
`Organization.js` holds only a small, fixed set of scalar settings today,
and adding an unbounded policy list directly onto it would risk the same
16MB BSON ceiling those other features already avoid.

**Plain text only - CRITICAL.** `content` is a plain `String` field with
no HTML-aware type or sanitizer. It is stored completely unmodified
(never HTML-stripped or escaped at write time) because the frontend NEVER
renders it via `dangerouslySetInnerHTML`/`innerHTML` - `Policies.jsx`
always renders `{detail.content}` as ordinary React text, with CSS
`white-space: pre-wrap` preserving the author's own line breaks. A policy
whose content is literally `<script>alert(1)</script>` is stored exactly
as typed and always displays as harmless text, never executes - the same
"storage is honest, rendering is safe" contract `User.bio` (DOC-71)
already established. `title`/`content`/`category` are all validated by a
small, dedicated `utils/policyFieldValidation.js` (title required/
trimmed/max 150 chars, content required/max 10,000 chars, category a
controlled enum: GENERAL/SECURITY/IT/SAFETY/HR/OPERATIONS/OTHER).

**Versioning.** `version` starts at 1 and is incremented ONLY when a
genuinely meaningful field changes - `title`, `content`, or `category`.
Toggling `isPublished` alone (publish/unpublish with no content change)
never bumps the version. Versioning matters because acknowledgement is
version-scoped (see below): a person who acknowledged version 1 of a
policy never silently counts as having acknowledged version 2's different
wording.

**Draft vs. Published vs. Archived.** `isPublished` (Boolean) and `status`
(`ACTIVE`/`ARCHIVED`) are two independent flags. A Manager can see every
combination in their own Organization; an Employee/Operator can only ever
see a policy that is BOTH `isPublished: true` AND `status: 'ACTIVE'` -
enforced entirely server-side (`loadAuthorizedPolicy` in
`policy.controller.js`), never hidden only by the frontend. Archiving
(`PATCH /api/policies/:policyId/archive`, its own dedicated endpoint, not
part of the general update whitelist) deliberately does NOT force
`isPublished` back to `false` - `status: 'ARCHIVED'` alone is already
sufficient to hide the policy from non-Managers, so `isPublished` is left
untouched as an honest historical record of whether the policy was
published at the moment it was archived. There is no hard-DELETE anywhere
in this feature and no un-archive endpoint (soft-archive only) - a
`PolicyAcknowledgement.policyId` must always resolve to a real document
for a Manager's own historical compliance reporting to stay meaningful.

**Anti-enumeration for non-Managers.** A single generic 404 ("Policy not
found.") covers three different underlying reasons for an Employee/
Operator: the id does not exist at all, it belongs to a different
Organization, or it is a real, same-Organization policy that simply is
not currently visible to that role (a draft or an archived policy). This
is deliberate - a distinguishing error would itself leak "a draft with
this id exists in your Organization" to someone who is not supposed to
know that.

**Field allowlists, never mass assignment.** `POST /api/policies` accepts
only `{title, content, category, isPublished}`; `PATCH
/api/policies/:policyId` whitelists the same four fields via explicit
`hasOwnProperty` checks. `organizationId`, `createdBy`, `updatedBy`,
`version`, and `status` are NEVER read from the request body on either
route, even if a client sends them - they are always server-derived
(`req.user.organizationId`/`req.user.userId`) or server-computed
(version increment, `status`).

**Acknowledgement.** `POST /api/policies/:policyId/acknowledge` - the
policy must belong to the caller's own Organization (else 404) and be
currently published + active (else 400); `userId` is always
`req.user.userId`, never accepted from the body. A unique index on
`PolicyAcknowledgement{policyId, userId, policyVersion}` makes
acknowledging the same version twice a database-level no-op; the
controller's own find-first check is the fast path, and a race between two
concurrent acknowledge calls is handled by catching that index's own
duplicate-key error and returning the now-existing row - the identical
pattern `DirectMessageConversation` creation (DOC-73) already established.
A brand-new user automatically sees every currently-published policy but
gets NO auto-created acknowledgement row - they remain unacknowledged
until they actually confirm. Acknowledging is deliberately NOT audit-
logged (task spec: "normal acknowledgement is not an administrative
action") - it is already durably, permanently recorded in
`PolicyAcknowledgement` itself.

**Compliance statistics - decisions, documented.** The eligible population
for both the Manager's list-view acknowledgement summary and the
per-policy acknowledgement detail (`GET
/api/policies/:policyId/acknowledgements`) is **active Employees and
Operators only** - Managers are excluded from both the denominator and the
returned user list (even though a Manager is technically allowed to
acknowledge a policy too), and an inactive Employee/Operator is excluded
as well. This follows the task's own "compliance reporting should
primarily focus on organization users" guidance. Every acknowledgement
counted is scoped to the policy's CURRENT `version` only - an old-version
acknowledgement never inflates today's percentage. Both the list view (one
summary per policy) and the detail view batch their queries (one eligible-
user fetch, one aggregate/find over `PolicyAcknowledgement`) rather than
running one query per policy or per user.

**Notifications.** `POLICY_PUBLISHED` and `POLICY_UPDATED` were added to
`Notification.NOTIFICATION_TYPES`. A single documented rule decides when
to notify: dispatch when the policy is published AFTER the request
completes AND EITHER this is a newly-published draft OR an
already-published policy just received a genuinely meaningful content
change while remaining published. This one condition correctly excludes
draft saves, unpublish actions, and a no-op publish-flag save with no
content change - and correctly fires exactly once for a request that does
both (a brand-new policy created already published). Recipients are the
same active-Employee/Operator population the compliance statistics use.
`message` is always the fixed, generic string "New organization policy
available." and `metadata` contains ONLY `{policyId}` - never the title or
any content. Draft saves, minor edits to a still-unpublished draft, and
archiving never notify anyone.

**Audit Log.** Five actions were added: `POLICY_CREATED`, `POLICY_UPDATED`,
`POLICY_PUBLISHED`, `POLICY_UNPUBLISHED`, `POLICY_ARCHIVED` (plus
`'OrganizationPolicy'` added to `TARGET_TYPES`). `POLICY_UPDATED` is
recorded ONLY when a real title/content/category field changed - a pure
publish/unpublish toggle with no content change gets its own dedicated
`POLICY_PUBLISHED`/`POLICY_UNPUBLISHED` entry instead, so a publish-only
request never produces two audit rows describing the same single action.
`changedFields` metadata never includes the actual content - only field
NAMES that changed, plus `policyId`/`title`/`version`. A create that goes
live immediately (`isPublished: true` on creation) records only
`POLICY_CREATED` (with `metadata.isPublished: true`), not a second,
redundant `POLICY_PUBLISHED` entry for the same request.

**Frontend `/policies`.** One shared page for all three allowed roles
(the same established pattern as `/chat` and `/messages`) - `Policies.jsx`
renders an Employee/Operator two-pane read view (policy list + detail,
with the acknowledgement button/status) or a Manager management view
(a table with Edit/Publish-Unpublish/Archive/Acknowledgements actions,
plus a simple Create/Edit form - a title input, a category select, a
plain `<textarea>`, and a Published checkbox; no rich-text editor, no HTML
toolbar) based on `user.role` - the backend remains the sole authority on
what data each role actually receives. The acknowledgement button reads
"I Have Read and Understand This Policy", deliberately never implying
legal consent beyond what is actually recorded. `NotificationBell.jsx`
navigates a `POLICY_PUBLISHED`/`POLICY_UPDATED` notification to
`/policies`.

**Test coverage.** A fourth mocked test harness (the same require.cache-
injection pattern as DOC-70/72/73: fake `OrganizationPolicy`/
`PolicyAcknowledgement`/`User` models plus fake `Notification`/`AuditLog`
models backing the REAL, unmodified `notification.service.js`/
`auditLog.service.js`, with the real `policy.controller.js` production
code running against all of them) ran 100 targeted assertions: creation
including field-spoofing rejection, validation limits, and literal XSS
storage (16), publish-visibility across every role/status combination
including the uniform-404 guarantee (14), update/versioning including
mass-assignment rejection and cross-org failure (10), acknowledgement
including idempotency, version-scoped uniqueness, and cross-org rejection
(11), compliance statistics denominator/percentage correctness (8),
notification dispatch-trigger correctness across every draft/publish/
update/unpublish/archive transition (11), Audit Log correctness including
the no-duplicate-entry-on-repeat-archive check (5), a cross-org/malformed-
id security-attack simulation (6), route-level `requireRole('manager')`
static contract checks (7), and frontend static contract checks including
verifying the app never uses `dangerouslySetInnerHTML` (8). All 100
passed. A separate, clean-process regression check confirmed every
existing model/controller/route (DOC-60/61/64/67/68/69/70/72/73) plus
every new DOC-74 file load together in one shared Node process with no
circular dependency and no `OverwriteModelError`.

## DOC-75 - Organization Q&A / Knowledge Board

A persistent, searchable Q&A area, deliberately distinct from Organization
Chat: Chat is real-time/transient communication that scrolls away; the
Knowledge Board is structured, permanent organizational knowledge meant to
be found again later via search, category, and status filters. Employees/
Operators/Managers in the same Organization ask questions, anyone active
in that Organization may answer, and the question's own author (or a
Manager) may mark one answer accepted.

**Two dedicated collections, never an embedded array.** `KnowledgeQuestion`
(`organizationId`, `authorId`, `title`, `content`, `category`, `status`,
`acceptedAnswerId`, `answerCount`, `viewCount`) and `KnowledgeAnswer`
(`organizationId`, `questionId`, `authorId`, `content`) - the same
"unbounded child data lives in its own collection" reasoning
Notification/ChatMessage/DirectMessage/DOC-74's own
OrganizationPolicy+PolicyAcknowledgement split already established. Every
answer carries its own `organizationId`/`questionId` denormalized from the
already-authorized parent question, so an answer-scoped lookup is always a
single flat, fully-scoped query (task spec section 41's own "ANSWER
IDOR... all must match" requirement) - never a global answer lookup
trusted against a separately-supplied questionId.

**Category decision, documented.** A controlled, fixed enum (GENERAL/IT/
NETWORK/COMPUTERS/ELECTRICITY/PLUMBING/MAINTENANCE/SECURITY/HR/OTHER) -
NOT a reuse of `ServiceCategory`. The read-only audit found
`ServiceCategory` is a Manager-owned, per-Organization, DYNAMIC list tied
specifically to Request routing and Operator specialty-matching (DOC-43/
DOC-44); a brand-new Organization starts with zero Service Categories
until a Manager creates some, and a Manager may deactivate one at any time
for Request-routing reasons unrelated to Q&A content. Coupling the
Knowledge Board's own categorization to that list would make asking a
question depend on unrelated Request-routing configuration. A small fixed
enum - the exact one the task spec itself suggests - always exists and
can never be emptied out from under this feature.

**Plain text only - CRITICAL.** `content` (question and answer) is a plain
`String` field with no HTML-aware type or sanitizer - Knowledge.jsx always
renders it as ordinary React text (`{detail.content}` / `{answer.content}`),
never `dangerouslySetInnerHTML`/`innerHTML`, the same "storage is honest,
rendering is safe" contract `OrganizationPolicy.content` (DOC-74) already
establishes. CSS `white-space: pre-wrap` preserves line breaks.

**Question status - centralized transition logic.** `OPEN` (no accepted
answer) / `ANSWERED` (an accepted answer exists) / `CLOSED` (author or
Manager intentionally ended discussion). Every transition is decided by
exactly one small, pure module - `utils/knowledgeStatusTransitions.js` -
never re-derived ad hoc in a controller: accepting an answer always
produces `ANSWERED`; removing the accepted answer ("unaccept") always
produces `OPEN`; closing always produces `CLOSED` regardless of the prior
state; reopening returns to `ANSWERED` if an accepted answer still exists
or `OPEN` otherwise. This project's own documented EXTENSION of the task
spec's six explicit rules: a `CLOSED` question also fully blocks
accept/unaccept and editing (of either the question or its answers) -
none of the task spec's own six rules describe a "CLOSED + accept"
transition, so rather than leave it undefined, closing is treated as a
full lock; a Manager or the author must reopen first.

**Permissions.** Ask: employee/operator/manager, same Organization only
(System Admin structurally excluded - never in
`requireRole('manager', 'operator', 'employee')`). Answer: any ACTIVE
same-Organization member of those three roles, including the question's
own author. Accept/unaccept/close/reopen: the question's own author OR a
same-Organization Manager - enforced inside the controller
(`isOwnerOrManager`), not at the route level, since a static route-level
role gate cannot express "the author OR a Manager" (the author may be an
Employee or Operator). Edit question/edit answer: the CONTENT's own author
only - Manager moderation-editing of someone else's question/answer text
is explicitly NOT implemented in this version (documented decision - no
requirement calls for it, and silently rewriting another user's words
would be a surprising, undocumented capability).

**Endpoints** (`/api/knowledge`): `POST /questions`, `GET /questions`
(pagination + search + category/status filters + sort), `GET
/questions/:id`, `PATCH /questions/:id` (author only, blocked while
CLOSED), `POST /questions/:id/close`, `POST /questions/:id/reopen`, `GET
/questions/:id/answers`, `POST /questions/:id/answers` (rejected 409 while
CLOSED), `PATCH /questions/:id/answers/:answerId` (answer author only),
`POST /questions/:id/answers/:answerId/accept`, `DELETE
/questions/:id/accepted-answer` ("unaccept", idempotent). No DELETE route
for a question or an answer itself anywhere (task spec section 23 -
"Prefer no delete in first version" - persistent knowledge is not expected
to disappear casually; there is not even a soft-delete field, since no
requirement in this ticket calls for removing content once posted).

**Field allowlists, never mass assignment.** `POST /questions` accepts
only `{title, content, category}`; `POST /questions/:id/answers` accepts
only `{content}`. `organizationId`/`authorId`/`status`/`acceptedAnswerId`/
`answerCount`/`viewCount` are NEVER read from the request body on any
route, even if a client sends them - always server-derived or
server-computed.

**Search.** Case-insensitive substring match over `title` + `content`,
regex-escaped via this project's own `utils/requestQueryBuilder.js`
`escapeRegExp` (never a raw user-supplied `RegExp`) - the identical
"never let a caller inject a potentially catastrophic-backtracking
pattern" guard DOC-54's own Request search and DOC-72's own mention search
already established, reused a third time rather than re-implemented.

**Pagination - a documented deviation.** Simple PAGE-BASED pagination
(`page` + `limit`, skip/limit), NOT the `limit` + `before`-cursor
convention Organization Chat/Direct Messages/Audit Log all share. That
cursor shape is specifically suited to an append-only, always-newest-
first, real-time feed; it has no natural meaning for `sort=mostAnswered`
(a value that can change out from under a stable point-in-time cursor),
and page numbers work identically regardless of which of the three sort
options (`newest`/`oldest`/`mostAnswered`) is active. This is the same
"persistent/searchable knowledge vs. transient/real-time communication"
distinction the ticket itself draws between Q&A and Chat, reflected
directly in the pagination choice.

**Answer count - denormalized, server-controlled only.** `answerCount` is
incremented via a single atomic `$inc` immediately AFTER a `KnowledgeAnswer`
document has actually been saved - never speculatively before, so a failed
answer creation can never increment it, and never trusted from the client.

**View count - optional, best-effort.** Incremented via a single atomic
`$inc` on `GET /questions/:id`, fire-and-forget - its own failure is only
ever logged, never surfaces to the caller, and never slows down the
primary read response (task spec section 36: "do not prioritize over core
functionality").

**Author data.** Minimal only - `{id, fullName, role, hasProfileImage}`,
the identical shape chat/DM/policy already return. Never email/bio/
sessions/organization internals. A deactivated author's historical
question/answer still resolves and displays their real name (never
filtered by `isActive` - the same "historical author remains visible"
rule Organization Chat's own `buildUserLookupMap` already established);
only NEW content creation is blocked for an inactive user (enforced by
`requireActiveOrganization`/the auth layer generally, not by this
feature's own code).

**Notifications.** `KNOWLEDGE_ANSWER_ADDED` (dispatched to the question's
author whenever someone else answers) and `KNOWLEDGE_ANSWER_ACCEPTED`
(dispatched to the accepted answer's author whenever someone else accepts
it) were added to `Notification.NOTIFICATION_TYPES`. Both are best-effort
and self-notify-guarded (checked explicitly at the call site AND
independently inside `createNotification` itself - defense in depth, the
same shape DOC-72/73/74 already use) and carry ONLY `{questionId,
answerId}` in `metadata` - never the answer's own text. `NotificationBell.jsx`
navigates either type to `/knowledge?questionId=<id>` - Knowledge.jsx
reads that query parameter on load and opens the matching question detail
directly, a small, real "open questionId" behavior (not a scroll-anchor)
satisfying the task spec's own "ideally open questionId if current
navigation system supports metadata" hint without overbuilding.

**Audit Log - deliberately quiet.** Normal Q&A activity (asking, answering,
accepting) is NEVER audit-logged - it is ordinary user activity, not an
administrative action. Exactly ONE new action exists,
`KNOWLEDGE_QUESTION_CLOSED_BY_MANAGER`, recorded ONLY when a Manager closes
a question authored by a DIFFERENT user - a genuine moderation action over
content the Manager does not own. A Manager closing their own question is
never logged.

**Upvotes and attachments - both deferred, documented.** Neither is part
of this version. Upvotes were explicitly optional/non-core per the task
spec; attachments were explicitly recommended for deferral (Organization
Chat already handles file sharing, and adding a second, parallel
attachment pathway here would expand scope without a stated requirement).
Both can be added later as independent, additive features without any
schema change to the core ask/answer/accept/search functionality shipped
here.

**No @mentions.** Deliberately not implemented here (task spec section
38) - Organization Chat's own mention parser stays a Chat-only feature;
Q&A's own notification semantics (question author, accepted-answer
author) already cover the two recipients this ticket actually needs.

**Frontend `/knowledge`.** One shared page for all three allowed roles - a
searchable/filterable card-grid list (title, category, status, answer
count, author, relative time) plus a single-column question detail view
(question body, answers oldest-first with the accepted one visually
highlighted, an answer-composer, and inline Accept/Close/Reopen/Edit
controls shown only to the question's own author or a Manager, mirroring
exactly what the backend already allows - never a control that the
backend would then reject). Avatars reuse `Avatar.jsx` (DOC-71) unchanged.
Empty states: "No questions yet. Be the first to ask a question." and "No
answers yet. Know the answer? Help your organization."

**Test coverage.** A fifth mocked test harness (the same require.cache-
injection pattern as DOC-70/72/73/74: fake `KnowledgeQuestion`/
`KnowledgeAnswer`/`User` models plus fake `Notification`/`AuditLog` models
backing the REAL, unmodified `notification.service.js`/
`auditLog.service.js`, with the real `knowledge.controller.js` production
code running against all of them) ran 70 targeted assertions: question
creation including field-spoofing rejection and validation limits (10),
list/search/filter/pagination including regex-special-character safety
(8), answers including cross-org rejection, forged-author rejection, and
closed-question enforcement (7), accepted-answer permissions including
cross-org and mismatched-pairing rejection and accepted-answer replacement
(8), close/reopen lifecycle including the one deliberate
Manager-moderation Audit Log entry (6), notification dispatch correctness
including both self-notify guards and a forced-failure resilience check
(6), a cross-org/mismatched-pairing/XSS/field-spoofing security-attack
simulation (6), route-level static contract checks (4), and frontend
static contract checks including verifying the page never uses
`dangerouslySetInnerHTML` (12). All 70 passed. A separate, clean-process
regression check confirmed every existing model/controller/route
(DOC-60/61/64/67/68/69/70/72/73/74) plus every new DOC-75 file load
together in one shared Node process with no circular dependency and no
`OverwriteModelError`.

## DOC-76 - User Help & Quick Guides

**Frontend-only. No backend, no database, no Render involvement at all**
(task spec sections 2/31/32 - "Do NOT require a database unless the audit
shows a real need... Default: no backend changes"). The read-only audit
found no existing PDF files, no existing help/guide infrastructure, and no
security or scale reason to justify a backend for 2-5 short, non-sensitive
product-usage guides - so this feature is a plain static JS metadata
module plus two new React pages, nothing in `backend/` was touched, and
this backend's own server has zero role in serving Help content: guides
are Vite build-time static assets, served the same way `favicon.ico`
already is.

**Architecture.** `frontend/src/data/helpGuides.js` exports one
centralized `HELP_GUIDES` array - the single source of truth, imported by
both `pages/Help.jsx` (list) and its own guide-detail sub-view (no
duplicated guide configuration anywhere else, task spec section 19). Each
entry is `{ id, title, description, allowedRoles, type, steps }` (for
`type: 'quickGuide'`) or `{ id, title, description, allowedRoles, type,
file }` (for a future `type: 'pdf'`, once a real file exists under
`frontend/public/guides/`).

**Two guide types, never confused (task spec section 27).** `'quickGuide'`
renders real, numbered step content in-app as ordinary React text (never
`dangerouslySetInnerHTML`) with a blue "Quick Guide" badge.  `'pdf'` would
open a real static file in a new browser tab (`target="_blank"
rel="noopener noreferrer"`) with a red "PDF Guide" badge - visually and
textually distinct so a Quick Guide is never presented as if it were a
PDF.

**Why both required guides ship as Quick Guides, not PDFs (task spec
section 26 - CRITICAL).** The audit confirmed there are zero `.pdf` files
anywhere in this repository. Per the ticket's own explicit instruction,
no binary PDF was fabricated. Instead, the two required guides (Employee
"How to Create a Request", Operator "How to Handle a Request") are
implemented as honestly-labeled `type: 'quickGuide'` entries with real
step content, grounded in a dedicated audit pass over the actual UI
(`pages/Dashboard.jsx`, `components/RequestRow.jsx`,
`components/ManagerRequestRow.jsx`, `components/RequestRatingSection.jsx`)
rather than invented button names - every quoted UI label in the guide
text ("Open New Request", "Service Category", "Priority", "Before
Images", "Start Work", "Mark Resolved", "Resume Work", "Confirm
Resolved", "Problem Still Exists", "Comments") is copied verbatim from
that real UI. One important correction the audit surfaced: "Close
Request" (resolved -> closed) is a **Manager-only** action
(`ManagerRequestRow.jsx`'s own `canClose`/`onManagerClose`), never an
Employee action - the Employee's own path to closing a resolved request
is "Confirm Resolved" - so the Employee guide never mentions "Close
Request" at all (verified by the test harness below).

**PDF assets still need to be supplied.** No PDF files exist for
Manager/System Admin guides (or as a replacement for the two Quick
Guides above) as of this ticket. `helpGuides.js`'s own bottom comment
documents the exact shape a future PDF-type entry would take once a real
file is placed at `frontend/public/guides/<file-name>.pdf` (lowercase,
hyphenated, no spaces, e.g. `manager-manage-users.pdf`) - adding one
requires zero code redesign, just one more object in `HELP_GUIDES` (or
changing an existing `quickGuide` entry to `pdf` once its real file
exists). No phantom Manager/System Admin entries were added to the array
itself (task spec section 20 - "do not register nonexistent guides");
that extension path is documented in code comments only.

**Role-based filtering happens in the frontend, not the backend - a
deliberate, ticket-scoped exception.** Every other feature in this
project (Chat, Messages, Policies, Knowledge Board) treats the backend as
the sole authority on visibility. Help has no backend at all to defer to,
and task spec section 7 explicitly requires "Filter at application logic
level (`allowedRoles.includes(role)`), never CSS only" - `getGuidesForRole()`
in `helpGuides.js` does exactly that, and `Help.jsx`'s own guide-detail
view re-checks role membership again (not just trusting a URL parameter)
so a role-inaccessible `:guideId` typed directly into the address bar
still renders a "Guide not found" state, never the content.

**Security honesty note (task spec section 35 - stated explicitly, not
glossed over).** If a future guide ever ships as a real PDF under
`frontend/public/guides/`, that file is a static asset in the production
build output - it is directly reachable by anyone who knows or guesses
its URL, regardless of the requesting user's role or authentication
state. Frontend role filtering controls what the **Help Center UI shows
and links to**; it does **not** provide true file-level access control.
This is an acceptable tradeoff **only** because Help guides are ordinary,
non-sensitive product documentation with no privacy requirement - if a
future guide ever needed genuine role-level file secrecy, it would
require an authenticated backend download endpoint (the same pattern
this project already uses for chat/DM attachments and profile images),
not public static hosting.

**Netlify static-file-priority-over-redirect behavior.** `frontend/public/
_redirects` contains only the existing SPA catch-all (`/* /index.html
200`), unchanged by this ticket. Netlify's documented, standard behavior
serves an actually-existing file in the publish directory directly,
falling through to `_redirects` rules only when no matching file exists -
so `/guides/<file>.pdf` would be served as the real file once one is
added, never swallowed by the SPA catch-all, while `/help` (which has no
matching static file) still correctly falls through to `index.html` and
loads the React app. This is standard Netlify behavior, documented here
for honesty rather than verified against an actual live Netlify
deployment from this sandboxed environment.

**Navigation.** A compact, circular, icon-only "Help Center" control was
added to `Navbar.jsx` (visually modeled on `NotificationBell.jsx`'s own
`.notification-bell-button` shape) rather than a 10th full-width text
link on an already link-heavy Navbar (task spec: "discoverable but not
dominant"). Visible to **every** authenticated role, including System
Admin (unlike Chat/Messages/Policies/Knowledge, which exclude System
Admin) - task spec never excludes System Admin from opening the Help
Center itself, only from seeing guide content meant for other roles,
which `getGuidesForRole()` already handles by returning an empty,
safely-rendered list. Hidden only during the forced-password-change
state, the same universal gate "Change Password"'s neighboring links
already use. Has an `aria-label`, is a real focusable `<a>` (via
`NavLink`), and has a visible `:focus-visible` keyboard-focus ring
(reusing the same `--shadow-glow` token every `.btn` in the app already
uses).

**Routes.** `/help` (guide list) and `/help/:guideId` (guide detail),
both wrapped in `ProtectedRoute` with **no** `roles` restriction - any
authenticated role may open the Help Center itself; content is filtered
inside the page, not the route. An unauthenticated visitor is redirected
to `/login` by the existing `ProtectedRoute` behavior, unchanged.

**Mobile/responsive.** `.help-card-list` uses the same `auto-fill`
CSS-grid shape `.knowledge-card-list` (DOC-75) already established, with
an identical `@media (max-width: 720px)` rule collapsing it to a single
column - no separate mobile-only component was built. The existing
`.navbar-links { flex-wrap: wrap; }` rule (unchanged) already reflows the
Navbar at narrow widths; adding one more compact icon button did not
require any Navbar CSS restructuring.

**Test coverage.** Since there is no backend controller for this
frontend-only ticket, the usual require.cache-injection mocked-model
harness (DOC-68 through DOC-75) does not apply. Instead, a 33-assertion
harness combined (A) FUNCTIONAL checks - importing the real,
unmodified `helpGuides.js` module and calling its real
`getGuidesForRole`/`getGuideById` exports with every role including
`undefined` and unknown ids, verifying the two required guides exist
with real step content, verifying no phantom Manager/System Admin
entries exist, verifying no sensitive terms (JWT/userId/organizationId/
sessionId/email/password/AWS-secret patterns) appear anywhere in guide
metadata, and verifying the Employee guide's own "Close Request" audit
correction - with (B) STATIC SOURCE-CONTRACT checks over the real
`Help.jsx`/`App.jsx`/`Navbar.jsx`/`index.css` source: no
`dangerouslySetInnerHTML`, role-array-free route protection on `/help`,
a mustChangePassword-only (not role-restricted) Navbar gate, an
accessible label and visible focus state on the Help control, a
mobile single-column card rule, visually distinct Quick-Guide/PDF-Guide
badge classes, zero `.pdf` files anywhere under `frontend/public`, an
unchanged `_redirects` SPA catch-all, and zero new backend files matching
"help" anywhere under `backend/src`. All 33 passed on the first run. A
full `npm run build` (92 modules, up from 90 pre-DOC-76) completed
cleanly both before and after the test pass, and `git status` confirmed
no DOC-76 work touched anything under `backend/`.

## DOC-77 - Theme Switcher / Appearance Customization

**Frontend-only, no backend/database changes** (task spec section 43 -
"Theme is client-side appearance preference"). Theme choice never
travels to this backend, is never stored on the `User` document, and no
endpoint reads or writes it - it is pure client-side CSS-variable
switching plus one `localStorage` key.

**Architecture discovered during audit.** `frontend/src/index.css`
already had a solid `:root` CSS-variable system (`--bg-primary`,
`--bg-card`, `--color-primary`, `--text-primary`, `--border-color`,
`--shadow-*`, etc.) - most of the stylesheet already referenced these
rather than literal colors, which made this a variable-remapping ticket
rather than a full rewrite. The audit also found a small but important
class of pre-existing bugs that this ticket fixed as a side effect:
several rules referenced custom properties that were **never actually
defined anywhere** (`--color-surface`, `--color-surface-alt`,
`--color-border`, `--color-text-secondary`, `--color-success`,
`--color-success-bg`, `--accent-color`, `--surface-muted`), each written
as `var(--name, <fallback>)` - because the variable never existed, every
one of those rules silently used its light-colored fallback regardless of
theme, which is why `.knowledge-card`, `.policy-list-item`, and
`.knowledge-answer-accepted` already rendered as stray white/pale-green
cards inside the otherwise all-dark UI even before this ticket existed.
Defining those variables for real (dark-appropriate in `:root`, the
existing light-colored fallback preserved as the literal light-theme
value) fixed that pre-existing bug and made those same rules correctly
theme-aware, with zero changes needed to the rules themselves.

**Hardcoded-color audit result.** Beyond the phantom-variable bugs above,
roughly 60 individual property values across `index.css` were literal
hex/`rgba(...)` colors rather than variables - the large majority were
`rgba(225, 29, 72, <alpha>)`, the brand red baked directly into hover
tints, glows, badge backgrounds, and gradients throughout Navbar,
dashboards, chat, DMs, and forms. Each was classified into one of two
groups before being touched: **accent-following** values (decorative
brand touches - hero glow, button gradients, avatar-initials tint, chat
"own message" bubble, mention highlight, header gradients) were rewritten
to `rgba(var(--color-primary-rgb), <alpha>)`, so they automatically
become blue in the light theme; **semantically-red** values (`.btn-danger`,
`.form-error-server`, `.cancel-confirm-panel`, `.chat-attachment-failed`,
status-inactive/reopened/overdue badges) were rewritten onto an
independent `--danger`/`--status-red-*` family that stays red in **both**
themes (task spec section 15 - critical: destructive/error meaning must
never silently become "blue" just because blue is now the brand accent).
A handful of genuinely broken spots were also found and fixed along the
way: the Notification dropdown panel had a literal near-black background
(`rgba(24, 24, 27, 0.98)`) that would have been unreadable-on-white in
light mode; a focused form input's background was hardcoded to `#18181b`
for the same reason; and the Help Center's own "Quick Guide" badge
(DOC-76) had a latent bug where its text color read `var(--color-primary,
#2f6feb)` - since `--color-primary` was always defined (red), that text
was always red sitting on a blue-tinted background, regardless of theme;
it now uses a fixed, accent-independent `--status-info-*` pair. A final
sweep confirmed zero live (non-fallback, non-variable-definition) literal
colors remain anywhere in the stylesheet. Intentionally-unchanged
literals: `.modal-overlay`'s black backdrop and two dropdown
`box-shadow`s (both universal, theme-independent UI conventions, not
theme bugs), and native `<select>` chrome (a handful of `<select>`
elements render with default OS styling in both themes - a pre-existing,
out-of-scope cosmetic limitation, not something this ticket introduced
or was asked to redesign).

**Theme architecture selected.** `document.documentElement` gets
`data-theme="dark"` or `data-theme="light"`; `index.css` defines the
existing dark palette unchanged in `:root` and a full white/blue override
in a single `[data-theme='light']` block - no duplicated CSS files, no
per-component theme variants anywhere.

**Files created:** `frontend/src/context/ThemeContext.jsx` (the
`ThemeProvider`/`useTheme` hook - `theme`/`setTheme`/`toggleTheme`,
completely independent of `AuthContext.jsx` per task spec section 6).

**Files modified:** `frontend/src/index.css` (the variable/light-theme
work described above), `frontend/index.html` (a tiny synchronous inline
flash-prevention script), `frontend/src/App.jsx` (`ThemeProvider` wraps
`AuthProvider`, not the reverse), `frontend/src/components/Navbar.jsx`
(Sun/Moon toggle button, rendered in both the authenticated and
logged-out Navbar states).

**Theme state/context design.** `ThemeContext` owns exactly one piece of
state and has zero knowledge of `token`/`user`/login/logout - it behaves
identically whether or not anyone is signed in. `setTheme`/`toggleTheme`
update React state, persist to `localStorage`, and apply
`data-theme` to `document.documentElement` in one synchronous effect - no
page reload is ever required.

**localStorage implementation.** One centralized key, `doc_theme`
(`ThemeContext.THEME_STORAGE_KEY`), whose only legal values are the
literal strings `'dark'`/`'light'`. Any other stored value (missing key,
corrupted value, a value from some future version of this app) safely
falls back to `'dark'` - existing users are never unexpectedly switched
to light. Reading and writing are both wrapped in `try/catch` so a
browser with `localStorage` disabled (private-browsing edge cases)
degrades to an in-memory-only theme for that session rather than
crashing. Never stores `userId`/`organizationId`/`role`/a JWT/anything
else - just the theme name (task spec section 42).

**Initial-load/flash behavior.** `frontend/index.html` has a tiny,
synchronous, inline `<script>` in `<head>`, before the deferred
`main.jsx` module script - the only code that runs before first paint.
It reads `doc_theme` from `localStorage`, applies the exact same
`'light'`-or-fallback-`'dark'` validation `ThemeContext.jsx` uses, and
sets `data-theme` immediately - by the time React mounts and
`ThemeProvider`'s own effect runs, the attribute is already correct, so
there is no visible flash of the wrong theme. Wrapped in `try/catch` so a
`localStorage`-disabled browser still renders (falling back to dark)
instead of breaking startup.

**Navbar toggle implementation.** A single compact icon button (reusing
the existing `.help-icon-button` circular treatment from DOC-76 - same
visual language, not a new one) showing a Sun icon while dark is active
and a Moon icon while light is active, rendered in **both** the
authenticated and logged-out Navbar branches (task spec section 28 -
appearance is a device preference, available before login too, unlike
Help/Notifications which only make sense once authenticated).

**Accessibility behavior.** Real `<button type="button">` (not a
div/span), keyboard-focusable and clickable with Enter/Space via native
button semantics, `aria-label` that always describes the action ("Switch
to light mode" / "Switch to dark mode" - the inverse of the icon shown,
exactly like a mute button), `aria-pressed` reflecting whether light mode
is currently active, a `title` tooltip mirroring the same text, and the
same `:focus-visible` box-shadow ring every other button/icon control in
this app already uses (`.help-icon-button:focus-visible`) - no new focus
treatment was invented.

**Dark Theme mapping.** Unchanged from before this ticket - every value
in `:root` is copied byte-for-byte from the stylesheet's own pre-existing
dark identity (black/near-black backgrounds, red `#e11d48` accent, white
text).

**Light Theme mapping.** `--bg-primary: #f4f6fb` (very light gray, not
pure white, to preserve visual hierarchy per task spec section 12),
`--bg-card: #ffffff`, `--color-primary: #2563eb` (blue), `--text-primary:
#0f172a` (dark navy/charcoal), `--border-color: #dde3ec`, softer
navy-tinted `--shadow-sm`/`--shadow-md` (a heavy black shadow at the
dark theme's own alpha would look muddy on white).

**Status/destructive color handling.** Five reusable hue families
(`--status-green-*`/`--status-yellow-*`/`--status-blue-*`/
`--status-red-*`/`--status-gray-*`, each a bg/border/text triplet) back
every status/role badge in the app; only the *text* shade changes
per theme (darker/more saturated in light mode, for contrast against a
near-white tinted background) - the same status keeps the same hue and
the same meaning in both themes. `--danger`/`--danger-hover`/
`--danger-light`/`--danger-rgb` are a fully independent family from
`--color-primary` - `.btn-danger`, `.cancel-confirm-panel`, and
`.chat-attachment-failed`'s error state stay red in the light theme even
though the brand accent there is blue.

**Form/button migration.** `.btn-primary`/`.btn-outline`/`.btn-danger`
all audited; the one genuine bug found (`.btn-danger` reading the
accent color instead of an independent danger color) is described above.
Text inputs/textareas already used `var(--bg-input)`/`var(--border-color)`
- the only fix needed was the hardcoded `#18181b` focus-state background
described above. No dedicated `<select>` styling exists for a couple of
Category/Priority dropdowns elsewhere in the app (pre-existing, renders
with native OS chrome in both themes - not part of this ticket's scope).

**Navbar migration.** `.navbar`'s own translucent surface
(`rgba(17, 17, 19, 0.9)`) and every icon-hover "lighten" tint
(`rgba(255, 255, 255, <alpha>)`) were rewritten onto `--navbar-bg-rgb`/
`--surface-tint-rgb` bare-RGB-triplet variables, so the light theme gets
a light, bordered surface and hover tints that darken instead of
lighten, instead of literally staying black. Active-link underlines and
focus rings already followed `--color-primary`, so they correctly become
blue automatically.

**Dashboard coverage.** All four dashboards (Employee/Operator/Manager/
System Admin) share the same `.card`/`.stat-card`/`.admin-panel`/
`.status-badge`/`.user-table` building blocks - none of them has its own
hardcoded color, so fixing those shared classes once covers all four
simultaneously; no dashboard needed an individual theme pass.

**Request UI coverage.** `RequestRow`/`ManagerRequestRow`/rating
section/comments/attachments all render through the shared status-badge
and card/button classes above; `RequestSlaBadge` and the satisfaction
star rating (`--rating-star-filled`, darkened for contrast in light
mode) were the two request-specific pieces requiring a change.

**Chat/DM coverage.** Organization Chat's message bubbles (including the
accent-tinted "own message" bubble), mention highlighting/dropdown,
attachment cards/thumbnails, and Direct Messages' conversation list/
active-conversation highlight/unread badge were all audited; the
Notification-dropdown-style hardcoded-dark-background bug (task spec
section 37's specific warning) was found and fixed in `.notification-panel`
- the mention dropdown itself was already fully variable-driven and
needed no fix.

**Policy/Knowledge coverage.** Both boards reuse the shared
`.status-badge` family for their own status labels; `.policy-category-badge`/
`.knowledge-category-badge` and `.knowledge-answer-accepted` were the
three rules hit by the phantom-variable bug described above, now fixed.

**Profile/Help coverage.** Avatar, bio, Active Sessions/session-history
rows, and security buttons all already used the shared surface/text
variables (or the now-newly-defined `--surface-muted`) and needed no
per-rule changes. Help Center's guide cards/detail view/role labels/
Quick-Guide badge were audited; the Quick-Guide badge color bug described
above was the one fix needed there.

**Auth-page coverage.** Login/Register/Forgot Password/Change Password
all render through the same shared `.card`/`.form-group`/`.btn-*`
classes as every other page - since `ThemeProvider` wraps the whole app
above `AuthProvider` (task spec sections 27/28), the saved theme applies
to these pages identically whether or not the Navbar's own toggle button
is visible there.

**Hardcoded colors intentionally remaining.** `.modal-overlay`'s
`rgba(0, 0, 0, 0.65)` backdrop and two dropdown `box-shadow`s using plain
black - both are universal, theme-independent UI conventions (a dimmed
backdrop and a drop shadow read as "black-ish" in virtually every
application regardless of light/dark theme), not theme bugs.

**Responsive behavior.** No changes needed - `.navbar-links { display:
flex; flex-wrap: wrap; }` (pre-existing) already reflows the Navbar
(including the two new icon buttons) at narrow widths, confirmed by the
same `@media (max-width: 640px)` rule every previous ticket's Navbar
addition already relied on.

**Test count and results.** A 35-assertion harness combining (A)
FUNCTIONAL checks - `ThemeContext.jsx` transformed from JSX to plain JS
via `esbuild` (already a Vite devDependency, so no new test framework was
installed) and its real, unmodified `readStoredTheme`/`isValidTheme`/
`applyThemeToDocument` exports exercised directly against a faked
`window.localStorage`/`document`, covering initial-load section 46's
five cases (no stored value, stored dark, stored light, invalid stored
value, and a `localStorage`-throwing edge case) plus persistence-shape
checks - with (B) STATIC SOURCE-CONTRACT checks over `index.html`/
`App.jsx`/`Navbar.jsx`/`AuthContext.jsx`/`index.css`: flash-prevention
script ordering and validation-parity with `ThemeContext.jsx`,
`ThemeProvider` wrapping order, confirmation that `AuthContext.jsx` never
references theme at all and that `logout()` never calls
`localStorage.clear()` (task spec section 29), confirmation that
`localStorage.setItem` calls in `ThemeContext.jsx` only ever write the
centralized key with no other identifiers, Navbar accessibility/icon-
communication checks, a CSS variable-parity check (every dark-theme
variable has either a light-theme override or is on an explicit allowed-
constant list), and regression guards for every specific bug fixed above
(`.btn-danger`, `.notification-panel`, `.help-badge-quick-guide`, the
`#18181b` focus background, the phantom `--color-surface-alt` variable).
All 35 passed on the first run.

**Functional regression results.** No application behavior changed -
`ThemeContext` never touches auth, requests, chat, notifications, or any
other feature's logic; it only ever reads/writes its own `localStorage`
key and sets one DOM attribute. Confirmed via the static checks above
(AuthContext untouched, no new backend files, no inline JS logic moved
into components) rather than re-running every other ticket's own test
harness, since no file any of them depend on was modified.

**Frontend build result.** `npm run build` - 93 modules (up from 92
pre-DOC-77), clean, no warnings or errors, both before and after the test
pass.

**Production/Netlify compatibility.** No environment variables needed, no
backend changes, no API request is ever made for theme - it is 100%
client-side `localStorage` + CSS. Works identically after a hard refresh
(the inline `<head>` script re-reads `localStorage` on every page load,
independent of any client-side router state) and requires no changes to
the existing Netlify `_redirects` SPA catch-all.

**Remaining limitations (documented honestly, not silently accepted):**
a handful of native `<select>` elements (Category/Priority pickers, a
couple of filter dropdowns) render with default OS chrome rather than
custom-themed styling in both themes - pre-existing, out of this
ticket's scope, and not a regression. `.modal-overlay`'s backdrop and two
dropdown shadows stay black-based in both themes by design (see above).
Cross-tab sync (task spec section 31, "optional, low-cost") IS
implemented via a `storage` event listener - changing the theme in one
tab updates any other open tab immediately.

**Git status summary.** Frontend-only diff: `index.css`, `index.html`,
`App.jsx`, `Navbar.jsx` modified; `context/ThemeContext.jsx` newly
created. No file under `backend/` was touched - confirmed by both the
test harness's own backend-directory scan and a manual `git status`
check.

**Confirmations:** no backend/database changes of any kind; no
password/secret/credential was read, written, or changed anywhere in
this ticket; nothing was committed; nothing was pushed.
