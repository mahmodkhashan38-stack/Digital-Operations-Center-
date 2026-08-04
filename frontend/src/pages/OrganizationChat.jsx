import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { organizationApi, chatApi } from '../services/api.js';
import EmptyState from '../components/EmptyState.jsx';

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

const POLL_INTERVAL_MS = 7000;
const MAX_CONTENT_LENGTH = 2000;
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
  const sendDisabled = sendPending || trimmedDraft.length === 0 || overLimit;

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
      const response = await chatApi.send(trimmedDraft, token);
      isNearBottomRef.current = true;
      setHasNewMessages(false);
      setMessages((prev) => mergeMessages(prev || [], [response.data]));
      setDraft('');
    } catch (error) {
      // Typed content is preserved on failure (task spec) - `draft` is
      // simply never cleared in this branch.
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
  const handleComposerKeyDown = (event) => {
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
                              text rendering is sufficient."). */}
                          <p className="chat-message-content">{message.content}</p>
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
            <div className="chat-composer-row">
              <textarea
                id="chat-message-input"
                className="chat-composer-input"
                rows={2}
                maxLength={MAX_CONTENT_LENGTH + 200}
                placeholder="Write a message to your organization… (Enter to send, Shift+Enter for a new line)"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                disabled={sendPending}
                aria-describedby="chat-char-counter"
              />
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
              {sendError && <span className="form-error form-error-server" role="alert">{sendError}</span>}
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}

export default OrganizationChat;
