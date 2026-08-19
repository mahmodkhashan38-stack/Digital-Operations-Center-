import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { notificationApi } from '../services/api.js';
import { destinationForRole } from '../utils/roleRoutes.js';

// DOC-18 - "In-App Notifications". Mounted once inside Navbar.jsx (which
// is itself mounted once at the top of App.jsx, outside every <Route> -
// see App.jsx) so this bell is present on every page while authenticated,
// exactly like the rest of the Navbar. Self-contained: it reads
// `token`/`user` from `useAuth()` and calls the backend itself, the same
// "own its own data" shape RequestActivityTimeline.jsx (DOC-17) and
// AuthenticatedRequestImage.jsx already established - Navbar itself needs
// no new state or props for this feature.
//
// POLLING (task spec section 31 - "prefer simple polling rather than
// WebSockets... unread count: every 15-30 seconds... notification list:
// fetch when panel opens and optionally refresh while open... do not poll
// every second"). Reuses OrganizationChat.jsx's own established polling
// shape (a single `setInterval` + an in-flight guard ref, cleared on
// unmount) rather than inventing a second convention: ONE interval, every
// 20 seconds, always refreshes the unread count (cheap - a single
// `countDocuments`), and ALSO refreshes the open panel's notification list
// on the same tick, but only while the panel is actually open - never a
// second, separate interval. Because this whole component is only ever
// mounted while `isAuthenticated` (see Navbar.jsx's own conditional
// render), the interval is automatically created on login and cleared on
// logout/unmount by this effect's own cleanup function - no separate
// "stop polling on logout" code path is needed.
const POLL_INTERVAL_MS = 20000;
const LIST_LIMIT = 20;

