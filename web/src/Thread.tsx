import { useEffect, useRef, useState } from "react";
import type { Conversation, Message } from "./api";
import { ApiError } from "./api";
import { conversationName, dividerLabel } from "./format";

const CLUSTER_GAP_MS = 60_000;
const DIVIDER_GAP_MS = 3_600_000;

function statusLabel(status: Message["status"]): string {
  switch (status) {
    case "queued":
      return "Sending…";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Not Delivered";
    default:
      return "";
  }
}

function Attachments({
  message,
  onOpen,
}: {
  message: Message;
  onOpen: (src: string) => void;
}) {
  const items = message.attachments ?? [];
  if (items.length === 0) return null;
  return (
    <div className="attachments">
      {items.map((a) => {
        const src = `/media/${a.path}`;
        if (a.contentType.startsWith("image/")) {
          return (
            <button
              key={a.id}
              className="attachment-image"
              onClick={() => onOpen(src)}
              aria-label="View image"
            >
              <img src={src} alt="" loading="lazy" />
            </button>
          );
        }
        if (a.contentType.startsWith("video/")) {
          return <video key={a.id} className="attachment-video" src={src} controls />;
        }
        return (
          <a key={a.id} className="attachment-file" href={src} download>
            Attachment ({a.contentType})
          </a>
        );
      })}
    </div>
  );
}

function MessageList({
  messages,
  onRetry,
}: {
  messages: Message[];
  onRetry: (messageId: string) => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const rows: React.ReactNode[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const gapFromPrev = prev
      ? Date.parse(m.createdAt) - Date.parse(prev.createdAt)
      : Infinity;
    if (gapFromPrev > DIVIDER_GAP_MS) {
      rows.push(
        <div key={`divider-${m.id}`} className="date-divider">
          {dividerLabel(m.createdAt)}
        </div>,
      );
    }
    const gapToNext = next
      ? Date.parse(next.createdAt) - Date.parse(m.createdAt)
      : Infinity;
    const endsCluster =
      !next || next.direction !== m.direction || gapToNext > CLUSTER_GAP_MS;
    const isLast = i === messages.length - 1;
    const showStatus =
      m.direction === "outbound" && (m.status === "failed" || isLast);

    const hasMedia = (m.attachments?.length ?? 0) > 0;
    rows.push(
      <div
        key={m.id}
        className={`bubble-row ${m.direction} ${endsCluster ? "tail" : ""}`}
      >
        <div
          className={`bubble ${m.status === "failed" ? "failed" : ""} ${
            hasMedia && !m.body ? "media-only" : ""
          }`}
        >
          <Attachments message={m} onOpen={setLightbox} />
          {m.body}
        </div>
      </div>,
    );
    if (showStatus && statusLabel(m.status)) {
      rows.push(
        <div
          key={`status-${m.id}`}
          className={`delivery-status ${m.status === "failed" ? "failed" : ""}`}
        >
          {statusLabel(m.status)}
          {m.status === "failed" && m.errorCode ? ` (error ${m.errorCode})` : ""}
          {m.status === "failed" && (
            <button
              className="retry-button"
              disabled={retrying === m.id}
              onClick={async () => {
                setRetrying(m.id);
                try {
                  await onRetry(m.id);
                } finally {
                  setRetrying(null);
                }
              }}
            >
              {retrying === m.id ? "Retrying…" : "Try Again"}
            </button>
          )}
        </div>,
      );
    }
  });

  return (
    <div className="message-scroll" ref={scrollRef}>
      <div className="message-list">{rows}</div>
      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-label="Image viewer"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" />
        </div>
      )}
    </div>
  );
}

function Composer({
  onSend,
  autoFocus,
}: {
  onSend: (body: string) => Promise<void>;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const autosize = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    setDraft("");
    requestAnimationFrame(autosize);
    try {
      await onSend(body);
    } catch (err) {
      setDraft(body); // let the user retry without retyping
      setError(err instanceof ApiError ? err.message : "Send failed");
    }
  };

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-bar">
        <textarea
          ref={areaRef}
          rows={1}
          autoFocus={autoFocus}
          placeholder="Text Message"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className={`send-button ${draft.trim() ? "active" : ""}`}
          aria-label="Send"
          onClick={() => void submit()}
          disabled={!draft.trim()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 19V6m0 0-6 6m6-6 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function Thread({
  mode,
  conversation,
  messages,
  onSend,
  onRetry,
  onRename,
  onBack,
}: {
  mode: "existing" | "new" | "none";
  conversation: Conversation | null;
  messages: Message[];
  onSend: (to: string, body: string) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
  onRename: (conversationId: string, displayName: string | null) => Promise<void>;
  onBack: () => void;
}) {
  const [composeTo, setComposeTo] = useState("");

  const promptRename = () => {
    if (!conversation) return;
    const next = window.prompt(
      "Contact name (leave empty to show the phone number)",
      conversation.displayName ?? "",
    );
    if (next === null) return;
    void onRename(conversation.id, next.trim() || null);
  };

  if (mode === "none") {
    return (
      <main className="thread">
        <div className="thread-empty">
          <p className="thread-empty-title">No Conversation Selected</p>
          <p className="thread-empty-sub">
            Choose a conversation or start a new one
          </p>
        </div>
      </main>
    );
  }

  const title =
    mode === "new" ? "New Message" : conversationName(conversation!);

  return (
    <main className="thread">
      <header className="thread-header">
        <button className="back-button" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M15 4l-8 8 8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="thread-title">{title}</div>
        {mode === "existing" && (
          <button
            className="icon-button rename-button"
            title="Rename contact"
            aria-label="Rename contact"
            onClick={promptRename}
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
        )}
      </header>
      {mode === "new" && (
        <div className="compose-to">
          <label htmlFor="compose-to">To:</label>
          <input
            id="compose-to"
            autoFocus
            type="tel"
            placeholder="Phone number"
            value={composeTo}
            onChange={(e) => setComposeTo(e.target.value)}
          />
        </div>
      )}
      <MessageList messages={messages} onRetry={onRetry} />
      <Composer
        autoFocus={mode === "existing"}
        onSend={(body) =>
          onSend(
            mode === "new" ? composeTo : conversation!.participants[0]!,
            body,
          )
        }
      />
    </main>
  );
}
