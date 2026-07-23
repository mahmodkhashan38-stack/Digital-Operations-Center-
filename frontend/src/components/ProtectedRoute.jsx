import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { destinationForRole } from '../utils/roleRoutes.js';

// Guards a route so only authenticated users can access it, and optionally
// only users with one of a specific set of roles (DOC-37).
//
// `roles` is optional - omitted entirely, this behaves exactly as before
// (any authenticated user may pass). When provided, a signed-in user whose
// role is not in the list is redirected to THEIR OWN dashboard
// (destinationForRole, utils/roleRoutes.js) rather than being shown the
// page - not to a hardcoded path. DOC-42: this used to redirect
// unconditionally to '/dashboard', which was harmless while /dashboard was
// open to every authenticated role, but became a redirect loop once
// /dashboard became employee-only (an Operator rejected from /admin would
// have been bounced to /dashboard, then rejected there too). Routing every
// wrong-role visitor to their own real destination instead means this stays
// correct no matter how many role-specific routes exist.
//
// IMPORTANT: this is a UX convenience only. It hides the page's UI from
// the wrong role in the browser - it is NOT the security boundary. The
// real boundary is the backend (requireRole('system_admin') on
// /api/organizations, DOC-32/DOC-38's isolation middleware, etc.), which
// rejects unauthorized requests regardless of what this component does or
// whether it is bypassed.
//
// Waits for `isLoading` to resolve before deciding anything - this is what
// makes a direct browser refresh on a protected route work correctly: the
// real signed-in user is never redirected away just because /me hasn't
// finished loading yet.
function ProtectedRoute({ children, roles }) {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <section className="page">
        <div className="card auth-card">
          <p className="auth-subtitle">Checking your session...</p>
        </div>
      </section>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (roles && !roles.includes(user?.role)) {
    return <Navigate to={destinationForRole(user?.role)} replace />;
  }

  return children;
}

export default ProtectedRoute;
