const mongoose = require('mongoose');
const { COMPANY_CODE_REGEX, normalizeCompanyCode } = require('../utils/companyCode');

// Represents a company/tenant using the platform. Mongo's own _id is used as
// the organization identifier everywhere - no separate organizationId field.
const organizationSchema = new mongoose.Schema(
  {
    // DOC-40 correctness audit: `unique: true` was intentionally NOT kept
    // here. Organization.companyCode (below) is the real unique onboarding
    // identifier the business logic actually depends on - nothing in the
    // product requirements (DOC-32/33/41) requires Organization NAMES to be
    // globally unique, and two legitimate, unrelated companies can
    // plausibly share an ordinary name. A leftover `unique: true` here was
    // reviewed and found to be an accidental Sprint-1-era constraint with
    // no documented business justification, so it has been removed as part
    // of this final Sprint 2 correctness pass - it would otherwise reject
    // a legitimate second Organization for no real reason.
    //
    // IMPORTANT - REAL DATABASE ACTION REQUIRED: removing `unique: true`
    // from this schema stops Mongoose from declaring/enforcing this index
    // going forward, but Mongoose's default `autoIndex` behavior only ever
    // CREATES indexes that are missing - it never drops an index that
    // already exists in the database but is no longer declared in the
    // schema. If this application has ever connected to a real MongoDB
    // deployment with this field's earlier `unique: true` in place, a
    // unique index on `name` may still physically exist there and will
    // keep being enforced until it is dropped manually. This was NOT done
    // automatically as part of this audit (no real database connection was
    // available to safely verify against - see the final report). Before
    // relying on duplicate Organization names being allowed against a real
    // deployment, run once, directly against that database:
    //   db.organizations.dropIndex("name_1")
    // (or the equivalent via MongoDB Compass / Atlas UI - check
    // `db.organizations.getIndexes()` first to confirm the exact index
    // name, which is normally "name_1" for a single-field ascending index
    // Mongoose would have created from this schema).
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Short, human-typeable onboarding code (DOC-41). NOT a credential - it
    // only identifies which Organization a future registration (DOC-33) is
    // for. Generation/normalization/validation all live in
    // src/utils/companyCode.js so this schema can never drift out of sync
    // with the logic that produces new codes.
    //
    // `set: normalizeCompanyCode` runs on every assignment (trim + upper-
    // case), so "abc123" is stored as "ABC123" no matter how it was set -
    // this is what keeps two organizations from ever differing only by
    // letter casing. `unique: true` gives a real MongoDB unique index,
    // the actual defense against duplicate codes (application-level retry
    // logic in generateUniqueCompanyCode() is the first line of defense,
    // this index is the backstop).
    companyCode: {
      type: String,
      required: true,
      unique: true,
      set: normalizeCompanyCode,
      match: [COMPANY_CODE_REGEX, 'companyCode must be exactly 6 uppercase letters/digits.'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // DOC-61 - "Organization Settings for Manager". Three new, optional
    // profile-style fields - the entire deliberately-small set the task
    // spec asks for (task spec section 3: "Do not create excessive
    // profile fields."). All three are editable by the Organization's own
    // Manager through PATCH /api/organizations/me (see
    // controllers/organization.controller.js's own updateMyOrganization) -
    // never by mass assignment, always through an explicit field
    // allowlist. None of the three participates in any existing business
    // rule anywhere in this codebase: `description` is a free-text
    // profile blurb, `contactEmail`/`contactPhone` are ORGANIZATION-level
    // contact details (e.g. a general company inbox/switchboard number) -
    // deliberately NOT the Manager's own login email (`User.email`,
    // authApi's login identity), which this feature never reads or
    // writes (task spec section 18: "Changing organization contactEmail
    // must NOT modify Manager/User email."). `default: null` (never
    // `default: ''`) for all three, matching this project's own
    // established "optional field, no value" convention (e.g.
    // `Request.cancelReason`, DOC-15/59) - lets every historical
    // Organization created before this ticket load safely with no
    // migration (Mongoose's own schema `default` only ever applies to a
    // NEW document; a pre-existing document simply reads back
    // `undefined`/`null` for a field it never had, which this schema and
    // every consumer already treats identically to an explicit `null`).
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    // Deliberately NOT `unique` and NOT validated as a login identity -
    // this is presentation-only contact information (task spec section
    // 18), format-validated (a real email shape) but never checked
    // against `User` documents for uniqueness/ownership the way
    // `User.email` is.
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    // Deliberately permissive (task spec section 19: "Do not over-
    // restrict to one country.") - format is validated at the
    // application layer (controllers/organization.controller.js's
    // `validateContactPhone`), not via a Mongoose `match` regex here, so
    // the one validation rule lives in exactly one place or the other,
    // never split across both and at risk of drifting apart.
    contactPhone: {
      type: String,
      trim: true,
      maxlength: 30,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('Organization', organizationSchema);
