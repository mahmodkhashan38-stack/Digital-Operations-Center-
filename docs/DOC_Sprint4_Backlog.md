# Digital Operations Center — Sprint 4 Gap Analysis & Backlog

**Prepared by:** Senior Software Architect / Product Owner (system audit)
**Scope:** Business-functionality gap analysis only. Bugs, code quality, and refactoring are explicitly out of scope.
**Baseline audited:** Sprint 1–2 (Auth, Organizations, multi-tenant isolation, four roles, dashboards, Company Code, JWT, MongoDB) and Sprint 3 (DOC-10, 11, 12, 13, 43, 44, 45, 46, 48, 52), verified directly against the current codebase (models, controllers, routes, and frontend pages) rather than assumed from ticket titles alone.

---

## 1. Method

Each gap below was checked against the actual implementation before being listed — not against the "special attention" topic list blindly. For example: Priority already exists on the Request model (`low`/`medium`/`high`, DOC-10/46), so it is **not** listed as a gap. Where a topic from the brief has no concrete, justified hook into the current system (e.g. a generic "System Settings" page with no defined setting to configure yet), it is called out in Section 4 as intentionally excluded rather than invented.

---

## 2. Gap Analysis

### DOC-53 — Reassign an Already-Assigned Operator

**Title:** Manager can reassign a Request to a different Operator
**Why needed:** `PATCH /api/requests/:id/assign` (DOC-52) only accepts a Request whose `status === 'open'`. Once a Request is assigned, there is no way to change the Operator — not even a Manager can move it. An Operator going on leave, being deactivated (DOC-48), or simply being the wrong specialty match leaves the Request stuck with them indefinitely.
**Depends on / extends:** DOC-52 (Operator Request Workflow), DOC-48 (Deactivate Employee — a deactivated Operator can currently still be left holding assigned Requests with no reassignment path).
**User problem solved:** Managers currently have no recovery path for a bad or now-invalid assignment.
**Complexity:** Small
**Sprint priority:** Must finish Sprint 4

---

### DOC-54 — Manager Override: Force-Resolve / Force-Close a Stuck Request

**Title:** Manager can close a Request on behalf of an unresponsive or deactivated Employee
**Why needed:** Per DOC-12/46, only the Employee who created a Request can transition it `resolved -> closed` or `resolved -> reopened`. If that Employee is deactivated (DOC-48) or simply never confirms, the Request is permanently stuck in `resolved` with no legal next transition for anyone.
**Depends on / extends:** DOC-12 (Status Workflow), DOC-48 (Deactivate Employee — this is the direct trigger scenario).
**User problem solved:** Prevents a Request from becoming an orphaned, un-closeable record the moment its creator is deactivated or unreachable.
**Complexity:** Small–Medium
**Sprint priority:** Must finish Sprint 4

---

### DOC-55 — Password Reset (Forgot Password)

**Title:** Self-service password reset for all roles
**Why needed:** There is currently no way for a user who forgets their password to regain access — no reset-token flow exists anywhere in `auth.controller.js`. A Manager or System Admin currently has no tool to fix this for a user either.
**Depends on / extends:** DOC-7/8 (Authentication).
**User problem solved:** A locked-out user currently has no recovery path except asking someone to manually create a new account.
**Complexity:** Medium
**Sprint priority:** Must finish Sprint 4

---

### DOC-56 — Request List Filtering & Sorting

**Title:** Filter and sort Request lists by status, priority, category, and Operator
**Why needed:** The Employee "My Requests," Manager "Organization Requests," and Operator "Assigned Requests" lists (DOC-11/52) return every matching Request with no way to narrow by status, priority, category, or assignee. As an organization accumulates Requests, these lists become unusable walls of rows.
**Depends on / extends:** DOC-11 (View Requests), DOC-52 (Manager/Operator Request lists).
**User problem solved:** Lets a Manager or Operator find the handful of Requests they actually need to act on, instead of scanning everything.
**Complexity:** Small–Medium
**Sprint priority:** Must finish Sprint 4

