import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, chatApi } from '../services/api.js';
import EmptyState from '../components/EmptyState.jsx';
import AuthenticatedChatAttachment, { formatFileSize } from '../components/AuthenticatedChatAttachment.jsx';
import { getInitials } from '../utils/initials.js';

// DOC-60 - "Organization Chat", UI/UX redesign pass. One shared page for
// every allowed role (manager/operator/employee - task spec: "Do not
// create separate chat pages per role.") - reached only via the /chat
// route, itself gated by ProtectedRoute (roles + the existing DOC-57
// forced-password-change redirect, both reused completely unchanged - see
// App.jsx). The backend remains the sole authority on WHO may read/send
// (routes/chat.routes.js) and on WHAT organization's messages are ever
// returned (chat.controller.js scopes every query by
// req.user.organizationId) - this page never predicts or duplicates that,
// it only renders whatever the backend actually returns.
//
// This pass is presentation-only: every data-fetching call
// (chatApi.list/chatApi.send), the polling interval, the "before"-based
// Load Older pagination, and the merge-by-id/never-clear-on-poll-failure
// contract are unchanged in substance from the original implementation -
// only the render tree, the scroll/"new messages" bookkeeping, and a
// handful of small additive helpers (date separators, same-author
// grouping, Enter-to-send) were added on top.
//
// DOC-70 - "Organization Chat Attachments" adds file attachments on top
// of this unchanged foundation: the composer gained an Attach button/
// selected-file list/client-side validation, `chatApi.send` now always
// posts `FormData` (text + 0-3 files), and each message bubble renders
// its `attachments` array (always present, empty for a text-only
// message) via AuthenticatedChatAttachment.jsx AFTER its text content.
// Pagination, polling, date separators, auto-scroll, and Organization
// isolation are completely untouched by this pass - see this file's own
// per-section comments below for exactly what changed.
//
// AVATAR INTEGRATION - DEFERRED (task spec section 25: "If it
// significantly expands scope: defer and document."). Displaying an
// Avatar next to each message was audited but NOT implemented in this
// pass: doing so safely would require a new, chat-specific safe-fields
// sanitizer for the resolved author (chat.controller.js's own
// `buildAuthorMap`/`sanitizeChatMessage` currently expose only
// `{ id, fullName, role }` - reusing DOC-71's `sanitizeUser` wholesale
// would leak `email`/`bio`/`organizationId`/`isActive` into an
// Organization-wide feed every member polls every few seconds, which is
// a real privacy regression, not a cosmetic one), plus the same
// polling-safe-fetch design AuthenticatedChatAttachment.jsx already needed
// for attachments. That is a second, independent scope of work on top of
// an already-large ticket - deferred rather than rushed, with the exact
// reason recorded here for whoever picks it up next.

const POLL_INTERVAL_MS = 7000;
const MAX_CONTENT_LENGTH = 2000;
// DOC-70 - "Organization Chat Attachments". Kept identical to the
// backend's own middleware/chatUpload.js constants for fast, consistent
// client-side feedback only - the backend remains the sole authority and
// re-validates every one of these independently regardless (task spec
// section 21: "Frontend validation is UX only. Backend remains
// authoritative.").
const ALLOWED_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'];
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 3;
const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(',');
// DOC-72 - "@Mentions in Organization Chat". Kept identical to the
// backend's own utils/chatMentionValidation.js
// MAX_MENTIONS_PER_MESSAGE for fast, consistent client-side feedback
// only - the backend remains the sole authority and re-validates
// independently regardless (same "frontend is UX only" contract DOC-70's
// own attachment limits already established).
const MAX_MENTIONS_PER_MESSAGE = 10;
// Debounce delay before firing a mention-search request per keystroke
// (task spec section 13: "Do not return entire organization user list on
// every keystroke if avoidable" - read here as "do not even ISSUE a
// request on every keystroke").
const MENTION_SEARCH_DEBOUNCE_MS = 200;
// How close to the bottom (in pixels) the message list must already be
// for an incoming poll/update to auto-scroll - a simple, documented
// heuristic (task spec: "If this is too complex for the current project,
// use a simpler behavior and document it."), not a precise "is the last
// message fully visible" calculation.
const NEAR_BOTTOM_THRESHOLD_PX = 80;
// Consecutive messages from the same author within this window are
// visually grouped (no repeated name/role/timestamp header) - a simple,
// documented heuristic for readability, not an attempt at Slack/Discord-
// grade grouping rules.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const ROLE_LABELS = { manager: 'Manager', operator: 'Operator', employee: 'Employee' };

