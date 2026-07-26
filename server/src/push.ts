import webpush from "web-push";
import type { VapidConfig } from "./config.js";

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class PushGoneError extends Error {
  constructor(public statusCode: number) {
    super(`push subscription gone (${statusCode})`);
    this.name = "PushGoneError";
  }
}

export interface PushSender {
  send(subscription: PushSubscriptionInfo, payload: string): Promise<void>;
}

export function createWebPushSender(vapid: VapidConfig): PushSender {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 3600 });
      } catch (err) {
        const status =
          err && typeof err === "object" && "statusCode" in err
            ? Number((err as { statusCode: unknown }).statusCode)
            : 0;
        // 404/410: the browser dropped the subscription — prune it.
        if (status === 404 || status === 410) throw new PushGoneError(status);
        throw err;
      }
    },
  };
}