---

### DOC-57 — Pagination for List Endpoints

**Title:** Paginate Requests, Users, and Organizations list endpoints
**Why needed:** `GET /api/requests*`, `GET /api/users`, and `GET /api/organizations` all return their full result set in one response with no `page`/`limit` support. This does not scale past a small amount of test data.
**Depends on / extends:** DOC-11, DOC-35 (User list), DOC-32 (Organization list) — every existing list endpoint.
**User problem solved:** Keeps list pages fast and the UI usable as real data volume grows; a direct prerequisite for DOC-56's filtering to stay performant.
**Complexity:** Small–Medium
**Sprint priority:** Must finish Sprint 4

---

### DOC-58 — In-App Notifications

**Title:** In-app notification center for assignment, status changes, and new comments
**Why needed:** Notifications were explicitly deferred in every Sprint 3 ticket (DOC-45/46/48/52) to keep each one scoped. As a result, an Employee has no signal their Request was assigned or resolved, and an Operator has no signal they were just assigned a new Request, short of manually refreshing their dashboard.
**Depends on / extends:** DOC-12 (Status Workflow), DOC-13 (Comments), DOC-52 (Assignment) — the three events worth notifying on already exist; only the notification layer is missing.
**User problem solved:** Closes the feedback loop on every core workflow action — right now nothing tells a user something happened to their Request.
**Complexity:** Large
**Sprint priority:** Must finish Sprint 4

---

### DOC-59 — Request Activity Timeline / History

**Title:** Per-Request activity timeline (status changes, assignment changes, edits)
**Why needed:** A Request only stores its *current* `status`/`assignedOperatorId`/`updatedAt` — there is no record of what changed, when, or by whom. Comments (DOC-13) capture conversation but not system events like "Manager assigned Operator X" or "Status changed open → in_progress."
**Depends on / extends:** DOC-12, DOC-46, DOC-52 — every mutation this ticket would need to log already exists.
**User problem solved:** Gives Employees, Operators, and Managers a trustworthy record of exactly what happened to a Request and when, useful for accountability and dispute resolution.
**Complexity:** Medium
**Sprint priority:** Nice to have

---

### DOC-60 — Self-Service Profile Editing

**Title:** Logged-in user can edit their own name/contact info
**Why needed:** `PATCH /api/users/:id` (DOC-50) only lets a Manager edit an Employee's or Operator's profile — a logged-in user has no "My Profile" page to edit their own basic details or change their own password.
**Depends on / extends:** DOC-50 (Manager edits user profile).
**User problem solved:** Removes the need to ask a Manager for something as basic as a name correction.
**Complexity:** Small
**Sprint priority:** Nice to have

---

### DOC-61 — Operator Can Add Attachments to Assigned Requests

**Title:** Operator can upload attachments (e.g. proof of work) to a Request they're assigned to
**Why needed:** DOC-45 gives the Employee full attachment add/remove rights and gives the Operator view-only access. An Operator resolving a Request has no way to attach evidence of the fix (a photo, a screenshot) for the Employee or Manager to see.
**Depends on / extends:** DOC-45 (Image Attachments), DOC-52 (Operator Workflow).
**User problem solved:** Lets an Operator document their resolution, not just describe it in a comment.
**Complexity:** Small
**Sprint priority:** Nice to have

---

### DOC-62 — Request Keyword Search

**Title:** Search Requests by title/description text
**Why needed:** There is no text search anywhere in the Request endpoints — only exact-match/scoped listing exists.
**Depends on / extends:** DOC-11, DOC-56 (natural pairing with filtering).
**User problem solved:** Lets a user find a specific Request without scrolling through a filtered list.
**Complexity:** Small–Medium
**Sprint priority:** Nice to have

---

### DOC-63 — Manager Analytics Dashboard

