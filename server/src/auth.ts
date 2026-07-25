import type { FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "session";
export const SESSION_VALUE = "authenticated";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Constant-time string comparison; hashing first equalizes lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isAuthenticated(req: FastifyRequest): boolean {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value === SESSION_VALUE;
}
