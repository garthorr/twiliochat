import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { Conversation, Message, RealtimeEvent } from "./api";
import { Sidebar } from "./Sidebar";
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
  const selectedRef = useRef<Selection>(null);
  selectedRef.current = selected;

  const refreshConversations = useCallback(async () => {
    try {
      setConversations((await api.conversations()).sort(byRecency));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
    }
  }, [onLogout]);

  const loadMessages = useCallback(async (conversationId: string) => {
    const { messages } = await api.messages(conversationId);
    setMessagesByConv((prev) => ({ ...prev, [conversationId]: messages }));
  }, []);

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

  const send = useCallback(
    async (to: string, body: string): Promise<void> => {
      const { conversationId, message } = await api.send(to, body);
      upsertMessage(message);
      if (selectedRef.current === "new") {
        await refreshConversations();
        setSelected(conversationId);
        void loadMessages(conversationId);
      }
    },
    [upsertMessage, refreshConversations, loadMessages],
  );

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
        onSelect={select}
        onCompose={() => setSelected("new")}
        onLogout={logout}
      />
      <Thread
        key={selected ?? "none"}
        mode={selected === "new" ? "new" : activeConversation ? "existing" : "none"}
        conversation={activeConversation}
        messages={
          activeConversation ? (messagesByConv[activeConversation.id] ?? []) : []
        }
        onSend={send}
        onBack={() => setSelected(null)}
      />
    </div>
  );
}