**Title:** Manager-facing analytics (avg. resolution time, Requests per category, per-Operator load)
**Why needed:** The Manager Dashboard (DOC-42/52) currently shows only live counts (open/assigned/etc.), not trends. A Manager has no way to see which categories generate the most Requests or how long resolution typically takes.
**Depends on / extends:** DOC-42 (Manager Dashboard), DOC-59 (Activity Timeline — resolution-time metrics need timestamped status history to be accurate).
**User problem solved:** Gives a Manager the operational visibility needed to staff and plan, not just react ticket-by-ticket.
**Complexity:** Medium–Large
**Sprint priority:** Nice to have

---

### DOC-64 — Export Requests to CSV/Excel

**Title:** Export the Organization Request list to CSV/Excel
**Why needed:** A Manager currently cannot get Request data out of the app for offline reporting or sharing with leadership.
**Depends on / extends:** DOC-52 (Organization Request list), DOC-56 (filtering — export should respect the current filter).
**User problem solved:** Lets a Manager produce a report without manual copy-paste.
**Complexity:** Medium
**Sprint priority:** Nice to have

---

### DOC-65 — Email Notifications

**Title:** Email delivery for the same events covered by DOC-58
**Why needed:** In-app notifications (DOC-58) only reach a user while they're logged in. Email extends that reach to when they're not.
**Depends on / extends:** DOC-58 (In-App Notifications) — should not be built before DOC-58 defines the event set.
**User problem solved:** Reaches users who don't have the app open, e.g. an Operator who should know immediately when something urgent is assigned.
**Complexity:** Medium–Large
**Sprint priority:** Nice to have

---

### DOC-66 — Automatic Operator Assignment

**Title:** Auto-assign a new Request to a suitable Operator instead of requiring a manual Manager action
**Why needed:** DOC-52 requires a Manager to manually pick an Operator for every single open Request. At any real volume, this becomes a bottleneck.
**Depends on / extends:** DOC-52 (Manual Assignment) — the eligibility rule (same org, active, matching specialty) already exists and would be reused, not reinvented.
**User problem solved:** Removes the Manager as a manual routing step for the common case, speeding up response time.
**Complexity:** Large
**Sprint priority:** Future release

---

### DOC-67 — Operator Workload Visibility

**Title:** Show each Operator's current open/assigned Request count on the Manager Dashboard
**Why needed:** When assigning a Request (DOC-52), a Manager currently has no visibility into how many active Requests each candidate Operator already has — they could easily overload one Operator while another sits idle.
**Depends on / extends:** DOC-52 (Assignment UI).
**User problem solved:** Lets a Manager make an informed, balanced assignment decision at a glance.
**Complexity:** Small
**Sprint priority:** Nice to have

---

### DOC-68 — Duplicate Request Detection

**Title:** Warn an Employee when they're about to submit a Request very similar to one they already have open
**Why needed:** Nothing currently stops an Employee from submitting the same issue twice, creating duplicate work for Operators.
**Depends on / extends:** DOC-10 (Create Request), DOC-62 (Search — duplicate detection is a targeted use of the same text-matching capability).
**User problem solved:** Reduces duplicate Operator effort and duplicate-Request clutter.
**Complexity:** Medium
**Sprint priority:** Nice to have

---

### DOC-69 — Request SLA & Due Dates

**Title:** Optional due date / response-time target per Request
**Why needed:** No Request currently carries any time expectation — every Request is equally "whenever," which doesn't reflect real operational priority even though `priority` (low/medium/high) already exists as a hint.
**Depends on / extends:** DOC-10 (Request model), DOC-59 (Activity Timeline — needed to measure SLA compliance against real event timestamps).
**User problem solved:** Lets an organization hold itself to a response-time standard instead of relying purely on priority labeling.
**Complexity:** Large
**Sprint priority:** Future release

---

### DOC-70 — SLA Escalation

