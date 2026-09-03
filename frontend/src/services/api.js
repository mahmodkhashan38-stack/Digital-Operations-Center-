export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// DOC-69 - "Error & UX Hardening" (task spec section 14, "Auth
// Expiration"). Before this ticket, an expired/invalid JWT discovered
// mid-session (as opposed to on initial page load, which
// AuthContext.jsx's own restoreSession already handled) had no
// application-wide effect: the page that happened to make the rejected
// call would show its own inline error message, but the stale token
// stayed in memory/localStorage and the person stayed on the same
// (now-broken) page rather than being routed back to Login.
//
// `setUnauthorizedHandler` lets AuthContext.jsx (the one place that owns
// auth state) register a callback this plain module can invoke without
// this file needing to import React/Context itself. Deliberately a single
// module-level slot (never a list/event-bus) - there is exactly one
// AuthProvider mounted for the lifetime of this app (see main.jsx), so a
// single slot is sufficient and simpler than a pub/sub system this project
// does not otherwise need.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

// The EXACT strings backend/src/middleware/auth.js's own verifyToken
// returns for "this token is no longer usable" (missing/expired/invalid)
// and for a deactivated account discovered mid-session - kept in sync
// with that file by design, not guessed. Matching on these specific
// messages (rather than "any 401/403 on any authenticated call") is
// deliberate: several endpoints legitimately return 401 for a genuine
// business reason that is NOT an expired session and must never force a
// logout - most notably `authApi.changePassword`'s own "Current password
// is incorrect." (also 401, see backend/src/controllers/
// auth.controller.js) - a person mistyping their current password must
// see that inline error on the Change Password form, never be bounced to
// Login. If this project's own auth middleware message text ever changes,
// the worst case is that this enhancement silently stops auto-triggering
// (the person still sees the normal inline error either way, just without
// the bonus redirect) - it can never falsely log someone out because of a
// mismatch, only fail to fire.
const SESSION_INVALID_MESSAGES = new Set([
  'Authentication token is missing.',
  'Authentication token has expired.',
  'Invalid authentication token.',
]);
const ACCOUNT_DEACTIVATED_MESSAGE = 'This account has been deactivated.';

// Generic request helper for talking to the backend API.
//
// DOC-45: `body` may now be a `FormData` instance (image uploads) as well
// as a plain object (every existing JSON call). When it is FormData, this
// deliberately does NOT set a Content-Type header - the browser must
// generate one itself (`multipart/form-data; boundary=...`), and manually
// setting `multipart/form-data` here would omit that boundary and break
// the upload. Every existing JSON caller is unaffected: `Content-Type:
// application/json` is still set exactly as before for anything that
// isn't FormData (task spec section 17/section 30 item 100).
async function request(path, { method = 'GET', body, token } = {}) {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const headers = {};
  if (!isFormData) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
    });
  } catch (networkError) {
    // DOC-69 (task spec section 13) - `fetch()` itself throws (never
    // resolves to a Response) when the server is unreachable at all -
    // offline, DNS failure, connection refused, CORS preflight failure,
    // etc. Left uncaught, this propagates the browser's own raw message
    // ("Failed to fetch" / "NetworkError when attempting to fetch
    // resource" / "Load failed") straight to whatever component called
    // this - exactly the raw technical string the task spec singles out
    // by name as something a user must never see directly. Every existing
    // caller's `catch (error) { ...error.message... }` continues to work
    // completely unchanged - it now simply receives this clean message
    // instead of the browser's own one.
    const connectionError = new Error('Unable to connect to the server. Please check your connection and try again.');
    connectionError.isNetworkError = true;
    throw connectionError;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || 'Something went wrong. Please try again.';
    const error = new Error(message);
    // DOC-58 - "Duplicate Request Detection". Every existing caller that
    // only ever reads `error.message` is completely unaffected by these
    // two extra properties. `error.status` (the real HTTP status) and
    // `error.data` (the full parsed JSON body) let a caller that needs
    // more than a flat error string - specifically Dashboard.jsx's
    // create-Request flow, which needs to tell a genuine validation
    // failure (400) apart from "a similar Request already exists" (409,
    // `data.duplicateDetected === true`, `data.duplicates`) - branch on
    // that without a second, parallel request-helper implementation.
    error.status = response.status;
    error.data = data;

    // DOC-69 - only ever considered for an AUTHENTICATED call (a `token`
    // was actually sent - never Login/Register themselves, which never
    // pass one) whose message exactly matches one of the known
    // session-invalid/deactivated strings above. See this file's own
    // comment on `SESSION_INVALID_MESSAGES` for why message-matching
    // (not a blanket status check) is deliberate here.
    if (token && unauthorizedHandler
      && ((response.status === 401 && SESSION_INVALID_MESSAGES.has(message))
        || (response.status === 403 && message === ACCOUNT_DEACTIVATED_MESSAGE))) {
      unauthorizedHandler();
    }

    throw error;
  }

  return data;
}

// Authentication-related API calls.
export const authApi = {
  register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
  getMe: (token) => request('/auth/me', { method: 'GET', token }),
  // DOC-57 - Flow A, "Self Password Change". `payload` is always exactly
  // { currentPassword, newPassword, confirmPassword } - reachable by any
  // authenticated role, and deliberately the one protected-route-shaped
  // call that keeps working even while the caller's own
  // mustChangePassword is true (see backend/src/middleware/
  // requirePasswordChangeCompleted.js - this route never has that
  // middleware composed into its chain at all).
  changePassword: (payload, token) => request('/auth/change-password', { method: 'PATCH', body: payload, token }),
  // DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
  // PUBLIC - no token, same shape as register/login above. `payload` is
  // always exactly { email, companyCode } - this project has no email
  // delivery, so the response is always a safe, generic status message,
  // never a token or account data (see backend's forgotPassword for the
  // full enumeration-resistance contract).
  forgotPassword: (payload) => request('/auth/forgot-password', { method: 'POST', body: payload }),
  // DOC-69 - "Login History & Active Sessions". Revokes the CURRENT
  // server-side session before AuthContext.jsx clears the local token -
  // see that file's own `logout` for why this is wrapped in a try/catch
  // there rather than here (a network failure must never prevent the
  // person from clearing their own local session).
  logout: (token) => request('/auth/logout', { method: 'POST', token }),
};

