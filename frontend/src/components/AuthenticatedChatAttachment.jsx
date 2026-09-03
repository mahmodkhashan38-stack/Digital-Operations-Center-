import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { API_BASE_URL } from '../services/api.js';

// DOC-70 - "Organization Chat Attachments".
//
// AUTHENTICATED FETCH, SAME PATTERN AS AuthenticatedRequestImage.jsx/
// Avatar.jsx: this project has no cookie-based session, so a plain
// `<img src="...">`/`<a href="...">` cannot attach the `Authorization`
// header GET /api/chat/messages/:messageId/attachments/:attachmentId/
// content requires. A NEW, independent component (rather than extending
// or importing either of those two) - mirrors the same audit conclusion
// services/profileImageStorage.js/chatAttachmentStorage.js already
// reached for the storage layer: a chat attachment is a conceptually
// different thing (it can be a PDF or text file, not just an image, and
// its card needs a filename/size/Open control neither existing component
// has) that happens to share the same underlying fetch-to-blob mechanism,
// not the same shape of data - keeping this independent means a future
// change to Avatar.jsx/AuthenticatedRequestImage.jsx can never silently
// affect chat rendering, and vice versa.
//
// LAZY VS EAGER FETCH (task spec section 22/26 - "Do not read huge files
// into Base64... Actual attachment bytes should fetch only when
// rendering/new attachment appears... avoid memory leaks/object URL
// churn"): an IMAGE attachment fetches its bytes immediately (a thumbnail
// needs the actual pixels to render at all) - exactly once per `url`,
// see the `useEffect` below. A PDF/text attachment fetches NOTHING until
// the person actually clicks "Open" - its card (icon + filename + size)
// needs no bytes at all to render, so this is a further, deliberate
// improvement over image handling: a chat full of PDF links costs zero
// extra network/memory until someone actually opens one.
//
// POLLING-SAFE (task spec section 26 - "Attachments must not trigger
// repeated binary downloads unnecessarily on every poll"): this
// component's own fetch effect is keyed on the `url` STRING prop, not on
// the parent `message`/`attachment` object's identity. OrganizationChat.jsx's
// polling merge (`mergeMessages`) replaces each message with a freshly
// parsed response object every ~7 seconds, but an unchanged attachment's
// `url` string is byte-identical across polls (it is derived only from
// the stable messageId/attachmentId, never a changing cache-busting
// version - chat attachments are immutable/write-once, unlike DOC-71's
// replaceable profile image). React's dependency comparison is by value,
// so an unchanged `url` string never re-runs this effect, regardless of
// how many times the parent re-renders with a new (but equal) prop value.
function AuthenticatedChatAttachment({ attachment }) {
  const { token } = useAuth();
  const isImage = attachment.mimeType && attachment.mimeType.startsWith('image/');

  const [imageObjectUrl, setImageObjectUrl] = useState(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (!isImage) return undefined;
    let cancelled = false;
    let createdObjectUrl = null;

    setImageObjectUrl(null);
    setImageFailed(false);

    if (!attachment.url || !token) {
      return undefined;
    }

    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}${attachment.url}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`Failed to load attachment (status ${response.status}).`);
        }
        const blob = await response.blob();
        if (cancelled) return;
        createdObjectUrl = URL.createObjectURL(blob);
        setImageObjectUrl(createdObjectUrl);
      } catch (error) {
        if (!cancelled) {
          setImageFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage, attachment.url, token]);

  // Lazy fetch-on-click for non-image attachments (PDF/text) - see this
  // file's own top comment. The created object URL is intentionally NOT
  // revoked immediately after opening (the newly-opened tab is still
  // using it) - it is instead tracked in a ref and revoked on unmount, a
  // small, bounded, per-attachment-card cost (task spec's own "revoke
  // object URLs appropriately", read as "eventually, safely" rather than
  // "the instant the click handler returns").
  const [openPending, setOpenPending] = useState(false);
  const [openError, setOpenError] = useState('');
  const openedObjectUrlRef = useRef(null);

  useEffect(() => () => {
    if (openedObjectUrlRef.current) {
      URL.revokeObjectURL(openedObjectUrlRef.current);
    }
  }, []);

  const handleOpen = async () => {
    if (openPending) return;
    setOpenPending(true);
    setOpenError('');
    try {
      const response = await fetch(`${API_BASE_URL}${attachment.url}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to load attachment (status ${response.status}).`);
      }
      const blob = await response.blob();
      if (openedObjectUrlRef.current) {
        URL.revokeObjectURL(openedObjectUrlRef.current);
      }
      const objectUrl = URL.createObjectURL(blob);
      openedObjectUrlRef.current = objectUrl;
      window.open(objectUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setOpenError('Unable to open attachment.');
    } finally {
      setOpenPending(false);
    }
  };

  const formattedSize = formatFileSize(attachment.size);

  if (isImage) {
    if (imageFailed) {
      // Task spec section 28 - "If image cannot load: show 'Unable to
      // load attachment' with filename. Do not show broken-image browser
      // icon only."
      return (
        <div className="chat-attachment-failed" role="img" aria-label={attachment.originalName}>
          <span>Unable to load attachment</span>
          <span className="chat-attachment-failed-name">{attachment.originalName}</span>
        </div>
      );
    }
    if (!imageObjectUrl) {
      // Loading (or no url/token yet) - an empty, already-styled
      // placeholder box, never a broken-image icon while a legitimate
      // fetch is still in flight (same convention
      // AuthenticatedRequestImage.jsx already established).
      return <span className="chat-attachment-image-placeholder" aria-hidden="true" />;
    }
    return (
      <a href={imageObjectUrl} target="_blank" rel="noreferrer" className="chat-attachment-image-link">
        <img src={imageObjectUrl} alt={attachment.originalName} className="chat-attachment-image" />
      </a>
    );
  }

  // PDF / plain text - a file card (task spec section 23: "PDF: file
  // card: PDF icon, filename, size, Open / Download").
  return (
    <div className="chat-attachment-card">
      <span className="chat-attachment-card-icon" aria-hidden="true">{fileIconFor(attachment.mimeType)}</span>
      <div className="chat-attachment-card-info">
        <span className="chat-attachment-card-name">{attachment.originalName}</span>
        {formattedSize && <span className="chat-attachment-card-size">{formattedSize}</span>}
      </div>
      <button type="button" className="btn btn-outline btn-small" onClick={handleOpen} disabled={openPending}>
        {openPending ? 'Opening…' : 'Open'}
      </button>
      {openError && <span className="form-error chat-attachment-card-error">{openError}</span>}
    </div>
  );
}

function fileIconFor(mimeType) {
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType === 'text/plain') return '📝';
  return '📎';
}

function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { formatFileSize };
export default AuthenticatedChatAttachment;
