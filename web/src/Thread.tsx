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

function MessageList({ messages }: { messages: Message[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

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

    rows.push(
      <div
        key={m.id}
        className={`bubble-row ${m.direction} ${endsCluster ? "tail" : ""}`}
      >
        <div className={`bubble ${m.status === "failed" ? "failed" : ""}`}>
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
        </div>,
      );
    }
  });

  return (
    <div className="message-scroll" ref={scrollRef}>
      <div className="message-list">{rows}</div>
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
  onBack,
}: {
  mode: "existing" | "new" | "none";
  conversation: Conversation | null;
  messages: Message[];
  onSend: (to: string, body: string) => Promise<void>;
  onBack: () => void;
}) {
  const [composeTo, setComposeTo] = useState("");

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
      <MessageList messages={messages} />
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