// DOC-69 - "Login History & Active Sessions". Reachable by any
// authenticated, non-forced-change role - every endpoint here is scoped
// server-side to the caller's OWN sessions only (never another user's,
// regardless of role - see backend/src/controllers/userSession.
// controller.js's own top comment). No payload ever includes a
// `tokenId`/`jti`/organizationId - this client never has one to send in
// the first place (the backend never returns one - see that controller's
// own `sanitizeSession`).
export const sessionApi = {
  // Returns up to the 30 most recent sessions (active + historical),
  // newest first, each already carrying its own computed `status`
  // ('ACTIVE'/'REVOKED'/'EXPIRED') and `isCurrent` flag - this client
  // never re-derives either of those itself.
  list: (token) => request('/auth/sessions', { method: 'GET', token }),
  // Revokes exactly one of the caller's own sessions. `sessionId` is an
  // opaque id from a previous `list()` response - never a raw tokenId/JWT
  // (this client never has one). Revoking the current session is allowed
  // by the backend; the caller (Profile.jsx) checks the returned
  // `isCurrent` flag and immediately performs a local logout when it is.
  revoke: (sessionId, token) => request(`/auth/sessions/${sessionId}`, { method: 'DELETE', token }),
  logoutOthers: (token) => request('/auth/sessions/logout-others', { method: 'POST', token }),
  logoutAll: (token) => request('/auth/sessions/logout-all', { method: 'POST', token }),
};

// DOC-62 - "User Profile". `updateMine` is the ONE new call this ticket
// adds - a thin `PATCH /users/me` wrapper, reachable by every authenticated
// role (backend enforces this, not this client - see routes/user.routes.js).
// `updates` should only ever contain `{ fullName }` - the backend rejects
// (400) role/organizationId/isActive/password/passwordHash/
// mustChangePassword/createdAt/updatedAt/_id/id/email/specialties outright
// if any of them are present, even if this client were to send one (it
// never does). This client never sends a userId either - the backend
// derives the target entirely from the authenticated caller's own token
// context, exactly like `organizationApi.updateMine` (DOC-61) already does
// for Organization Settings.
export const userSelfApi = {
  // `updates` may now also include `bio` (DOC-71) alongside `fullName` -
  // same self-scoped, explicit-whitelist contract: the backend rejects
  // (400) anything else outright, even if this client were to send it (it
  // never does), and derives the target user entirely from the
  // authenticated caller's own token, never from anything sent here.
  updateMine: (updates, token) => request('/users/me', { method: 'PATCH', body: updates, token }),
  // DOC-71 - "Enhanced User Profile: Profile Picture + Bio". `file` is a
  // single File/Blob from an `<input type="file">` - wrapped in FormData
  // under the field name `profileImage`, the exact field name the backend
  // Multer middleware (`uploadMemory.single('profileImage')` - see
  // routes/user.routes.js) expects. No userId is ever sent - this always
  // targets the caller's OWN image (POST /users/me/profile-image), the
  // backend derives the target entirely from the token, never from a URL
  // param (task spec section 10). The response's `data` is the caller's
  // full freshly-sanitized user object (same shape `authApi.login`/
  // `userSelfApi.updateMine` already return), ready to hand directly to
  // AuthContext's `updateUser` with no separate GET /auth/me round trip.
  uploadProfileImage: (file, token) => {
    const formData = new FormData();
    formData.append('profileImage', file);
    return request('/users/me/profile-image', { method: 'POST', body: formData, token });
  },
  // No body - clears the caller's own current profile image (idempotent
  // on the backend: calling this with no image already set still returns
  // a normal 200 success, never an error - see userProfileImage.
  // controller.js's own deleteMyProfileImage).
  deleteProfileImage: (token) => request('/users/me/profile-image', { method: 'DELETE', token }),
};

