import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { getGuideById, getGuidesForRole } from '../data/helpGuides.js';
import { roleLabel } from '../utils/roleRoutes.js';
import EmptyState from '../components/EmptyState.jsx';

// DOC-76 - "User Help & Quick Guides".
//
// FRONTEND-ONLY ROLE FILTERING (task spec section 7 - "Filter at
// application logic level (`allowedRoles.includes(role)`), never CSS
// only"). This is a deliberate, ticket-scoped exception to this
// project's usual "backend is the sole authority on visibility" rule
// (see DOC-60/73/74/75's own routes, which all rely on the backend to
// decide what data a role may see). It is safe here specifically
// BECAUSE Help guides are non-sensitive, generic product documentation
// with no privacy requirement of their own - there is no backend at all
// for this ticket to defer to (task spec section 2/31: no database, no
// backend changes). See this project's README "Help Center" section for
// the full honesty note this ticket's own section 35 requires about
// static/public hosting not providing true role-level secrecy.
//
// ONE SHARED ROUTE, EVERY ROLE (including System Admin) MAY OPEN IT
// (App.jsx's <ProtectedRoute> for /help intentionally has NO `roles`
// restriction, unlike /chat, /messages, /policies, /knowledge above it -
// task spec never excludes System Admin from Help itself, only from
// seeing Employee/Operator guide content, which this page's own
// `getGuidesForRole` filter already prevents by simply returning zero
// guides for a role with none registered).
function Help() {
  const { user } = useAuth();
  const { guideId } = useParams();

  const guides = useMemo(() => getGuidesForRole(user?.role), [user?.role]);

  if (guideId) {
    return <HelpGuideDetail guideId={guideId} guides={guides} />;
  }

  return (
    <div className="page help-page">
      <div className="admin-section-header">
        <h1>Help Center</h1>
      </div>
      <p className="auth-subtitle">Quick guides for using Digital Operations Center.</p>

      {guides.length === 0 ? (
        <EmptyState
          title="No guides yet"
          message="There are no Help guides for your role yet. Check back later."
        />
      ) : (
        <div className="help-card-list">
          {guides.map((guide) => (
            <HelpGuideCard key={guide.id} guide={guide} role={user?.role} />
          ))}
        </div>
      )}
    </div>
  );
}

function HelpGuideCard({ guide, role }) {
  const isPdf = guide.type === 'pdf';
  return (
    <article className="card help-guide-card">
      <div className="help-guide-card-header">
        <h2>{guide.title}</h2>
        <span className={`status-badge ${isPdf ? 'help-badge-pdf' : 'help-badge-quick-guide'}`}>
          {isPdf ? 'PDF Guide' : 'Quick Guide'}
        </span>
      </div>
      <p className="help-guide-role-label">For: {roleLabel(role)}</p>
      <p className="auth-subtitle">{guide.description}</p>
      {isPdf ? (
        // Task spec section 11/24 - real PDF files open browser-native in
        // a new tab, no in-app PDF rendering library anywhere in this
        // project. `rel="noopener noreferrer"` is standard new-tab-link
        // hygiene (this project's own convention, see other external
        // links in this codebase).
        <a
          className="btn btn-outline"
          href={guide.file}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Guide
        </a>
      ) : (
        <Link className="btn btn-outline" to={`/help/${guide.id}`}>
          Open Guide
        </Link>
      )}
    </article>
  );
}

// Task spec section 12 - "optional in-app view at /help/:guideId... only
// if it works reliably on desktop and mobile". Since every guide
// currently registered is a 'quickGuide' (plain text steps, no PDF), this
// view always renders reliably on any screen size - no iframe, no
// external viewer dependency at all.
//
// MISSING-GUIDE SAFETY (task spec section 20 - "never show a broken
// iframe indefinitely" and this project's own general 404-safety
// convention): an unknown or role-inaccessible :guideId renders a plain
// "guide not found" EmptyState instead of crashing or rendering nothing.
function HelpGuideDetail({ guideId, guides }) {
  const guide = useMemo(() => {
    const match = getGuideById(guideId);
    if (!match) return null;
    // A guide that exists globally but isn't in this caller's own
    // role-filtered list must not be shown either - this is the same
    // "role filtering must actually withhold content, not just hide the
    // list entry" requirement task spec section 7 describes for the list
    // view, applied identically to direct/typed-in navigation to
    // /help/:guideId.
    const isAllowedForRole = guides.some((allowed) => allowed.id === match.id);
    return isAllowedForRole ? match : null;
  }, [guideId, guides]);

  if (!guide) {
    return (
      <div className="page help-page">
        <Link className="help-back-link" to="/help">
          &larr; Back to Help Center
        </Link>
        <EmptyState
          title="Guide not found"
          message="This guide does not exist or is not available for your role."
        />
      </div>
    );
  }

  if (guide.type === 'pdf') {
    // Defensive fallback only - the list view already links PDF guides
    // directly to their file (new tab), so this branch is not reachable
    // via normal navigation today, but is kept safe rather than absent.
    return (
      <div className="page help-page">
        <Link className="help-back-link" to="/help">
          &larr; Back to Help Center
        </Link>
        <div className="card help-guide-detail">
          <h1>{guide.title}</h1>
          <p className="auth-subtitle">{guide.description}</p>
          <a className="btn btn-primary" href={guide.file} target="_blank" rel="noopener noreferrer">
            Open PDF
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="page help-page">
      <Link className="help-back-link" to="/help">
        &larr; Back to Help Center
      </Link>
      <div className="card help-guide-detail">
        <div className="help-guide-card-header">
          <h1>{guide.title}</h1>
          <span className="status-badge help-badge-quick-guide">Quick Guide</span>
        </div>
        <p className="auth-subtitle">{guide.description}</p>
        <ol className="help-guide-steps">
          {guide.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default Help;
