import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import type pg from "pg";
import type { Config } from "./config.js";

export interface AppDeps {
  config: Config;
  // Optional so tests and DB-less contexts can build the app.
  pool?: pg.Pool;
}

export async function buildApp({ config, pool }: AppDeps) {
  const app = Fastify({ logger: true });

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
