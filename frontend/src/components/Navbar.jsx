import { NavLink, useNavigate } from 'react-router-dom';
import logoMark from '../assets/logo-mark.png';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { DASHBOARD_ROUTE_BY_ROLE } from '../utils/roleRoutes.js';
import NotificationBell from './NotificationBell.jsx';
import DirectMessageNavBadge from './DirectMessageNavBadge.jsx';

// DOC-77 - "Theme Switcher / Appearance Customization" (task spec section
// 7). Sun/Moon, same viewBox/stroke conventions as HelpIcon/BellIcon
// below and in NotificationBell.jsx - a third icon in the same visual
// language, not a new one. Which icon is SHOWN communicates which theme
// is currently ACTIVE; ThemeToggleButton's own aria-label communicates
// what pressing it will DO next (task spec: "This communicates what
// pressing the button will do") - deliberately the inverse of the icon,
// exactly like a mute button shows a "muted speaker" icon while labelled
// "Unmute".
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}

// A single compact icon button, same `.help-icon-button`-style circular
// treatment as HelpIcon's own button in the render below (task spec
// section 7: "compact theme button... similar in importance/size to the
// existing Help/Notification controls"). Deliberately a plain <button>,
// not a NavLink - toggling appearance is an action, not a navigation.
function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  // Task spec section 7 - the label always describes what clicking the
  // button will DO (switch to the OTHER theme), never which theme is
  // currently active.
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      className="help-icon-button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      aria-pressed={!isDark}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

// DOC-76 - "User Help & Quick Guides". A small question-mark icon,
// visually modeled on NotificationBell.jsx's own `<BellIcon />` (same
// viewBox/stroke conventions) so the new Help control looks like it
// belongs next to the existing icon-style Navbar controls rather than
// introducing a third visual language.
function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2-2.4 3.4" />
      <path d="M12 17.5h.01" />
    </svg>
  );
}

// Human-readable label for each role's dashboard link. Kept separate from
// DASHBOARD_ROUTE_BY_ROLE (utils/roleRoutes.js) - that file is routing
// logic (shared with Login/ProtectedRoute), this is presentation-only.
const DASHBOARD_LABEL_BY_ROLE = {
  system_admin: 'Admin Dashboard',
  manager: 'Manager Dashboard',
  operator: 'Operator Dashboard',
  employee: 'My Dashboard',
};

