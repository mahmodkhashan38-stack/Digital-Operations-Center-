import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { API_BASE_URL } from '../services/api.js';
import getInitials from '../utils/initials.js';

// DOC-71 - "Enhanced User Profile: Profile Picture + Bio".
//
// AUTHENTICATED IMAGE, SAME PATTERN AS AuthenticatedRequestImage.jsx: this
// project has no cookie-based session, so a plain `<img src="...">` cannot
// attach the `Authorization` header GET /api/users/:userId/profile-image
// requires. This component performs its own authenticated `fetch()`,
// converts the response to a Blob, and renders an object URL - never a raw
// `/users/:id/profile-image` string as an `<img src>` directly.
//
// FALLBACK, NEVER A BROKEN-IMAGE ICON (task spec section 12): whenever
// there is no image at all (`profileImageUrl` is null/undefined), the fetch
// is still in flight, or the fetch fails for any reason (deleted out from
// under a stale reference, network error, 404), this renders an initials
// circle instead - `getInitials(fullName)` - never lets the browser's own
// broken-image icon appear.
//
// CACHE-BUSTING (task spec section 28): `profileImageUrl` already carries
// its own `?v=<updatedAt>` query parameter (see backend's
// auth.controller.js `sanitizeProfileImage`) - this component does not add
// or need any cache-busting logic of its own, it just re-fetches whenever
// the URL STRING changes (a replaced image gets a brand-new `v`, so the
// `useEffect` below re-runs automatically; an unchanged image keeps its
// same object URL across re-renders).
//
// CHAT-READINESS (task spec section 19 - "design profile image data so a
// future Chat feature could render avatar + fullName without redesigning
// storage"): this component's entire public contract is exactly
// `{ profileImageUrl, fullName }` - the two fields `sanitizeUser` already
// returns for ANY user, including one only known through a Chat message's
// `authorId`/`authorName`. A future Chat feature can render an avatar next
// to a message by reusing this component completely unchanged, passing
// whatever minimal `{ profileImage, fullName }` shape the Chat API already
// carries - no new avatar component or storage change would be needed.
function Avatar({ profileImageUrl, fullName, size = 'medium', className = '' }) {
  const { token } = useAuth();
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdObjectUrl = null;

    setObjectUrl(null);
    setFailed(false);

    if (!profileImageUrl || !token) {
      return undefined;
    }

    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}${profileImageUrl}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`Failed to load avatar (status ${response.status}).`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        createdObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(createdObjectUrl);
      } catch (error) {
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
  }, [profileImageUrl, token]);

  const sizeClass = `avatar-${size}`;

  if (objectUrl && !failed) {
    return <img src={objectUrl} alt={fullName ? `${fullName}'s avatar` : 'Avatar'} className={`avatar ${sizeClass} ${className}`} />;
  }

  return (
    <span className={`avatar avatar-initials ${sizeClass} ${className}`} aria-label={fullName ? `${fullName}'s avatar` : 'Avatar'}>
      {getInitials(fullName)}
    </span>
  );
}

export default Avatar;
