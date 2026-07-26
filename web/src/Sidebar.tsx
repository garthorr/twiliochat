import { useEffect, useMemo, useState } from "react";
import { api, type Conversation, type SearchHit } from "./api";
import type { Selection } from "./Messenger";
import {
  avatarHue,
  avatarInitials,
  conversationName,
  sidebarTime,
} from "./format";
import { disablePush, enablePush, pushState, type PushState } from "./push";
import { setSoundsEnabled, soundsEnabled } from "./sounds";

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
  showArchived,
  onSelect,
  onCompose,
  onArchive,
  onDelete,
  onToggleArchived,
  onOpenContacts,
  onLogout,
}: {
  conversations: Conversation[];
  selected: Selection;
  showArchived: boolean;
  onSelect: (id: string) => void;
  onCompose: () => void;
  onArchive: (id: string, archived: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggleArchived: () => void;
  onOpenContacts: () => void;
  onLogout: () => void;
}) {
  const [search, setSearch] = useState("");
  const [push, setPush] = useState<PushState>("unsupported");
  const [sounds, setSounds] = useState(true);
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => setSounds(soundsEnabled()), []);

  // Search message bodies server-side, debounced; local filtering stays instant.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .search(q)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    pushState()
      .then(setPush)
      .catch(() => setPush("unsupported"));
  }, []);

  const togglePush = async () => {
    setPush(push === "on" ? await disablePush() : await enablePush());
  };

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
        <h1>{showArchived ? "Archived" : "Messages"}</h1>
        <div className="sidebar-actions">
          <button
            className={`icon-button ${sounds ? "active" : ""}`}
            title={sounds ? "Message sounds on" : "Message sounds off"}
            aria-label="Toggle message sounds"
            aria-pressed={sounds}
            onClick={() => {
              setSoundsEnabled(!sounds);
              setSounds(!sounds);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M11 5 6.5 9H3v6h3.5L11 19V5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              {sounds ? (
                <path
                  d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="M15.5 9.5l5 5m0-5l-5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
          {(push === "on" || push === "off" || push === "denied") && (
            <button
              className={`icon-button ${push === "on" ? "active" : ""}`}
              title={
                push === "on"
                  ? "Notifications on"
                  : push === "denied"
                    ? "Notifications blocked in browser settings"
                    : "Enable notifications"
              }
              aria-label="Toggle notifications"
              aria-pressed={push === "on"}
              disabled={push === "denied"}
              onClick={() => void togglePush()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3a5.5 5.5 0 0 1 5.5 5.5c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5A5.5 5.5 0 0 1 12 3zM10 18a2 2 0 0 0 4 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {push !== "on" && (
                  <path
                    d="M4 4l16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
          )}
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
            title="Contacts"
            aria-label="Contacts"
            onClick={onOpenContacts}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6 3h13v18H6zM3 7h3M3 12h3M3 17h3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="12.5" cy="10" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M9 16c0-2 1.6-3 3.5-3s3.5 1 3.5 3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className={`icon-button ${showArchived ? "active" : ""}`}
            title={showArchived ? "Back to Messages" : "Show Archived"}
            aria-label="Toggle archived"
            aria-pressed={showArchived}
            onClick={onToggleArchived}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M3 6h18v3H3zM5 9v10h14V9M10 13h4"
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
        {visible.length === 0 && hits.length === 0 && (
          <p className="empty-hint">
            {conversations.length === 0 ? "No conversations yet" : "No results"}
          </p>
        )}
        {visible.map((c) => (
          <div
            key={c.id}
            className={`conversation-row ${selected === c.id ? "selected" : ""}`}
          >
            <button className="row-open" onClick={() => onSelect(c.id)}>
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
            <div className="row-actions">
              <button
                className="row-action"
                title={showArchived ? "Unarchive" : "Archive"}
                aria-label={showArchived ? "Unarchive" : "Archive"}
                onClick={() => void onArchive(c.id, !showArchived)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M3 6h18v3H3zM5 9v10h14V9M10 13h4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className="row-action"
                title="Delete"
                aria-label="Delete conversation"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete the conversation with ${conversationName(c)}? This removes its messages and any photos, and cannot be undone.`,
                    )
                  ) {
                    void onDelete(c.id);
                  }
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M5 7h14M10 7V5h4v2M6 7l1 12h10l1-12M10 11v5M14 11v5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {hits.length > 0 && (
          <>
            <p className="list-section-label">Messages</p>
            {hits.map((hit) => (
              <button
                key={hit.message.id}
                className="conversation-row row-open"
                onClick={() => onSelect(hit.conversation.id)}
              >
                <span className="unread-dot" />
                <Avatar conversation={hit.conversation} />
                <span className="row-main">
                  <span className="row-top">
                    <span className="row-name">
                      {conversationName(hit.conversation)}
                    </span>
                    <span className="row-time">
                      {sidebarTime(hit.message.createdAt)}
                    </span>
                  </span>
                  <span className="row-preview">{hit.message.body}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