// Small role badge, sharing the existing `.status-badge` base class every
// other badge in this project already uses (StatusBadge.jsx/
// RequestStatusBadge.jsx/RequestSlaBadge.jsx) - new status-role-* color
// modifiers only, no new badge component/visual language. System Admin
// never appears here because System Admin cannot reach this page at all
// (ProtectedRoute + the backend's own requireRole both already block it) -
// ROLE_LABELS simply has no 'system_admin' entry, so an unexpected role
// silently renders nothing rather than a raw string.
function RoleBadge({ role }) {
  if (!role || !ROLE_LABELS[role]) return null;
  return <span className={`status-badge chat-role-badge status-role-${role}`}>{ROLE_LABELS[role]}</span>;
}

// Reuses this project's existing hand-written inline-SVG icon convention
// (viewBox 0 0 24 24, stroke="currentColor", strokeWidth 1.8, round caps/
// joins - see Home.jsx's own feature icons) rather than adding an icon
// library just for one button. The path itself is the same refresh/reload
// glyph Home.jsx already uses for its "Operator Handles and Updates It"
// step icon.
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function formatMessageTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatFullTimestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// DOC-72 - "@Mentions in Organization Chat" (task spec section 18/19:
// "Mention text should be visually distinct... Do NOT use
// dangerouslySetInnerHTML. Do not parse arbitrary HTML... Prefer
// rendering message text as React nodes. If parsing mention ranges
// becomes complicated, use a safe tokenizer."). This IS that safe
// tokenizer: a plain, greedy, left-to-right scan using
// `String.prototype.startsWith` (never a RegExp built from message
// content or a mentioned user's name, and never any form of HTML
// parsing/injection) that splits `content` into an array of plain
// strings and `<span>` elements React can render directly. `mentions` is
// the message's own server-resolved `{ id, fullName }` array (task spec
// section 34) - matched here purely for DISPLAY highlighting, never to
// reconstruct or trust an id from text (task spec section 15: "Do not
// later reconstruct ID from text" - the actual notification/authorization
// decision already happened server-side at send time, using the real
// `mentions` array, not this rendering pass).
//
// Longest-name-first matching avoids a shorter name incorrectly
// "winning" inside a longer one that starts the same way (e.g. "Ahmad"
// vs "Ahmad Saleh"). A mention whose current fullName no longer appears
// verbatim in this OLD message's `content` (the sender renamed since -
// task spec section 17: "old message text may still show the name used
// at send time... This is acceptable") simply never highlights - the
// plain text is still shown exactly as sent, never rewritten.
function renderContentWithMentions(content, mentions) {
  if (!content) return null;
  const tokens = (mentions || [])
    .map((mention) => `@${mention.fullName}`)
    .filter((token) => token.length > 1)
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return content;

  const nodes = [];
  let buffer = '';
  let index = 0;
  let key = 0;
  while (index < content.length) {
    const matchedToken = tokens.find((token) => content.startsWith(token, index));
    if (matchedToken) {
      if (buffer) {
        nodes.push(buffer);
        buffer = '';
      }
      // eslint-disable-next-line react/no-array-index-key
      nodes.push(<span key={`mention-${key}`} className="chat-mention">{matchedToken}</span>);
      key += 1;
      index += matchedToken.length;
    } else {
      buffer += content[index];
      index += 1;
    }
  }
  if (buffer) nodes.push(buffer);
  return nodes;
}

// DOC-72 - "@Mentions in Organization Chat" (task spec section 12: "When
// user types @: show a dropdown of matching users."). Scans backward from
// the caret to find an unclosed `@trigger` - i.e. an `@` that is either at
// the very start of the text or immediately preceded by whitespace, with
// no whitespace/newline between it and the caret. This correctly stops
// matching once the person types a space after the query (so an
// already-completed `@Full Name ` mention, or an unrelated "a@b"-looking
// fragment, never re-opens the dropdown) - the same "trigger closes on
// whitespace" behavior every @mention UI (Slack, GitHub, etc.) uses.
// Returns `{ start, query }` (the index of the `@` and the text typed
// after it) or `null` when no trigger is currently active.
function detectMentionTrigger(text, cursorPos) {
  const upToCursor = text.slice(0, cursorPos);
  const atIndex = upToCursor.lastIndexOf('@');
  if (atIndex === -1) return null;
  const precedingChar = atIndex > 0 ? upToCursor[atIndex - 1] : '';
  if (precedingChar && !/\s/.test(precedingChar)) return null;
  const query = upToCursor.slice(atIndex + 1);
  if (/\s/.test(query)) return null;
  return { start: atIndex, query };
}

