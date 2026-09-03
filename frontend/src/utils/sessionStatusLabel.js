// DOC-69 - "Login History & Active Sessions" (task spec section 24 -
// "Centralize logic"). The backend already classifies every session into
// exactly one of three states (ACTIVE / REVOKED / EXPIRED - see
// backend/src/services/userSession.service.js's own `classifySessionStatus`,
// the ONE place that computation happens server-side). This is the
// matching ONE place a `{ status, revokedReason }` pair is ever turned
// into the label a person actually reads - every session list in this
// project's frontend routes through this function, so "what does REVOKED
// even mean here" can never be worded two different ways in two different
// components.
//
// `revokedReason` is always one of the backend's own controlled enum
// values (models/UserSession.js's REVOKE_REASONS) - task spec section 24:
// "If revokedReason is shown, expose only controlled values." This
// function's own switch is itself that allowlist on the frontend side: an
// unrecognized/missing reason falls back to the generic "Logged out"
// rather than ever displaying a raw string.
const REVOKED_REASON_LABELS = {
  LOGOUT: 'Logged out',
  USER_REVOKED: 'Logged out (revoked)',
  LOGOUT_OTHERS: 'Logged out (other sessions)',
  LOGOUT_ALL: 'Logged out (all sessions)',
  PASSWORD_CHANGED: 'Logged out (password changed)',
  PASSWORD_RESET: 'Logged out (password reset)',
  USER_DEACTIVATED: 'Logged out (account deactivated)',
};

export function describeSessionStatus(session) {
  if (session.status === 'ACTIVE') {
    return 'Active';
  }
  if (session.status === 'EXPIRED') {
    return 'Expired';
  }
  // REVOKED
  return REVOKED_REASON_LABELS[session.revokedReason] || 'Logged out';
}

// A small, CSS-only badge tone - reuses this project's existing
// StatusBadge visual language (active = positive, everything else =
// neutral/muted) rather than inventing a third color scheme just for this
// one panel.
export function sessionStatusTone(session) {
  return session.status === 'ACTIVE' ? 'active' : 'inactive';
}

export default describeSessionStatus;
