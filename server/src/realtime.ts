import type { WebSocket } from "ws";
import type { Conversation, Message } from "./services/messaging.js";

export type RealtimeEvent =
  | { type: "message.new"; conversation: Conversation; message: Message }
  | { type: "message.status"; message: Message }
  | { type: "conversation.read"; conversationId: string };

const OPEN = 1;

export class Hub {
  private clients = new Set<WebSocket>();
  private pingTimer: NodeJS.Timeout | null = null;

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
    if (!this.pingTimer) {
      // Keep intermediary proxies from idling out long-lived connections.
      this.pingTimer = setInterval(() => {
        for (const client of this.clients) {
          if (client.readyState === OPEN) client.ping();
        }
      }, 30_000);
      this.pingTimer.unref();
    }
  }

  broadcast(event: RealtimeEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === OPEN) client.send(data);
    }
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const client of this.clients) client.terminate();
    this.clients.clear();
  }
}
