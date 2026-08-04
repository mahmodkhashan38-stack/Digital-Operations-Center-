// DOC-40 code-quality fix: EMAIL_REGEX and MIN_PASSWORD_LENGTH were
// previously copy-pasted identically across Register.jsx,
// CreateOrganizationForm.jsx, and OrganizationCard.jsx. These are purely
// client-side UX checks (fast feedback before a round trip) - the backend
// (backend/src/controllers/auth.controller.js) remains the sole authority
// on what is actually valid and always re-validates independently. Having
// one shared copy here just means the three forms can never quietly drift
// out of sync with each other.
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 6;
// DOC-57 - mirrors the backend's shared validator (backend/src/utils/
// passwordPolicy.js) exactly - see that file's own comment for why this
// is a new ceiling (the pre-DOC-57 policy had none) while
// MIN_PASSWORD_LENGTH above stays unchanged. Used by the new Change
// Password page and the Manager's Reset Password panel, both purely for
// fast client-side feedback - the backend remains the sole authority and
// re-validates independently regardless.
export const MAX_PASSWORD_LENGTH = 128;
