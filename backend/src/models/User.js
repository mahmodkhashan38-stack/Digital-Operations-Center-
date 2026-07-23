const mongoose = require('mongoose');

// Represents an application user account.
const userSchema = new mongoose.Schema({
  fullName: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: {
    type: String,
    required: true,
  },
  // 'system_admin' (DOC-31) is a single, global, non-organization-scoped
  // account created only through the backend/scripts/seedSystemAdmin.js
  // bootstrap script - never through public registration.
  //
  // 'manager' (DOC-34) is organization-scoped: it is created only through
  // the System-Admin-only Organization-manager flow in
  // controllers/organization.controller.js, never through public
  // registration.
  //
  // 'operator' (DOC-35) is organization-scoped, exactly like 'manager' in
  // that it always requires an organizationId (see the validator below) -
  // but unlike 'manager', it has no dedicated creation path of its own.
  // There is no "register as operator" and no "create operator" endpoint:
  // an operator only ever comes from an existing 'employee' being promoted
  // by their Organization's Manager (controllers/user.controller.js), and
  // can be demoted back to 'employee' the same way. Nothing else may set
  // role: 'operator'.
  role: {
    type: String,
    enum: ['employee', 'system_admin', 'manager', 'operator'],
    default: 'employee',
  },
  // Reference to the Organization this user belongs to. The Organization
  // document (backend/src/models/Organization.js) remains the single source
  // of truth for organization data - only its _id is stored here, never a
  // copy of the organization's name/companyCode/etc.
  //
  // Not required at the schema level for every role, on purpose:
  //   - Sprint 1 users (created before this field existed) have no value
  //     for it. Requiring it here would make every existing document fail
  //     validation on save and could crash flows that touch those users
  //     (DOC-39 normalizes the raw data shape but never invents membership).
  //   - The global system_admin role (DOC-31) is a system-level user that
  //     is not scoped to any organization, so it must be able to stay null
  //     permanently, not just temporarily.
  // 'employee' is expected to have this populated once registration is
  // connected to organizations in DOC-33; enforcing that is left to that
  // task's registration logic, not to schema-level validation here.
  // 'manager' (DOC-34) IS enforced here (see the validator below), because
  // a manager only ever exists via one controlled server-side creation path
  // that always sets organizationId itself - there is no legacy manager
  // data to accommodate, unlike 'employee'.
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    index: true,
    validate: {
      // Defense in depth for three rules, kept in one place:
      //   - system_admin (DOC-31) is global and must never belong to an
      //     Organization.
      //   - manager (DOC-34) is organization-scoped and must always belong
      //     to one.
      //   - operator (DOC-35) is organization-scoped exactly like manager -
      //     it is only ever created by promoting an existing employee (who
      //     already has an organizationId), never independently, so unlike
      //     'employee' it has no legacy/transitional state to accommodate
      //     and can be enforced as strictly as 'manager' from day one.
      // Every current code path already respects all three by construction
      // (register() hardcodes 'employee'; seedSystemAdmin.js hardcodes
      // organizationId: null for system_admin; the DOC-34 manager-creation
      // helper always sets organizationId to the target Organization's
      // _id; the DOC-35 role-management controller only ever promotes/
      // demotes a user who already has the caller's own organizationId),
      // but this validator keeps all three invariants true at the data
      // layer too, so a future bug elsewhere in Sprint 2 cannot quietly
      // violate any of them.
      validator(value) {
        if (this.role === 'system_admin') {
          return value === null || value === undefined;
        }
        if (this.role === 'manager' || this.role === 'operator') {
          return value !== null && value !== undefined;
        }
        return true;
      },
      // This validator only ever fails in exactly two situations, and they
      // are distinguishable by whether a value was supplied: manager/operator
      // +missing (props.value is null/undefined) or system_admin+present (it
      // isn't). (Mongoose does not reliably bind `this` to the document
      // inside a validator's `message` function, only inside `validator`
      // itself, so this can't just re-check `this.role` the way `validator`
      // above does.)
      message(props) {
        return props.value == null
          ? 'manager and operator users must have an organizationId.'
          : 'system_admin users must not have an organizationId.';
      },
    },
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Enforces "at most one system_admin" at the database level, not just in
// application code. A partial unique index only applies to documents
// matching the filter, so it has zero effect on employee/manager (or,
// later, operator) documents - it exists purely as a safety net against
// concurrent/duplicate runs of the bootstrap script or a manual DB edit,
// on top of the bootstrap script's own "does one already exist?" check.
userSchema.index(
  { role: 1 },
  { unique: true, partialFilterExpression: { role: 'system_admin' } },
);

module.exports = mongoose.model('User', userSchema);
