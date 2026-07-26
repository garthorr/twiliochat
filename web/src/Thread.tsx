import { useEffect, useRef, useState } from "react";
import type { Conversation, Message, StagedMedia } from "./api";
import { api, ApiError } from "./api";
import { conversationName, dividerLabel } from "./format";
import { segmentInfo, shouldShowCounter } from "./segments";

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
  hasMore,
  optedOut,
  onRetry,
  onLoadOlder,
}: {
  messages: Message[];
  hasMore: boolean;
  optedOut: boolean;
  onRetry: (messageId: string) => Promise<void>;
  onLoadOlder: () => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldestIdRef = useRef<string | null>(null);
  const prevHeightRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const oldestId = messages[0]?.id ?? null;
    if (oldestIdRef.current && oldestId !== oldestIdRef.current) {
      // Older page prepended — hold the viewport where the user was reading.
      el.scrollTop = el.scrollHeight - prevHeightRef.current;
    } else {
      el.scrollTop = el.scrollHeight;
    }
    oldestIdRef.current = oldestId;
    prevHeightRef.current = el.scrollHeight;
  }, [messages]);

  const onScroll = async () => {
    const el = scrollRef.current;
    if (!el || !hasMore || loadingOlder || el.scrollTop > 80) return;
    setLoadingOlder(true);
    prevHeightRef.current = el.scrollHeight;
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

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
          {m.status === "failed" && !optedOut && (
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
    <div className="message-scroll" ref={scrollRef} onScroll={() => void onScroll()}>
      <div className="message-list">
        {hasMore && (
          <div className="load-older">
            {loadingOlder ? "Loading earlier messages…" : "Scroll up for more"}
          </div>
        )}
        {rows}
      </div>
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
  disabled,
}: {
  onSend: (body: string, media: StagedMedia[]) => Promise<void>;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<Array<StagedMedia & { preview: string }>>(
    [],
  );
  const [uploading, setUploading] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const info = segmentInfo(draft);

  const attach = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const media = await api.uploadAttachment(file);
      setStaged((prev) => [
        ...prev,
        { ...media, preview: URL.createObjectURL(file) },
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const autosize = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body && staged.length === 0) return;
    setError(null);
    setDraft("");
    const media = staged;
    setStaged([]);
    requestAnimationFrame(autosize);
    try {
      await onSend(body, media.map(({ preview: _preview, ...m }) => m));
      for (const m of media) URL.revokeObjectURL(m.preview);
    } catch (err) {
      // Let the user retry without retyping or re-picking the photo.
      setDraft(body);
      setStaged(media);
      setError(err instanceof ApiError ? err.message : "Send failed");
    }
  };

  return (
    <div className="composer">
      {error && <div className="composer-error">{error}</div>}
      {staged.length > 0 && (
        <div className="staged-media">
          {staged.map((m) => (
            <div key={m.path} className="staged-item">
              <img src={m.preview} alt="" />
              <button
                className="staged-remove"
                aria-label="Remove photo"
                onClick={() => {
                  URL.revokeObjectURL(m.preview);
                  setStaged((prev) => prev.filter((s) => s.path !== m.path));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-bar">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attach(file);
          }}
        />
        <button
          className="attach-button"
          aria-label="Attach photo"
          title="Attach photo"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <textarea
          ref={areaRef}
          rows={1}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={disabled ? "Messaging blocked" : "Text Message"}
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
          className={`send-button ${draft.trim() || staged.length > 0 ? "active" : ""}`}
          aria-label="Send"
          onClick={() => void submit()}
          disabled={disabled || (!draft.trim() && staged.length === 0)}
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
      {shouldShowCounter(info) && (
        <div className="segment-counter">
          {info.remaining} left · {info.segments} segment
          {info.segments === 1 ? "" : "s"}
          {info.encoding === "UCS-2" ? " (unicode)" : ""}
        </div>
      )}
    </div>
  );
}

export function Thread({
  mode,
  conversation,
  messages,
  hasMore,
  onLoadOlder,
  onSend,
  onRetry,
  onRename,
  onBack,
}: {
  mode: "existing" | "new" | "none";
  conversation: Conversation | null;
  messages: Message[];
  hasMore: boolean;
  onLoadOlder: (conversationId: string) => Promise<void>;
  onSend: (to: string, body: string, media: StagedMedia[]) => Promise<void>;
  onRetry: (messageId: string) => Promise<void>;
  onRename: (conversationId: string, displayName: string | null) => Promise<void>;
  onBack: () => void;
}) {
  const [composeTo, setComposeTo] = useState("");
  const optedOut = conversation?.optedOut ?? false;

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
      {optedOut && (
        <div className="optout-banner" role="status">
          <strong>This person has opted out.</strong> They replied STOP, so
          Twilio blocks messages to them until they text START.
        </div>
      )}
      <MessageList
        messages={messages}
        hasMore={hasMore}
        optedOut={optedOut}
        onRetry={onRetry}
        onLoadOlder={() => onLoadOlder(conversation!.id)}
      />
      <Composer
        autoFocus={mode === "existing"}
        disabled={optedOut}
        onSend={(body, media) =>
          onSend(
            mode === "new" ? composeTo : conversation!.participants[0]!,
            body,
            media,
          )
        }
      />
    </main>
  );
}
