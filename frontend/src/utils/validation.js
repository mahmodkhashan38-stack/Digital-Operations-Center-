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
// Sprint 7 - "SMS + Phone Authentication Upgrade". A deliberately loose,
// client-side-only "does this look like a phone number" check - fast
// feedback only, same spirit as EMAIL_REGEX above. The backend's
// utils/phoneNumber.js (normalizePhoneNumber/isValidE164) is the sole real
// authority: it normalizes to E.164 (adding the default country code when
// missing, stripping a leading trunk "0", etc.) and is what actually
// decides whether a number is accepted - this regex only exists so a user
// gets an inline error before a round trip for obviously-wrong input like
// letters or an empty string.
//
// *** RETIRED - DOC Email Authentication & Notification Upgrade ***
// This regex was only ever used by the Sprint 7 mandatory-phone-number
// fields on Register.jsx, ManagerFormFields.jsx, CreateOrganizationForm.jsx
// and OrganizationCard.jsx. All four have been updated to no longer collect
// a phone number at all (accounts now verify by EMAIL instead), so nothing
// in this project imports PHONE_REGEX anymore. Left in place, unused,
// rather than deleted, only because this session's sandboxed shell (needed
// to safely confirm zero remaining references with a real `grep -r` and
// then `git rm`) has been unavailable. Confirmed via this app's own search
// tools that no file references it. Safe to delete once shell access is
// available - just remove this export.
export const PHONE_REGEX = /^[0-9+()\-\s]{7,20}$/;
