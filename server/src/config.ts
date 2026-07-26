import { randomBytes } from "node:crypto";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  publicDir: string | null;
  /** Public HTTPS base URL Twilio webhooks are pointed at. */
  publicUrl: string | null;
  twilio: TwilioConfig | null;
  appPassword: string | null;
  sessionSecret: string;
  vapid: VapidConfig | null;
  /** Directory where inbound MMS media is re-hosted. */
  mediaDir: string;
  /** Cost guards on outbound sending. */
  maxSendsPerMinute: number;
  maxSendsPerDay: number;
  /** Brute-force guard on the login endpoint. */
  maxLoginAttempts: number;
  loginWindowMinutes: number;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const twilio =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER
      ? {
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          phoneNumber: env.TWILIO_PHONE_NUMBER,
        }
      : null;

  return {
    port: env.PORT ? Number(env.PORT) : 8080,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://twiliochat:twiliochat@localhost:5432/twiliochat",
    publicDir: env.PUBLIC_DIR ?? null,
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : null,
    twilio,
    appPassword: env.APP_PASSWORD || null,
    // Without a configured secret, sessions just reset on restart.
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString("hex"),
    mediaDir: env.MEDIA_DIR ?? "/data/media",
    maxSendsPerMinute: Number(env.MAX_SENDS_PER_MINUTE ?? 10),
    maxSendsPerDay: Number(env.MAX_SENDS_PER_DAY ?? 250),
    maxLoginAttempts: Number(env.MAX_LOGIN_ATTEMPTS ?? 5),
    loginWindowMinutes: Number(env.LOGIN_WINDOW_MINUTES ?? 15),
    vapid:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT || "mailto:admin@example.com",
          }
        : null,
  };
}