// Organization-management API calls (DOC-32/DOC-34/DOC-41). Every one of
// these hits an existing System-Admin-only backend endpoint - nothing here
// invents new backend behavior, it only exposes what already exists to the
// Admin Dashboard (DOC-37). The backend remains the authority on
// authorization: these calls will simply fail (401/403) for a token that
// isn't a system_admin's, exactly like calling them with curl would.
export const organizationApi = {
  list: (token) => request('/organizations', { method: 'GET', token }),
  get: (id, token) => request(`/organizations/${id}`, { method: 'GET', token }),
  // DOC-42: the authenticated caller's OWN Organization, derived entirely
  // server-side from req.user.organizationId (see backend/src/routes/
  // organization.routes.js and controllers/organization.controller.js's
  // getMyOrganization). This client never sends an id, and never could
  // choose a different Organization by calling it - used by the Manager
  // Dashboard's Organization Information section and the Operator
  // Dashboard's organization context.
  getMine: (token) => request('/organizations/me', { method: 'GET', token }),
  // DOC-61 - "Organization Settings for Manager". Manager-only on the
  // backend (`requireRole('manager')` - see routes/organization.routes.js).
  // `updates` should only ever contain a subset of
  // { name, description, contactEmail, contactPhone } - the backend
  // rejects (400) companyCode/isActive/createdAt/manager/managerId/
  // organizationId/_id/id/users outright if any of them are present, even
  // if this client were to send one (it never does). This client never
  // sends an organizationId either - the backend derives the target
  // Organization entirely from the authenticated Manager's own token
  // context, exactly like `getMine` above.
  updateMine: (updates, token) => request('/organizations/me', { method: 'PATCH', body: updates, token }),
  // `manager` is optional: { fullName, email, password }. companyCode,
  // managerId, and organizationId are never sent from here - the backend
  // generates/derives all of those itself.
  create: (payload, token) => request('/organizations', { method: 'POST', body: payload, token }),
  // Only { name, isActive } are ever meaningful in `updates` - the backend
  // ignores anything else, but this client only ever sends one of those two
  // fields anyway (see AdminDashboard's activate/deactivate action).
  update: (id, updates, token) => request(`/organizations/${id}`, { method: 'PATCH', body: updates, token }),
  regenerateCode: (id, token) => request(`/organizations/${id}/regenerate-code`, { method: 'POST', token }),
  // DOC-53: System-Admin-only platform statistics (Total/Active/Inactive
  // Organizations, With/Without Manager, Total Managers) - never
  // Organization-operational Request data (System Admin does not have
  // that permission, and this endpoint does not grant it).
  getStatistics: (token) => request('/organizations/statistics', { method: 'GET', token }),
  assignManager: (id, payload, token) => request(`/organizations/${id}/manager`, { method: 'POST', body: payload, token }),
  // DOC-49: edits the CURRENT Manager's own fullName/email (409 if the
  // Organization has no Manager yet - use assignManager instead).
  updateManagerProfile: (id, updates, token) => request(`/organizations/${id}/manager`, { method: 'PATCH', body: updates, token }),
  // DOC-49: replaces the CURRENT Manager with a brand-new account
  // (fullName/email/password, like assignManager) - the backend
  // deactivates the old Manager, never deletes them (409 if there is no
  // existing Manager to replace).
  replaceManager: (id, payload, token) => request(`/organizations/${id}/manager`, { method: 'PUT', body: payload, token }),
  // DOC-47: hard-deletes an Organization. The backend rejects this (409)
  // while any User still belongs to it - this client does not attempt to
  // predict or enforce that itself, it just surfaces whatever the backend
  // decides, the same as every other action here.
  delete: (id, token) => request(`/organizations/${id}`, { method: 'DELETE', token }),
};

