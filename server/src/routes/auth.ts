import type { FastifyInstance } from "fastify";
import {
  isAuthenticated,
  safeEqual,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SESSION_VALUE,
} from "../auth.js";
import type { Config } from "../config.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  { config }: { config: Config },
): void {
  app.post("/api/login", {
    config: {
      // A single password on a public URL must not be brute-forceable.
      rateLimit: {
        max: config.maxLoginAttempts,
        timeWindow: config.loginWindowMinutes * 60_000,
      },
    },
  }, async (req, reply) => {
    if (!config.appPassword) {
      return reply.status(503).send({ error: "APP_PASSWORD not configured" });
    }
    const { password } = (req.body ?? {}) as { password?: string };
    if (typeof password !== "string" || !safeEqual(password, config.appPassword)) {
      return reply.status(401).send({ error: "invalid password" });
    }
    reply.setCookie(SESSION_COOKIE, SESSION_VALUE, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return { authenticated: true };
  });

  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/api/session", async (req) => ({
    authenticated: isAuthenticated(req),
  }));
}