// "Today" / "Yesterday" / a full browser-local date, exactly the task
// spec's own examples - backend timestamps (createdAt, always UTC) are
// never touched, only formatted for display.
function formatDateSeparator(value) {
  const target = new Date(value);
  const now = new Date();
  if (isSameCalendarDay(target, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(target, yesterday)) return 'Yesterday';
  return target.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

// Turns the flat, chronologically-ordered `messages` array into a render
// list of date-separator and message entries, and marks each message as
// `grouped` (same author as the previous message, no date boundary
// between them, within GROUP_WINDOW_MS) so the render below can skip
// repeating the author/role/timestamp header for it. Pure function, no
// component state - recomputed only when `messages` actually changes
// (see the `useMemo` call site).
function buildTimeline(messages) {
  const items = [];
  let previousMessage = null;
  messages.forEach((message) => {
    const currentDate = new Date(message.createdAt);
    const isNewDay = !previousMessage || !isSameCalendarDay(currentDate, new Date(previousMessage.createdAt));
    if (isNewDay) {
      items.push({ type: 'separator', key: `separator-${message.id}`, label: formatDateSeparator(message.createdAt) });
    }
    const grouped = !isNewDay
      && previousMessage
      && String(previousMessage.author?.id) === String(message.author?.id)
      && currentDate.getTime() - new Date(previousMessage.createdAt).getTime() < GROUP_WINDOW_MS;
    items.push({
      type: 'message', key: message.id, message, grouped: Boolean(grouped),
    });
    previousMessage = message;
  });
  return items;
}

// Merges a freshly-fetched batch of messages into the existing list,
// de-duplicating by `id` (task spec: "merge/deduplicate messages by
// message id") - never clears or replaces what is already on screen
// (task spec: "do not clear existing messages during refresh"). Used by
// the polling refresh, "Load Older Messages", and a successful send, so
// all three share exactly one merge implementation. Re-sorts by createdAt
// ascending, with `id` as a stable secondary key for the rare case of two
// messages sharing an identical timestamp (task spec, mirroring the
// backend's own ordering guarantee) - the frontend never relies on
// insertion order alone.
function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((message) => [message.id, message]));
  incoming.forEach((message) => byId.set(message.id, message));
  return Array.from(byId.values()).sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

function OrganizationChat() {
  const { user, token } = useAuth();

  // Organization name, if already safely available - fetched the exact
  // same secure way every other dashboard already does (GET
  // /api/organizations/me, derived entirely from req.user.organizationId).
  // Non-fatal if it fails - the chat itself does not depend on this.
  const [organization, setOrganization] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await organizationApi.getMine(token);
        if (!cancelled) setOrganization(response.data);
      } catch (error) {
        // Non-fatal - the header simply omits the Organization name; chat
        // itself is unaffected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const [messages, setMessages] = useState(null); // null = not loaded yet
  const [messagesError, setMessagesError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  // Manual "Refresh" button in the header - a thin wrapper around the same
  // loadInitial() the initial mount already uses, with its own pending
  // flag so the button can show "Refreshing..." without disturbing the
  // full-page "Loading messages..." state (which only applies to the very
  // first load, when `messages` is still null).
  const [manualRefreshing, setManualRefreshing] = useState(false);
  // New-messages-while-reading-history indicator (task spec: "If the user
  // is reading old messages: do not force-scroll them; show a small 'New
  // messages' button or indicator.").
  const [hasNewMessages, setHasNewMessages] = useState(false);

  // Guards against overlapping requests (task spec: "avoid overlapping
  // requests") - the initial load, every poll tick, "Load Older Messages"
  // and a manual refresh all check this before starting a new fetch, and
  // it is cleared in a `finally` so a failed request never permanently
  // wedges polling.
  const fetchInFlightRef = useRef(false);
  const pollIntervalRef = useRef(null);
  const listContainerRef = useRef(null);
  const hasLoadedOnceRef = useRef(false);
  // Tracks whether the viewer was already scrolled near the bottom
  // immediately BEFORE new messages arrive - updated on every scroll
  // event, read right after a merge to decide whether to auto-scroll or
  // surface the "New messages" indicator instead (task spec: "auto-scroll
  // only if the user is already near the bottom... Do not force-scroll a
  // user who is reading older messages.").
  const isNearBottomRef = useRef(true);
  // The most recently known newest message id - compared after every
  // `messages` update so a genuinely NEW latest message (poll tick, own
  // send) can be distinguished from "Load Older Messages" merging older
  // history in at the front (which never changes the newest id, and must
  // never scroll or trigger the indicator).
  const lastSeenNewestIdRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    const el = listContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const handleScroll = () => {
    const el = listContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setHasNewMessages(false);
  };

  // Initial load - the newest 50 messages (backend default), ascending.
  const loadInitial = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setMessagesError('');
    try {
      const response = await chatApi.list(token);
      setMessages(response.data);
      setHasMore(Boolean(response.meta?.hasMore));
    } catch (error) {
      setMessagesError(error.message);
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [token]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const handleManualRefresh = async () => {
    if (fetchInFlightRef.current) return;
    setManualRefreshing(true);
    try {
      await loadInitial();
    } finally {
      setManualRefreshing(false);
    }
  };

  // Single consolidated effect covering both "scroll to newest exactly
  // once on first load" and "auto-scroll on a new update only if already
  // near the bottom, otherwise show the New Messages indicator". Runs on
  // every `messages` change (initial load, poll merge, Load Older merge,
  // a confirmed send) but only ever acts on a genuine change in the
  // NEWEST message id - "Load Older Messages" prepends older history
  // without changing the newest id, so it correctly never scrolls or
  // triggers the indicator (task spec: "Explicitly does NOT touch scroll
  // position").
  useEffect(() => {
    if (messages === null) return;
    const newest = messages.length > 0 ? messages[messages.length - 1] : null;

    if (!hasLoadedOnceRef.current) {
      hasLoadedOnceRef.current = true;
      isNearBottomRef.current = true;
      lastSeenNewestIdRef.current = newest ? newest.id : null;
      // Deferred one tick so the newly-rendered rows have real height
      // before the scroll calculation runs.
      requestAnimationFrame(scrollToBottom);
      return;
    }

    if (newest && newest.id !== lastSeenNewestIdRef.current) {
      lastSeenNewestIdRef.current = newest.id;
      if (isNearBottomRef.current) {
        requestAnimationFrame(scrollToBottom);
      } else {
        setHasNewMessages(true);
      }
    }
  }, [messages, scrollToBottom]);

  const handleJumpToNewest = () => {
    isNearBottomRef.current = true;
    setHasNewMessages(false);
    requestAnimationFrame(scrollToBottom);
  };

  // DOC-60 - near-real-time POLLING, not true real-time messaging (task
  // spec: "Document that this is near-real-time polling."). Fetches the
  // newest 50 messages every 7 seconds and merges them into whatever is
  // already on screen (never clears/replaces it) - stopped on unmount via
  // the cleanup function, and skipped entirely while a fetch is already
  // in flight (initial load, another poll tick, "Load Older Messages", or
  // a manual refresh) to avoid overlapping requests.
  useEffect(() => {
    pollIntervalRef.current = setInterval(async () => {
      if (fetchInFlightRef.current) return;
      fetchInFlightRef.current = true;
      try {
        const response = await chatApi.list(token);
        setMessages((prev) => mergeMessages(prev || [], response.data));
      } catch (error) {
        // A single failed poll tick is silent/non-blocking by design - the
        // existing message list is left exactly as it was, and the next
        // tick simply tries again. A persistent connectivity problem would
        // already have surfaced via the initial load's own error state.
      } finally {
        fetchInFlightRef.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [token]);

  const handleLoadOlder = async () => {
    if (!messages || messages.length === 0 || fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const oldest = messages[0];
      const response = await chatApi.list(token, { before: oldest.createdAt, limit: 50 });
      // Explicitly does NOT touch scroll position/isNearBottomRef - the
      // viewer is reading older history, the effect above must not jump
      // them back to the bottom.
      setMessages((prev) => mergeMessages(prev || [], response.data));
      setHasMore(Boolean(response.meta?.hasMore));
    } catch (error) {
      setOlderError(error.message);
    } finally {
      setLoadingOlder(false);
      fetchInFlightRef.current = false;
    }
  };

  // --- Message composer -------------------------------------------------
  const [draft, setDraft] = useState('');
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState('');

  const trimmedDraft = draft.trim();
  const overLimit = draft.length > MAX_CONTENT_LENGTH;

  // DOC-70 - selected-but-not-yet-sent attachments. Each entry is
  // `{ file, previewUrl }` - `previewUrl` is a local `URL.createObjectURL`
  // preview for an image file (task spec section 22: "For selected image
  // files: show small local preview before send... Use object URLs and
  // revoke them appropriately."), `null` for a PDF/text file (task spec:
  // "For PDFs: show file icon + name + size" - no preview needed).
  const [selectedAttachments, setSelectedAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const fileInputRef = useRef(null);

  // Revokes every still-outstanding local preview object URL on unmount -
  // mirrors Profile.jsx's own DOC-71 preview-cleanup effect. Individual
  // previews are also revoked immediately on Remove/Send (see
  // handleRemoveAttachment/submitDraft below); this is only the final
  // safety net for whatever is still selected when the page unmounts.
  useEffect(() => () => {
    selectedAttachments.forEach((entry) => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendDisabled = sendPending
    || overLimit
    || (trimmedDraft.length === 0 && selectedAttachments.length === 0);

  const handleAttachClick = () => {
    if (sendPending) return;
    fileInputRef.current?.click();
  };

  // Client-side validation only (task spec section 21/29) - MIME type,
  // per-file size, and total count (existing selection + newly-picked
  // files, task spec section 6: "max 3 attachments per chat message").
  // The backend (middleware/chatUpload.js) independently re-validates
  // every one of these and remains authoritative regardless.
  const handleFilesSelected = (event) => {
    const files = Array.from(event.target.files || []);
    // Always reset the input's own value so picking the SAME file again
    // later (e.g. after removing it) still fires this handler.
    event.target.value = '';
    if (files.length === 0) return;

    setAttachmentError('');

    if (selectedAttachments.length + files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      setAttachmentError(`Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
      return;
    }

    const nextEntries = [];
    for (const file of files) {
      if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.type)) {
        setAttachmentError('Unsupported file type.');
        return;
      }
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        setAttachmentError('File exceeds 10 MB.');
        return;
      }
      const isImage = file.type.startsWith('image/');
      nextEntries.push({ file, previewUrl: isImage ? URL.createObjectURL(file) : null });
    }

    setSelectedAttachments((prev) => [...prev, ...nextEntries]);
  };

  const handleRemoveAttachment = (index) => {
    setSelectedAttachments((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  // --- @Mentions (DOC-72) -------------------------------------------------
  const textareaRef = useRef(null);
  // Index (into `draft`) of the `@` that started the currently-active
  // trigger, or `null` when no mention dropdown is open (task spec section
  // 15: "Track: raw text (with @query)... Hidden state: selected
  // userId"). `mentionQuery` is the text typed after that `@` - used both
  // to fetch suggestions and to know exactly which substring to replace on
  // selection.
  const [mentionTriggerStart, setMentionTriggerStart] = useState(null);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionSuggestions, setMentionSuggestions] = useState(null); // null = no active trigger / not loaded yet
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  // Stable display text -> userId tracking (task spec section 15: "Do not
  // later reconstruct ID from text"). Keyed by userId so re-selecting the
  // same user is naturally a no-op update rather than a duplicate entry
  // (task spec: "Selecting the same user twice: still only one mention").
  // Cleared alongside `draft` on a successful send, and pruned whenever the
  // corresponding `@fullName` text is deleted from the draft (see the
  // cleanup effect below).
  const [selectedMentions, setSelectedMentions] = useState(new Map());
  const [mentionError, setMentionError] = useState('');

  const mentionCloseDropdown = () => {
    setMentionTriggerStart(null);
    setMentionQuery('');
    setMentionSuggestions(null);
    setMentionActiveIndex(0);
  };

  // Debounced mention-search (task spec section 13: "Do not return entire
  // organization user list on every keystroke if avoidable" - read here as
  // "do not even issue a request on every keystroke"). Re-fires whenever
  // the active trigger's query text changes; a `cancelled` flag ensures a
  // slow, stale response can never clobber a newer one or reopen a
  // dropdown the person has since closed.
  useEffect(() => {
    if (mentionTriggerStart === null) return undefined;
    let cancelled = false;
    setMentionLoading(true);
    const timeoutId = setTimeout(async () => {
      try {
        const response = await chatApi.searchMentionUsers(token, mentionQuery);
        if (!cancelled) {
          setMentionSuggestions(response.data);
          setMentionActiveIndex(0);
        }
      } catch (error) {
        if (!cancelled) setMentionSuggestions([]);
      } finally {
        if (!cancelled) setMentionLoading(false);
      }
    }, MENTION_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [mentionTriggerStart, mentionQuery, token]);

  // Removes a selected mention whose `@fullName` text no longer appears
  // verbatim in the draft (task spec section 16: "If user deletes the
  // mention text before sending: remove that mention from selected
  // mention state if practical.") - runs on every draft change, a cheap
  // substring check against a normally-tiny Map. Only ever produces a new
  // Map when something was actually pruned, so it never triggers an
  // unnecessary extra render.
  useEffect(() => {
    setSelectedMentions((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map();
      prev.forEach((fullName, userId) => {
        if (draft.includes(`@${fullName}`)) {
          next.set(userId, fullName);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [draft]);

  const handleDraftChange = (event) => {
    const { value } = event.target;
    setDraft(value);
    const cursorPos = event.target.selectionStart ?? value.length;
    const trigger = detectMentionTrigger(value, cursorPos);
    if (trigger) {
      setMentionTriggerStart(trigger.start);
      setMentionQuery(trigger.query);
    } else if (mentionTriggerStart !== null) {
      mentionCloseDropdown();
    }
  };

  // Inserts the chosen user's CURRENT fullName as stable display text
  // (task spec section 15: "Insert stable display text... Track hidden
  // userId separately") and records the real userId in `selectedMentions`
  // - never derives or reconstructs an id from the inserted text later.
  // Enforces the same MAX_MENTIONS_PER_MESSAGE the backend independently
  // re-validates (task spec: "Prefer reject with a clear safe error" - here
  // read as "prevent the client from even trying to exceed it").
  const handleSelectMentionSuggestion = (candidate) => {
    if (mentionTriggerStart === null || !textareaRef.current) return;
    const alreadySelected = selectedMentions.has(candidate.id);
    if (!alreadySelected && selectedMentions.size >= MAX_MENTIONS_PER_MESSAGE) {
      setMentionError(`A message may mention at most ${MAX_MENTIONS_PER_MESSAGE} users.`);
      mentionCloseDropdown();
      return;
    }
    setMentionError('');

    const cursorPos = textareaRef.current.selectionStart ?? draft.length;
    const before = draft.slice(0, mentionTriggerStart);
    const after = draft.slice(cursorPos);
    const insertion = `@${candidate.fullName} `;

    setDraft(`${before}${insertion}${after}`);
    setSelectedMentions((prev) => {
      const next = new Map(prev);
      next.set(candidate.id, candidate.fullName);
      return next;
    });
    mentionCloseDropdown();

    const nextCursorPos = before.length + insertion.length;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursorPos, nextCursorPos);
      }
    });
  };

  // Extracted from the form's onSubmit so both a normal Send-button click
  // AND the Enter-to-send keyboard shortcut below can share one
  // implementation - never two competing send paths.
  const submitDraft = async () => {
    if (sendDisabled) return;
    setSendPending(true);
    setSendError('');
    try {
      // Real server response only - never a locally-faked message shown
      // before the backend confirms it (task spec: "do not fake a message
      // before server confirmation").
      const files = selectedAttachments.map((entry) => entry.file);
      // DOC-72 - the real, validated userId list, never reconstructed from
      // `draft` text - `selectedMentions` was built exclusively from actual
      // suggestion selections (see handleSelectMentionSuggestion above).
      const mentionUserIds = Array.from(selectedMentions.keys());
      const response = await chatApi.send(trimmedDraft, files, mentionUserIds, token);
      isNearBottomRef.current = true;
      setHasNewMessages(false);
      setMessages((prev) => mergeMessages(prev || [], [response.data]));
      setDraft('');
      selectedAttachments.forEach((entry) => {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      });
      setSelectedAttachments([]);
      setAttachmentError('');
      setSelectedMentions(new Map());
      setMentionError('');
      mentionCloseDropdown();
    } catch (error) {
      // Typed content AND selected attachments are preserved on failure
      // (task spec: "do not clear text/files on a failed send" - the same
      // "preserve on failure" contract the existing text-only behavior
      // already had) - neither `draft` nor `selectedAttachments` is
      // cleared in this branch.
      setSendError(error.message);
    } finally {
      setSendPending(false);
    }
  };

  const handleSend = (event) => {
    event.preventDefault();
    submitDraft();
  };

  // Task spec: "Enter sends. Shift+Enter creates a new line." Composition
  // (IME) input is respected via `isComposing` so this never sends a
  // half-typed multi-byte character while the person is still composing
  // it.
  //
  // DOC-72 - when the mention dropdown is open, arrow keys/Enter/Tab/Escape
  // are intercepted FIRST for dropdown navigation/selection/dismissal
  // (task spec section 12's own "dropdown of matching users" UX - keyboard
  // navigation is the standard way to drive one) - falling through to the
  // existing Enter-sends/Shift+Enter-newline logic only once no suggestion
  // dropdown is showing, so a normal in-flight send is never disrupted by
  // this addition.
  const handleComposerKeyDown = (event) => {
    const dropdownOpen = mentionTriggerStart !== null && Array.isArray(mentionSuggestions) && mentionSuggestions.length > 0;
    if (dropdownOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionActiveIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionActiveIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        handleSelectMentionSuggestion(mentionSuggestions[mentionActiveIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        mentionCloseDropdown();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      submitDraft();
    }
  };

  const timeline = useMemo(() => buildTimeline(messages || []), [messages]);

  return (
    <section className="page chat-page">
      <div className="chat-shell">
        <div className="chat-container">
          <header className="chat-header">
            <div className="chat-header-titles">
              <h1 className="chat-header-title">Organization Chat</h1>
              <p className="chat-header-meta">
                {organization?.name ? `${organization.name} · ` : ''}
                Organization-wide channel
              </p>
              <p className="chat-header-scope">Manager, Operators and Employees</p>
            </div>
            <button
              type="button"
              className="btn btn-outline chat-refresh-btn"
              onClick={handleManualRefresh}
              disabled={manualRefreshing || messages === null}
            >
              <span className="chat-refresh-icon"><RefreshIcon /></span>
              {manualRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </header>

          <div className="chat-body">
            {messages === null && !messagesError && (
              <div className="chat-loading-state" role="status" aria-live="polite">
                <span className="chat-loading-spinner" aria-hidden="true" />
                <span>Loading messages…</span>
              </div>
            )}

            {messagesError && (
              <div className="chat-error-block" role="alert" aria-live="assertive">
                <p className="form-error form-error-server">{messagesError}</p>
                <button type="button" className="btn btn-outline" onClick={loadInitial}>
                  Retry
                </button>
              </div>
            )}

            {messages !== null && !messagesError && (
              messages.length === 0 ? (
                <EmptyState title="No messages yet" message="Start the conversation with your organization." />
              ) : (
                <div className="chat-message-area">
                  {hasMore && (
                    <div className="chat-load-older-row">
                      <button type="button" className="btn btn-outline" onClick={handleLoadOlder} disabled={loadingOlder}>
                        {loadingOlder ? 'Loading older messages…' : 'Load Older Messages'}
                      </button>
                      {olderError && <span className="form-error" role="alert">{olderError}</span>}
                    </div>
                  )}

                  <div className="chat-message-list" ref={listContainerRef} onScroll={handleScroll}>
                    {timeline.map((item) => {
                      if (item.type === 'separator') {
                        return (
                          <div className="chat-date-separator" key={item.key} role="separator" aria-label={item.label}>
                            <span>{item.label}</span>
                          </div>
                        );
                      }

                      const { message, grouped } = item;
                      const isOwnMessage = Boolean(user?.id) && String(message.author?.id) === String(user.id);
                      const authorLabel = isOwnMessage ? 'You' : (message.author?.fullName || 'Unknown User');
                      const bubbleClassName = [
                        'chat-message',
                        isOwnMessage ? 'chat-message-own' : 'chat-message-other',
                        grouped ? 'chat-message-grouped' : '',
                      ].filter(Boolean).join(' ');

                      return (
                        <div key={item.key} className={bubbleClassName}>
                          {!grouped && (
                            <div className="chat-message-header">
                              <span className="chat-message-author">{authorLabel}</span>
                              <RoleBadge role={message.author?.role} />
                              <span className="chat-message-timestamp" title={formatFullTimestamp(message.createdAt)}>
                                {formatMessageTime(message.createdAt)}
                              </span>
                            </div>
                          )}
                          {/* Plain React text rendering only - never
                              dangerouslySetInnerHTML (task spec: "React
                              text rendering is sufficient."). DOC-72 -
                              `message.mentions` (always present, `[]` for
                              a message with no mentions or from before
                              this feature existed) is passed through the
                              safe tokenizer above purely for DISPLAY
                              highlighting. */}
                          {message.content && (
                            <p className="chat-message-content">
                              {renderContentWithMentions(message.content, message.mentions)}
                            </p>
                          )}
                          {/* DOC-70 - attachments render AFTER the text
                              content (task spec section 23: "Text
                              content then attachments."), and are simply
                              omitted for a text-only message (empty
                              array) - see AuthenticatedChatAttachment.jsx
                              for the image-thumbnail/PDF-card rendering
                              and its own polling-safety comment. */}
                          {message.attachments && message.attachments.length > 0 && (
                            <div className="chat-message-attachments">
                              {message.attachments.map((attachment) => (
                                <AuthenticatedChatAttachment key={attachment.id} attachment={attachment} />
                              ))}
                            </div>
                          )}
                          {grouped && (
                            <span
                              className="chat-message-timestamp chat-message-timestamp-grouped"
                              title={formatFullTimestamp(message.createdAt)}
                            >
                              {formatMessageTime(message.createdAt)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {hasNewMessages && (
                    <button type="button" className="chat-jump-button" onClick={handleJumpToNewest}>
                      ↓ New messages
                    </button>
                  )}
                </div>
              )
            )}
          </div>

          <form className="chat-composer" onSubmit={handleSend}>
            <label htmlFor="chat-message-input" className="sr-only">
              Message
            </label>
            {/* DOC-70 - selected-but-not-yet-sent attachments (task spec
                section 20: "After selection, show: photo.jpg 1.2 MB
                [Remove]"). Reuses this project's existing
                .selected-image-list/.selected-image-item convention
                (RequestRow.jsx's own "Add Images" form) with a small
                image preview added for image files. */}
            {selectedAttachments.length > 0 && (
              <ul className="selected-image-list chat-selected-attachments">
                {selectedAttachments.map((entry, index) => (
                  <li key={`${entry.file.name}-${index}`} className="selected-image-item">
                    {entry.previewUrl ? (
                      <img src={entry.previewUrl} alt={entry.file.name} className="chat-selected-attachment-preview" />
                    ) : (
                      <span className="chat-selected-attachment-icon" aria-hidden="true">
                        {entry.file.type === 'application/pdf' ? '📄' : '📎'}
                      </span>
                    )}
                    <span className="selected-image-name">
                      {entry.file.name} · {formatFileSize(entry.file.size)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline btn-small"
                      onClick={() => handleRemoveAttachment(index)}
                      disabled={sendPending}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {attachmentError && <span className="form-error" role="alert">{attachmentError}</span>}

            <div className="chat-composer-row">
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                onChange={handleFilesSelected}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                className="btn btn-outline chat-attach-btn"
                onClick={handleAttachClick}
                disabled={sendPending || selectedAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                title="Attach a file"
                aria-label="Attach a file"
              >
                📎 Attach
              </button>
              <div className="chat-mention-input-wrapper">
                <textarea
                  ref={textareaRef}
                  id="chat-message-input"
                  className="chat-composer-input"
                  rows={2}
                  maxLength={MAX_CONTENT_LENGTH + 200}
                  placeholder="Write a message to your organization… (Enter to send, Shift+Enter for a new line, @ to mention)"
                  value={draft}
                  onChange={handleDraftChange}
                  onKeyDown={handleComposerKeyDown}
                  disabled={sendPending}
                  aria-describedby="chat-char-counter"
                />
                {/* DOC-72 - mention suggestion dropdown (task spec section
                    12/24: same-organization, active, allowed-chat-role
                    users only, already enforced server-side by
                    GET /api/chat/mention-users). Initials-only, per the
                    documented performance decision (task spec section 24:
                    "do not make mention dropdown performance poor") -
                    `hasProfileImage` is returned by the backend but
                    intentionally unused here. */}
                {mentionTriggerStart !== null && (
                  <ul className="chat-mention-dropdown" role="listbox" aria-label="Mention suggestions">
                    {mentionSuggestions === null && (
                      <li className="chat-mention-dropdown-empty">Searching…</li>
                    )}
                    {mentionSuggestions !== null && mentionSuggestions.length === 0 && !mentionLoading && (
                      <li className="chat-mention-dropdown-empty">No matching users</li>
                    )}
                    {mentionSuggestions && mentionSuggestions.map((candidate, index) => (
                      <li key={candidate.id} role="option" aria-selected={index === mentionActiveIndex}>
                        <button
                          type="button"
                          className={index === mentionActiveIndex ? 'chat-mention-option chat-mention-option-active' : 'chat-mention-option'}
                          // onMouseDown (not onClick) so the selection runs
                          // BEFORE the textarea's own blur would otherwise
                          // close this dropdown first - the standard
                          // "prevent focus loss" pattern for a custom
                          // dropdown built on a text input.
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleSelectMentionSuggestion(candidate);
                          }}
                          onMouseEnter={() => setMentionActiveIndex(index)}
                        >
                          <span className="chat-mention-option-initials" aria-hidden="true">
                            {getInitials(candidate.fullName)}
                          </span>
                          <span className="chat-mention-option-name">{candidate.fullName}</span>
                          <RoleBadge role={candidate.role} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="submit" className="btn btn-primary chat-send-btn" disabled={sendDisabled}>
                {sendPending ? 'Sending…' : 'Send'}
              </button>
            </div>
            <div className="chat-composer-meta">
              <span
                id="chat-char-counter"
                className={overLimit ? 'chat-char-counter chat-char-counter-over' : 'chat-char-counter'}
              >
                {draft.length} / {MAX_CONTENT_LENGTH}
              </span>
              {overLimit && <span className="form-error">Message must be at most {MAX_CONTENT_LENGTH} characters.</span>}
              {mentionError && <span className="form-error" role="alert">{mentionError}</span>}
              {sendError && <span className="form-error form-error-server" role="alert">{sendError}</span>}
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

export default OrganizationChat;
