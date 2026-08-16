import { useState } from 'react';
import RequestStatusBadge from './RequestStatusBadge.jsx';
import RequestSlaBadge from './RequestSlaBadge.jsx';
import AuthenticatedRequestImage from './AuthenticatedRequestImage.jsx';

// DOC-52 - one row in the Manager Dashboard's new "Organization Requests"
// table. Deliberately a SEPARATE small component from RequestRow.jsx
// rather than another mode bolted onto it: the task spec's own section 1
// asks for Title/Employee/Category/Priority/Status/Assigned
// Operator/Created date as directly visible table columns (not hidden
// behind a "View Details" toggle the way Employee/Operator's Category/
// Priority/Assigned Operator already are). Reusing RequestRow would mean
// threading a third role's worth of conditional rendering through a
// component that already carries Employee- and Operator-specific logic;
// a focused row is the smaller, clearer change.
//
// `eligibleOperators` is computed by the parent (ManagerDashboard.jsx)
// from its own already-loaded `users` list, filtered to this specific
// Request's CURRENT category (task spec section 2: same Organization,
// role === 'operator', isActive === true, specialties contains this
// Request's category) - purely a UI convenience for the original DOC-52
// inline Assign/Reassign form below, kept completely unchanged. The
// backend (assignRequestOperator) is the sole authority and re-validates
// every one of those same rules independently regardless of what this row
// offers.
//
// DOC-56 - "Operator Completion Proof Images". Adds a fifth, purely
// read-only action: "View Images" / "Hide Images", toggling a new row
// that shows BOTH galleries side by side - `request.attachments`
// ("Before Images", DOC-45) and `request.completionAttachments` ("After
// Images", DOC-56) - exactly like RequestRow.jsx's Employee-facing
// rendering, but with no Add/Remove control of any kind on either
// gallery (task spec: "MANAGER can: view. download. Never edit. Never
// remove."). This is intentionally the SAME "toggle reveals a detail
// row" shape RequestRow.jsx's own "View Details" already uses, not a
// modal or a second component - the smallest addition that fits this
// row's existing structure.
//
// Sprint 4 (DOC-59) - "Manager Request Administration" adds four more
// actions to this same row: Edit (priority/category/assigned operator,
// combined), Remove Operator, Cancel Request (with a required reason),
// and Close Request (resolved -> closed). These are ADDITIVE - the
// original DOC-52 Assign/Reassign form above is left completely as-is,
// on purpose, rather than folding operator assignment entirely into the
// new Edit panel: DOC-59 explicitly asks not to modify already-completed
// functionality unless strictly required, and the two paths are not in
// conflict (both ultimately go through the backend's own independent
// re-validation).
const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };
const PRIORITY_VALUES = ['low', 'medium', 'high'];

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function ManagerRequestRow({
  request,
  eligibleOperators,
  onAssignOperator,
  categories,
  activeOperators,
  onManagerUpdate,
  onManagerCancel,
  onManagerClose,
}) {
  const [selectedOperatorId, setSelectedOperatorId] = useState('');
  const [assignPending, setAssignPending] = useState(false);
  const [assignError, setAssignError] = useState('');

  // DOC-56 - purely a local UI toggle, never a network call (both
  // galleries are already present on `request` itself - sanitizeRequest
  // always includes `attachments`/`completionAttachments`).
  const [showImages, setShowImages] = useState(false);

  // Task spec section 5: assignment (first-time or replacing an existing
  // Operator) is only ever possible while the Request is still 'open' -
  // the backend independently enforces the exact same rule with its own
  // 409, this is only the UI's reflection of it.
  const canAssign = request.status === 'open' && typeof onAssignOperator === 'function';

  const handleAssign = async (event) => {
    event.preventDefault();
    setAssignError('');
    if (!selectedOperatorId) {
      setAssignError('Select an operator first.');
      return;
    }
    setAssignPending(true);
    try {
      await onAssignOperator(request, selectedOperatorId);
      setSelectedOperatorId('');
    } catch (error) {
      // Failed: nothing about `request` has changed here - the backend's
      // own client-safe error message is shown inline, no fake success.
      setAssignError(error.message);
    } finally {
      setAssignPending(false);
    }
  };

  // --- Sprint 4 (DOC-59) - Manager Request Administration ------------------
  // `mode` gates which single panel (if any) is open below the main row -
  // 'edit' | 'cancel' | 'removeOperator' | null. Mutually exclusive, the
  // same shape OrganizationUserRow's confirm panels already use.
  const [mode, setMode] = useState(null);

  const isTerminal = request.status === 'closed' || request.status === 'cancelled';
  const canCancel = !isTerminal && typeof onManagerCancel === 'function';
  const canClose = request.status === 'resolved' && typeof onManagerClose === 'function';
  const canRemoveOperator = request.status === 'open' && !!request.assignedOperator && typeof onManagerUpdate === 'function';
  const canEdit = !isTerminal && typeof onManagerUpdate === 'function';

  // --- Edit panel (priority / category / assigned operator) ---
  const [editPriority, setEditPriority] = useState(request.priority);
  const [editCategoryId, setEditCategoryId] = useState(request.category ? request.category.id : '');
  const [editOperatorId, setEditOperatorId] = useState(request.assignedOperator ? request.assignedOperator.id : '');
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState('');

  const openEdit = () => {
    setEditPriority(request.priority);
    setEditCategoryId(request.category ? request.category.id : '');
    setEditOperatorId(request.assignedOperator ? request.assignedOperator.id : '');
    setEditError('');
    setMode('edit');
  };

  // Recomputed against whichever category is currently SELECTED in the
  // panel (not necessarily the Request's saved category yet) - so
  // changing the category dropdown immediately narrows the operator
  // dropdown to specialty-matching Operators for that new category, the
  // same rule the backend enforces independently.
  const eligibleOperatorsForEdit = (activeOperators || []).filter(
    (operator) => (operator.specialties || []).some((specialty) => specialty.id === editCategoryId),
  );

  const handleSaveEdit = async (event) => {
    event.preventDefault();
    setEditError('');

    const originalOperatorId = request.assignedOperator ? request.assignedOperator.id : '';
    const originalCategoryId = request.category ? request.category.id : '';

    // Only fields the Manager actually changed are sent - this is what
    // lets a priority-only edit succeed even while the Request is not
    // 'open' (which would otherwise make an unrelated, unchanged operator
    // field look like an illegal reassignment attempt to the backend).
    const updates = {};
    if (editPriority !== request.priority) {
      updates.priority = editPriority;
    }
    if (editCategoryId && editCategoryId !== originalCategoryId) {
      updates.categoryId = editCategoryId;
    }
    if (editOperatorId !== originalOperatorId) {
      updates.assignedOperatorId = editOperatorId || null;
    }

    if (Object.keys(updates).length === 0) {
      setEditError('No changes to save.');
      return;
    }

    setEditPending(true);
    try {
      await onManagerUpdate(request, updates);
      setMode(null);
    } catch (error) {
      setEditError(error.message);
    } finally {
      setEditPending(false);
    }
  };

  // --- Remove Operator ---
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const handleConfirmRemoveOperator = async () => {
    setRemoveError('');
    setRemovePending(true);
    try {
      await onManagerUpdate(request, { assignedOperatorId: null });
      setMode(null);
    } catch (error) {
      setRemoveError(error.message);
    } finally {
      setRemovePending(false);
    }
  };

  // --- Cancel Request ---
  const [cancelReason, setCancelReason] = useState('');
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState('');

  const handleConfirmCancel = async (event) => {
    event.preventDefault();
    setCancelError('');
    if (!cancelReason.trim()) {
      setCancelError('A cancellation reason is required.');
      return;
    }
    setCancelPending(true);
    try {
      await onManagerCancel(request, cancelReason.trim());
      setMode(null);
      setCancelReason('');
    } catch (error) {
      setCancelError(error.message);
    } finally {
      setCancelPending(false);
    }
  };

  // --- Close Request (no confirmation dialog - single, low-risk, reversible-by-nobody-but-explicit action) ---
  const [closePending, setClosePending] = useState(false);
  const [closeError, setCloseError] = useState('');

  const handleClose = async () => {
    setCloseError('');
    setClosePending(true);
    try {
      await onManagerClose(request);
    } catch (error) {
      setCloseError(error.message);
    } finally {
      setClosePending(false);
    }
  };

  const closePanel = () => {
    setMode(null);
    setEditError('');
    setRemoveError('');
    setCancelError('');
    setCancelReason('');
  };

  return (
    <>
      <tr>
        <td>{request.title}</td>
        <td>{request.employee ? request.employee.fullName : 'Unknown employee'}</td>
        <td>{request.category ? request.category.name : 'Unknown category'}</td>
        <td>{PRIORITY_LABELS[request.priority] || request.priority}</td>
        <td>
          <RequestStatusBadge status={request.status} />
        </td>
        {/* DOC-55 - "Request SLA and Due Dates". Due date, badge, and
            remaining/overdue time all come from RequestSlaBadge, which
            only ever reads the already-sanitized `sla` object this row
            received - never a local recalculation. */}
        <td>
          <RequestSlaBadge sla={request.sla} status={request.status} />
        </td>
        {/* Task spec section 13: "Manager must always see: assigned Operator
            or Unassigned" - shown as plain text here regardless of whether
            assignment is currently possible. */}
        <td>{request.assignedOperator ? request.assignedOperator.fullName : 'Unassigned'}</td>
        <td>{formatDateTime(request.createdAt)}</td>
        <td className="user-table-action-cell">
          {canAssign ? (
            <form className="assign-operator-form" onSubmit={handleAssign}>
              <select
                value={selectedOperatorId}
                onChange={(event) => setSelectedOperatorId(event.target.value)}
                disabled={assignPending}
              >
                <option value="">Select operator...</option>
                {(eligibleOperators || []).map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.fullName}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={assignPending || !selectedOperatorId}
              >
                {assignPending ? 'Assigning...' : request.assignedOperator ? 'Reassign' : 'Assign'}
              </button>
              {(eligibleOperators || []).length === 0 && (
                <p className="auth-subtitle">No eligible operators for this category.</p>
              )}
            </form>
          ) : (
            <span className="auth-subtitle">
              {typeof onAssignOperator === 'function' ? `Not editable (${request.status})` : '-'}
            </span>
          )}
          {assignError && <span className="form-error">{assignError}</span>}

          {/* Sprint 4 (DOC-59) - only actions that are currently legal for
              this Request's status are ever shown. */}
          <div className="manager-request-actions">
            {/* DOC-56 - always available regardless of status (task spec:
                Manager can always view/download both galleries, read
                only). */}
            <button type="button" className="btn btn-outline" onClick={() => setShowImages((prev) => !prev)}>
              {showImages ? 'Hide Images' : 'View Images'}
            </button>
            {canEdit && mode !== 'edit' && (
              <button type="button" className="btn btn-outline" onClick={openEdit}>
                Edit
              </button>
            )}
            {canRemoveOperator && mode !== 'removeOperator' && (
              <button type="button" className="btn btn-outline" onClick={() => setMode('removeOperator')}>
                Remove Operator
              </button>
            )}
            {canClose && (
              <button type="button" className="btn btn-primary" onClick={handleClose} disabled={closePending}>
                {closePending ? 'Closing...' : 'Close Request'}
              </button>
            )}
            {canCancel && mode !== 'cancel' && (
              <button type="button" className="btn btn-outline" onClick={() => setMode('cancel')}>
                Cancel Request
              </button>
            )}
          </div>
          {closeError && <span className="form-error">{closeError}</span>}
        </td>
      </tr>

      {/* DOC-56 - "Manager shows both galleries. Read only." Same two-
          gallery layout RequestRow.jsx's Employee view uses (Before
          Images / After Images), with no Add/Remove control on either
          one - Manager can only view/download. */}
      {showImages && (
        <tr>
          <td colSpan={8}>
            <div className="request-detail-panel">
              <div className="request-attachments">
                <span className="stat-label">Before Images</span>
                {(!request.attachments || request.attachments.length === 0) && (
                  <p className="auth-subtitle">No images attached.</p>
                )}
                {request.attachments && request.attachments.length > 0 && (
                  <ul className="attachment-gallery">
                    {request.attachments.map((attachment) => (
                      <li key={attachment.id} className="attachment-item">
                        <AuthenticatedRequestImage url={attachment.url} alt={attachment.originalName} />
                        <span className="attachment-caption">{attachment.originalName}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="request-attachments">
                <span className="stat-label">After Images</span>
                {(!request.completionAttachments || request.completionAttachments.length === 0) && (
                  <p className="auth-subtitle">No completion images yet.</p>
                )}
                {request.completionAttachments && request.completionAttachments.length > 0 && (
                  <ul className="attachment-gallery">
                    {request.completionAttachments.map((attachment) => (
                      <li key={attachment.id} className="attachment-item">
                        <AuthenticatedRequestImage url={attachment.url} alt={attachment.originalName} />
                        <span className="attachment-caption">{attachment.originalName}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}

      {mode === 'edit' && (
        <tr>
          <td colSpan={8}>
            <form className="cancel-confirm-panel" onSubmit={handleSaveEdit}>
              <p>Edit this request&apos;s priority, category, and/or assigned operator.</p>
              <div className="form-group">
                <label htmlFor={`edit-priority-${request.id}`}>Priority</label>
                <select
                  id={`edit-priority-${request.id}`}
                  value={editPriority}
                  onChange={(event) => setEditPriority(event.target.value)}
                  disabled={editPending}
                >
                  {PRIORITY_VALUES.map((value) => (
                    <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor={`edit-category-${request.id}`}>Category</label>
                <select
                  id={`edit-category-${request.id}`}
                  value={editCategoryId}
                  onChange={(event) => { setEditCategoryId(event.target.value); setEditOperatorId(''); }}
                  disabled={editPending}
                >
                  {(categories || []).map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor={`edit-operator-${request.id}`}>Assigned Operator</label>
                <select
                  id={`edit-operator-${request.id}`}
                  value={editOperatorId}
                  onChange={(event) => setEditOperatorId(event.target.value)}
                  disabled={editPending || request.status !== 'open'}
                >
                  <option value="">Unassigned</option>
                  {eligibleOperatorsForEdit.map((operator) => (
                    <option key={operator.id} value={operator.id}>{operator.fullName}</option>
                  ))}
                </select>
                {request.status !== 'open' && (
                  <p className="form-hint">Assigned operator can only be changed while the request is open.</p>
                )}
              </div>
              {editError && <p className="form-error form-error-server">{editError}</p>}
              <div className="form-actions form-actions-row">
                <button type="submit" className="btn btn-primary" disabled={editPending}>
                  {editPending ? 'Saving...' : 'Save Changes'}
                </button>
                <button type="button" className="btn btn-outline" onClick={closePanel} disabled={editPending}>
                  Cancel
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}

      {mode === 'removeOperator' && (
        <tr>
          <td colSpan={8}>
            <div className="cancel-confirm-panel">
              <p>
                Remove <strong>{request.assignedOperator?.fullName}</strong> from this request? It will
                become unassigned and open for reassignment.
              </p>
              {removeError && <p className="form-error form-error-server">{removeError}</p>}
              <div className="form-actions form-actions-row">
                <button type="button" className="btn btn-outline" onClick={closePanel} disabled={removePending}>
                  Keep Operator
                </button>
                <button type="button" className="btn btn-primary" onClick={handleConfirmRemoveOperator} disabled={removePending}>
                  {removePending ? 'Removing...' : 'Remove Operator'}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}

      {mode === 'cancel' && (
        <tr>
          <td colSpan={8}>
            <form className="cancel-confirm-panel" onSubmit={handleConfirmCancel}>
              <p>Cancel this request? This cannot be undone - a reason is required.</p>
              <div className="form-group">
                <label htmlFor={`cancel-reason-${request.id}`}>Cancellation Reason</label>
                <textarea
                  id={`cancel-reason-${request.id}`}
                  rows={3}
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  disabled={cancelPending}
                  placeholder="e.g. Duplicate of another request, no longer needed..."
                />
              </div>
              {cancelError && <p className="form-error form-error-server">{cancelError}</p>}
              <div className="form-actions form-actions-row">
                <button type="button" className="btn btn-outline" onClick={closePanel} disabled={cancelPending}>
                  Keep Request
                </button>
                <button type="submit" className="btn btn-primary" disabled={cancelPending}>
                  {cancelPending ? 'Cancelling...' : 'Cancel Request'}
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

export default ManagerRequestRow;
