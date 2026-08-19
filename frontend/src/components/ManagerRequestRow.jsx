import { useState } from 'react';
import RequestStatusBadge from './RequestStatusBadge.jsx';
import RequestSlaBadge from './RequestSlaBadge.jsx';
import RequestNumberBadge from './RequestNumberBadge.jsx';
import AuthenticatedRequestImage from './AuthenticatedRequestImage.jsx';
import RequestActivityTimeline from './RequestActivityTimeline.jsx';
import { PRIORITY_LABELS } from '../utils/requestLabels.js';

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
// DOC-69 - PRIORITY_LABELS now imported from utils/requestLabels.js (see
// that file's own comment) instead of being redeclared here.
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

  // --- Sprint 4 (DOC-59) / DOC-15 - `mode` gates which single panel (if
  // any) is open below the main row - 'edit' | 'cancel' | 'removeOperator'
  // | 'reassign' | null. Mutually exclusive, the same shape
  // OrganizationUserRow's confirm panels already use. Declared here
  // (rather than down with the rest of the DOC-59 panel state) because
  // DOC-15's reassignment confirmation (below) needs to open it too.
  const [mode, setMode] = useState(null);

  // DOC-15 - "Advanced Request History & Reassignment". A reason is only
  // ever required for a genuine REASSIGNMENT (replacing an already-
  // assigned Operator with a different one) - never for a first
  // assignment (task spec section 5), which stays exactly as simple/
  // immediate as it always was below.
  const [reassignReason, setReassignReason] = useState('');
  const [reassignPending, setReassignPending] = useState(false);
  const [reassignError, setReassignError] = useState('');

  // DOC-56 - purely a local UI toggle, never a network call (both
  // galleries are already present on `request` itself - sanitizeRequest
  // always includes `attachments`/`completionAttachments`).
  const [showImages, setShowImages] = useState(false);

  // DOC-17 - its own boolean + own <tr>, same shape as `showImages` above,
  // rather than folding into `mode`/`request-detail-panel` - this row has
  // no single shared "detail panel" the way RequestRow.jsx does, so each
  // read-only toggle here (Images, now Timeline) gets its own state and
  // its own row, exactly like DOC-56 already established.
  const [showTimeline, setShowTimeline] = useState(false);

  // Task spec section 5: assignment (first-time or replacing an existing
  // Operator) is only ever possible while the Request is still 'open' -
  // the backend independently enforces the exact same rule with its own
  // 409, this is only the UI's reflection of it.
  const canAssign = request.status === 'open' && typeof onAssignOperator === 'function';

  // DOC-15 - the id of the Operator this Request is CURRENTLY assigned to
  // (if any) - the one comparison point that decides whether submitting
  // this form is a first assignment (simple, immediate) or a genuine
  // reassignment (requires the confirmation panel below).
  const currentOperatorId = request.assignedOperator ? request.assignedOperator.id : '';

  const handleAssign = async (event) => {
    event.preventDefault();
    setAssignError('');
    if (!selectedOperatorId) {
      setAssignError('Select an operator first.');
      return;
    }

    // Sprint 4 (DOC-22, preserved) - a client-side pre-check for the exact
    // same no-op the backend independently rejects - faster feedback,
    // never a substitute for the backend's own authoritative check.
    if (currentOperatorId && selectedOperatorId === currentOperatorId) {
      setAssignError('This request is already assigned to this operator.');
      return;
    }

    // DOC-15 task spec section 12 - "Do not immediately reassign merely
    // because dropdown value changed... Require explicit confirmation."
    // A genuine reassignment (an Operator is already assigned, and a
    // DIFFERENT one was just selected) opens the confirmation panel below
    // instead of calling the API immediately - the actual network call
    // only happens from handleConfirmReassign, after the Manager has seen
    // current/new Operator and entered a reason.
    if (currentOperatorId) {
      setReassignReason('');
      setReassignError('');
      setMode('reassign');
      return;
    }

    // DOC-15 task spec section 14 - first assignment stays exactly as
    // simple/immediate as it always was: no modal, no reason.
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

  // DOC-15 - the reassignment confirmation panel's own submit handler.
  // `selectedOperatorId` was already chosen in the main row's dropdown
  // before this panel opened - never re-asked for here.
  const handleConfirmReassign = async (event) => {
    event.preventDefault();
    setReassignError('');
    if (!reassignReason.trim()) {
      setReassignError('A reason is required.');
      return;
    }
    setReassignPending(true);
    try {
      await onAssignOperator(request, selectedOperatorId, reassignReason.trim());
      setSelectedOperatorId('');
      setReassignReason('');
      setMode(null);
    } catch (error) {
      setReassignError(error.message);
    } finally {
      setReassignPending(false);
    }
  };

  const handleCancelReassign = () => {
    setMode(null);
    setReassignReason('');
    setReassignError('');
  };

  // --- Sprint 4 (DOC-59) - Manager Request Administration ------------------

  const isTerminal = request.status === 'closed' || request.status === 'cancelled';
  const canCancel = !isTerminal && typeof onManagerCancel === 'function';
  const canClose = request.status === 'resolved' && typeof onManagerClose === 'function';
  const canRemoveOperator = request.status === 'open' && !!request.assignedOperator && typeof onManagerUpdate === 'function';
  const canEdit = !isTerminal && typeof onManagerUpdate === 'function';

  // --- Edit panel (priority / category / assigned operator) ---
  const [editPriority, setEditPriority] = useState(request.priority);
  const [editCategoryId, setEditCategoryId] = useState(request.category ? request.category.id : '');
  const [editOperatorId, setEditOperatorId] = useState(request.assignedOperator ? request.assignedOperator.id : '');
  // DOC-15 - only ever shown/required when the panel's own operator
  // selection represents a genuine reassignment or unassignment (see
  // `editOperatorIsReassignment`/`editOperatorIsUnassignment` below) -
  // never for a first assignment made through this same combined panel.
  const [editOperatorReason, setEditOperatorReason] = useState('');
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState('');

  const openEdit = () => {
    setEditPriority(request.priority);
    setEditCategoryId(request.category ? request.category.id : '');
    setEditOperatorId(request.assignedOperator ? request.assignedOperator.id : '');
    setEditOperatorReason('');
    setEditError('');
    setMode('edit');
  };

  // DOC-15 - whether the operator dropdown's CURRENT selection (which may
  // not have been saved yet) represents a genuine reassignment/
  // unassignment - i.e. an assignment already existed AND the selection
  // now differs from it - the same rule the backend independently applies
  // to decide when a reason is required.
  const originalOperatorIdForEdit = request.assignedOperator ? request.assignedOperator.id : '';
  const editOperatorChanged = editOperatorId !== originalOperatorIdForEdit;
  const editOperatorRequiresReason = !!originalOperatorIdForEdit && editOperatorChanged;

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
      // DOC-15 - a reason is required here under the exact same rule the
      // backend independently enforces: an assignment already existed AND
      // is being replaced or removed. A first assignment made through
      // this same combined panel never requires or sends one.
      if (originalOperatorId) {
        if (!editOperatorReason.trim()) {
          setEditError('A reason is required when reassigning or unassigning an operator.');
          return;
        }
        updates.reason = editOperatorReason.trim();
      }
    }

    if (Object.keys(updates).length === 0) {
      setEditError('No changes to save.');
      return;
    }

    setEditPending(true);
    try {
      await onManagerUpdate(request, updates);
      setEditOperatorReason('');
      setMode(null);
    } catch (error) {
      setEditError(error.message);
    } finally {
      setEditPending(false);
    }
  };

  // --- Remove Operator ---
  // DOC-15 task spec section 4/13 - unassignment now also requires an
  // explicit reason, entered in this same confirmation panel (never a
  // one-click action - task spec: "Do not allow accidental one-click
  // unassignment.").
  const [removeReason, setRemoveReason] = useState('');
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const openRemoveOperator = () => {
    setRemoveReason('');
    setRemoveError('');
    setMode('removeOperator');
  };

  const handleConfirmRemoveOperator = async () => {
    setRemoveError('');
    if (!removeReason.trim()) {
      setRemoveError('A reason is required.');
      return;
    }
    setRemovePending(true);
    try {
      await onManagerUpdate(request, { assignedOperatorId: null, reason: removeReason.trim() });
      setRemoveReason('');
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
    setEditOperatorReason('');
    setRemoveError('');
    setRemoveReason('');
    setCancelError('');
    setCancelReason('');
  };

  return (
    <>
      <tr>
        {/* DOC-16 - see RequestRow.jsx's identical comment for why this is
            inline within the title cell rather than a new column. */}
        <td>
          <RequestNumberBadge requestNumber={request.requestNumber} />
          {request.title}
        </td>
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
                disabled={assignPending || mode === 'reassign'}
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
                disabled={assignPending || mode === 'reassign' || !selectedOperatorId}
              >
                {/* DOC-15 - clicking this button while an Operator is
                    already assigned never submits immediately - it opens
                    the reassignment confirmation panel below (task spec
                    section 12) via handleAssign; the label still reads
                    "Reassign" so the button's purpose is clear either way. */}
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
            {/* DOC-17 - always available regardless of status, same as
                View Images above (read only, no eligibility rule to check). */}
            <button type="button" className="btn btn-outline" onClick={() => setShowTimeline((prev) => !prev)}>
              {showTimeline ? 'Hide Timeline' : 'View Timeline'}
            </button>
            {canEdit && mode !== 'edit' && (
              <button type="button" className="btn btn-outline" onClick={openEdit}>
                Edit
              </button>
            )}
            {canRemoveOperator && mode !== 'removeOperator' && (
              <button type="button" className="btn btn-outline" onClick={openRemoveOperator}>
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

      {/* DOC-15 - "Advanced Request History & Reassignment". Reassignment
          confirmation panel (task spec section 12) - opened by
          handleAssign instead of submitting immediately, whenever the
          Manager picks a DIFFERENT operator for an already-assigned
          Request. Shows current Operator, the newly-selected one, and a
          required reason - Cancel/Reassign, never a one-click action. */}
      {mode === 'reassign' && (
        <tr>
          <td colSpan={8}>
            <form className="cancel-confirm-panel" onSubmit={handleConfirmReassign}>
              <p>Reassign this request to a different operator?</p>
              <div className="reassign-operator-summary">
                <div>
                  <span className="stat-label">Current Operator</span>
                  <p>{request.assignedOperator?.fullName || 'Unassigned'}</p>
                </div>
                <div>
                  <span className="stat-label">New Operator</span>
                  <p>{(eligibleOperators || []).find((operator) => operator.id === selectedOperatorId)?.fullName || '-'}</p>
                </div>
              </div>
              <div className="form-group">
                <label htmlFor={`reassign-reason-${request.id}`}>Reason</label>
                <textarea
                  id={`reassign-reason-${request.id}`}
                  rows={3}
                  value={reassignReason}
                  onChange={(event) => setReassignReason(event.target.value)}
                  disabled={reassignPending}
                  placeholder="e.g. Ahmad is unavailable..."
                />
              </div>
              {reassignError && <p className="form-error form-error-server">{reassignError}</p>}
              <div className="form-actions form-actions-row">
                <button type="button" className="btn btn-outline" onClick={handleCancelReassign} disabled={reassignPending}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={reassignPending}>
                  {reassignPending ? 'Reassigning...' : 'Reassign Request'}
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}

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

      {/* DOC-17 - own boolean + own row, matching the Images toggle
          immediately above rather than the mutually-exclusive `mode`
          panels below (those are edit/action forms; this, like Images,
          is a purely read-only, independently-toggleable view). */}
      {showTimeline && (
        <tr>
          <td colSpan={8}>
            <div className="request-detail-panel">
              <RequestActivityTimeline requestId={request.id} />
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
              {/* DOC-15 - only shown when the selection above actually
                  represents a reassignment/unassignment (an assignment
                  already existed and is being replaced/removed) - never
                  for a first assignment made through this same panel. */}
              {editOperatorRequiresReason && (
                <div className="form-group">
                  <label htmlFor={`edit-operator-reason-${request.id}`}>Reason for operator change</label>
                  <textarea
                    id={`edit-operator-reason-${request.id}`}
                    rows={3}
                    value={editOperatorReason}
                    onChange={(event) => setEditOperatorReason(event.target.value)}
                    disabled={editPending}
                    placeholder="e.g. Ahmad is unavailable, incorrect specialty assignment..."
                  />
                </div>
              )}
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
              {/* DOC-15 task spec section 4/13 - a reason is now required
                  here too, entered in this same confirmation panel -
                  never a one-click action. */}
              <div className="form-group">
                <label htmlFor={`remove-operator-reason-${request.id}`}>Reason</label>
                <textarea
                  id={`remove-operator-reason-${request.id}`}
                  rows={3}
                  value={removeReason}
                  onChange={(event) => setRemoveReason(event.target.value)}
                  disabled={removePending}
                  placeholder="e.g. Waiting for replacement operator, operator unavailable..."
                />
              </div>
              {removeError && <p className="form-error form-error-server">{removeError}</p>}
              <div className="form-actions form-actions-row">
                <button type="button" className="btn btn-outline" onClick={closePanel} disabled={removePending}>
                  Keep Operator
                </button>
                {/* DOC-69 - `.btn-danger` (not `.btn-primary`) for visual
                    consistency with every other destructive confirm action
                    in this project (OrganizationCard.jsx's Delete
                    Organization/Replace Manager) - this button already sat
                    behind its own confirmation panel, this only changes its
                    color to match its severity. */}
                <button type="button" className="btn btn-danger" onClick={handleConfirmRemoveOperator} disabled={removePending}>
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
                {/* DOC-69 - `.btn-danger`, same reasoning as "Remove
                    Operator" above. */}
                <button type="submit" className="btn btn-danger" disabled={cancelPending}>
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