function formatRelativeTime(value) {
  if (!value) return '';
  const target = new Date(value);
  const diffMs = Date.now() - target.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return target.toLocaleDateString();
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function NotificationBell() {
  const { user, token, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [isOpen, setIsOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState(null); // null = not loaded yet
  const [listError, setListError] = useState('');
  const [markAllPending, setMarkAllPending] = useState(false);

  const panelRef = useRef(null);
  const fetchInFlightRef = useRef(false);
  const isOpenRef = useRef(false);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const loadUnreadCount = async () => {
    try {
      const response = await notificationApi.getUnreadCount(token);
      setUnreadCount(response.data.unreadCount);
    } catch (error) {
      // Silent/non-blocking, exactly like OrganizationChat's own poll-tick
      // failure handling - a single failed tick never surfaces an error
      // banner; the next tick simply tries again.
    }
  };

  const loadNotifications = async () => {
    setListError('');
    try {
      const response = await notificationApi.list(token, { limit: LIST_LIMIT });
      setNotifications(response.data);
    } catch (error) {
      setListError(error.message);
    }
  };

  // Initial unread-count fetch on mount (i.e. immediately on login, since
  // this component only ever mounts while authenticated).
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    loadUnreadCount();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token]);

  // The single polling interval described in this file's own top comment.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const intervalId = setInterval(async () => {
      if (fetchInFlightRef.current) return;
      fetchInFlightRef.current = true;
      try {
        await loadUnreadCount();
        if (isOpenRef.current) {
          await loadNotifications();
        }
      } finally {
        fetchInFlightRef.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token]);

  // Close the panel when clicking anywhere outside it - standard dropdown
  // behavior; only attached while the panel is actually open.
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const togglePanel = () => {
    const next = !isOpen;
    setIsOpen(next);
    // Task spec section 29/31 - the list is fetched when the panel opens,
    // not upfront on every page load (unread count alone is cheap enough
    // to poll always; the full list is only ever fetched on demand).
    if (next) {
      loadNotifications();
    }
  };

  const handleMarkOneRead = async (notification, event) => {
    event.stopPropagation();
    if (notification.readAt) return;
    try {
      await notificationApi.markRead(notification.id, token);
      setNotifications((prev) => (prev || []).map((item) => (
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item
      )));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (error) {
      // Non-blocking - the notification simply stays visually unread; the
      // next poll/open will reflect the real server state either way.
    }
  };

  const handleMarkAllRead = async () => {
    setMarkAllPending(true);
    try {
      await notificationApi.markAllRead(token);
      setNotifications((prev) => (prev || []).map((item) => (
        item.readAt ? item : { ...item, readAt: new Date().toISOString() }
      )));
      setUnreadCount(0);
    } catch (error) {
      // Non-blocking - same reasoning as handleMarkOneRead above.
    } finally {
      setMarkAllPending(false);
    }
  };

  // Click behavior (task spec section 30): mark read, then navigate to the
  // relevant Request context. This application has no standalone Request
  // URL (every Request is viewed inline inside a role's own dashboard
  // table - see RequestRow.jsx/ManagerRequestRow.jsx) and no query-param
  // deep-link mechanism for "open this one row" - inventing either would
  // mean rewriting routing, which task spec explicitly says not to do
  // ("If the application does not have standalone Request URLs, use the
  // existing dashboard/modal mechanism rather than rewriting routing").
  // The existing, safest mechanism is therefore the same one every
  // dashboard link already uses: send the caller to THEIR OWN role's
  // dashboard (utils/roleRoutes.js's own `destinationForRole`, the exact
  // function Navbar.jsx/ProtectedRoute.jsx already use for this) - an
  // Employee always lands in Employee-visible Request context, an
  // Operator in Operator-visible context, a Manager in Manager-visible
  // context, and the Request's own title (already shown in the
  // notification) is enough to find it in that dashboard's existing
  // search/filter controls (DOC-54).
  const handleNotificationClick = async (notification) => {
    if (!notification.readAt) {
      try {
        await notificationApi.markRead(notification.id, token);
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch (error) {
        // Non-blocking - navigation still proceeds even if the mark-read
        // call itself failed; the notification will simply still show as
        // unread next time.
      }
    }
    setIsOpen(false);
    if (notification.requestId) {
      navigate(destinationForRole(user?.role));
    }
  };

  // Task spec section 28: hidden for an unauthenticated guest (this
  // component is only ever rendered inside Navbar's own `isAuthenticated`
  // branch - see Navbar.jsx) and for System Admin, which has no Request
  // operational notification use case at all in this version (task spec
  // section 8: "System Admin: No Request operational notifications") -
  // hiding the bell entirely (rather than showing an always-empty one) is
  // the clearer signal that this feature simply does not apply to that
  // role, the same choice already made for the Organization Chat link.
  if (!isAuthenticated || user?.role === 'system_admin') {
    return null;
  }

  const displayCount = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <div className="notification-bell" ref={panelRef}>
      <button
        type="button"
        className="notification-bell-button"
        onClick={togglePanel}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      >
        <BellIcon />
        {unreadCount > 0 && <span className="notification-badge">{displayCount}</span>}
      </button>

      {isOpen && (
        <div className="notification-panel" role="dialog" aria-label="Notifications">
          <div className="notification-panel-header">
            <span className="notification-panel-title">Notifications</span>
            <button
              type="button"
              className="notification-mark-all-btn"
              onClick={handleMarkAllRead}
              disabled={markAllPending || unreadCount === 0}
            >
              {markAllPending ? 'Marking...' : 'Mark All as Read'}
            </button>
          </div>

          <div className="notification-list-wrapper">
            {notifications === null && !listError && (
              <p className="auth-subtitle notification-panel-message">Loading notifications...</p>
            )}
            {listError && (
              <p className="form-error form-error-server notification-panel-message">{listError}</p>
            )}
            {notifications !== null && !listError && notifications.length === 0 && (
              <p className="auth-subtitle notification-panel-message">No notifications yet.</p>
            )}
            {notifications !== null && !listError && notifications.length > 0 && (
              <ul className="notification-list">
                {notifications.map((notification) => (
                  <li
                    key={notification.id}
                    className={notification.readAt ? 'notification-item' : 'notification-item notification-item-unread'}
                  >
                    <button
                      type="button"
                      className="notification-item-button"
                      onClick={() => handleNotificationClick(notification)}
                    >
                      <span className="notification-item-title">{notification.title}</span>
                      <span className="notification-item-message">{notification.message}</span>
                      <span className="notification-item-time">{formatRelativeTime(notification.createdAt)}</span>
                    </button>
                    {!notification.readAt && (
                      <button
                        type="button"
                        className="notification-item-mark-read"
                        onClick={(event) => handleMarkOneRead(notification, event)}
                        title="Mark as read"
                        aria-label="Mark as read"
                      >
                        ✓
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