// Organization user-management API calls (DOC-35). Manager-only on the
// backend, and already scoped to the caller's own Organization at the
// database query level (DOC-38) - this client never sends organizationId
// on either call, and never needs to: the backend derives it entirely
// from the authenticated Manager's own token context. Used by the Manager
// Dashboard (DOC-36).
export const userApi = {
  list: (token) => request('/users', { method: 'GET', token }),
  // `role` must be exactly 'employee' or 'operator' - the backend rejects
  // anything else (including 'manager'/'system_admin') with an explicit
  // allowlist, see backend/src/controllers/user.controller.js.
  updateRole: (id, role, token) => request(`/users/${id}/role`, { method: 'PATCH', body: { role }, token }),
  // DOC-50: fullName/email only - the backend allowlists exactly these two
  // fields and rejects role/isActive/organizationId/password if sent here.
  updateProfile: (id, updates, token) => request(`/users/${id}`, { method: 'PATCH', body: updates, token }),
  // DOC-50: activate/deactivate. `isActive` must be a boolean - the backend
  // rejects anything else. DOC-48 reuses this same endpoint for
  // "Organization Employee Removal" rather than adding a second one (see
  // backend/README.md's DOC-48 section) - the resolved response may now
  // also carry an optional top-level `warning` string (Operator being
  // deactivated while still holding active assigned Requests), which
  // OrganizationUserRow.jsx shows as a small non-blocking notice.
  updateStatus: (id, isActive, token) => request(`/users/${id}/status`, { method: 'PATCH', body: { isActive }, token }),
  // DOC-44: full-replacement specialty assignment for an Operator -
  // `categoryIds` is the complete desired set of Service Category ids
  // (send [] to clear all specialties). This client never sends
  // organizationId or role - the backend derives the target's identity
  // entirely from the scoped :id lookup and rejects anything that isn't
  // currently an Operator in the caller's own Organization.
  updateSpecialties: (id, categoryIds, token) => request(`/users/${id}/specialties`, { method: 'PATCH', body: { categoryIds }, token }),
  // DOC-57 - Flow B, "Manager Password Reset". `payload` is always
  // exactly { newPassword, confirmPassword } - the Manager never sends
  // and never sees the target's old password. Only usable on an Employee
  // or Operator in the Manager's own Organization (never self, another
  // Manager, or System Admin) - the backend is the sole authority on
  // that, this client does not attempt to predict it beyond simply never
  // rendering the control on a Manager/System-Admin row (this component
  // never receives one anyway - see OrganizationUserRow.jsx's own
  // comment).
  resetPassword: (id, payload, token) => request(`/users/${id}/reset-password`, { method: 'PATCH', body: payload, token }),
  // DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
  // Manager-only, own Organization only (backend-enforced) - see
  // routes/user.routes.js. `status` is optional; omitted, the backend
  // returns every request (newest first) so the Manager can see history,
  // not just the current pending queue.
  listPasswordResetRequests: (token, status) => request(
    `/users/password-reset-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    { method: 'GET', token },
  ),
  // `payload` is always exactly { newPassword, confirmPassword } - the
  // same shape resetPassword above already sends, since this ultimately
  // performs the exact same backend reset mechanism.
  approvePasswordResetRequest: (id, payload, token) => request(
    `/users/password-reset-requests/${id}/approve`,
    { method: 'PATCH', body: payload, token },
  ),
  rejectPasswordResetRequest: (id, token) => request(
    `/users/password-reset-requests/${id}/reject`,
    { method: 'PATCH', token },
  ),
};

// Service Category management API calls (DOC-43). Manager-only on the
// backend, and already scoped to the caller's own Organization at the
// database query level (DOC-38) - this client never sends organizationId
// on any call, and never needs to: the backend derives it entirely from
// the authenticated Manager's own token context. Used by the Manager
// Dashboard's Service Categories section.
export const serviceCategoryApi = {
  list: (token) => request('/service-categories', { method: 'GET', token }),
  // Only `name` is ever meaningful here - the backend never reads
  // organizationId/isActive from this call even if sent.
  create: (name, token) => request('/service-categories', { method: 'POST', body: { name }, token }),
  update: (id, name, token) => request(`/service-categories/${id}`, { method: 'PATCH', body: { name }, token }),
  // `isActive` must be a boolean. There is no delete - see
  // backend/src/controllers/serviceCategory.controller.js.
  updateStatus: (id, isActive, token) => request(`/service-categories/${id}/status`, { method: 'PATCH', body: { isActive }, token }),
  // DOC-10: read-only, active-only Categories for the caller's own
  // Organization - available to any authenticated Organization member
  // (not just Manager), used by the Employee Dashboard's "Open New
  // Request" form to populate the Category selector. Hits a SEPARATE
  // backend endpoint from `list` above (GET /service-categories/available,
  // not the Manager-only GET /service-categories) - see
  // backend/src/routes/serviceCategory.routes.js.
  listAvailable: (token) => request('/service-categories/available', { method: 'GET', token }),
  // Sprint 4 - Manager-only recovery action for an Organization with zero
  // Categories. No request body - the backend derives organizationId
  // entirely from the Manager's own token context, same as every other
  // call in this object. Safe to call more than once (idempotent on the
  // backend); the response's `data` is the Organization's full resulting
  // Category list, ready to replace whatever the Manager Dashboard
  // currently has loaded.
  createDefaults: (token) => request('/service-categories/create-defaults', { method: 'POST', token }),
};

// DOC-54 - "Request Search, Filters and Sorting". Builds a query string
// from a plain filters object, skipping any key that is undefined, null,
// or an empty string - so a dashboard can always pass its FULL filters
// state object (including every field it never touched) without ever
// needing to manually prune it first. Every value is sent as plain text;
// the backend (utils/requestQueryBuilder.js) is the sole authority on
// validating each one - this is purely a "don't send noise" convenience,
// never a security boundary.
function buildRequestQueryString(filters) {
  const params = new URLSearchParams();
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}

// Request API calls (DOC-10 create, DOC-11 read-only list/detail). This
// client never sends organizationId, createdBy, status, or
// assignedOperatorId on create - the backend derives/hardcodes all of
// those itself (see backend/src/controllers/request.controller.js) and
// would simply ignore them if sent. `listMine`/`getMineById` are
// deliberately read-only - there is no `delete` here (DOC-46/DOC-45 own
// edit/cancel/attachments instead), and both endpoints only ever return
// the authenticated Employee's OWN Requests, enforced server-side.
export const requestApi = {
  // DOC-45: `formData` is always a `FormData` instance built by the
  // caller (Dashboard.jsx) - `title`/`description`/`categoryId`/
  // `priority` as text fields, plus zero or more `attachments` file
  // fields. Creating a Request with no images is still just a FormData
  // object with no `attachments` entries - the backend handles both
  // shapes identically (see request.controller.js's createRequest).
  create: (formData, token) => request('/requests', { method: 'POST', body: formData, token }),
  // DOC-54: `filters` is optional - every existing caller that omits it
  // (or passes {}) gets the exact same unfiltered, newest-first list as
  // before (the backend's own defaults - see requestQueryBuilder.js).
  listMine: (token, filters) => request(`/requests${buildRequestQueryString(filters)}`, { method: 'GET', token }),
  getMineById: (id, token) => request(`/requests/${id}`, { method: 'GET', token }),
  // DOC-12: the one dedicated status-change call, reachable by Employee/
  // Operator/Manager tokens (each with their own server-enforced rules -
  // see backend/src/utils/requestStatusTransitions.js). This client never
  // sends assignedOperatorId/organizationId/createdBy - only `status` is
  // ever read by the backend, and only if the transition is authorized.
  updateStatus: (id, statusValue, token) => request(`/requests/${id}/status`, { method: 'PATCH', body: { status: statusValue }, token }),
  // DOC-46: `updates` should only ever contain a subset of
  // { title, description, categoryId, priority } - the backend rejects
  // (400) anything else, including status/organizationId/createdBy/
  // assignedOperatorId, even if this client were to send them (it never
  // does). Only usable while the Request is 'open' and unassigned - the
  // backend is the sole authority on that, this client does not attempt
  // to predict it beyond hiding the Edit action in the UI.
  updateMine: (id, updates, token) => request(`/requests/${id}`, { method: 'PATCH', body: updates, token }),
  // DOC-46: no body is ever sent - the backend decides `status: 'cancelled'`
  // entirely server-side. Only usable while the Request is 'open' and
  // unassigned, same as `updateMine`.
  cancelMine: (id, token) => request(`/requests/${id}/cancel`, { method: 'PATCH', token }),
  // DOC-45: `formData` contains one or more `attachments` file fields and
  // nothing else - only usable while the Request is 'open' and
  // unassigned (same eligibility as `updateMine`/`cancelMine`), enforced
  // server-side with its own 409 regardless of what this client predicts.
  addAttachments: (id, formData, token) => request(`/requests/${id}/attachments`, { method: 'POST', body: formData, token }),
  // DOC-45: no body - `attachmentId` alone identifies which single
  // attachment to remove; the backend looks up the actual stored file
  // from its own already-stored metadata, this client never sends a
  // filesystem path.
  removeAttachment: (id, attachmentId, token) => request(`/requests/${id}/attachments/${attachmentId}`, { method: 'DELETE', token }),
  // DOC-52: Manager-only, every Request in the Manager's own Organization
  // (not scoped by createdBy the way listMine is) - used by the Manager
  // Dashboard's new "Organization Requests" section.
  // DOC-54: `filters` optional, same contract as listMine above - now also
  // supports the two Manager-only filters (assignedOperatorId, including
  // the special "unassigned" value, and createdBy) and the createdFrom/
  // createdTo date range.
  listOrganization: (token, filters) => request(`/requests/organization${buildRequestQueryString(filters)}`, { method: 'GET', token }),
  // DOC-67 - "Request Reports & CSV Export". Deliberately does NOT reuse
  // the shared `request()` helper above - that helper always calls
  // `response.json()`, which would break on this endpoint's real
  // (non-JSON) success response, a raw `text/csv` file. On failure the
  // backend still returns the project's normal JSON error shape
  // (`{status, message}`), so this function mirrors `request()`'s own
  // error-handling contract (throws an `Error` whose `.message` is the
  // server's message, `.status` is the real HTTP status) for exactly that
  // case - only the SUCCESS path differs, returning a `Blob` plus the
  // filename the backend chose (parsed from its own
  // `Content-Disposition` header - task spec section 5's own safe,
  // server-generated `requests-YYYY-MM-DD.csv` shape) instead of parsed
  // JSON. `filters` reuses the exact same query-string builder every
  // other filtered list call in this file already uses - the export
  // always requests the CURRENT filter state, never an unfiltered pull
  // (task spec section 18).
  //
  // AUTHENTICATED DOWNLOAD, NOT A RAW BROWSER NAVIGATION (task spec
  // section 19): a plain `<a href="...">`/`window.location` navigation to
  // this endpoint would never attach the `Authorization` header this
  // project's JWT auth requires, and the token must never be placed in a
  // query parameter (task spec: "Do not put JWT in query parameters. Do
  // not expose tokens in downloadable URLs."). Calling this via
  // authenticated `fetch` and handing the caller back a `Blob` is what
  // lets ManagerDashboard.jsx build a short-lived `ObjectURL` and trigger
  // the actual save entirely client-side (see that file's own
  // `handleExportCsv`), with the real token never touching the URL bar or
  // any downloadable link at all.
  exportOrganizationCsv: async (token, filters) => {
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/requests/organization/export${buildRequestQueryString(filters)}`, {
        method: 'GET',
        headers,
      });
    } catch (networkError) {
      // DOC-69 - same raw-fetch() network-failure handling as the shared
      // `request()` helper above (this call deliberately bypasses that
      // helper - see its own top comment - but must not bypass this
      // safety net too).
      const connectionError = new Error('Unable to connect to the server. Please check your connection and try again.');
      connectionError.isNetworkError = true;
      throw connectionError;
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = data?.message || 'Something went wrong. Please try again.';
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      // DOC-69 - same session-expiry detection as the shared `request()`
      // helper (see its own comment on SESSION_INVALID_MESSAGES) - this
      // endpoint bypasses `request()` for its success path (a Blob, not
      // JSON) but must not bypass the same auto-logout safety net on
      // failure.
      if (token && unauthorizedHandler
        && ((response.status === 401 && SESSION_INVALID_MESSAGES.has(message))
          || (response.status === 403 && message === ACCOUNT_DEACTIVATED_MESSAGE))) {
        unauthorizedHandler();
      }
      throw error;
    }

    const blob = await response.blob();
    // Parses `attachment; filename="requests-2026-08-16.csv"` back into
    // just the filename - falls back to a locally-built same-shape name
    // if the header is ever missing/unparseable for any reason (should
    // not happen against this project's own backend, defensive only).
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `requests-${new Date().toISOString().slice(0, 10)}.csv`;
    return { blob, filename };
  },
  // DOC-52: Operator-only, only Requests currently assigned to the caller
  // - used by the Operator Dashboard in place of its old placeholders.
  // DOC-54: `filters` optional, same contract as listMine (no operator/
  // creator override - the backend simply never reads those two for this
  // role, see requestQueryBuilder.js).
  getAssigned: (token, filters) => request(`/requests/assigned${buildRequestQueryString(filters)}`, { method: 'GET', token }),
  // DOC-52: Manager-only. `operatorId` must belong to an active Operator
  // in the Manager's own Organization whose specialties include this
  // Request's category - the backend is the sole authority on that, this
  // client does not attempt to predict it beyond only offering eligible
  // operators in the UI. Only usable while the Request is still 'open'
  // (also enforced server-side, same as every other eligibility rule in
  // this project).
  // DOC-15 - "Advanced Request History & Reassignment" extended this same
  // endpoint: `operatorId` may now also be explicit `null` (unassign), and
  // `reason` is a new optional parameter - required by the backend for a
  // genuine reassignment/unassignment, ignored for a first assignment
  // (task spec section 5). `reason` is simply omitted from the JSON body
  // (`undefined`) when the caller has none to send - the backend only
  // ever validates it when it actually needs one.
  assignOperator: (id, operatorId, reason, token) => request(`/requests/${id}/assign`, { method: 'PATCH', body: { operatorId, reason }, token }),
  // Sprint 4 (DOC-59) - Manager Request Administration, three dedicated
  // Manager-only endpoints - never the Employee-only calls above.
  // `updates` should only ever contain a subset of
  // { priority, categoryId, assignedOperatorId } - assignedOperatorId may
  // be a real operator id (assign/reassign) or explicit `null` (remove).
  // DOC-15 - `updates` may now also include `reason`, required by the
  // backend whenever `assignedOperatorId` represents a genuine
  // reassignment/unassignment (never for a first assignment) - the exact
  // same rule assignOperator's own DOC-15 extension enforces, held in
  // parity across both of this project's assignment-capable endpoints.
  // The backend independently re-validates every rule (open-only for
  // assignment changes, active+same-org+specialty-matching operator,
  // active category, no terminal-status edits) regardless of what this
  // client sends.
  managerUpdate: (id, updates, token) => request(`/requests/${id}/manager`, { method: 'PATCH', body: updates, token }),
  // `reason` is the only field ever sent - status/cancelledBy/cancelledAt
  // are always server-decided (see request.controller.js's
  // managerCancelRequest).
  managerCancel: (id, reason, token) => request(`/requests/${id}/manager/cancel`, { method: 'PATCH', body: { reason }, token }),
  // No body - only usable while the Request is 'resolved', enforced
  // server-side.
  managerClose: (id, token) => request(`/requests/${id}/manager/close`, { method: 'PATCH', token }),
  // DOC-53 - "Dashboard Statistics". `dateFilters` is optional
  // ({ createdFrom, createdTo }, reusing the exact same DOC-54 query
  // string builder) - deliberately does NOT accept status/priority/
  // category/q/sortBy/etc: statistics represent the role's FULL
  // authorized scope, not whatever the DOC-54 search/filter controls
  // currently have active (see requestQueryBuilder.js/
  // requestStatistics.js's own comments for why). Each call is Employee/
  // Operator/Manager-only on the backend - a token without the right role
  // simply gets 403, the same as every other endpoint in this file.
  getMyStatistics: (token, dateFilters) => request(`/requests/statistics/mine${buildRequestQueryString(dateFilters)}`, { method: 'GET', token }),
  getAssignedStatistics: (token, dateFilters) => request(`/requests/statistics/assigned${buildRequestQueryString(dateFilters)}`, { method: 'GET', token }),
  getOrganizationStatistics: (token, dateFilters) => request(`/requests/statistics/organization${buildRequestQueryString(dateFilters)}`, { method: 'GET', token }),
  // DOC-56 - "Operator Completion Proof Images", Operator-only on the
  // backend. `formData` contains one or more `completionAttachments` file
  // fields and nothing else - a completely separate field name/collection
  // from `addAttachments`'s `attachments` above, never merged. Only
  // usable while the caller is the assigned Operator AND the Request is
  // 'in_progress' - the backend is the sole authority on that, this
  // client does not attempt to predict it beyond only offering the
  // control in the UI under the same condition.
  addCompletionImages: (id, formData, token) => request(`/requests/${id}/completion-images`, { method: 'POST', body: formData, token }),
  // No body - `attachmentId` alone identifies which single completion
  // image to remove; the backend looks up the actual stored file from its
  // own already-stored metadata, this client never sends a filesystem
  // path. Same eligibility as addCompletionImages (in_progress only).
  removeCompletionImage: (id, attachmentId, token) => request(`/requests/${id}/completion-images/${attachmentId}`, { method: 'DELETE', token }),
  // DOC-17 - "Request Activity Timeline". Reachable by Employee (own
  // Request), Operator (assigned Request), Manager (any Request in their
  // Organization) - the backend is the sole authority on that, same as
  // every other endpoint here. Returns activity events oldest-first,
  // ready to render directly with no client-side re-sorting.
  getActivities: (id, token) => request(`/requests/${id}/activities`, { method: 'GET', token }),
  // DOC-68 - "Employee Satisfaction Rating". Employee-only on the backend
  // (must be the Request's own creator, and only once the Request is
  // 'closed' - see requestRating.controller.js's own loadOwnClosedRequestOrRespondLookup).
  // `submitRating` only ever sends `{ score, comment }` - employeeId/
  // operatorId/organizationId/requestId/createdAt are always
  // server-derived, never sent from here (matches every other create call
  // in this file). `getMyRating` returns `{ status: 'success', data: null }`
  // (never a 404) when the caller has not rated this Request yet - that is
  // a normal, expected response here, not an error to catch.
  submitRating: (id, { score, comment }, token) => request(`/requests/${id}/rating`, { method: 'POST', body: { score, comment }, token }),
  getMyRating: (id, token) => request(`/requests/${id}/rating`, { method: 'GET', token }),
  // Manager-only on the backend. `params` may include `{ limit, before,
  // score, operator, createdFrom, createdTo }`, all optional - reuses the
  // exact same query-string builder every other filtered/paginated call in
  // this file already uses. Always scoped server-side to the caller's own
  // Organization regardless of any filter passed here.
  listOrganizationRatings: (token, params) => request(`/requests/ratings/organization${buildRequestQueryString(params)}`, { method: 'GET', token }),
};