// Site navigation bar. Reflects authentication state: shows Login/Register
// when signed out, and Dashboard/Logout when signed in.
function Navbar() {
  const { isAuthenticated, user, logout } = useAuth();
  const navigate = useNavigate();
  const linkClass = ({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');

  // DOC-69 - `logout()` is now async (it revokes the current session
  // server-side before clearing local state - see AuthContext.jsx's own
  // comment) - awaited here so the navigation below always happens after
  // local state has actually been cleared, never racing it.
  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  // Every role (system_admin/manager/operator/employee - DOC-42) gets a
  // link to its own dedicated Dashboard, and only that one - a Manager
  // never sees "Admin Dashboard" or "Operator Dashboard", and so on for
  // every other role. Nothing here shows more than one dashboard link at
  // once.
  const dashboardNav = {
    path: DASHBOARD_ROUTE_BY_ROLE[user?.role] || '/dashboard',
    label: DASHBOARD_LABEL_BY_ROLE[user?.role] || 'Dashboard',
  };

  return (
    <header className="navbar">
      <NavLink to="/" end className="navbar-brand">
        <img src={logoMark} alt="Digital Operations Center logo" className="navbar-logo" />
        Digital Operations Center
      </NavLink>
      <nav className="navbar-links">
        <NavLink to="/" end className={linkClass}>
          Home
        </NavLink>
        {isAuthenticated ? (
          <>
            {/* DOC-57 - while a password change is required, the normal
                dashboard link is hidden (task spec: "should not expose
                normal dashboard actions during forced-change state if
                that creates bypass/confusion") - ProtectedRoute.jsx would
                bounce the person straight back to /change-password
                anyway, so hiding it here avoids offering a link that can
                never actually go anywhere else. "Change Password" and
                Logout both always remain available either way. */}
            {!user?.mustChangePassword && (
              <NavLink to={dashboardNav.path} className={linkClass}>
                {dashboardNav.label}
              </NavLink>
            )}
            {/* DOC-62 - "User Profile". One link, every role (system_admin/
                manager/operator/employee) - unlike the dashboard link
                above, there is no per-role variant to choose between.
                Hidden during the forced-password-change state for the
                identical reason the dashboard/chat links already are: the
                backend's own PATCH /api/users/me requires
                requirePasswordChangeCompleted, so a link that could never
                actually save anything yet would only be confusing -
                ProtectedRoute would bounce the person straight back to
                /change-password anyway. */}
            {!user?.mustChangePassword && (
              <NavLink to="/profile" className={linkClass}>
                My Profile
              </NavLink>
            )}
            {/* DOC-60 - "Organization Chat". Manager/Operator/Employee only
                (task spec) - never System Admin, and hidden during the
                forced-password-change state for the same reason the
                dashboard link above already is: ProtectedRoute would just
                bounce the person straight back to /change-password anyway,
                so offering a link that can never actually go anywhere else
                would only be confusing. */}
            {!user?.mustChangePassword && ['manager', 'operator', 'employee'].includes(user?.role) && (
              <NavLink to="/chat" className={linkClass}>
                Organization Chat
              </NavLink>
            )}
            {/* DOC-73 - "Private Direct Messages". Same visibility gate as
                Organization Chat above (manager/operator/employee only,
                hidden during forced-password-change) - System Admin has
                no DM use case at all (it can never be a conversation
                participant, see directMessage.controller.js's own top
                comment), and a person mid-forced-change would just be
                bounced back by ProtectedRoute anyway. The unread badge is
                its own independent component/count (task spec section
                30: "Do not merge this visually with Notification count
                unless clearly designed") - never sharing state with
                NotificationBell. */}
            {!user?.mustChangePassword && ['manager', 'operator', 'employee'].includes(user?.role) && (
              <NavLink to="/messages" className={linkClass}>
                Messages
                <DirectMessageNavBadge />
              </NavLink>
            )}
            {/* DOC-74 - "Organization Policies & Guidelines". Same visibility
                gate as Organization Chat/Messages above (manager/operator/
                employee only, hidden during forced-password-change) -
                System Admin has no policy management/reading use case at
                all in this ticket (task spec: "System Admin does not
                participate in organization policy reading/editing by
                default"). */}
            {!user?.mustChangePassword && ['manager', 'operator', 'employee'].includes(user?.role) && (
              <NavLink to="/policies" className={linkClass}>
                Policies
              </NavLink>
            )}
            {/* DOC-75 - "Organization Q&A / Knowledge Board". Same
                visibility gate as Organization Chat/Messages/Policies
                above - System Admin has no Knowledge Board use case at
                all (task spec: "System Admin should remain excluded if
                no org membership"). */}
            {!user?.mustChangePassword && ['manager', 'operator', 'employee'].includes(user?.role) && (
              <NavLink to="/knowledge" className={linkClass}>
                Knowledge
              </NavLink>
            )}
            <NavLink to="/change-password" className={linkClass}>
              Change Password
            </NavLink>
            {/* DOC-76 - "User Help & Quick Guides". Deliberately a compact,
                icon-only control (task spec: "discoverable but not
                dominant... should not visually dominate the Navbar or
                push out existing navigation items") rather than a 10th
                full-width text link on an already link-heavy Navbar (9
                items before this one). Visible to EVERY authenticated
                role, including System Admin - unlike Chat/Messages/
                Policies/Knowledge above, Help itself has no role
                restriction (task spec never excludes System Admin from
                opening the Help Center, only from seeing content meant
                for other roles - Help.jsx's own role filter handles
                that). Hidden only during the forced-password-change state,
                the same universal gate "Change Password"'s neighbors
                (Dashboard/My Profile) already use - a person mid-forced-
                change would just be bounced back to /change-password by
                ProtectedRoute anyway, so this avoids offering a link that
                cannot go anywhere else yet. */}
            {!user?.mustChangePassword && (
              <NavLink to="/help" className="help-icon-button" aria-label="Help Center">
                <HelpIcon />
              </NavLink>
            )}
            {/* DOC-77 - "Theme Switcher". Same universal, mustChangePassword-
                only gate as the Help control immediately above (visible to
                every authenticated role, including System Admin - there is
                nothing role-specific about appearance). Placed next to Help
                since both are compact, equally-weighted icon controls (task
                spec: "similar in importance/size to the existing Help/
                Notification controls"). */}
            {!user?.mustChangePassword && <ThemeToggleButton />}
            {/* DOC-18 - "In-App Notifications". Hidden during the same
                forced-password-change state as the dashboard/chat links
                above, for the identical reason: the notification API
                itself requires requirePasswordChangeCompleted, so showing
                a bell that could never actually load anything would only
                be confusing. NotificationBell independently hides itself
                for System Admin (no Request notification use case) - no
                extra role check is needed here. */}
            {!user?.mustChangePassword && <NotificationBell />}
            <button type="button" className="nav-link nav-link-button" onClick={handleLogout}>
              Logout
            </button>
          </>
        ) : (
          <>
            <NavLink to="/login" className={linkClass}>
              Login
            </NavLink>
            <NavLink to="/register" className={linkClass}>
              Register
            </NavLink>
            {/* DOC-77 - task spec section 28: "Theme preference is device/
                browser preference, not account data... do not require
                authentication." Available here too, before sign-in, since
                nothing about it depends on being logged in - unlike Help/
                Notifications, which only make sense once authenticated. */}
            <ThemeToggleButton />
          </>
        )}
      </nav>
    </header>
  );
}

export default Navbar;
