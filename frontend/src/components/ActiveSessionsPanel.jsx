import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { sessionApi } from '../services/api.js';
import getApiErrorMessage from '../utils/apiError.js';
import describeUserAgent from '../utils/userAgentLabel.js';
import { describeSessionStatus, sessionStatusTone } from '../utils/sessionStatusLabel.js';

// DOC-69 - "Login History & Active Sessions". Self-contained, the same
// "owns its own fetch/loading/error state" pattern
// AuditLogPanel.jsx/PasswordResetRequestsPanel.jsx/RequestActivityTimeline.jsx
// already establish in this project - dropped into Profile.jsx with zero
// new props/plumbing required from that page.
function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function SessionRow({ session, onRevoke, revokingId }) {
  const isRevoking = revokingId === session.id;
  return (
    <li className="session-item">
      <div className="session-item-main">
        <div className="session-item-header">
          <span className="session-device">{describeUserAgent(session.userAgent)}</span>
          {session.isCurrent && <span className="status-badge status-active">Current</span>}
          {!session.isCurrent && (
            <span className={`status-badge status-${sessionStatusTone(session)}`}>
              {describeSessionStatus(session)}
            </span>
          )}
        </div>
        <p className="session-detail">Login: {formatDateTime(session.createdAt)}</p>
        <p className="session-detail">Last active: {formatDateTime(session.lastActiveAt)}</p>
        {session.ipAddress && <p className="session-detail session-ip">IP: {session.ipAddress}</p>}
      </div>
      {/* Task spec section 14/21 - no revoke control on the CURRENT
          session here; a dedicated Logout already exists (Navbar.jsx) for
          ending it, the same "prevent it, provide separate Logout" choice
          the task spec's own example UI shows (Current Session -> [Current]
          only, no [Log out] button). */}
      {!session.isCurrent && session.status === 'ACTIVE' && (
        <button
          type="button"
          className="btn btn-outline btn-small"
          disabled={isRevoking}
          onClick={() => onRevoke(session.id)}
        >
          {isRevoking ? 'Logging out...' : 'Log out'}
        </button>
      )}
    </li>
  );
}

