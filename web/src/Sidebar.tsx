import { useMemo, useState } from "react";
import type { Conversation } from "./api";
import type { Selection } from "./Messenger";
import {
  avatarHue,
  avatarInitials,
  conversationName,
  sidebarTime,
} from "./format";

function Avatar({ conversation }: { conversation: Conversation }) {
  const initials = avatarInitials(conversation);
  const hue = avatarHue(conversation.participants.join(","));
  return (
    <div
      className="avatar"
      style={{
        background: `linear-gradient(180deg, hsl(${hue} 45% 65%), hsl(${hue} 55% 48%))`,
      }}
    >
      {initials ?? (
        <svg viewBox="0 0 24 24" className="avatar-person" aria-hidden="true">
          <circle cx="12" cy="9" r="4" fill="currentColor" />
          <path
            d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"
            fill="currentColor"
          />
        </svg>
      )}
    </div>
  );
}

export function Sidebar({
  conversations,
  selected,
  onSelect,
  onCompose,
  onLogout,
}: {
  conversations: Conversation[];
  selected: Selection;
  onSelect: (id: string) => void;
  onCompose: () => void;
  onLogout: () => void;
}) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        conversationName(c).toLowerCase().includes(q) ||
        c.participants.some((p) => p.includes(q)) ||
        (c.lastMessage?.body ?? "").toLowerCase().includes(q),
    );
  }, [conversations, search]);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>Messages</h1>
        <div className="sidebar-actions">
          <button
            className="icon-button"
            title="New Message"
            aria-label="New Message"
            onClick={onCompose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M16.5 3.9a2.1 2.1 0 0 1 3 3L8 18.4l-4 1 1-4L16.5 3.9z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="icon-button"
            title="Sign Out"
            aria-label="Sign Out"
            onClick={onLogout}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M9 4h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H9M13 12H3m0 0 3.5-3.5M3 12l3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>
      <input
        className="search"
        type="search"
        placeholder="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="conversation-list">
        {visible.length === 0 && (
          <p className="empty-hint">
            {conversations.length === 0 ? "No conversations yet" : "No results"}
          </p>
        )}
        {visible.map((c) => (
          <button
            key={c.id}
            className={`conversation-row ${selected === c.id ? "selected" : ""}`}
            onClick={() => onSelect(c.id)}
          >
            <span className={`unread-dot ${c.unreadCount > 0 ? "on" : ""}`} />
            <Avatar conversation={c} />
            <span className="row-main">
              <span className="row-top">
                <span className="row-name">{conversationName(c)}</span>
                {c.lastMessageAt && (
                  <span className="row-time">{sidebarTime(c.lastMessageAt)}</span>
                )}
              </span>
              <span className="row-preview">
                {c.lastMessage
                  ? (c.lastMessage.direction === "outbound" ? "You: " : "") +
                    c.lastMessage.body
                  : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