**Title:** Automatically flag or escalate a Request that has breached its SLA
**Why needed:** An SLA (DOC-69) is only useful if a breach actually surfaces to someone.
**Depends on / extends:** DOC-69 (SLA — this ticket has no meaning without it), DOC-58 (Notifications — the escalation needs a delivery channel).
**User problem solved:** Ensures a missed deadline gets noticed instead of silently expiring.
**Complexity:** Medium
**Sprint priority:** Future release

---

### DOC-71 — Email Verification on Registration

**Title:** Verify a new user's email address at registration
**Why needed:** `register` (DOC-33) creates an active account immediately off of Company Code + email + password, with no confirmation that the email address is real or belongs to the registrant.
**Depends on / extends:** DOC-33 (Employee Registration with Company Code).
**User problem solved:** Reduces typo/fake-email accounts and gives the org more confidence in the employee directory.
**Complexity:** Small–Medium
**Sprint priority:** Future release

---

### DOC-72 — Request Templates

**Title:** Predefined Request templates per Service Category
**Why needed:** Every Request is currently created from a blank title/description. Common, recurring request types (e.g. "New Laptop Request" under an IT category) could be pre-filled.
**Depends on / extends:** DOC-43 (Service Categories), DOC-10 (Create Request).
**User problem solved:** Speeds up submission and improves description consistency for common, repeated request types.
**Complexity:** Medium
**Sprint priority:** Future release

---

### DOC-73 — Organization Settings Page

**Title:** A dedicated settings area for Manager-configurable Organization preferences
**Why needed:** Beyond name and Company Code (DOC-32/41), an Organization has no configurable preferences today. This ticket is a placeholder home for future org-level toggles (e.g. default notification preferences from DOC-65, default SLA from DOC-69) rather than a concrete feature on its own.
**Depends on / extends:** DOC-32 (Organization Management).
**User problem solved:** Gives future org-level preferences one obvious place to live instead of being bolted onto unrelated screens.
**Complexity:** Small–Medium
**Sprint priority:** Future release

---

### DOC-74 — Request Archive / Retention View

**Title:** A dedicated archive view for old closed/cancelled Requests
**Why needed:** Closed and cancelled Requests stay mixed into the same lists forever with no way to set them aside. Once DOC-56 (filtering) and DOC-57 (pagination) exist, very old closed Requests still visually clutter the default view.
**Depends on / extends:** DOC-56 (Filtering), DOC-57 (Pagination) — this ticket only makes sense once both exist.
**User problem solved:** Keeps the default Request views focused on active work while preserving full history elsewhere.
**Complexity:** Small
**Sprint priority:** Future release

---

### DOC-75 — System-Wide Audit Log

**Title:** System Admin-facing audit log across Organizations, Users, and role changes
**Why needed:** DOC-59 covers a single Request's history; there is no cross-cutting log of administrative actions (Organization created/deleted, Manager replaced, role changed) for the System Admin to review.
**Depends on / extends:** DOC-31 (System Admin), DOC-32/47 (Organization CRUD), DOC-35 (Role changes), DOC-49 (Manager replacement) — all of the events this would log already exist as actions.
**User problem solved:** Gives the System Admin accountability and traceability over administrative changes across the whole platform.
**Complexity:** Large
**Sprint priority:** Future release

---

### DOC-76 — Global Search (Within Role Scope)

**Title:** A single search box covering Requests and Users within what the current user can already see
**Why needed:** DOC-62 covers Request text search specifically; a Manager may also want to jump straight to a User by name/email without leaving the search bar. Must respect existing tenant isolation (DOC-38) — never a literal cross-organization search.
**Depends on / extends:** DOC-62 (Request Search), DOC-38 (Tenant Isolation — this ticket must not weaken it).
**User problem solved:** One search entry point instead of separately searching Requests and Users.
**Complexity:** Medium
**Sprint priority:** Future release

---

