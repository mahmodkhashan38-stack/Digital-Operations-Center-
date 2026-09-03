import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { directMessageApi } from '../services/api.js';
import EmptyState from '../components/EmptyState.jsx';
import Avatar from '../components/Avatar.jsx';
import AuthenticatedChatAttachment, { formatFileSize } from '../components/AuthenticatedChatAttachment.jsx';

// DOC-73 - "Private Direct Messages". A dedicated /messages page, separate
// from Organization Chat (/chat) - the two features have genuinely
// different privacy models (org-wide/everyone-can-read vs. exactly-two-
// participants-private, see directMessage.controller.js's own top
// comment) and this page's own two-pane layout (conversation list +
// active conversation) has no equivalent in the single-channel
// OrganizationChat.jsx. Where the underlying UX problem is IDENTICAL
// (polling merge/dedup, auto-scroll-only-if-near-bottom, attachment
// selection/preview, Enter-to-send), this file deliberately reuses the
// exact same proven approach/CSS classes OrganizationChat.jsx already
// established (task spec section 38: "Reuse Organization Chat behavior if
// suitable") rather than inventing a second, subtly different one.
//
// NO @MENTIONS (task spec section 44) - message content here is always
// plain text, rendered directly, never passed through a mention
// tokenizer - a 1:1 conversation has only one other possible participant,
// so a `@` a person types remains completely ordinary text.

const CONVERSATION_POLL_INTERVAL_MS = 15000;
const MESSAGE_POLL_INTERVAL_MS = 5000;
const MAX_CONTENT_LENGTH = 2000;
// DOC-73 (task spec section 19) - identical to DOC-70's own limits, since
// the backend reuses middleware/chatUpload.js unchanged for DM attachments
// (see routes/directMessage.routes.js's own comment) - kept here purely
// for fast, consistent client-side feedback; the backend remains
// authoritative and re-validates every one of these independently.
const ALLOWED_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'];
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 3;
const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(',');
// Task spec section 53 - "debounced frontend" user search.
const USER_SEARCH_DEBOUNCE_MS = 250;
const NEAR_BOTTOM_THRESHOLD_PX = 80;

const ROLE_LABELS = { manager: 'Manager', operator: 'Operator', employee: 'Employee' };

function RoleBadge({ role }) {
  if (!role || !ROLE_LABELS[role]) return null;
  return <span className={`status-badge chat-role-badge status-role-${role}`}>{ROLE_LABELS[role]}</span>;
}

// Task spec section 35 - "Reuse DOC-71 Avatar... avoid duplicate avatar
// logic." The backend's user-summary shape (sanitizeUserSummary,
// directMessage.controller.js) deliberately returns only `hasProfileImage`
// - never a pre-built URL, mirroring DOC-72's own mention-suggestion
// minimalism - so this small helper builds the SAME authenticated
// content-proxy URL shape auth.controller.js's own `sanitizeProfileImage`
// already establishes (`/users/:userId/profile-image`), since
// GET /api/users/:userId/profile-image already allows any same-
// Organization viewer (userProfileImage.controller.js's own
// `canViewProfileImage`) - no new backend field or endpoint is needed for
// Avatar.jsx to render another participant's real photo.
function profileImageUrlFor(participant) {
  if (!participant || !participant.hasProfileImage || !participant.id) return null;
  return `/users/${participant.id}/profile-image`;
}

function formatMessageTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatFullTimestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function formatRelativeConversationTime(value) {
  if (!value) return '';
  const target = new Date(value);
  const now = new Date();
  const diffMs = now.getTime() - target.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Merges a freshly-fetched batch of messages into the existing list for
// ONE conversation, de-duplicating by id - identical contract to
// OrganizationChat.jsx's own `mergeMessages` (never clears/replaces what
// is already on screen; re-sorts ascending with `id` as a stable
// secondary key).
function mergeMessages(existing, incoming) {
  const byId = new Map(existing.map((message) => [message.id, message]));
  incoming.forEach((message) => byId.set(message.id, message));
  return Array.from(byId.values()).sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

function mergeConversationsPreservingOrder(incoming) {
  // The backend already returns conversations sorted by most-recent
  // activity (lastMessageAt desc) - this is a thin passthrough kept as its
  // own function so a future client-side re-sort (e.g. pinning) would have
  // exactly one place to change.
  return incoming;
}

function Messages() {
  const { token } = useAuth();

  // --- Conversation list --------------------------------------------
  const [conversations, setConversations] = useState(null); // null = not loaded yet
  const [conversationsError, setConversationsError] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  // Mobile layout: which pane is currently shown (task spec section 32 -
  // "Conversation list -> tap conversation -> conversation view. Provide
  // back button to list."). Ignored entirely on wide viewports via CSS
  // (both panes always render side by side there - see index.css).
  const [mobilePane, setMobilePane] = useState('list');

  const conversationsFetchInFlightRef = useRef(false);

  const loadConversations = useCallback(async () => {
    if (conversationsFetchInFlightRef.current) return;
    conversationsFetchInFlightRef.current = true;
    try {
      const response = await directMessageApi.listConversations(token);
      setConversations(mergeConversationsPreservingOrder(response.data));
      setConversationsError('');
    } catch (error) {
      setConversationsError(error.message);
    } finally {
      conversationsFetchInFlightRef.current = false;
    }
  }, [token]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Task spec section 36 - "conversation list every ~10-20 seconds".
  useEffect(() => {
    const intervalId = setInterval(() => {
      loadConversations();
    }, CONVERSATION_POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [loadConversations]);

  const selectedConversation = useMemo(
    () => (conversations || []).find((conversation) => conversation.id === selectedConversationId) || null,
    [conversations, selectedConversationId],
  );

  // --- New conversation: user search ----------------------------------
  const [searchQuery, setSearchQuery] = useState('');
  // Whether the search dropdown is currently open at all - a separate flag
  // from `searchQuery` so focusing an EMPTY search box can still trigger
  // the backend's own "empty q returns a same-org browse list" behavior
  // (task spec section 12) on its very first render, not only once the
  // person has typed something.
  const [searchActivated, setSearchActivated] = useState(false);
  const [searchResults, setSearchResults] = useState(null); // null = loading/not yet returned
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [startPending, setStartPending] = useState(false);

  useEffect(() => {
    if (!searchActivated) return undefined;
    let cancelled = false;
    setSearchLoading(true);
    const timeoutId = setTimeout(async () => {
      try {
        const response = await directMessageApi.searchUsers(token, searchQuery.trim());
        if (!cancelled) {
          setSearchResults(response.data);
          setSearchError('');
        }
      } catch (error) {
        if (!cancelled) setSearchError(error.message);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, USER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [searchActivated, searchQuery, token]);

  const handleFocusSearch = () => {
    setSearchActivated(true);
  };

  const closeSearch = () => {
    setSearchActivated(false);
    setSearchResults(null);
    setSearchQuery('');
    setSearchError('');
  };

  const handleStartConversation = async (candidate) => {
    if (startPending) return;
    setStartPending(true);
    setSearchError('');
    try {
      const response = await directMessageApi.createConversation(candidate.id, token);
      closeSearch();
      await loadConversations();
      setSelectedConversationId(response.data.id);
      setMobilePane('conversation');
    } catch (error) {
      setSearchError(error.message);
    } finally {
      setStartPending(false);
    }
  };

  // --- Active conversation: messages ----------------------------------
  const [messages, setMessages] = useState(null); // null = not loaded for the current conversation
  const [messagesError, setMessagesError] = useState('');
  const [hasNewMessages, setHasNewMessages] = useState(false);

  const messagesFetchInFlightRef = useRef(false);
  const listContainerRef = useRef(null);
  const hasLoadedOnceRef = useRef(false);
  const isNearBottomRef = useRef(true);
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

  // Task spec section 28/34 - marking read is best-effort/non-blocking:
  // a failure here never prevents the person from reading what is already
  // on screen, and the next successful call (or the next time they open
  // this conversation) simply tries again.
  const markRead = useCallback(async (conversationId) => {
    if (!conversationId) return;
    try {
      await directMessageApi.markRead(conversationId, token);
      setConversations((prev) => (prev || []).map((conversation) => (
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation
      )));
    } catch (error) {
      // Non-blocking - see this function's own top comment.
    }
  }, [token]);

  const loadMessages = useCallback(async (conversationId) => {
    if (!conversationId || messagesFetchInFlightRef.current) return;
    messagesFetchInFlightRef.current = true;
    try {
      const response = await directMessageApi.listMessages(conversationId, token);
      setMessages(response.data);
      setMessagesError('');
    } catch (error) {
      setMessagesError(error.message);
    } finally {
      messagesFetchInFlightRef.current = false;
    }
  }, [token]);

  const handleSelectConversation = (conversationId) => {
    if (conversationId === selectedConversationId) {
      setMobilePane('conversation');
      return;
    }
    setSelectedConversationId(conversationId);
    setMessages(null);
    setMessagesError('');
    setHasNewMessages(false);
    hasLoadedOnceRef.current = false;
    lastSeenNewestIdRef.current = null;
    isNearBottomRef.current = true;
    setMobilePane('conversation');
  };

  useEffect(() => {
    if (!selectedConversationId) return;
    loadMessages(selectedConversationId).then(() => markRead(selectedConversationId));
  }, [selectedConversationId, loadMessages, markRead]);

  // Auto-scroll-only-if-near-bottom, identical contract to
  // OrganizationChat.jsx's own effect (task spec section 38).
  useEffect(() => {
    if (messages === null) return;
    const newest = messages.length > 0 ? messages[messages.length - 1] : null;

    if (!hasLoadedOnceRef.current) {
      hasLoadedOnceRef.current = true;
      isNearBottomRef.current = true;
      lastSeenNewestIdRef.current = newest ? newest.id : null;
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

  // Task spec section 36 - "active conversation more frequently, e.g.
  // ~5 seconds". Task spec section 37 - "Do not perform unnecessary
  // requests when page/tab not active if easily avoidable": skipped
  // entirely while the document is hidden (backgrounded tab), the cheapest
  // possible version of that requirement with no extra state to manage.
  useEffect(() => {
    if (!selectedConversationId) return undefined;
    const intervalId = setInterval(async () => {
      if (document.hidden) return;
      if (messagesFetchInFlightRef.current) return;
      messagesFetchInFlightRef.current = true;
      try {
        const response = await directMessageApi.listMessages(selectedConversationId, token);
        setMessages((prev) => mergeMessages(prev || [], response.data));
        // A poll tick may have just brought in a new message from the
        // other participant while this conversation is the one currently
        // open - immediately mark it read rather than waiting for the
        // person to switch away and back (task spec section 34: "new
        // message after lastRead increments again" implies the reverse
        // is also true while actively viewing).
        const incomingFromOther = response.data.some((message) => !message.isOwnMessage);
        if (incomingFromOther) {
          markRead(selectedConversationId);
        }
      } catch (error) {
        // Silent/non-blocking - identical to OrganizationChat.jsx's own
        // poll-tick failure handling.
      } finally {
        messagesFetchInFlightRef.current = false;
      }
    }, MESSAGE_POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [selectedConversationId, token, markRead]);

  const handleBackToList = () => {
    setMobilePane('list');
  };

  // --- Composer ---------------------------------------------------------
  const [draft, setDraft] = useState('');
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [selectedAttachments, setSelectedAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const fileInputRef = useRef(null);

  const trimmedDraft = draft.trim();
  const overLimit = draft.length > MAX_CONTENT_LENGTH;
  const sendDisabled = sendPending
    || overLimit
    || !selectedConversationId
    || (trimmedDraft.length === 0 && selectedAttachments.length === 0);

  useEffect(() => () => {
    selectedAttachments.forEach((entry) => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clears the composer's own draft/attachments/errors whenever the
  // selected conversation changes - a half-typed message for conversation
  // A must never leak into conversation B (task spec has no explicit
  // instruction either way, but this is the safer, less surprising
  // default, and mirrors how a single shared OrganizationChat composer has
  // no such issue only because there is exactly one channel there).
  useEffect(() => {
    setDraft('');
    setSendError('');
    setAttachmentError('');
    setSelectedAttachments((prev) => {
      prev.forEach((entry) => {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      });
      return [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversationId]);

  const handleAttachClick = () => {
    if (sendPending) return;
    fileInputRef.current?.click();
  };

  const handleFilesSelected = (event) => {
    const files = Array.from(event.target.files || []);
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

  const submitDraft = async () => {
    if (sendDisabled) return;
    setSendPending(true);
    setSendError('');
    try {
      const files = selectedAttachments.map((entry) => entry.file);
      const response = await directMessageApi.sendMessage(selectedConversationId, trimmedDraft, files, token);
      isNearBottomRef.current = true;
      setHasNewMessages(false);
      setMessages((prev) => mergeMessages(prev || [], [response.data]));
      setDraft('');
      selectedAttachments.forEach((entry) => {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      });
      setSelectedAttachments([]);
      setAttachmentError('');
      // Refresh the conversation list so its preview/lastMessageAt reflect
      // this new message immediately, rather than waiting up to
      // CONVERSATION_POLL_INTERVAL_MS for the next tick.
      loadConversations();
    } catch (error) {
      setSendError(error.message);
    } finally {
      setSendPending(false);
    }
  };

  const handleSend = (event) => {
    event.preventDefault();
    submitDraft();
  };

  const handleComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      submitDraft();
    }
  };

  return (
    <section className="page messages-page">
      <div className={`messages-shell messages-mobile-${mobilePane}`}>
        <aside className="messages-sidebar">
          <div className="messages-sidebar-header">
            <h1 className="messages-sidebar-title">Messages</h1>
            <div className="messages-search-wrap">
              <input
                type="text"
                className="messages-search-input"
                placeholder="Search people to message…"
                value={searchQuery}
                onFocus={handleFocusSearch}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label="Search people to message"
              />
              {searchActivated && (
                <ul className="messages-search-dropdown" role="listbox">
                  {(searchLoading || searchResults === null) && <li className="messages-search-empty">Searching…</li>}
                  {!searchLoading && searchResults !== null && searchResults.length === 0 && (
                    <li className="messages-search-empty">No matching users</li>
                  )}
                  {!searchLoading && searchResults !== null && searchResults.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        className="messages-search-result"
                        disabled={startPending}
                        onClick={() => handleStartConversation(candidate)}
                      >
                        <Avatar profileImageUrl={profileImageUrlFor(candidate)} fullName={candidate.fullName} size="small" />
                        <span className="messages-search-result-name">{candidate.fullName}</span>
                        <RoleBadge role={candidate.role} />
                      </button>
                    </li>
                  ))}
                  <li className="messages-search-dropdown-close">
                    <button type="button" className="btn btn-outline btn-small" onClick={closeSearch}>
                      Close
                    </button>
                  </li>
                </ul>
              )}
              {searchError && <span className="form-error" role="alert">{searchError}</span>}
            </div>
          </div>

          <div className="messages-conversation-list">
            {conversations === null && !conversationsError && (
              <div className="chat-loading-state" role="status" aria-live="polite">
                <span className="chat-loading-spinner" aria-hidden="true" />
                <span>Loading conversations…</span>
              </div>
            )}
            {conversationsError && (
              <div className="chat-error-block" role="alert" aria-live="assertive">
                <p className="form-error form-error-server">{conversationsError}</p>
                <button type="button" className="btn btn-outline" onClick={loadConversations}>Retry</button>
              </div>
            )}
            {conversations !== null && !conversationsError && conversations.length === 0 && (
              <EmptyState
                title="No conversations yet"
                message="Start a private conversation with someone in your organization."
              />
            )}
            {conversations !== null && !conversationsError && conversations.length > 0 && (
              <ul className="messages-conversation-items">
                {conversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={
                        conversation.id === selectedConversationId
                          ? 'messages-conversation-item messages-conversation-item-active'
                          : 'messages-conversation-item'
                      }
                      onClick={() => handleSelectConversation(conversation.id)}
                    >
                      <Avatar
                        profileImageUrl={profileImageUrlFor(conversation.otherParticipant)}
                        fullName={conversation.otherParticipant?.fullName}
                        size="medium"
                      />
                      <span className="messages-conversation-info">
                        <span className="messages-conversation-top-row">
                          <span className="messages-conversation-name">{conversation.otherParticipant?.fullName || 'Unknown user'}</span>
                          <span className="messages-conversation-time">{formatRelativeConversationTime(conversation.lastMessageAt)}</span>
                        </span>
                        <span className="messages-conversation-bottom-row">
                          <span className="messages-conversation-preview">
                            {conversation.lastMessagePreview || 'No messages yet'}
                          </span>
                          {conversation.unreadCount > 0 && (
                            <span className="messages-unread-badge">
                              {conversation.unreadCount > 9 ? '9+' : conversation.unreadCount}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="messages-conversation-pane">
          {!selectedConversation && (
            <EmptyState
              title="Select a conversation"
              message="Choose someone from the list, or search for a coworker to start a new private conversation."
            />
          )}

          {selectedConversation && (
            <>
              <header className="messages-conversation-header">
                <button type="button" className="messages-back-btn" onClick={handleBackToList} aria-label="Back to conversation list">
                  ←
                </button>
                <Avatar
                  profileImageUrl={profileImageUrlFor(selectedConversation.otherParticipant)}
                  fullName={selectedConversation.otherParticipant?.fullName}
                  size="medium"
                />
                <span className="messages-conversation-header-info">
                  <span className="messages-conversation-header-name">{selectedConversation.otherParticipant?.fullName || 'Unknown user'}</span>
                  <RoleBadge role={selectedConversation.otherParticipant?.role} />
                </span>
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
                    <button type="button" className="btn btn-outline" onClick={() => loadMessages(selectedConversationId)}>Retry</button>
                  </div>
                )}

                {messages !== null && !messagesError && (
                  messages.length === 0 ? (
                    <EmptyState title="No messages yet" message="Send the first message." />
                  ) : (
                    <div className="chat-message-area">
                      <div className="chat-message-list" ref={listContainerRef} onScroll={handleScroll}>
                        {messages.map((message) => {
                          const bubbleClassName = [
                            'chat-message',
                            message.isOwnMessage ? 'chat-message-own' : 'chat-message-other',
                          ].join(' ');
                          return (
                            <div key={message.id} className={bubbleClassName}>
                              {message.content && (
                                <p className="chat-message-content">{message.content}</p>
                              )}
                              {message.attachments && message.attachments.length > 0 && (
                                <div className="chat-message-attachments">
                                  {message.attachments.map((attachment) => (
                                    <AuthenticatedChatAttachment key={attachment.id} attachment={attachment} />
                                  ))}
                                </div>
                              )}
                              <span className="chat-message-timestamp chat-message-timestamp-grouped" title={formatFullTimestamp(message.createdAt)}>
                                {formatMessageTime(message.createdAt)}
                              </span>
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
                <label htmlFor="dm-message-input" className="sr-only">Message</label>
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
                  <textarea
                    id="dm-message-input"
                    className="chat-composer-input"
                    rows={2}
                    maxLength={MAX_CONTENT_LENGTH + 200}
                    placeholder="Write a private message… (Enter to send, Shift+Enter for a new line)"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={sendPending}
                    aria-describedby="dm-char-counter"
                  />
                  <button type="submit" className="btn btn-primary chat-send-btn" disabled={sendDisabled}>
                    {sendPending ? 'Sending…' : 'Send'}
                  </button>
                </div>
                <div className="chat-composer-meta">
                  <span id="dm-char-counter" className={overLimit ? 'chat-char-counter chat-char-counter-over' : 'chat-char-counter'}>
                    {draft.length} / {MAX_CONTENT_LENGTH}
                  </span>
                  {overLimit && <span className="form-error">Message must be at most {MAX_CONTENT_LENGTH} characters.</span>}
                  {sendError && <span className="form-error form-error-server" role="alert">{sendError}</span>}
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

export default Messages;
