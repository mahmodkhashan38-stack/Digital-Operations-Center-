const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Generic request helper for talking to the backend API.
async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.message || 'Something went wrong. Please try again.';
    throw new Error(message);
  }

  return data;
}

// Authentication-related API calls.
export const authApi = {
  register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
  getMe: (token) => request('/auth/me', { method: 'GET', token }),
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
  assignManager: (id, payload, token) => request(`/organizations/${id}/manager`, { method: 'POST', body: payload, token }),
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
};

export default request;
