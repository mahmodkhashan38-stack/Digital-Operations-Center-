import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { directMessageApi } from '../services/api.js';

// DOC-73 - "Private Direct Messages" (task spec section 30: "Add a
// Messages entry/icon if UI architecture supports it. Show total unread
// DM count. Do not merge this visually with Notification count unless
// clearly designed."). A small, self-contained badge mounted next to the
// "Messages" Navbar link - deliberately its OWN component/polling loop,
// never merged into NotificationBell.jsx's own count or UI: the two are
// conceptually different inboxes (Notifications vs. private
// conversations) and the task spec explicitly warns against conflating
// them visually.
//
// There is no dedicated "unread DM count" backend endpoint - reusing
// GET /api/direct-messages/conversations (already capped at 100
// conversations, and each conversation's own `unreadCount` is already
// computed via ONE batched aggregation query server-side - see
// directMessage.controller.js's own `buildUnreadCountMap`) and summing
// client-side is simpler than adding a second endpoint whose only job
// would be the exact same sum. Polls independently from Messages.jsx's own
// conversation-list polling (this component may be mounted on any page,
// not just /messages) at the same ~15-20 second cadence task spec section
// 36 recommends for a conversation list.
const POLL_INTERVAL_MS = 20000;

function DirectMessageNavBadge() {
  const { token, isAuthenticated } = useAuth();
  const [unreadTotal, setUnreadTotal] = useState(0);
  const fetchInFlightRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const loadUnreadTotal = async () => {
      if (fetchInFlightRef.current) return;
      fetchInFlightRef.current = true;
      try {
        const response = await directMessageApi.listConversations(token);
        const total = (response.data || []).reduce((sum, conversation) => sum + (conversation.unreadCount || 0), 0);
        setUnreadTotal(total);
      } catch (error) {
        // Silent/non-blocking - a badge that briefly fails to refresh is
        // not worth surfacing an error for; the next tick simply retries.
      } finally {
        fetchInFlightRef.current = false;
      }
    };

    loadUnreadTotal();
    const intervalId = setInterval(loadUnreadTotal, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [isAuthenticated, token]);

  if (unreadTotal <= 0) {
    return null;
  }

  return (
    <span className="notification-badge messages-nav-badge">
      {unreadTotal > 9 ? '9+' : unreadTotal}
    </span>
  );
}

export default DirectMessageNavBadge;
