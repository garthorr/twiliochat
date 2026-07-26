export interface Attachment {
  id: string;
  messageId: string;
  path: string;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  twilioSid: string | null;
  direction: "inbound" | "outbound";
  fromNumber: string;
  body: string;
  status: "receiving" | "received" | "queued" | "sent" | "delivered" | "failed";
  errorCode: string | null;
  createdAt: string;
  attachments?: Attachment[];
}

export interface Conversation {
  id: string;
  participants: string[];
  displayName: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  archived: boolean;
  optedOut: boolean;
  createdAt: string;
  lastMessage?: Message | null;
}

export type RealtimeEvent =
  | { type: "message.new"; conversation: Conversation; message: Message }
  | { type: "message.status"; message: Message }
  | { type: "conversation.read"; conversationId: string }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "conversation.deleted"; conversationId: string };

export interface SearchHit {
  conversation: Conversation;
  message: Message;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>("/api/session"),
  login: (password: string) =>
    request<{ authenticated: boolean }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => request<void>("/api/logout", { method: "POST" }),
  conversations: async (archived = false) =>
    (
      await request<{ conversations: Conversation[] }>(
        `/api/conversations${archived ? "?archived=true" : ""}`,
      )
    ).conversations,
  messages: (conversationId: string, before?: string) =>
    request<{
      conversation: Conversation;
      messages: Message[];
      hasMore: boolean;
    }>(
      `/api/conversations/${conversationId}/messages${
        before ? `?before=${encodeURIComponent(before)}` : ""
      }`,
    ),
  send: (to: string, body: string) =>
    request<{ conversationId: string; message: Message }>("/api/messages", {
      method: "POST",
      body: JSON.stringify({ to, body }),
    }),
  markRead: (conversationId: string) =>
    request<void>(`/api/conversations/${conversationId}/read`, {
      method: "POST",
    }),
  rename: (conversationId: string, displayName: string | null) =>
    request<{ conversation: Conversation }>(
      `/api/conversations/${conversationId}`,
      { method: "PATCH", body: JSON.stringify({ displayName }) },
    ),
  setArchived: (conversationId: string, archived: boolean) =>
    request<{ conversation: Conversation }>(
      `/api/conversations/${conversationId}`,
      { method: "PATCH", body: JSON.stringify({ archived }) },
    ),
  deleteConversation: (conversationId: string) =>
    request<void>(`/api/conversations/${conversationId}`, { method: "DELETE" }),
  retry: (messageId: string) =>
    request<{ message: Message }>(`/api/messages/${messageId}/retry`, {
      method: "POST",
    }),
  search: async (q: string) =>
    (await request<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`))
      .results,
};
