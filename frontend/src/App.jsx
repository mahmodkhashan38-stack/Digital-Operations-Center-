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
          </Routes>
        </main>
      </div>
    </AuthProvider>
  );
}

export default App;
