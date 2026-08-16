import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { API_BASE_URL } from '../services/api.js';

// GRIDFS MIGRATION - every Request image (Before Image or Completion
// Image) is now served through an authenticated, per-Request-authorized
// endpoint (GET /api/requests/:requestId/attachments/:attachmentId/content
// - see backend/src/controllers/request.controller.js's
// getRequestAttachmentContent) instead of the old unauthenticated
// `/api/uploads/requests/...` static path. This project has no
// cookie-based session - every API call attaches a JWT via an
// `Authorization: Bearer <token>` header (services/api.js's `request()`
// helper) - and a plain `<img src="...">` has no way to attach a custom
// header to its own request. This component is the one place that works
// around that: it performs an authenticated `fetch()` itself, turns the
// response into a Blob, and renders an object URL instead (the "Option
// B" approach from the migration's own design notes - never puts the
// JWT in a query string, never a second, weaker auth mechanism).
//
// `url` is expected to already be the attachment's root-relative content
// URL exactly as returned by the backend's sanitizeRequest (e.g.
// `/requests/<id>/attachments/<id>/content`) - this component only ever
// prepends API_BASE_URL and attaches the caller's own token to it, it
// never re-derives, guesses, or trusts any other URL shape.
//
// Renders the SAME DOM shape (`<a target="_blank"><img /></a>`) the
// previous raw `<img>` markup used across RequestRow.jsx/
// ManagerRequestRow.jsx, reusing the exact same `attachment-thumb`/
// `attachment-thumb-broken` CSS classes - no CSS changes needed, and the
// "open full image in a new tab" link keeps working by pointing the
// anchor at the SAME already-fetched object URL (a second unauthenticated
// request from a new tab would otherwise simply fail).
function AuthenticatedRequestImage({ url, alt, className = 'attachment-thumb' }) {
  const { token } = useAuth();
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdObjectUrl = null;

    setObjectUrl(null);
    setFailed(false);

    if (!url || !token) {
      return undefined;
    }

    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}${url}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`Failed to load image (status ${response.status}).`);
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

    // Cleanup - revokes the object URL whenever `url`/`token` changes or
    // this component unmounts, so a gallery of many images never leaks
    // memory by accumulating unrevoked blob URLs.
    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
  }, [url, token]);

  if (failed) {
    return <span className={`${className} attachment-thumb-broken`} role="img" aria-label={alt} />;
  }

  if (!objectUrl) {
    // Loading (or no url/token yet) - an empty, already-styled placeholder
    // box (`.attachment-thumb` already has its own background/sizing in
    // index.css), never a broken-image icon while a legitimate fetch is
    // still in flight.
    return <span className={className} aria-hidden="true" />;
  }

  return (
    <a href={objectUrl} target="_blank" rel="noreferrer">
      <img src={objectUrl} alt={alt} className={className} />
    </a>
  );
}

export default AuthenticatedRequestImage;
