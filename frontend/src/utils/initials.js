// DOC-71 - "Enhanced User Profile: Profile Picture + Bio" (task spec
// section 12 - avatar fallback: "e.g. 'Mahmoud Khashan' -> 'MK'").
// Takes the first letter of the first two whitespace-separated words in a
// full name. Deliberately simple and dependency-free - this project has no
// internationalization/locale-aware name-splitting requirement, and a
// single-word name (e.g. a placeholder/test account) still degrades
// gracefully to a single letter rather than throwing.
export function getInitials(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return '?';
  }
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return words[0].charAt(0).toUpperCase();
  }
  return `${words[0].charAt(0)}${words[words.length - 1].charAt(0)}`.toUpperCase();
}

export default getInitials;
