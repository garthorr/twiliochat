import { eq } from "drizzle-orm";
import { pushSubscriptions } from "../db/schema.js";
import { PushGoneError, type PushSender, type PushSubscriptionInfo } from "../push.js";
import type { Db } from "./messaging.js";

export async function saveSubscription(
  db: Db,
  sub: PushSubscriptionInfo,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      keysP256dh: sub.keys.p256dh,
      keysAuth: sub.keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { keysP256dh: sub.keys.p256dh, keysAuth: sub.keys.auth },
    });
}

export async function removeSubscription(
  db: Db,
  endpoint: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
}

export interface PushPayload {
  title: string;
  body: string;
  conversationId: string;
}

/** Fan a notification out to every subscription, pruning dead ones. */
export async function notifyAll(
  db: Db,
  sender: PushSender,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  const subs = await db.select().from(pushSubscriptions);
  const data = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await sender.send(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keysP256dh, auth: sub.keysAuth },
          },
          data,
        );
        sent += 1;
      } catch (err) {
        if (err instanceof PushGoneError) {
          await removeSubscription(db, sub.endpoint);
          pruned += 1;
        }
        // Other failures are transient; leave the subscription alone.
      }
    }),
  );
  return { sent, pruned };
}
