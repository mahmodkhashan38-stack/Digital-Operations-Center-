import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { destinationForRole } from '../utils/roleRoutes.js';

// DOC-57 - the one path this component must never redirect AWAY from on
// account of `mustChangePassword`, or the person could never actually
// clear that flag (an infinite redirect loop back to itself).
const CHANGE_PASSWORD_PATH = '/change-password';

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
  const location = useLocation();

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

  // DOC-57 - "Secure Password Management": a user whose password was just
  // reset by their Manager (or who otherwise has mustChangePassword ===
  // true) is redirected away from every normal protected page to
  // /change-password - this is a UX convenience only, exactly like every
  // other check in this component; the real boundary is the backend's
  // own requirePasswordChangeCompleted middleware, which independently
  // rejects the underlying API calls regardless of what this component
  // does. The explicit path check below is what prevents a redirect loop
  // - /change-password is itself wrapped in this same ProtectedRoute (no
  // `roles` restriction), so without this check a forced-change user
  // would be bounced right back to the page they're already on.
  if (user?.mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }

  return children;
}

export default ProtectedRoute;
