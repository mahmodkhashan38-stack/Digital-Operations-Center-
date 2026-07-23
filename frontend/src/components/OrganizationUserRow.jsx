import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';

// A single Employee or Operator row inside the Manager Dashboard's user
// table. `actionRole` is the ONE role this row's button may request
// ('operator' for an Employee row, 'employee' for an Operator row) - there
// is no dropdown offering every role, because the backend (DOC-35) only
// ever allows these two exact transitions in the first place. `manager`
// and `system_admin` are never options here, and never will be: this
// component has no code path that could send either, and the Manager's
// own row is never rendered here at all (see ManagerDashboard.jsx, which
// only ever builds Employee/Operator sections - a 'manager' or
// 'system_admin' user, including the caller themselves, simply never
// belongs to either group).
//
// A role change is only ever reflected once the backend confirms it: this
// row calls the async `onChangeRole(user, actionRole)` prop (owned by the
// parent, which is what actually calls userApi.updateRole and updates the
// shared user list on success) and shows its own pending/error state
// locally. If the request fails, nothing about `user` has changed - the
// row (and therefore its section) stays exactly where it was, and the
// backend's own client-safe error message is shown inline instead of
// pretending the change happened.
function OrganizationUserRow({ user, actionRole, actionLabel, onChangeRole }) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');

  const handleClick = async () => {
    setError('');
    setIsPending(true);
    try {
      await onChangeRole(user, actionRole);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <tr>
      <td>{user.fullName}</td>
      <td>{user.email}</td>
      <td className="user-table-role-cell">{user.role}</td>
      <td>
        <StatusBadge isActive={user.isActive} />
      </td>
      <td className="user-table-action-cell">
        <button type="button" className="btn btn-outline" onClick={handleClick} disabled={isPending}>
          {isPending ? 'Updating...' : actionLabel}
        </button>
        {error && <span className="form-error">{error}</span>}
      </td>
    </tr>
  );
}

export default OrganizationUserRow;
