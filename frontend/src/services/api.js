export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

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

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
  });

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
  assignOperator: (id, operatorId, token) => request(`/requests/${id}/assign`, { method: 'PATCH', body: { operatorId }, token }),
  // Sprint 4 (DOC-59) - Manager Request Administration, three dedicated
  // Manager-only endpoints - never the Employee-only calls above.
  // `updates` should only ever contain a subset of
  // { priority, categoryId, assignedOperatorId } - assignedOperatorId may
  // be a real operator id (assign/reassign) or explicit `null` (remove).
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
// `send` only ever transmits `{ content }` - organizationId/authorId/
// role/createdAt/updatedAt are all always server-derived, never sent from
// here (see chat.controller.js's own explicit allowlist).
export const chatApi = {
  list: (token, params) => request(`/chat/messages${buildRequestQueryString(params)}`, { method: 'GET', token }),
  send: (content, token) => request('/chat/messages', { method: 'POST', body: { content }, token }),
};

export default request;
