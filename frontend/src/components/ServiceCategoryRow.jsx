import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';

// A single Service Category row inside the Manager Dashboard's Service
// Categories table (DOC-43). Mirrors OrganizationUserRow's established
// pattern (DOC-36/50): a role change/edit/status toggle is only ever
// reflected once the backend confirms it - this row calls an async prop
// owned by the parent (which actually calls serviceCategoryApi and updates
// the shared category list on success) and shows its own pending/error
// state locally. If a request fails, nothing about `category` has
// changed, and the backend's own client-safe error message is shown
// inline instead of pretending the change happened.
//
// There is no Delete action anywhere on this row, on purpose - DOC-43
// explicitly requires history preservation (a future Request may
// reference this Category by id), so the only lifecycle action is
// Activate/Deactivate.
function ServiceCategoryRow({ category, onUpdateName, onToggleStatus }) {
  const [error, setError] = useState('');

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(category.name);
  const [editError, setEditError] = useState('');
  const [editPending, setEditPending] = useState(false);

  const [statusPending, setStatusPending] = useState(false);

  const openEdit = () => {
    setError('');
    setEditName(category.name);
    setEditError('');
    setIsEditing(true);
  };

  const handleSaveName = async (event) => {
    event.preventDefault();
    setError('');

    if (!editName.trim()) {
      setEditError('Category name is required.');
      return;
    }
    setEditError('');

    setEditPending(true);
    try {
      await onUpdateName(category, editName.trim());
      setIsEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setEditPending(false);
    }
  };

  const handleToggleStatusClick = async () => {
    setError('');
    setStatusPending(true);
    try {
      await onToggleStatus(category, !category.isActive);
    } catch (err) {
      setError(err.message);
    } finally {
      setStatusPending(false);
    }
  };

  if (isEditing) {
    return (
      <tr>
        <td colSpan={3}>
          <form className="user-row-edit-form" onSubmit={handleSaveName} noValidate>
            <div className="form-group user-row-edit-field">
              <label htmlFor={`edit-category-${category.id}`}>Category Name</label>
              <input
                id={`edit-category-${category.id}`}
                name="name"
                type="text"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
              {editError && <span className="form-error">{editError}</span>}
            </div>
            {error && <span className="form-error">{error}</span>}
            <div className="form-actions form-actions-row">
              <button type="submit" className="btn btn-primary" disabled={editPending}>
                {editPending ? 'Saving...' : 'Save'}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => setIsEditing(false)} disabled={editPending}>
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{category.name}</td>
      <td>
        <StatusBadge isActive={category.isActive} />
      </td>
      <td className="user-table-action-cell">
        <div className="user-table-action-group">
          <button type="button" className="btn btn-outline" onClick={openEdit}>
            Edit
          </button>
          <button type="button" className="btn btn-outline" onClick={handleToggleStatusClick} disabled={statusPending}>
            {statusPending ? 'Updating...' : category.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>
        {error && <span className="form-error">{error}</span>}
      </td>
    </tr>
  );
}

export default ServiceCategoryRow;
