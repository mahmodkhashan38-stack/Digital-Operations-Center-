import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import ManagerDashboard from './pages/ManagerDashboard.jsx';
import OperatorDashboard from './pages/OperatorDashboard.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Profile from './pages/Profile.jsx';
import OrganizationChat from './pages/OrganizationChat.jsx';
import Messages from './pages/Messages.jsx';
import Policies from './pages/Policies.jsx';
import Knowledge from './pages/Knowledge.jsx';
import Help from './pages/Help.jsx';
import NotFound from './pages/NotFound.jsx';

// Root application component. Wires up authentication state, the navigation
// bar, and page routes (including the protected dashboard).
//
// DOC-77 - ThemeProvider wraps AuthProvider, not the other way around
// (task spec section 6/27/28: appearance is a device/browser preference,
// completely independent of - and available before - authentication).
// Nothing about sign-in state ever gates whether the saved theme applies:
// Login/Register/Forgot Password/Change Password all render *inside*
// ThemeProvider exactly like every authenticated page does, so the
// correct theme is already active on every page in the app, signed in or
// not.
function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <div className="app-shell">
          <Navbar />
          <main className="page-container">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              {/* DOC-70 - "Forgot Password / Password Recovery via Manager
                  Approval". Public, unauthenticated - the whole point is
                  that a person who cannot log in can still reach this. */}
              <Route path="/forgot-password" element={<ForgotPassword />} />
              {/* DOC-57 - reachable by ANY authenticated role (no `roles`
                  restriction, unlike every dashboard route below) - both
                  voluntarily (Navbar's "Change Password" link) and
                  involuntarily (ProtectedRoute.jsx's forced-change
                  redirect, whenever user.mustChangePassword === true). */}
              <Route
                path="/change-password"
                element={
                  <ProtectedRoute>
                    <ChangePassword />
                  </ProtectedRoute>
                }
              />
              {/* DOC-62 - "User Profile". Reachable by ANY authenticated role
                  (no `roles` restriction, same shape as /change-password
                  above) - the page itself derives everything it shows from
                  the caller's own token context. A user with
                  mustChangePassword === true is still redirected to
                  /change-password by ProtectedRoute's existing check below
                  the roles check, unchanged - they never see this page's
                  content until that flag clears. */}
              <Route
                path="/profile"
                element={
                  <ProtectedRoute>
                    <Profile />
                  </ProtectedRoute>
                }
              />
              {/* DOC-42: /dashboard is now the Employee-only "Personal Request
                  Management" dashboard - Operator moved out to its own /operator
                  route below. Only role: 'employee' may render it. */}
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute roles={['employee']}>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              {/* DOC-37: System Admin's dedicated, global Organization-
                  management dashboard - distinct from every organization-
                  scoped dashboard below. Only role: 'system_admin' may render
                  it (enforced client-side here for UX, and for real by the
                  backend on every request this page makes). */}
              <Route
                path="/admin"
                element={
                  <ProtectedRoute roles={['system_admin']}>
                    <AdminDashboard />
                  </ProtectedRoute>
                }
              />
              {/* DOC-36: Organization Manager's dedicated, Organization-
                  scoped dashboard - separate from System Admin's global one
                  above. Only role: 'manager' may render it (again, UX only -
                  the backend's own manager-only, organization-scoped
                  endpoints (DOC-35/DOC-38) are the real boundary). */}
              <Route
                path="/manager"
                element={
                  <ProtectedRoute roles={['manager']}>
                    <ManagerDashboard />
                  </ProtectedRoute>
                }
              />
              {/* DOC-42: Operator's dedicated Work Management dashboard.
                  Previously Operator shared the generic /dashboard with
                  Employee - that changed here specifically so /dashboard could
                  become Employee's own "Personal Request Management" page.
                  Only role: 'operator' may render it. */}
              <Route
                path="/operator"
                element={
                  <ProtectedRoute roles={['operator']}>
                    <OperatorDashboard />
                  </ProtectedRoute>
                }
              />
              {/* DOC-60 - "Organization Chat". Reachable by manager/operator/
                  employee only - System Admin is redirected to /admin
                  (ProtectedRoute's own roles-mismatch redirect, via
                  destinationForRole), the same "own dashboard" redirect every
                  other wrong-role visit already uses, never a hardcoded
                  fallback. A user with mustChangePassword === true is still
                  redirected to /change-password by ProtectedRoute's existing
                  check below the roles check - no new logic needed for that,
                  reused exactly as-is. One shared page for all three allowed
                  roles (task spec: "Do not create separate chat pages per
                  role."). */}
              <Route
                path="/chat"
                element={
                  <ProtectedRoute roles={['manager', 'operator', 'employee']}>
                    <OrganizationChat />
                  </ProtectedRoute>
                }
              />
              {/* DOC-73 - "Private Direct Messages". Reachable by manager/
                  operator/employee only, same roles set as /chat above -
                  System Admin is redirected to /admin (ProtectedRoute's own
                  roles-mismatch redirect), and a user with
                  mustChangePassword === true is redirected to
                  /change-password, both completely unchanged/reused. One
                  shared page for all three allowed roles, exactly like
                  /chat - Messages.jsx itself is the sole authority on which
                  conversations any given caller can see (backend-enforced
                  participant-only privacy, never a role distinction). */}
              <Route
                path="/messages"
                element={
                  <ProtectedRoute roles={['manager', 'operator', 'employee']}>
                    <Messages />
                  </ProtectedRoute>
                }
              />
              {/* DOC-74 - "Organization Policies & Guidelines". Reachable by
                  manager/operator/employee only, same roles set as /chat and
                  /messages above - System Admin is redirected to /admin
                  (ProtectedRoute's own roles-mismatch redirect), and a user
                  with mustChangePassword === true is redirected to
                  /change-password, both completely unchanged/reused. One
                  shared page for all three allowed roles - Policies.jsx
                  itself renders a Manager-management view vs. an Employee/
                  Operator read+acknowledge view based on user.role, but the
                  BACKEND is the sole authority on what data each role
                  actually receives (never frontend-hidden data). */}
              <Route
                path="/policies"
                element={
                  <ProtectedRoute roles={['manager', 'operator', 'employee']}>
                    <Policies />
                  </ProtectedRoute>
                }
              />
              {/* DOC-75 - "Organization Q&A / Knowledge Board". Reachable by
                  manager/operator/employee only, same roles set as /chat,
                  /messages, /policies above - System Admin is redirected to
                  /admin (ProtectedRoute's own roles-mismatch redirect). One
                  shared page for all three allowed roles - Knowledge.jsx
                  renders the exact same board to every role, with Manager
                  getting only two additional inline privileges (accept
                  answer, close/reopen) rather than a separate view (task
                  spec section 49: "Manager sees same Knowledge Board as
                  users"). */}
              <Route
                path="/knowledge"
                element={
                  <ProtectedRoute roles={['manager', 'operator', 'employee']}>
                    <Knowledge />
                  </ProtectedRoute>
                }
              />
              {/* DOC-76 - "User Help & Quick Guides". Reachable by ANY
                  authenticated role (no `roles` restriction - unlike /chat,
                  /messages, /policies, /knowledge above, which all exclude
                  System Admin) - task spec never excludes System Admin from
                  opening the Help Center itself, only from seeing guide
                  CONTENT meant for other roles, and Help.jsx's own
                  `getGuidesForRole` filter already handles that by simply
                  returning an empty, safely-handled list for any role with
                  no guides registered. Same route renders both the guide
                  list (/help) and a single guide's detail (/help/:guideId)
                  - Help.jsx itself branches on the optional :guideId param,
                  the same "one page, param-driven view" shape Knowledge.jsx
                  already uses for its own list/detail split via
                  useSearchParams. */}
              <Route
                path="/help"
                element={
                  <ProtectedRoute>
                    <Help />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/help/:guideId"
                element={
                  <ProtectedRoute>
                    <Help />
                  </ProtectedRoute>
                }
              />
              {/* DOC-69 - "Error & UX Hardening" (task spec section 35). Catch-all
                  for any URL that matches none of the routes above (a typo, a
                  stale bookmark, a copy-pasted link with extra path segments).
                  Always the LAST route - React Router only reaches this when
                  nothing earlier matched. Unauthenticated on purpose (no
                  ProtectedRoute wrapper): a person is not signed in yet at the
                  point they've mistyped a URL, and NotFound.jsx itself already
                  reads auth state to decide its own "go back" destination. */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
        </div>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
