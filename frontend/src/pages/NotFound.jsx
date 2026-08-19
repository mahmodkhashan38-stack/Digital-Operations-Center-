import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { destinationForRole } from '../utils/roleRoutes.js';

// DOC-69 - "Error & UX Hardening" (task spec section 35). Before this
// ticket, App.jsx's <Routes> had no catch-all route at all - visiting any
// URL that didn't exactly match one of the explicit <Route path="...">
// entries (a typo, a stale bookmark, a copy-pasted link with a trailing
// slash, etc.) rendered nothing: React Router simply has no matching
// element, so <main> stayed empty - a blank page with the Navbar still
// visible above it and no indication anything went wrong.
//
// "Go to your dashboard" only renders while signed in (and points at the
// caller's OWN role's dashboard, via the same `destinationForRole` helper
// ProtectedRoute.jsx/Login.jsx already use - never a hardcoded path) -
// signed out, the safer, always-correct destination is Home.
function NotFound() {
  const { isAuthenticated, user } = useAuth();

  return (
    <section className="page auth-page">
      <div className="card auth-card">
        <h1>Page not found</h1>
        <p className="auth-subtitle">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <div className="form-actions">
          {isAuthenticated ? (
            <Link to={destinationForRole(user?.role)} className="btn btn-primary btn-block">
              Go to My Dashboard
            </Link>
          ) : (
            <Link to="/" className="btn btn-primary btn-block">
              Back to Home
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

export default NotFound;
