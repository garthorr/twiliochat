import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { Conversation, Message, RealtimeEvent } from "./api";
import { Sidebar } from "./Sidebar";
import { playReceived, playSent } from "./sounds";
import { Thread } from "./Thread";
import { connectRealtime } from "./ws";

export type Selection = string | "new" | null;

function byRecency(a: Conversation, b: Conversation): number {
  const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
  const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
  return tb - ta;
}

export function Messenger({ onLogout }: { onLogout: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Selection>(null);
  const [messagesByConv, setMessagesByConv] = useState<Record<string, Message[]>>({});
  const [hasMoreByConv, setHasMoreByConv] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState(false);
  const selectedRef = useRef<Selection>(null);
  selectedRef.current = selected;
  const messagesByConvRef = useRef(messagesByConv);
  messagesByConvRef.current = messagesByConv;
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(
        (await api.conversations(showArchivedRef.current)).sort(byRecency),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
    }
  }, [onLogout]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const { messages, hasMore } = await api.messages(conversationId);
    setMessagesByConv((prev) => ({ ...prev, [conversationId]: messages }));
    setHasMoreByConv((prev) => ({ ...prev, [conversationId]: hasMore }));
  }, []);

  /** Prepend the previous page when the user scrolls to the top of a thread. */
  const loadOlder = useCallback(
    async (conversationId: string) => {
      const existing = messagesByConvRef.current[conversationId];
      const oldest = existing?.[0];
      if (!oldest) return;
      const { messages, hasMore } = await api.messages(
        conversationId,
        oldest.createdAt,
      );
      if (messages.length > 0) {
        setMessagesByConv((prev) => ({
          ...prev,
          [conversationId]: [...messages, ...(prev[conversationId] ?? [])],
        }));
      }
      setHasMoreByConv((prev) => ({ ...prev, [conversationId]: hasMore }));
    },
    [],
  );

  const upsertMessage = useCallback((message: Message) => {
    setMessagesByConv((prev) => {
      const list = prev[message.conversationId];
      if (!list) return prev; // thread not loaded yet; fetched on open
      const idx = list.findIndex((m) => m.id === message.id);
      const next =
        idx >= 0
          ? list.map((m) => (m.id === message.id ? message : m))
          : [...list, message];
      return { ...prev, [message.conversationId]: next };
    });
  }, []);

  const handleEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.type === "message.new") {
        const { conversation, message } = event;
        upsertMessage(message);
        if (message.direction === "inbound") playReceived();
        const isOpen = selectedRef.current === conversation.id;
        setConversations((prev) => {
          const rest = prev.filter((c) => c.id !== conversation.id);
          const merged: Conversation = {
            ...conversation,
            lastMessage: message,
            unreadCount: isOpen ? 0 : conversation.unreadCount,
          };
          return [merged, ...rest].sort(byRecency);
        });
        if (isOpen && message.direction === "inbound") {
          api.markRead(conversation.id).catch(() => {});
        }
      } else if (event.type === "message.status") {
        upsertMessage(event.message);
        setConversations((prev) =>
          prev.map((c) =>
            c.lastMessage?.id === event.message.id
              ? { ...c, lastMessage: event.message }
              : c,
          ),
        );
      } else if (event.type === "conversation.read") {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === event.conversationId ? { ...c, unreadCount: 0 } : c,
          ),
        );
      } else if (event.type === "conversation.updated") {
        const updated = event.conversation;
        setConversations((prev) => {
          // Archiving moves a thread out of (or into) the current list.
          if (updated.archived !== showArchivedRef.current) {
            return prev.filter((c) => c.id !== updated.id);
          }
          return prev.some((c) => c.id === updated.id)
            ? prev.map((c) =>
                c.id === updated.id
                  ? { ...updated, lastMessage: c.lastMessage }
                  : c,
              )
            : [...prev, updated].sort(byRecency);
        });
      } else if (event.type === "conversation.deleted") {
        setConversations((prev) =>
          prev.filter((c) => c.id !== event.conversationId),
        );
        if (selectedRef.current === event.conversationId) setSelected(null);
      }
    },
    [upsertMessage],
  );
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    return connectRealtime(
      (event) => handleEventRef.current(event),
      () => {
        // Initial connect and reconnects: refetch anything we may have missed.
        void refreshConversations();
        const current = selectedRef.current;
        if (current && current !== "new") void loadMessages(current);
      },
    );
  }, [refreshConversations, loadMessages]);

  const select = useCallback(
    (id: Selection) => {
      setSelected(id);
      if (!id || id === "new") return;
      void loadMessages(id);
      setConversations((prev) => {
        const conv = prev.find((c) => c.id === id);
        if (conv && conv.unreadCount > 0) {
          api.markRead(id).catch(() => {});
          return prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c));
        }
        return prev;
      });
    },
    [loadMessages],
  );

  // Deep links from notifications: ?c=<id> when the app is opened cold, or a
  // message from the service worker when an existing window is focused.
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get("c");
    if (fromUrl) {
      select(fromUrl);
      history.replaceState(null, "", location.pathname);
    }
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; conversationId?: string };
      if (data?.type === "open-conversation" && data.conversationId) {
        select(data.conversationId);
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [select]);

  const send = useCallback(
    async (to: string, body: string): Promise<void> => {
      const { conversationId, message } = await api.send(to, body);
      upsertMessage(message);
      if (message.status !== "failed") playSent();
      if (selectedRef.current === "new") {
        await refreshConversations();
        setSelected(conversationId);
        void loadMessages(conversationId);
      }
    },
    [upsertMessage, refreshConversations, loadMessages],
  );

  const retry = useCallback(
    async (messageId: string): Promise<void> => {
      const { message } = await api.retry(messageId);
      upsertMessage(message);
      if (message.status !== "failed") playSent();
    },
    [upsertMessage],
  );

  const rename = useCallback(
    async (conversationId: string, displayName: string | null) => {
      const { conversation } = await api.rename(conversationId, displayName);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversation.id
            ? { ...conversation, lastMessage: c.lastMessage }
            : c,
        ),
      );
    },
    [],
  );

  const archive = useCallback(
    async (conversationId: string, archived: boolean) => {
      await api.setArchived(conversationId, archived);
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (selectedRef.current === conversationId) setSelected(null);
    },
    [],
  );

  const remove = useCallback(async (conversationId: string) => {
    await api.deleteConversation(conversationId);
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    if (selectedRef.current === conversationId) setSelected(null);
  }, []);

  const toggleArchived = useCallback(() => {
    // Set the ref synchronously: refreshConversations reads it immediately,
    // and a state updater would not have run yet.
    const next = !showArchivedRef.current;
    showArchivedRef.current = next;
    setShowArchived(next);
    setSelected(null);
    void refreshConversations();
  }, [refreshConversations]);

  const logout = useCallback(() => {
    api.logout().finally(onLogout);
  }, [onLogout]);

  const activeConversation =
    selected && selected !== "new"
      ? (conversations.find((c) => c.id === selected) ?? null)
      : null;

  return (
    <div className={`app ${selected ? "thread-open" : ""}`}>
      <Sidebar
        conversations={conversations}
        selected={selected}
        showArchived={showArchived}
        onSelect={select}
        onCompose={() => setSelected("new")}
        onArchive={archive}
        onDelete={remove}
        onToggleArchived={toggleArchived}
        onLogout={logout}
      />
      <Thread
        key={selected ?? "none"}
        mode={selected === "new" ? "new" : activeConversation ? "existing" : "none"}
        conversation={activeConversation}
        messages={
          activeConversation ? (messagesByConv[activeConversation.id] ?? []) : []
        }
        hasMore={
          activeConversation ? (hasMoreByConv[activeConversation.id] ?? false) : false
        }
        onLoadOlder={loadOlder}
        onSend={send}
        onRetry={retry}
        onRename={rename}
        onBack={() => setSelected(null)}
      />
    </div>
  );
}
