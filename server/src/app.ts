import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
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
import { registerContactRoutes } from "./routes/contacts.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { verifyMediaSignature, type MediaFetcher } from "./services/media.js";
import type { Db } from "./services/messaging.js";
import type { SmsSender } from "./twilio.js";

export interface AppDeps {
  config: Config;
  // Optional so tests and DB-less contexts can build the app.
  pool?: pg.Pool;
  db?: Db;
  sender?: SmsSender | null;
  pushSender?: PushSender | null;
  mediaFetcher?: MediaFetcher | null;
}

// Reachable without a session cookie; everything else under /api requires one.
const PUBLIC_API_ROUTES = new Set(["/api/login", "/api/session"]);

export async function buildApp({
  config,
  pool,
  db,
  sender,
  pushSender,
  mediaFetcher,
}: AppDeps) {
  const app = Fastify({ logger: true });
  const hub = new Hub();

  // Twilio webhooks arrive as application/x-www-form-urlencoded.
  await app.register(fastifyFormbody);
  // Contact imports are posted as a raw vCard/CSV body.
  app.addContentTypeParser(
    ["text/plain", "text/csv", "text/vcard", "text/x-vcard"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  // Outbound MMS images are posted as raw bytes.
  app.addContentTypeParser(
    ["image/jpeg", "image/png", "image/gif", "image/webp"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyWebsocket);
  // Global limiter is opt-in per route; see login and send routes.
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite injects a small inline bootstrap; media/images are same-origin
        // files plus blob/data URLs from the service worker cache.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        objectSrc: ["'none'"],
      },
    },
    // Cross-origin isolation would block nothing useful here but breaks
    // installing the PWA from some browsers.
    crossOriginEmbedderPolicy: false,
  });

  app.addHook("preHandler", async (req, reply) => {
    const url = (req.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
    const guarded = url.startsWith("/api/") || url.startsWith("/media/");
    if (!guarded || PUBLIC_API_ROUTES.has(url)) return;
    if (isAuthenticated(req)) return;

    // Twilio fetches outbound MMS media anonymously, so a valid short-lived
    // signature stands in for a session on that one file.
    if (url.startsWith("/media/")) {
      const { expires, sig } = req.query as {
        expires?: string;
        sig?: string;
      };
      if (verifyMediaSignature(config.sessionSecret, url, expires, sig)) return;
    }
    return reply.status(401).send({ error: "unauthorized" });
  });

  // Re-hosted MMS media — behind the same session guard as the API.
  if (fs.existsSync(config.mediaDir)) {
    await app.register(fastifyStatic, {
      root: config.mediaDir,
      prefix: "/media/",
      decorateReply: false,
    });
  }

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
      mediaFetcher: mediaFetcher ?? null,
    });
    registerApiRoutes(app, { config, db, sender: sender ?? null, hub });
    registerPushRoutes(app, { config, db });
    registerContactRoutes(app, { db, hub });
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