// Comment API calls (DOC-13, create + view only - no edit/delete). Reachable
// for a Request the caller is authorized to comment on (Employee - own
// Request; Operator - assigned Request; Manager - any Request in their own
// Organization); the backend is the sole authority on who that is, this
// client does not attempt to predict it. `create` only ever sends
// `{ content }` - never authorId/organizationId/requestId, all of which the
// backend derives/ignores regardless.
export const commentApi = {
  list: (requestId, token) => request(`/requests/${requestId}/comments`, { method: 'GET', token }),
  create: (requestId, content, token) => request(`/requests/${requestId}/comments`, { method: 'POST', body: { content }, token }),
};

// DOC-60 - "Organization Chat". Reachable by manager/operator/employee
// only on the backend (see routes/chat.routes.js) - a system_admin or
// unauthenticated call simply fails (403/401), the same as every other
// endpoint in this file. `list` reuses the exact same query-string
// builder every other paginated/filterable call in this file already
// uses - `params` is `{ before, limit }`, both optional; omitting either
// (or passing `{}`) gets the backend's own default (newest 50 messages).
// organizationId/authorId/role/createdAt/updatedAt are all always
// server-derived, never sent from here (see chat.controller.js's own
// explicit allowlist).
//
// DOC-70 - `send` now always builds a `FormData` body (the same shape
// `requestApi.create` already uses for text+file submissions) rather than
// a plain JSON object, since the backend route is now wired through
// Multer unconditionally (routes/chat.routes.js) - a text-only message is
// simply a FormData object with a `content` field and zero `attachments`
// entries, handled identically to a JSON body would have been.
// `attachments` is an array of 0-3 File objects (already client-validated
// for MIME/size/count by OrganizationChat.jsx - the backend remains
// authoritative and re-validates independently regardless).
// DOC-72 - "@Mentions in Organization Chat". `send`'s new third parameter,
// `mentionUserIds`, is an array of 0-10 already-validated (by the
// composer's own suggestion dropdown - see OrganizationChat.jsx) user id
// strings - sent as a JSON-array TEXT field (`mentionUserIds`) alongside
// `content`/`attachments`, exactly the "robust representation" shape the
// backend's own `parseMentionUserIdsField` expects (chat.controller.js).
// The backend independently re-validates every id regardless of what this
// client sends (same-organization, active, allowed role) - this client
// never assumes its own dropdown selection is still valid by the time
// Send is actually pressed.
export const chatApi = {
  list: (token, params) => request(`/chat/messages${buildRequestQueryString(params)}`, { method: 'GET', token }),
  send: (content, attachments, mentionUserIds, token) => {
    const formData = new FormData();
    formData.append('content', content || '');
    (attachments || []).forEach((file) => formData.append('attachments', file));
    if (mentionUserIds && mentionUserIds.length > 0) {
      formData.append('mentionUserIds', JSON.stringify(mentionUserIds));
    }
    return request('/chat/messages', { method: 'POST', body: formData, token });
  },
  // DOC-72 - same-Organization, active, allowed-chat-role user search for
  // the composer's own @mention suggestion dropdown (GET /api/chat/
  // mention-users?q=...). `q` is optional; omitted (or empty), the
  // backend returns its own small "browse" list rather than an error.
  // Returns only `{ id, fullName, role, hasProfileImage }` per result -
  // never email/bio/organization internals (see chat.controller.js's own
  // `sanitizeMentionCandidate`).
  searchMentionUsers: (token, q) => request(`/chat/mention-users${buildRequestQueryString({ q })}`, { method: 'GET', token }),
};

