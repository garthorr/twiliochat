import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import fs from "node:fs";
import type pg from "pg";
import { isAuthenticated } from "./auth.js";
import type { Config } from "./config.js";
import { Hub } from "./realtime.js";
import type { PushSender } from "./push.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { Db } from "./services/messaging.js";
import type { SmsSender } from "./twilio.js";

export interface AppDeps {
  config: Config;
  // Optional so tests and DB-less contexts can build the app.
  pool?: pg.Pool;
  db?: Db;
  sender?: SmsSender | null;
  pushSender?: PushSender | null;
}

// Reachable without a session cookie; everything else under /api requires one.
const PUBLIC_API_ROUTES = new Set(["/api/login", "/api/session"]);

export async function buildApp({
  config,
  pool,
  db,
  sender,
  pushSender,
}: AppDeps) {
  const app = Fastify({ logger: true });
  const hub = new Hub();

  // Twilio webhooks arrive as application/x-www-form-urlencoded.
  await app.register(fastifyFormbody);
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyWebsocket);

  app.addHook("preHandler", async (req, reply) => {
    const url = (req.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
    if (!url.startsWith("/api/") || PUBLIC_API_ROUTES.has(url)) return;
    if (!isAuthenticated(req)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.addHook("onClose", async () => hub.close());

  app.get("/healthz", async (_req, reply) => {
    if (!pool) {
      return { status: "ok", db: "not_configured" };
    }
    try {
      await pool.query("SELECT 1");
      return { status: "ok", db: "ok" };
    } catch {
      return reply.status(503).send({ status: "degraded", db: "unreachable" });
    }
  });

  registerAuthRoutes(app, { config });

  if (db) {
    app.get("/ws", { websocket: true }, (socket, req) => {
      if (!isAuthenticated(req)) {
        socket.close(4401, "unauthorized");
        return;
      }
      hub.add(socket);
    });

    registerWebhookRoutes(app, {
      config,
      db,
      hub,
      pushSender: pushSender ?? null,
    });
    registerApiRoutes(app, { config, db, sender: sender ?? null, hub });
    registerPushRoutes(app, { config, db });
  }

  if (config.publicDir && fs.existsSync(config.publicDir)) {
    await app.register(fastifyStatic, { root: config.publicDir });
    // SPA fallback: unknown non-API GETs serve the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({ error: "not found" });
    });
  }

  return app;
}
