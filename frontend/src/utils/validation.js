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
