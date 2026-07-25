import fastifyFormbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import type pg from "pg";
import type { Config } from "./config.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import type { Db } from "./services/messaging.js";
import type { SmsSender } from "./twilio.js";

export interface AppDeps {
  config: Config;
  // Optional so tests and DB-less contexts can build the app.
  pool?: pg.Pool;
  db?: Db;
  sender?: SmsSender | null;
}

export async function buildApp({ config, pool, db, sender }: AppDeps) {
  const app = Fastify({ logger: true });

  // Twilio webhooks arrive as application/x-www-form-urlencoded.
  await app.register(fastifyFormbody);

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

  if (db) {
    registerWebhookRoutes(app, { config, db });
    registerApiRoutes(app, { config, db, sender: sender ?? null });
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