// DOC-18 - "In-App Notifications". Reachable by manager/operator/employee
// only on the backend (System Admin is structurally rejected -
// req.user.organizationId is always null for that role - see
// routes/notification.routes.js) - a system_admin or unauthenticated call
// simply fails (403/401), the same as every other endpoint in this file.
// Every call here is already scoped to the caller's own inbox server-side
// (routes/notification.routes.js + controllers/notification.controller.js)
// - this client never sends and could never send a recipientId.
// DOC-64 - "Audit Log". Manager (own Organization only) / System Admin
// (platform-wide, with an optional `organization` filter) - see
// backend/src/routes/auditLog.routes.js for the full authorization chain.
// `params` may include `{ limit, before, action, targetType, actor,
// createdFrom, createdTo, organization }`, all optional - reuses the exact
// same query-string builder every other filtered/paginated call in this
// file already uses. There is no create/update/delete call here at all -
// this collection is read-only from the frontend's point of view, matching
// the backend having no PATCH/DELETE route for it (task spec section 36).
export const auditLogApi = {
  list: (token, params) => request(`/audit-logs${buildRequestQueryString(params)}`, { method: 'GET', token }),
};

// DOC-73 - "Private Direct Messages". Reachable by manager/operator/
// employee only on the backend (System Admin is structurally rejected -
// see routes/directMessage.routes.js) - a system_admin or unauthenticated
// call simply fails (403/401), the same as every other endpoint in this
// file. Every conversation-scoped call is authorized server-side by
// PARTICIPATION, not merely organization membership - this client never
// assumes a call will succeed just because the current user is in the
// same Organization (see directMessage.controller.js's own
// loadAuthorizedConversation for the full privacy rule).
export const directMessageApi = {
  // GET /api/direct-messages/users?q=... - same-organization, active,
  // allowed-role user search for the "start a new conversation" box.
  // Returns only `{ id, fullName, role, hasProfileImage }` per result -
  // never email/bio/organization internals.
  searchUsers: (token, q) => request(`/direct-messages/users${buildRequestQueryString({ q })}`, { method: 'GET', token }),
  // `recipientId` is the only field ever sent - senderId/organizationId
  // are always derived server-side from the token. Idempotent: calling
  // this again for the same pair returns the SAME existing conversation
  // (200), never a duplicate (201 the first time only).
  createConversation: (recipientId, token) => request('/direct-messages/conversations', {
    method: 'POST', body: { recipientId }, token,
  }),
  // Every conversation where the CALLER is a participant - never a
  // global/Organization-wide list. Does not include message history (use
  // listMessages for that).
  listConversations: (token) => request('/direct-messages/conversations', { method: 'GET', token }),
  // `params` is `{ before, limit }`, both optional - reuses the exact
  // same query-string builder every other paginated call in this file
  // already uses.
  listMessages: (conversationId, token, params) => request(
    `/direct-messages/conversations/${conversationId}/messages${buildRequestQueryString(params)}`,
    { method: 'GET', token },
  ),
  // `attachments` is an array of 0-3 File objects (already client-
  // validated for MIME/size/count, mirroring OrganizationChat.jsx's own
  // DOC-70 validation) - the backend remains authoritative and
  // re-validates independently regardless. Always builds FormData, the
  // same shape chatApi.send already uses, so a text-only message is
  // simply a FormData object with a `content` field and zero
  // `attachments` entries.
  sendMessage: (conversationId, content, attachments, token) => {
    const formData = new FormData();
    formData.append('content', content || '');
    (attachments || []).forEach((file) => formData.append('attachments', file));
    return request(`/direct-messages/conversations/${conversationId}/messages`, {
      method: 'POST', body: formData, token,
    });
  },
  // No body - sets the CALLER's own lastReadAt for this conversation to
  // now; never affects the other participant's own read state.
  markRead: (conversationId, token) => request(`/direct-messages/conversations/${conversationId}/read`, {
    method: 'POST', token,
  }),
};

