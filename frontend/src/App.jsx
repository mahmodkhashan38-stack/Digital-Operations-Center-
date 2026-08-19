import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import Home from './pages/Home.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import ManagerDashboard from './pages/ManagerDashboard.jsx';
import OperatorDashboard from './pages/OperatorDashboard.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Profile from './pages/Profile.jsx';
import OrganizationChat from './pages/OrganizationChat.jsx';
import NotFound from './pages/NotFound.jsx';

// Root application component. Wires up authentication state, the navigation
// bar, and page routes (including the protected dashboard).
function App() {
  return (
    <AuthProvider>
      <div className="app-shell">
        <Navbar />
        <main className="page-container">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
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
  );
}

export default App;
