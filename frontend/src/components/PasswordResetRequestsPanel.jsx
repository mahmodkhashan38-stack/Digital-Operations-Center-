import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { userApi } from '../services/api.js';
import { roleLabel } from '../utils/roleRoutes.js';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../utils/validation.js';
import getApiErrorMessage from '../utils/apiError.js';

// DOC-70 - "Forgot Password / Password Recovery via Manager Approval".
// Self-contained, own fetch/loading/error/empty state - the same pattern
// AuditLogPanel.jsx (DOC-64) already established for a Manager-Dashboard
// panel that owns its own data lifecycle independently of the rest of the
// page. The backend (routes/user.routes.js) is the real Manager-only,
// own-Organization boundary - this component never filters results
// client-side to fake that.
//
// APPROVAL UX (task spec section 12/15): "Approve" reuses the EXACT same
// new-password + confirm-password form OrganizationUserRow.jsx's existing
// "Reset Password" panel already uses (same validation constants, same
// field shapes) - because approving IS a Manager Reset Password under the
// hood (userApi.approvePasswordResetRequest -> the backend's
// performPasswordReset, shared with the direct reset endpoint). There is
// no second, different-looking reset UI anywhere in this app.
const STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function PasswordResetRequestRow({ request, onApprove, onReject }) {
  const [showApprove, setShowApprove] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [approvePending, setApprovePending] = useState(false);
  const [approveError, setApproveError] = useState('');
  const [approveSuccessMessage, setApproveSuccessMessage] = useState('');

  const [rejectPending, setRejectPending] = useState(false);
  const [rowError, setRowError] = useState('');

  const openApprove = () => {
    setRowError('');
    setApproveError('');
    setApproveSuccessMessage('');
    setNewPassword('');
    setConfirmPassword('');
    setShowApprove(true);
  };

  const closeApprove = () => {
    setShowApprove(false);
    setNewPassword('');
    setConfirmPassword('');
    setApproveError('');
    setApproveSuccessMessage('');
  };

  const handleApproveSubmit = async (event) => {
    event.preventDefault();
    setApproveError('');
    setApproveSuccessMessage('');

    if (!newPassword || !confirmPassword) {
      setApproveError('New password and confirmation are both required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setApproveError('Passwords do not match.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setApproveError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword.length > MAX_PASSWORD_LENGTH) {
      setApproveError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
      return;
    }

    setApprovePending(true);
    try {
      await onApprove(request, { newPassword, confirmPassword });
      // Task spec: never display the password again after success, never
      // log it - discarded right here, exactly like OrganizationUserRow's
      // own Reset Password panel already does.
      setNewPassword('');
      setConfirmPassword('');
      setApproveSuccessMessage('Password reset successfully. The user must change it at their next login.');
    } catch (err) {
      setApproveError(getApiErrorMessage(err, 'Unable to approve this request. Please try again.'));
    } finally {
      setApprovePending(false);
    }
  };

  const handleReject = async () => {
    setRowError('');
    setRejectPending(true);
    try {
      await onReject(request);
    } catch (err) {
      setRowError(getApiErrorMessage(err, 'Unable to reject this request. Please try again.'));
    } finally {
      setRejectPending(false);
    }
  };

  if (showApprove) {
    return (
      <tr>
        <td colSpan={5}>
          <div className="user-row-edit-form">
            <p className="user-row-edit-title">Approve Password Reset for {request.user.fullName}</p>

            {approveSuccessMessage ? (
              <>
                <p className="form-success">{approveSuccessMessage}</p>
                <div className="form-actions form-actions-row">
                  <button type="button" className="btn btn-outline" onClick={closeApprove}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={handleApproveSubmit} noValidate>
                <div className="user-row-edit-fields">
                  <div className="form-group user-row-edit-field">
                    <label htmlFor={`prr-new-password-${request.id}`}>New Password</label>
                    <input
                      id={`prr-new-password-${request.id}`}
                      name="newPassword"
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      disabled={approvePending}
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="form-group user-row-edit-field">
                    <label htmlFor={`prr-confirm-password-${request.id}`}>Confirm Password</label>
                    <input
                      id={`prr-confirm-password-${request.id}`}
                      name="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      disabled={approvePending}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                {approveError && <span className="form-error">{approveError}</span>}
                <div className="form-actions form-actions-row">
                  <button type="submit" className="btn btn-primary" disabled={approvePending}>
                    {approvePending ? 'Approving...' : 'Approve & Reset Password'}
                  </button>
                  <button type="button" className="btn btn-outline" onClick={closeApprove} disabled={approvePending}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{request.user.fullName}</td>
      <td>{request.user.email}</td>
      <td>{request.user.role ? roleLabel(request.user.role) : '-'}</td>
      <td>{formatDateTime(request.requestedAt)}</td>
      <td className="user-table-action-cell">
        <span className={`status-badge status-password-reset-${request.status}`}>
          {STATUS_LABELS[request.status] || request.status}
        </span>
        {request.status === 'pending' && (
          <div className="user-table-action-group">
            <button type="button" className="btn btn-outline" onClick={openApprove}>
              Approve / Reset
            </button>
            <button type="button" className="btn btn-outline" disabled={rejectPending} onClick={handleReject}>
              {rejectPending ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        )}
        {request.status !== 'pending' && request.reviewedBy && (
          <p className="timeline-detail">
            {STATUS_LABELS[request.status] || request.status} by {request.reviewedBy.fullName} on {formatDateTime(request.reviewedAt)}
          </p>
        )}
        {rowError && <span className="form-error">{rowError}</span>}
      </td>
    </tr>
  );
}

function PasswordResetRequestsPanel() {
  const { token } = useAuth();

  const [requests, setRequests] = useState(null); // null = not loaded yet
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const loadRequests = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      // No `status` filter (task spec section 20 - the Manager should be
      // able to see recent history, not just a queue that disappears the
      // moment it's acted on) - every request for this Organization,
      // newest first; pending ones are visually distinguished by their
      // badge and are the only ones with action buttons.
      const response = await userApi.listPasswordResetRequests(token);
      setRequests(response.data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load password reset requests. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const replaceRequest = (updated) => {
    setRequests((prev) => (prev || []).map((request) => (request.id === updated.id ? updated : request)));
  };

  const handleApprove = async (request, payload) => {
    const response = await userApi.approvePasswordResetRequest(request.id, payload, token);
    replaceRequest(response.data);
    return response.data;
  };

  const handleReject = async (request) => {
    const response = await userApi.rejectPasswordResetRequest(request.id, token);
    replaceRequest(response.data);
    return response.data;
  };

  const pendingCount = (requests || []).filter((request) => request.status === 'pending').length;

  return (
    <div className="card admin-panel password-reset-requests-panel">
      <h2>Password Reset Requests {requests !== null && pendingCount > 0 && `(${pendingCount} pending)`}</h2>
      <p className="auth-subtitle">
        Employees and Operators who cannot sign in can request a password reset here - no email is sent.
        Review each request below and either approve it (choosing a new password for them) or reject it.
      </p>

      {isLoading && requests === null && (
        <p className="auth-subtitle">Loading password reset requests...</p>
      )}
      {error && <p className="form-error form-error-server">{error}</p>}
      {!isLoading && !error && requests !== null && requests.length === 0 && (
        <p className="auth-subtitle">No pending password reset requests.</p>
      )}

      {requests !== null && !error && requests.length > 0 && (
        <div className="user-table-wrapper">
          <table className="user-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Requested</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <PasswordResetRequestRow
                  key={request.id}
                  request={request}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PasswordResetRequestsPanel;
