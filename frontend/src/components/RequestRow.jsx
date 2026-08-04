import { useEffect, useState } from 'react';
import RequestStatusBadge from './RequestStatusBadge.jsx';
import RequestSlaBadge from './RequestSlaBadge.jsx';
import { API_BASE_URL } from '../services/api.js';

// DOC-11 - a single row in the Employee Dashboard's "My Requests" table,
// mirroring the inline-expand pattern OrganizationUserRow.jsx and
// ServiceCategoryRow.jsx already use for their own row-level detail/edit
// views - the smallest maintainable option (no modal library, no
// dedicated /requests/:id route) for "let the Employee open one
// Request's full detail". "View Details" only ever toggles what is
// shown, it never sends a request to the backend.
//
// DOC-12 adds the Employee's ONLY two legal status actions, and only when
// `request.status === 'resolved'` - "Confirm Resolved" (-> closed) and
// "Problem Still Exists" (-> reopened). No other status shows any
// control here: open/in_progress/closed/reopened all stay strictly
// read-only for the Employee (DOC-12 section 19) - there is no generic
// status dropdown anywhere on this row. Both buttons call the async
// `onUpdateStatus` prop owned by the parent (Dashboard.jsx), which is
// what actually calls PATCH /requests/:id/status and refreshes the real
// list on success - if the request fails, nothing about `request` has
// changed here, and the backend's own client-safe error message is shown
// inline instead of pretending the transition happened.
//
// DOC-13 adds the comment thread inside the same expanded detail panel.
// Comments are loaded ONLY the first time this row is expanded (never
// upfront for every row - GET /api/requests already returns the full
// list without them, on purpose) via the async `onLoadComments` prop, and
// posted via `onAddComment` - both owned by the parent, which is what
// actually talks to the backend (same "row owns local pending/error
// state, parent owns the real network call" pattern `onUpdateStatus`
// already uses). A newly posted comment is appended from the backend's
// own response, never guessed locally. If the Request is `closed` OR
// (DOC-46) `cancelled`, the Add Comment form is replaced with a short
// explanatory message - the backend enforces the same rule independently
// (utils/commentAccess.js), this is only the honest reflection of it in
// the UI, not the actual security boundary.
//
// DOC-46 adds Edit and Cancel, both shown ONLY when `request.status ===
// 'open'` AND `request.assignedOperator` is null (task spec sections
// 20/22) - the exact same eligibility the backend independently enforces
// (409 otherwise). "Edit Request" swaps the read-only detail grid for a
// small prefilled form (Title/Description/Category/Priority); only the
// fields the Employee actually changed are ever sent in the PATCH (an
// unchanged Category is never resent, which is also what lets an
// Employee save a title/description-only edit without being forced to
// replace a Category that has since gone inactive - see `categoryOptions`
// below). "Cancel Request" requires an explicit confirm/keep panel
// (task spec section 22/23) - never a single accidental click - and,
// like every destructive-adjacent action in this project, relies entirely
// on the parent's real API response for success; nothing here is a local
// guess.
//
// DOC-45 adds an Images section, always visible (existing images are
// never hidden, even on a cancelled/closed Request - task spec section
// 13/16) with its own gallery, independent of whether the Employee is
// currently in Edit-text mode. "Add Images"/each image's "Remove" button
// only appear under the exact same eligibility Edit/Cancel already use.
// `request.attachments` comes straight from the already-loaded Request
// (the sanitized shape the backend returns - id/originalName/mimeType/
// size/url/uploadedAt) - no separate fetch is needed the way DOC-13's
// comments needed one.
//
// DOC-56 - "Operator Completion Proof Images". Extends this same row a
// second time (after DOC-52): the pre-existing "Images" gallery above is
// the Employee's BEFORE images (DOC-45, unchanged, still `attachments`).
// A completely separate gallery, `request.completionAttachments`, is now
// also rendered - the exact shape depends on `viewerRole`:
//   - Employee (default): the original "Images" block is relabeled
//     "Before Images", and a new read-only "After Images" block is added
//     right after it - side by side, per the task spec - showing
//     `completionAttachments`. Employee never gets Add/Remove on either
//     gallery for completion images (`onAddCompletionImages`/
//     `onRemoveCompletionImage` are simply never passed by Dashboard.jsx),
//     "view/download only" is enforced structurally the same way DOC-52
//     already enforces "Operator cannot remove Employee attachments".
//   - Operator: the original "Images" block keeps its plain "Images"
//     label (still read-only for the Operator - the props that would
//     enable Add/Remove on IT are still never passed here), and a new
//     "Completion Images" block is added below it, with its own Add
//     Images / Remove Image controls - shown ONLY while
//     `request.status === 'in_progress'` (task spec: "Only when: status
//     == in_progress. assigned operator") AND `onAddCompletionImages`/
//     `onRemoveCompletionImage` are actually passed a function
//     (OperatorDashboard passes them; every other caller of this
//     component does not, so those controls structurally cannot appear
//     anywhere else). Every row OperatorDashboard renders is already
//     scoped to Requests assigned to the CALLING Operator (GET
//     /requests/assigned, DOC-52) - there is no separate "is this MY
//     assignment" check needed here, the same way DOC-52's own
//     Edit/Cancel/Add/Remove-Attachment gating already relies on this.
//   - Manager never renders this component at all (see
//     ManagerRequestRow.jsx's own separate, read-only "both galleries"
//     section).
//
// DOC-52 - this same row is now also reused, unmodified in every other
// respect, by the Operator Dashboard (see OperatorDashboard.jsx) for its
// "assigned to me" list. The new optional `viewerRole` prop (defaults to
// 'employee', so Dashboard.jsx needs zero changes) is the ONLY thing that
// changes: it swaps which status-transition buttons are offered -
// Employee still only ever gets "Confirm Resolved"/"Problem Still
// Exists" on a resolved Request (unchanged), while an Operator gets
// "Start Work" (open->in_progress), "Mark Resolved" (in_progress-
// >resolved), and "Resume Work" (reopened->in_progress) - reusing the
// exact same `onUpdateStatus` prop and PATCH /api/requests/:id/status
// endpoint DOC-12 already built (task spec section 10: "Reuse DOC-12. Do
// NOT create another transition system."). Edit/Cancel and Add/Remove
// Images already only render when their respective
// onUpdateRequest/onCancelRequest/onAddAttachments/onRemoveAttachment
// props are actually passed a function - OperatorDashboard simply never
// passes them, so an Operator structurally cannot reach any of those
// four actions without any extra role check needed here (task spec
// section 12: "Operator can view/download. He cannot remove Employee
// attachments. Do not expand permissions."). The new optional
// `request.employee` field (only ever populated by the two DOC-52
// listing endpoints, GET /requests/organization and GET
// /requests/assigned) is shown in the detail grid so an Operator can see
// which Employee opened the Request (task spec section 9) - it is simply
// absent (`undefined`) on every Employee-facing response, so this field
// never appears on the Employee's own "My Requests" view.
const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGES_PER_REQUEST = 5;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function RequestRow({
  request,
  viewerRole = 'employee',
  onUpdateStatus,
  onLoadComments,
  onAddComment,
  onUpdateRequest,
  onCancelRequest,
  onAddAttachments,
  onRemoveAttachment,
  onAddCompletionImages,
  onRemoveCompletionImage,
  activeCategories = [],
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState('');

  const [comments, setComments] = useState(null); // null = not loaded yet
  const [commentsError, setCommentsError] = useState('');
  const [commentText, setCommentText] = useState('');
  const [commentPending, setCommentPending] = useState(false);
  const [commentSubmitError, setCommentSubmitError] = useState('');

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState('');
  const [editSuccessMessage, setEditSuccessMessage] = useState('');

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState('');

  // DOC-45 - images. `addImagesSelected` mirrors the create-form's
  // "queued but not yet submitted" pattern (Dashboard.jsx's
  // `selectedImages`) - files are validated/queued locally, then sent
  // together as one FormData on "Upload". `removingAttachmentId` tracks
  // which single existing image is mid-removal so only that image's
  // button shows "Removing..." rather than disabling the whole gallery.
  const [addImagesSelected, setAddImagesSelected] = useState([]);
  const [addImagesError, setAddImagesError] = useState('');
  const [addImagesPending, setAddImagesPending] = useState(false);
  const [removingAttachmentId, setRemovingAttachmentId] = useState(null);
  const [removeAttachmentError, setRemoveAttachmentError] = useState('');

  // DOC-56 - completion images. Mirrors the DOC-45 add/remove state above
  // exactly, but entirely separate local state for the entirely separate
  // `completionAttachments` collection - nothing here is ever mixed with
  // `addImagesSelected`/`removingAttachmentId` above.
  const [addCompletionImagesSelected, setAddCompletionImagesSelected] = useState([]);
  const [addCompletionImagesError, setAddCompletionImagesError] = useState('');
  const [addCompletionImagesPending, setAddCompletionImagesPending] = useState(false);
  const [removingCompletionImageId, setRemovingCompletionImageId] = useState(null);
  const [removeCompletionImageError, setRemoveCompletionImageError] = useState('');

  useEffect(() => {
    if (!isExpanded || comments !== null || typeof onLoadComments !== 'function') {
      return;
    }
    let cancelled = false;
    setCommentsError('');
    (async () => {
      try {
        const data = await onLoadComments(request.id);
        if (!cancelled) setComments(data);
      } catch (err) {
        if (!cancelled) setCommentsError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isExpanded, comments, onLoadComments, request.id]);

  const handleStatusAction = async (nextStatus) => {
    setStatusError('');
    setStatusPending(true);
    try {
      await onUpdateStatus(request, nextStatus);
    } catch (err) {
      setStatusError(err.message);
    } finally {
      setStatusPending(false);
    }
  };

  const handleAddComment = async (event) => {
    event.preventDefault();
    setCommentSubmitError('');
    const trimmed = commentText.trim();
    if (!trimmed) {
      setCommentSubmitError('Comment cannot be empty.');
      return;
    }
    setCommentPending(true);
    try {
      const newComment = await onAddComment(request.id, trimmed);
      // Append the backend's own response - never a locally guessed object
      // (no fake success). Clears the textarea only once the comment is
      // confirmed to actually exist.
      setComments((prev) => [...(prev || []), newComment]);
      setCommentText('');
    } catch (err) {
      // Failed: the typed content is deliberately left in the textarea so
      // nothing the Employee/Operator/Manager wrote is lost.
      setCommentSubmitError(err.message);
    } finally {
      setCommentPending(false);
    }
  };

  // DOC-52 - the set of status-transition buttons this row offers is now
  // role-aware, but still driven entirely by the same `onUpdateStatus`
  // prop and the same backend transition endpoint every role already
  // shared (DOC-12). Employee's behavior is completely unchanged (still
  // only "resolved" shows anything, still the same two buttons/labels).
  // Operator gets its own three single-button cases, one per reachable
  // status (task spec section 10) - never more than one button at once,
  // since OPERATOR_TRANSITIONS on the backend (utils/
  // requestStatusTransitions.js) only ever allows exactly one next status
  // from any given current status.
  const statusActions = typeof onUpdateStatus !== 'function' ? [] : (() => {
    if (viewerRole === 'operator') {
      if (request.status === 'open') return [{ label: 'Start Work', nextStatus: 'in_progress' }];
      if (request.status === 'in_progress') return [{ label: 'Mark Resolved', nextStatus: 'resolved' }];
      if (request.status === 'reopened') return [{ label: 'Resume Work', nextStatus: 'in_progress' }];
      return [];
    }
    // Employee (default) - unchanged from pre-DOC-52 behavior.
    if (request.status === 'resolved') {
      return [
        { label: 'Confirm Resolved', nextStatus: 'closed' },
        { label: 'Problem Still Exists', nextStatus: 'reopened' },
      ];
    }
    return [];
  })();
  // DOC-46: 'cancelled' is read-only for comments, exactly like 'closed'
  // (utils/commentAccess.js's COMMENT_READ_ONLY_STATUSES on the backend).
  const commentReadOnly = request.status === 'closed' || request.status === 'cancelled';
  const canWriteComments = !commentReadOnly && typeof onAddComment === 'function';

  // DOC-46: the one eligibility rule shared by Edit and Cancel - an
  // Employee may only touch a Request that is still 'open' AND has no
  // assigned Operator yet. Mirrors the backend's own check exactly
  // (request.controller.js's updateMyRequest/cancelMyRequest); this is
  // only the UI's reflection of it, the backend independently enforces
  // the same rule with its own 409 regardless of what this renders.
  const isEditableOrCancellable = request.status === 'open' && !request.assignedOperator;

  // The current Category may no longer be active (a Request opened
  // against a Category that was later deactivated - DOC-11's historical-
  // display rule) - if so, it will not appear in `activeCategories`
  // (GET /api/service-categories/available, active-only). It is still
  // added as its own disabled option so the select correctly shows what
  // the Request is currently set to, without letting the Employee
  // re-select an inactive Category (task spec section 21) - they can only
  // ever pick a *different*, active one, or leave it untouched entirely.
  const currentCategoryIsActiveOption = request.category
    && activeCategories.some((category) => category.id === request.category.id);
  const categoryOptions = !request.category || currentCategoryIsActiveOption
    ? activeCategories
    : [{ id: request.category.id, name: `${request.category.name} (no longer available)`, inactive: true }, ...activeCategories];

  const startEditing = () => {
    setEditForm({
      title: request.title,
      description: request.description,
      categoryId: request.category ? request.category.id : '',
      priority: request.priority,
    });
    setEditError('');
    setEditSuccessMessage('');
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditForm(null);
    setEditError('');
  };

  const handleEditFieldChange = (event) => {
    const { name, value } = event.target;
    setEditForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSaveEdit = async (event) => {
    event.preventDefault();
    setEditError('');

    // Only the fields the Employee actually changed are ever sent - an
    // untouched Category (even a now-inactive one) is never resent, which
    // is what lets a title/description-only edit succeed without forcing
    // a Category replacement (task spec section 21).
    const updates = {};
    if (editForm.title.trim() !== request.title) updates.title = editForm.title.trim();
    if (editForm.description.trim() !== request.description) updates.description = editForm.description.trim();
    const originalCategoryId = request.category ? request.category.id : '';
    if (editForm.categoryId !== originalCategoryId) updates.categoryId = editForm.categoryId;
    if (editForm.priority !== request.priority) updates.priority = editForm.priority;

    if (Object.keys(updates).length === 0) {
      setEditError('No changes to save.');
      return;
    }

    setEditPending(true);
    try {
      await onUpdateRequest(request, updates);
      setIsEditing(false);
      setEditForm(null);
      setEditSuccessMessage('Request updated successfully.');
    } catch (err) {
      // Failed: edit mode stays open with everything the Employee typed
      // still in place - nothing is lost, no fake success.
      setEditError(err.message);
    } finally {
      setEditPending(false);
    }
  };

  const handleCancelRequest = async () => {
    setCancelError('');
    setCancelPending(true);
    try {
      await onCancelRequest(request);
      setShowCancelConfirm(false);
    } catch (err) {
      setCancelError(err.message);
    } finally {
      setCancelPending(false);
    }
  };

  // DOC-45 - validates each newly chosen file client-side (type/size),
  // same rules as Dashboard.jsx's create-form input, PLUS a cap that
  // accounts for images this Request already has - "existing + queued
  // <= 5" (task spec's "3 existing + up to 2 more" example). The backend
  // independently re-enforces every one of these, this is only an early,
  // friendlier rejection.
  const handleAddImagesInputChange = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    const errors = [];
    const accepted = [];
    files.forEach((file) => {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        errors.push(`"${file.name}" is not a supported image type.`);
        return;
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        errors.push(`"${file.name}" is larger than 5 MB.`);
        return;
      }
      accepted.push(file);
    });

    const existingCount = request.attachments ? request.attachments.length : 0;
    setAddImagesSelected((prev) => {
      const combined = [...prev, ...accepted];
      const remaining = Math.max(MAX_IMAGES_PER_REQUEST - existingCount, 0);
      if (combined.length > remaining) {
        errors.push(`Only ${remaining} more image(s) may be added to this request.`);
        return combined.slice(0, remaining);
      }
      return combined;
    });
    setAddImagesError(errors.join(' '));
  };

  const removeSelectedAddImage = (index) => {
    setAddImagesSelected((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUploadImages = async (event) => {
    event.preventDefault();
    setAddImagesError('');
    if (addImagesSelected.length === 0) {
      setAddImagesError('Select at least one image first.');
      return;
    }
    setAddImagesPending(true);
    try {
      const formData = new FormData();
      addImagesSelected.forEach((file) => formData.append('attachments', file));
      await onAddAttachments(request, formData);
      setAddImagesSelected([]);
    } catch (err) {
      setAddImagesError(err.message);
    } finally {
      setAddImagesPending(false);
    }
  };

  const handleRemoveAttachment = async (attachmentId) => {
    setRemoveAttachmentError('');
    setRemovingAttachmentId(attachmentId);
    try {
      await onRemoveAttachment(request, attachmentId);
    } catch (err) {
      setRemoveAttachmentError(err.message);
    } finally {
      setRemovingAttachmentId(null);
    }
  };

  // DOC-56 - "Only when: status == in_progress. assigned operator." Every
  // row rendered on the Operator Dashboard is already scoped to this
  // caller's own assignment (GET /requests/assigned) - see this file's
  // own top comment - so `viewerRole === 'operator'` plus the status
  // check is sufficient here, mirroring how DOC-52's Edit/Cancel/
  // Add-Attachment gating already relies on props simply not being passed
  // for any other role rather than a second explicit ownership check.
  const canManageCompletionImages = viewerRole === 'operator' && request.status === 'in_progress';

  const handleAddCompletionImagesInputChange = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    const errors = [];
    const accepted = [];
    files.forEach((file) => {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        errors.push(`"${file.name}" is not a supported image type.`);
        return;
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        errors.push(`"${file.name}" is larger than 5 MB.`);
        return;
      }
      accepted.push(file);
    });

    const existingCount = request.completionAttachments ? request.completionAttachments.length : 0;
    setAddCompletionImagesSelected((prev) => {
      const combined = [...prev, ...accepted];
      const remaining = Math.max(MAX_IMAGES_PER_REQUEST - existingCount, 0);
      if (combined.length > remaining) {
        errors.push(`Only ${remaining} more image(s) may be added to this request.`);
        return combined.slice(0, remaining);
      }
      return combined;
    });
    setAddCompletionImagesError(errors.join(' '));
  };

  const removeSelectedCompletionImage = (index) => {
    setAddCompletionImagesSelected((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUploadCompletionImages = async (event) => {
    event.preventDefault();
    setAddCompletionImagesError('');
    if (addCompletionImagesSelected.length === 0) {
      setAddCompletionImagesError('Select at least one image first.');
      return;
    }
    setAddCompletionImagesPending(true);
    try {
      const formData = new FormData();
      addCompletionImagesSelected.forEach((file) => formData.append('completionAttachments', file));
      await onAddCompletionImages(request, formData);
      setAddCompletionImagesSelected([]);
    } catch (err) {
      setAddCompletionImagesError(err.message);
    } finally {
      setAddCompletionImagesPending(false);
    }
  };

  const handleRemoveCompletionImage = async (attachmentId) => {
    setRemoveCompletionImageError('');
    setRemovingCompletionImageId(attachmentId);
    try {
      await onRemoveCompletionImage(request, attachmentId);
    } catch (err) {
      setRemoveCompletionImageError(err.message);
    } finally {
      setRemovingCompletionImageId(null);
    }
  };

  return (
    <>
      <tr>
        <td>{request.title}</td>
        <td>{request.category ? request.category.name : 'Unknown category'}</td>
        <td>{PRIORITY_LABELS[request.priority] || request.priority}</td>
        <td>
          <RequestStatusBadge status={request.status} />
        </td>
        {/* DOC-55 - "Request SLA and Due Dates". Shared by Employee AND
            Operator dashboards, since both use this same component -
            RequestSlaBadge only ever reads the already-sanitized `sla`
            object, never recalculates anything itself. */}
        <td>
          <RequestSlaBadge sla={request.sla} status={request.status} />
        </td>
        <td>{formatDateTime(request.createdAt)}</td>
        <td className="user-table-action-cell">
          <div className="user-table-action-group">
            <button type="button" className="btn btn-outline" onClick={() => setIsExpanded((prev) => !prev)}>
              {isExpanded ? 'Hide Details' : 'View Details'}
            </button>
            {statusActions.map((action, index) => (
              <button
                key={action.nextStatus}
                type="button"
                className={index === 0 ? 'btn btn-primary' : 'btn btn-outline'}
                disabled={statusPending}
                onClick={() => handleStatusAction(action.nextStatus)}
              >
                {statusPending ? 'Updating...' : action.label}
              </button>
            ))}
          </div>
          {statusError && <span className="form-error">{statusError}</span>}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7}>
            <div className="request-detail-panel">
              {!isEditing && (
                <>
                  <div className="org-card-detail">
                    <span className="stat-label">Description</span>
                    <span className="stat-value request-detail-description">{request.description}</span>
                  </div>
                  <div className="request-detail-grid">
                    {/* DOC-52 - only present on the Manager/Operator listing
                        endpoints (GET /requests/organization, GET
                        /requests/assigned); undefined (and therefore never
                        rendered) on the Employee's own "My Requests". */}
                    {request.employee && (
                      <div className="org-card-detail">
                        <span className="stat-label">Employee</span>
                        <span className="stat-value">{request.employee.fullName}</span>
                      </div>
                    )}
                    <div className="org-card-detail">
                      <span className="stat-label">Category</span>
                      <span className="stat-value">{request.category ? request.category.name : 'Unknown category'}</span>
                    </div>
                    <div className="org-card-detail">
                      <span className="stat-label">Priority</span>
                      <span className="stat-value">{PRIORITY_LABELS[request.priority] || request.priority}</span>
                    </div>
                    <div className="org-card-detail">
                      <span className="stat-label">Status</span>
                      <RequestStatusBadge status={request.status} />
                    </div>
                    <div className="org-card-detail">
                      <span className="stat-label">Assigned Operator</span>
                      <span className="stat-value">
                        {request.assignedOperator ? request.assignedOperator.fullName : 'Not yet assigned'}
                      </span>
                    </div>
                    <div className="org-card-detail">
                      <span className="stat-label">Created At</span>
                      <span className="stat-value">{formatDateTime(request.createdAt)}</span>
                    </div>
                    <div className="org-card-detail">
                      <span className="stat-label">Updated At</span>
                      <span className="stat-value">{formatDateTime(request.updatedAt)}</span>
                    </div>
                  </div>

                  {editSuccessMessage && <p className="form-success">{editSuccessMessage}</p>}

                  {/* DOC-46 - shown only while status === 'open' AND there is no
                      assigned Operator (task spec sections 20/22); the backend
                      independently enforces the exact same rule with its own
                      409, this is only the UI's reflection of it. */}
                  {isEditableOrCancellable && typeof onUpdateRequest === 'function' && !showCancelConfirm && (
                    <div className="form-actions form-actions-row">
                      <button type="button" className="btn btn-outline" onClick={startEditing}>
                        Edit Request
                      </button>
                      {typeof onCancelRequest === 'function' && (
                        <button
                          type="button"
                          className="btn btn-outline"
                          onClick={() => {
                            setCancelError('');
                            setShowCancelConfirm(true);
                          }}
                        >
                          Cancel Request
                        </button>
                      )}
                    </div>
                  )}

                  {/* DOC-46 - a dedicated confirm/keep panel, never a single
                      accidental click (task spec sections 22/23). */}
                  {showCancelConfirm && (
                    <div className="cancel-confirm-panel">
                      <p>Are you sure you want to cancel this request? This action cannot be undone.</p>
                      {cancelError && <p className="form-error form-error-server">{cancelError}</p>}
                      <div className="form-actions form-actions-row">
                        <button
                          type="button"
                          className="btn btn-outline"
                          disabled={cancelPending}
                          onClick={() => {
                            setShowCancelConfirm(false);
                            setCancelError('');
                          }}
                        >
                          Keep Request
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={cancelPending}
                          onClick={handleCancelRequest}
                        >
                          {cancelPending ? 'Cancelling...' : 'Cancel Request'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {isEditing && (
                <form className="request-edit-form" onSubmit={handleSaveEdit}>
                  <div className="form-group">
                    <label htmlFor={`edit-title-${request.id}`}>Title</label>
                    <input
                      id={`edit-title-${request.id}`}
                      name="title"
                      type="text"
                      value={editForm.title}
                      onChange={handleEditFieldChange}
                      disabled={editPending}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-description-${request.id}`}>Description</label>
                    <textarea
                      id={`edit-description-${request.id}`}
                      name="description"
                      rows={4}
                      value={editForm.description}
                      onChange={handleEditFieldChange}
                      disabled={editPending}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-category-${request.id}`}>Service Category</label>
                    <select
                      id={`edit-category-${request.id}`}
                      name="categoryId"
                      value={editForm.categoryId}
                      onChange={handleEditFieldChange}
                      disabled={editPending}
                    >
                      {categoryOptions.map((category) => (
                        <option key={category.id} value={category.id} disabled={!!category.inactive}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor={`edit-priority-${request.id}`}>Priority</label>
                    <select
                      id={`edit-priority-${request.id}`}
                      name="priority"
                      value={editForm.priority}
                      onChange={handleEditFieldChange}
                      disabled={editPending}
                    >
                      {PRIORITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {editError && <p className="form-error form-error-server">{editError}</p>}

                  <div className="form-actions form-actions-row">
                    <button type="submit" className="btn btn-primary" disabled={editPending}>
                      {editPending ? 'Saving...' : 'Save'}
                    </button>
                    <button type="button" className="btn btn-outline" onClick={cancelEditing} disabled={editPending}>
                      Cancel Editing
                    </button>
                  </div>
                </form>
              )}

              {/* DOC-45 - always rendered, regardless of isEditing/status -
                  existing images stay visible even on a cancelled/closed
                  Request (task spec sections 13/16). Add/Remove controls
                  are gated on the same isEditableOrCancellable eligibility
                  Edit/Cancel already use. */}
              <div className="request-attachments">
                {/* DOC-56 - Employee now sees this labeled "Before Images"
                    (paired with the new read-only "After Images" block
                    right below it); every other viewer keeps the original
                    plain "Images" label. */}
                <span className="stat-label">{viewerRole === 'employee' ? 'Before Images' : 'Images'}</span>

                {(!request.attachments || request.attachments.length === 0) && (
                  <p className="auth-subtitle">No images attached.</p>
                )}

                {request.attachments && request.attachments.length > 0 && (
                  <ul className="attachment-gallery">
                    {request.attachments.map((attachment) => (
                      <li key={attachment.id} className="attachment-item">
                        <a href={`${API_BASE_URL}${attachment.url}`} target="_blank" rel="noreferrer">
                          <img
                            src={`${API_BASE_URL}${attachment.url}`}
                            alt={attachment.originalName}
                            className="attachment-thumb"
                            loading="lazy"
                            onError={(event) => {
                              event.target.onerror = null;
                              event.target.classList.add('attachment-thumb-broken');
                            }}
                          />
                        </a>
                        <span className="attachment-caption">{attachment.originalName}</span>
                        {isEditableOrCancellable && typeof onRemoveAttachment === 'function' && (
                          <button
                            type="button"
                            className="btn btn-outline"
                            disabled={removingAttachmentId === attachment.id}
                            onClick={() => handleRemoveAttachment(attachment.id)}
                          >
                            {removingAttachmentId === attachment.id ? 'Removing...' : 'Remove'}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {removeAttachmentError && <p className="form-error form-error-server">{removeAttachmentError}</p>}

                {isEditableOrCancellable && typeof onAddAttachments === 'function' && (
                  <form className="attachment-add-form" onSubmit={handleUploadImages}>
                    <div className="form-group">
                      <label htmlFor={`add-images-${request.id}`}>Add Images</label>
                      <input
                        id={`add-images-${request.id}`}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        onChange={handleAddImagesInputChange}
                        disabled={addImagesPending}
                      />
                      <span className="auth-subtitle">JPEG, PNG, or WEBP. Max 5 MB each, up to 5 images per request.</span>
                    </div>

                    {addImagesSelected.length > 0 && (
                      <ul className="selected-image-list">
                        {addImagesSelected.map((file, index) => (
                          <li key={`${file.name}-${index}`} className="selected-image-item">
                            <span className="selected-image-name">{file.name}</span>
                            <button
                              type="button"
                              className="btn btn-outline"
                              onClick={() => removeSelectedAddImage(index)}
                              disabled={addImagesPending}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {addImagesError && <span className="form-error">{addImagesError}</span>}

                    {addImagesSelected.length > 0 && (
                      <div className="form-actions form-actions-row">
                        <button type="submit" className="btn btn-primary" disabled={addImagesPending}>
                          {addImagesPending ? 'Uploading...' : 'Upload'}
                        </button>
                      </div>
                    )}
                  </form>
                )}
              </div>

              {/* DOC-56 - Employee's read-only "After Images" - the exact
                  same gallery markup as "Before Images" above, minus any
                  Add/Remove controls (Employee can only ever view/
                  download completion images, task spec: "Never edit.
                  Never remove."). Rendered only for viewerRole ===
                  'employee' - Operator's own completion-images block
                  (with Add/Remove) is the separate section further below. */}
              {viewerRole === 'employee' && (
                <div className="request-attachments">
                  <span className="stat-label">After Images</span>

                  {(!request.completionAttachments || request.completionAttachments.length === 0) && (
                    <p className="auth-subtitle">No completion images yet.</p>
                  )}

                  {request.completionAttachments && request.completionAttachments.length > 0 && (
                    <ul className="attachment-gallery">
                      {request.completionAttachments.map((attachment) => (
                        <li key={attachment.id} className="attachment-item">
                          <a href={`${API_BASE_URL}${attachment.url}`} target="_blank" rel="noreferrer">
                            <img
                              src={`${API_BASE_URL}${attachment.url}`}
                              alt={attachment.originalName}
                              className="attachment-thumb"
                              loading="lazy"
                              onError={(event) => {
                                event.target.onerror = null;
                                event.target.classList.add('attachment-thumb-broken');
                              }}
                            />
                          </a>
                          <span className="attachment-caption">{attachment.originalName}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* DOC-56 - Operator's own "Completion Images" gallery, with
                  Add Images / Remove Image controls - only while
                  `canManageCompletionImages` (status === 'in_progress',
                  see this file's own comment on that flag above) AND
                  `onAddCompletionImages`/`onRemoveCompletionImage` are
                  actually passed a function (OperatorDashboard only).
                  Existing images stay visible read-only even once the
                  Request leaves 'in_progress' (e.g. after it is resolved)
                  - only the Add/Remove controls disappear, the gallery
                  itself never hides what was already uploaded. */}
              {viewerRole === 'operator' && (
                <div className="request-attachments">
                  <span className="stat-label">Completion Images</span>

                  {(!request.completionAttachments || request.completionAttachments.length === 0) && (
                    <p className="auth-subtitle">No completion images yet.</p>
                  )}

                  {request.completionAttachments && request.completionAttachments.length > 0 && (
                    <ul className="attachment-gallery">
                      {request.completionAttachments.map((attachment) => (
                        <li key={attachment.id} className="attachment-item">
                          <a href={`${API_BASE_URL}${attachment.url}`} target="_blank" rel="noreferrer">
                            <img
                              src={`${API_BASE_URL}${attachment.url}`}
                              alt={attachment.originalName}
                              className="attachment-thumb"
                              loading="lazy"
                              onError={(event) => {
                                event.target.onerror = null;
                                event.target.classList.add('attachment-thumb-broken');
                              }}
                            />
                          </a>
                          <span className="attachment-caption">{attachment.originalName}</span>
                          {canManageCompletionImages && typeof onRemoveCompletionImage === 'function' && (
                            <button
                              type="button"
                              className="btn btn-outline"
                              disabled={removingCompletionImageId === attachment.id}
                              onClick={() => handleRemoveCompletionImage(attachment.id)}
                            >
                              {removingCompletionImageId === attachment.id ? 'Removing...' : 'Remove'}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {removeCompletionImageError && <p className="form-error form-error-server">{removeCompletionImageError}</p>}

                  {canManageCompletionImages && typeof onAddCompletionImages === 'function' && (
                    <form className="attachment-add-form" onSubmit={handleUploadCompletionImages}>
                      <div className="form-group">
                        <label htmlFor={`add-completion-images-${request.id}`}>Add Images</label>
                        <input
                          id={`add-completion-images-${request.id}`}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          onChange={handleAddCompletionImagesInputChange}
                          disabled={addCompletionImagesPending}
                        />
                        <span className="auth-subtitle">JPEG, PNG, or WEBP. Max 5 MB each, up to 5 images per request.</span>
                      </div>

                      {addCompletionImagesSelected.length > 0 && (
                        <ul className="selected-image-list">
                          {addCompletionImagesSelected.map((file, index) => (
                            <li key={`${file.name}-${index}`} className="selected-image-item">
                              <span className="selected-image-name">{file.name}</span>
                              <button
                                type="button"
                                className="btn btn-outline"
                                onClick={() => removeSelectedCompletionImage(index)}
                                disabled={addCompletionImagesPending}
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {addCompletionImagesError && <span className="form-error">{addCompletionImagesError}</span>}

                      {addCompletionImagesSelected.length > 0 && (
                        <div className="form-actions form-actions-row">
                          <button type="submit" className="btn btn-primary" disabled={addCompletionImagesPending}>
                            {addCompletionImagesPending ? 'Uploading...' : 'Upload'}
                          </button>
                        </div>
                      )}
                    </form>
                  )}
                </div>
              )}

              <div className="request-comments">
                <span className="stat-label">Comments</span>

                {comments === null && !commentsError && (
                  <p className="auth-subtitle">Loading comments...</p>
                )}
                {commentsError && (
                  <p className="form-error form-error-server">{commentsError}</p>
                )}
                {comments !== null && !commentsError && comments.length === 0 && (
                  <p className="auth-subtitle">No comments yet.</p>
                )}
                {comments !== null && !commentsError && comments.length > 0 && (
                  <ul className="comment-list">
                    {comments.map((comment) => (
                      <li key={comment.id} className="comment-item">
                        <div className="comment-item-header">
                          <span className="comment-author">
                            {comment.author.fullName}
                            {comment.author.role ? ` (${comment.author.role})` : ''}
                          </span>
                          <span className="comment-timestamp">{formatDateTime(comment.createdAt)}</span>
                        </div>
                        <p className="comment-content">{comment.content}</p>
                      </li>
                    ))}
                  </ul>
                )}

                {canWriteComments && (
                  <form className="comment-form" onSubmit={handleAddComment}>
                    <textarea
                      rows={3}
                      placeholder="Add a comment..."
                      value={commentText}
                      onChange={(event) => setCommentText(event.target.value)}
                      disabled={commentPending}
                    />
                    {commentSubmitError && <span className="form-error">{commentSubmitError}</span>}
                    <div className="form-actions form-actions-row">
                      <button type="submit" className="btn btn-primary" disabled={commentPending}>
                        {commentPending ? 'Adding...' : 'Add Comment'}
                      </button>
                    </div>
                  </form>
                )}
                {!canWriteComments && typeof onAddComment === 'function' && (
                  <p className="auth-subtitle">
                    {request.status === 'cancelled'
                      ? 'This request has been cancelled and no longer accepts comments.'
                      : 'This request is closed and no longer accepts comments.'}
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default RequestRow;