## 3. Already Implemented — Not Gaps

To avoid inflating the backlog with things that already exist:

- **Priority** (`low`/`medium`/`high`) — already on the Request model since DOC-10/46.
- **Manual Operator assignment** — already implemented (DOC-52); DOC-53/66 above are genuine *extensions* of it, not re-implementations.
- **Role-scoped dashboards with live counts** — already implemented (DOC-42/52) for all four roles; DOC-63 above extends this into trend analytics, it does not recreate it.

## 4. Intentionally Not Turned Into Tickets

- **"System Settings"** (platform-wide, non-Organization-scoped configuration) — no concrete System-Admin-level setting exists in the current system that would need one. Listing this as a standalone ticket today would be inventing scope with nothing to configure. If a real need emerges (e.g. global rate limits, platform branding), it belongs in a future audit once that need is concrete.
- **"Tags"** as a feature independent of Service Categories — categories (DOC-43) already provide the primary classification axis Requests are organized by. A second, parallel free-form tagging system was judged to duplicate that role rather than extend it, so it was left out rather than manufactured.

---

## 5. Recommended Sprint 4 Backlog (Priority Order)

| # | Ticket | Title | Complexity | Priority |
|---|--------|-------|------------|----------|
| 1 | DOC-53 | Reassign an Already-Assigned Operator | Small | Must finish Sprint 4 |
| 2 | DOC-54 | Manager Override: Force-Resolve / Force-Close a Stuck Request | Small–Medium | Must finish Sprint 4 |
| 3 | DOC-57 | Pagination for List Endpoints | Small–Medium | Must finish Sprint 4 |
| 4 | DOC-56 | Request List Filtering & Sorting | Small–Medium | Must finish Sprint 4 |
| 5 | DOC-55 | Password Reset (Forgot Password) | Medium | Must finish Sprint 4 |
| 6 | DOC-58 | In-App Notifications | Large | Must finish Sprint 4 |
| 7 | DOC-59 | Request Activity Timeline / History | Medium | Nice to have |
| 8 | DOC-67 | Operator Workload Visibility | Small | Nice to have |
| 9 | DOC-61 | Operator Can Add Attachments to Assigned Requests | Small | Nice to have |
| 10 | DOC-60 | Self-Service Profile Editing | Small | Nice to have |
| 11 | DOC-62 | Request Keyword Search | Small–Medium | Nice to have |
| 12 | DOC-64 | Export Requests to CSV/Excel | Medium | Nice to have |
| 13 | DOC-68 | Duplicate Request Detection | Medium | Nice to have |
| 14 | DOC-63 | Manager Analytics Dashboard | Medium–Large | Nice to have |
| 15 | DOC-65 | Email Notifications | Medium–Large | Nice to have |
| 16 | DOC-71 | Email Verification on Registration | Small–Medium | Future release |
| 17 | DOC-74 | Request Archive / Retention View | Small | Future release |
| 18 | DOC-73 | Organization Settings Page | Small–Medium | Future release |
| 19 | DOC-76 | Global Search (Within Role Scope) | Medium | Future release |
| 20 | DOC-72 | Request Templates | Medium | Future release |
| 21 | DOC-70 | SLA Escalation | Medium | Future release |
| 22 | DOC-66 | Automatic Operator Assignment | Large | Future release |
| 23 | DOC-69 | Request SLA & Due Dates | Large | Future release |
| 24 | DOC-75 | System-Wide Audit Log | Large | Future release |

**Note on ordering within "Must finish Sprint 4":** DOC-53/54 come first because they are workflow dead-ends today (a Manager can get a Request permanently stuck with no fix). DOC-57/56 come next because DOC-58's notification list and every other future list-based ticket becomes more valuable once the underlying lists are usable at scale. DOC-55 and DOC-58 close out the tier as the two largest, most user-visible gaps.

This document proposes scope only — no code was written or modified as part of this audit.