function ActiveSessionsPanel() {
  const { token, logout } = useAuth();
  const [sessions, setSessions] = useState(null); // null = not loaded yet
  const [error, setError] = useState('');

  const [revokingId, setRevokingId] = useState(null);
  const [revokeError, setRevokeError] = useState('');

  const [logoutOthersPending, setLogoutOthersPending] = useState(false);
  const [logoutOthersMessage, setLogoutOthersMessage] = useState('');
  const [logoutOthersError, setLogoutOthersError] = useState('');

  const [logoutAllPending, setLogoutAllPending] = useState(false);
  const [logoutAllError, setLogoutAllError] = useState('');

  const loadSessions = useCallback(async () => {
    setError('');
    try {
      const response = await sessionApi.list(token);
      setSessions(response.data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load your sessions. Please try again.'));
    }
  }, [token]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleRevoke = async (sessionId) => {
    setRevokeError('');
    setRevokingId(sessionId);
    try {
      // The backend always allows revoking the current session too (task
      // spec section 14) - this UI simply never offers the button for it
      // (see SessionRow above), so `response.data.isCurrent` is expected
      // to be `false` on every real call made from here. Refreshing the
      // list from the backend's own response afterward (rather than
      // guessing the new state locally) keeps this consistent with every
      // other mutation in this project.
      await sessionApi.revoke(sessionId, token);
      await loadSessions();
    } catch (err) {
      setRevokeError(getApiErrorMessage(err, 'Unable to log out that session. Please try again.'));
    } finally {
      setRevokingId(null);
    }
  };

  const handleLogoutOthers = async () => {
    setLogoutOthersError('');
    setLogoutOthersMessage('');
    setLogoutOthersPending(true);
    try {
      const response = await sessionApi.logoutOthers(token);
      const { revokedCount } = response.data;
      setLogoutOthersMessage(
        revokedCount > 0
          ? `Logged out of ${revokedCount} other session${revokedCount === 1 ? '' : 's'}.`
          : 'No other active sessions to log out.',
      );
      await loadSessions();
    } catch (err) {
      setLogoutOthersError(getApiErrorMessage(err, 'Unable to log out of other sessions. Please try again.'));
    } finally {
      setLogoutOthersPending(false);
    }
  };

  // Task spec section 16 - "logout-all" includes the CURRENT session, so a
  // successful call here means this exact browser is also now signed out
  // server-side. Reuses AuthContext's own `logout()` afterward purely to
  // clear the LOCAL token/state immediately (its own server-side call is a
  // harmless, already-revoked no-op at that point - see that function's
  // own try/catch) - this is the "immediately log the user out" behavior
  // task spec section 16 requires, with no separate navigate() call needed
  // here (ProtectedRoute reacts to `isAuthenticated` becoming false on its
  // own, the same pattern the automatic session-expiry handler already
  // uses).
  const handleLogoutAll = async () => {
    setLogoutAllError('');
    setLogoutAllPending(true);
    try {
      await sessionApi.logoutAll(token);
      await logout();
    } catch (err) {
      setLogoutAllError(getApiErrorMessage(err, 'Unable to log out of all sessions. Please try again.'));
      setLogoutAllPending(false);
    }
  };

  if (sessions === null && !error) {
    return (
      <div className="card admin-panel session-panel">
        <h2>Security / Active Sessions</h2>
        <p className="auth-subtitle">Loading your sessions...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card admin-panel session-panel">
        <h2>Security / Active Sessions</h2>
        <p className="form-error form-error-server">{error}</p>
      </div>
    );
  }

  const activeSessions = sessions.filter((session) => session.status === 'ACTIVE');
  const currentSession = activeSessions.find((session) => session.isCurrent) || null;
  const otherActiveSessions = activeSessions.filter((session) => !session.isCurrent);

  return (
    <div className="card admin-panel session-panel">
      <h2>Security / Active Sessions</h2>
      <p className="field-hint">
        See where you&apos;re logged in, and log out of any session that isn&apos;t you.
      </p>

      {currentSession && (
        <ul className="session-list">
          <SessionRow session={currentSession} onRevoke={handleRevoke} revokingId={revokingId} />
        </ul>
      )}

      <h3 className="session-subheading">Other Sessions</h3>
      {revokeError && <p className="form-error">{revokeError}</p>}
      {otherActiveSessions.length === 0 ? (
        <p className="auth-subtitle">You&apos;re not logged in anywhere else.</p>
      ) : (
        <>
          <ul className="session-list">
            {otherActiveSessions.map((session) => (
              <SessionRow key={session.id} session={session} onRevoke={handleRevoke} revokingId={revokingId} />
            ))}
          </ul>
          <div className="form-actions form-actions-row">
            <button
              type="button"
              className="btn btn-outline"
              disabled={logoutOthersPending}
              onClick={handleLogoutOthers}
            >
              {logoutOthersPending ? 'Logging out...' : 'Log out of all other sessions'}
            </button>
          </div>
          {logoutOthersMessage && <p className="form-success">{logoutOthersMessage}</p>}
          {logoutOthersError && <p className="form-error">{logoutOthersError}</p>}
        </>
      )}

      <div className="form-actions form-actions-row session-logout-all">
        <button
          type="button"
          className="btn btn-outline"
          disabled={logoutAllPending}
          onClick={handleLogoutAll}
        >
          {logoutAllPending ? 'Logging out...' : 'Log out of all sessions'}
        </button>
      </div>
      {logoutAllError && <p className="form-error">{logoutAllError}</p>}

      <h3 className="session-subheading">Recent Login History</h3>
      {sessions.length === 0 ? (
        <p className="auth-subtitle">No login history yet.</p>
      ) : (
        <ul className="session-list session-history-list">
          {sessions.map((session) => (
            <li key={session.id} className="session-item session-history-item">
              <span className="session-device">{describeUserAgent(session.userAgent)}</span>
              <span className="session-detail">{formatDateTime(session.createdAt)}</span>
              <span className={`status-badge status-${sessionStatusTone(session)}`}>
                {describeSessionStatus(session)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ActiveSessionsPanel;