// DOC-74 - "Organization Policies & Guidelines". Reachable by manager/
// operator/employee only on the backend (System Admin is structurally
// rejected - see routes/policy.routes.js). `list`/`get` return a
// role-shaped response - the BACKEND decides what a caller may see
// (Manager: any status; Employee/Operator: published+active only), this
// client never filters/hides anything itself. `create`/`update`/`archive`/
// `getAcknowledgements` all 403 on the backend for a non-Manager token,
// even though this client only ever renders those controls for a Manager
// in the first place.
export const policyApi = {
  list: (token, params) => request(`/policies${buildRequestQueryString(params)}`, { method: 'GET', token }),
  get: (policyId, token) => request(`/policies/${policyId}`, { method: 'GET', token }),
  // `payload` is always a subset of { title, content, category,
  // isPublished } - organizationId/createdBy/updatedBy/version are always
  // server-derived, never sent from here.
  create: (payload, token) => request('/policies', { method: 'POST', body: payload, token }),
  update: (policyId, payload, token) => request(`/policies/${policyId}`, { method: 'PATCH', body: payload, token }),
  // No body - the backend sets status: 'ARCHIVED' + archivedAt entirely
  // server-side. There is no un-archive endpoint (not requested by the
  // ticket - see routes/policy.routes.js's own comment).
  archive: (policyId, token) => request(`/policies/${policyId}/archive`, { method: 'PATCH', token }),
  // No body - the backend always derives the acknowledging user from the
  // token (never accepts a userId here). Idempotent: acknowledging the
  // same current version twice returns the same existing record (200),
  // never a duplicate.
  acknowledge: (policyId, token) => request(`/policies/${policyId}/acknowledge`, { method: 'POST', token }),
  // Manager-only - compliance summary + per-user acknowledgement status
  // for the policy's CURRENT version, own Organization's active
  // Employees/Operators only (see policy.controller.js's own
  // getPolicyAcknowledgements).
  getAcknowledgements: (policyId, token) => request(`/policies/${policyId}/acknowledgements`, { method: 'GET', token }),
};

