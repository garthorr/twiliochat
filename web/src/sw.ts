/// <reference lib="webworker" />
import { BackgroundSyncPlugin } from "workbox-background-sync";
import { ExpirationPlugin } from "workbox-expiration";
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

interface PushPayload {
  title: string;
  body: string;
  conversationId: string;
}

precacheAndRoute(self.__WB_MANIFEST);

// App shell for navigations, but never for API/WS/webhook traffic.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/ws$/, /^\/webhooks\//, /^\/media\//],
  }),
);

// Conversation history stays readable offline (fresh when the network is up).
registerRoute(
  ({ url, request }) =>
    request.method === "GET" && url.pathname.startsWith("/api/conversations"),
  new NetworkFirst({
    cacheName: "api-cache",
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 }),
    ],
  }),
);

// Inbound MMS media is immutable once stored — cache it aggressively.
registerRoute(
  ({ url, request }) =>
    request.method === "GET" && url.pathname.startsWith("/media/"),
  new NetworkFirst({
    cacheName: "media-cache",
    plugins: [
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);

// Offline outbox: sends attempted while offline replay when connectivity returns.
registerRoute(
  ({ url, request }) =>
    request.method === "POST" && url.pathname === "/api/messages",
  new NetworkOnly({
    plugins: [
      new BackgroundSyncPlugin("outbox", {
        maxRetentionTime: 24 * 60,
      }),
    ],
  }),
  "POST",
);

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // Collapse repeat notifications from the same thread.
      tag: payload.conversationId,
      renotify: true,
      data: { conversationId: payload.conversationId },
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = (event.notification.data as { conversationId?: string })
    ?.conversationId;
  const target = conversationId ? `/?c=${conversationId}` : "/";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "open-conversation", conversationId });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener("message", (event) => {
  if ((event.data as { type?: string })?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
