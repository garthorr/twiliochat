import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { PushSubscriptionInfo } from "../push.js";
import type { Db } from "../services/messaging.js";
import { removeSubscription, saveSubscription } from "../services/push.js";

export interface PushRouteDeps {
  config: Config;
  db: Db;
}

function parseSubscription(body: unknown): PushSubscriptionInfo | null {
  const b = body as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  } | null;
  if (
    !b ||
    typeof b.endpoint !== "string" ||
    typeof b.keys?.p256dh !== "string" ||
    typeof b.keys?.auth !== "string"
  ) {
    return null;
  }
  return {
    endpoint: b.endpoint,
    keys: { p256dh: b.keys.p256dh, auth: b.keys.auth },
  };
}

export function registerPushRoutes(
  app: FastifyInstance,
  { config, db }: PushRouteDeps,
): void {
  app.get("/api/push/public-key", async (_req, reply) => {
    if (!config.vapid) {
      return reply.status(404).send({ error: "push not configured" });
    }
    return { publicKey: config.vapid.publicKey };
  });

  app.post("/api/push/subscribe", async (req, reply) => {
    if (!config.vapid) {
      return reply.status(404).send({ error: "push not configured" });
    }
    const sub = parseSubscription(req.body);
    if (!sub) {
      return reply.status(400).send({ error: "invalid subscription" });
    }
    await saveSubscription(db, sub);
    return reply.status(201).send({ ok: true });
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    const { endpoint } = (req.body ?? {}) as { endpoint?: string };
    if (typeof endpoint !== "string") {
      return reply.status(400).send({ error: "endpoint required" });
    }
    await removeSubscription(db, endpoint);
    return reply.status(204).send();
  });
}