// DOC-75 - "Organization Q&A / Knowledge Board". Reachable by manager/
// operator/employee only on the backend (System Admin is structurally
// rejected - see routes/knowledge.routes.js). `listQuestions` uses simple
// PAGE-BASED pagination (`page`/`limit`), a deliberate, documented
// deviation from chatApi/directMessageApi's own `before`-cursor shape -
// see knowledge.controller.js's own top comment on `parsePagination` for
// why (a sortable/filterable board vs. an append-only real-time feed).
// `create`/`update` on a question, and `answer` create/update, all only
// ever send the plain-text fields the backend actually accepts -
// organizationId/authorId/status/acceptedAnswerId/answerCount/viewCount
// are always server-derived, never sent from here.
export const knowledgeApi = {
  listQuestions: (token, params) => request(`/knowledge/questions${buildRequestQueryString(params)}`, { method: 'GET', token }),
  getQuestion: (questionId, token) => request(`/knowledge/questions/${questionId}`, { method: 'GET', token }),
  createQuestion: (payload, token) => request('/knowledge/questions', { method: 'POST', body: payload, token }),
  // `payload` is a subset of { title, content, category } - only usable
  // by the question's own author while it is not CLOSED (backend-
  // enforced, this client only ever renders the Edit control under the
  // same condition).
  updateQuestion: (questionId, payload, token) => request(`/knowledge/questions/${questionId}`, { method: 'PATCH', body: payload, token }),
  // No body - question author OR Manager (backend-enforced).
  closeQuestion: (questionId, token) => request(`/knowledge/questions/${questionId}/close`, { method: 'POST', token }),
  reopenQuestion: (questionId, token) => request(`/knowledge/questions/${questionId}/reopen`, { method: 'POST', token }),
  listAnswers: (questionId, token, params) => request(`/knowledge/questions/${questionId}/answers${buildRequestQueryString(params)}`, { method: 'GET', token }),
  // `content` only - authorId/organizationId/questionId are always
  // server-derived. Rejected (409) by the backend if the question is
  // CLOSED, regardless of what this client's own UI currently shows.
  createAnswer: (questionId, content, token) => request(`/knowledge/questions/${questionId}/answers`, { method: 'POST', body: { content }, token }),
  updateAnswer: (questionId, answerId, content, token) => request(`/knowledge/questions/${questionId}/answers/${answerId}`, { method: 'PATCH', body: { content }, token }),
  // No body - question author OR Manager (backend-enforced). Idempotent:
  // accepting the same answer twice, or unaccepting when nothing is
  // accepted, both simply return the current state.
  acceptAnswer: (questionId, answerId, token) => request(`/knowledge/questions/${questionId}/answers/${answerId}/accept`, { method: 'POST', token }),
  unacceptAnswer: (questionId, token) => request(`/knowledge/questions/${questionId}/accepted-answer`, { method: 'DELETE', token }),
};

export const notificationApi = {
  // `params` is `{ before, limit }`, both optional - reuses the exact same
  // query-string builder every other paginated call in this file already
  // uses. Newest-first, ready to render directly with no client-side
  // re-sorting (the opposite reading order from requestApi.getActivities,
  // which is oldest-first - see backend/README.md's DOC-18 section for why
  // that difference is deliberate).
  list: (token, params) => request(`/notifications${buildRequestQueryString(params)}`, { method: 'GET', token }),
  getUnreadCount: (token) => request('/notifications/unread-count', { method: 'GET', token }),
  // No body - `id` alone identifies which single notification to mark
  // read; the backend derives WHO is marking it from the token, never
  // from anything this client sends.
  markRead: (id, token) => request(`/notifications/${id}/read`, { method: 'PATCH', token }),
  markAllRead: (token) => request('/notifications/read-all', { method: 'PATCH', token }),
};

export default request;
