import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import * as schema from "../src/db/schema.js";
import { PushGoneError, type PushSender } from "../src/push.js";
import { extensionFor, type MediaFetcher } from "../src/services/media.js";
import type { Db } from "../src/services/messaging.js";
import type { SmsSender } from "../src/twilio.js";

export const TEST_AUTH_TOKEN = "test_auth_token_not_a_secret";
export const TEST_PUBLIC_URL = "https://twiliochat.example.test";
export const TEST_FROM_NUMBER = "+15005550006";
export const TEST_PASSWORD = "test-password-not-a-secret";

export function testConfig(): Config {
  return loadConfig({
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: TEST_FROM_NUMBER,
    PUBLIC_URL: TEST_PUBLIC_URL,
    APP_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: "test-session-secret-not-a-secret",
    // Structurally valid VAPID keys are not needed: the sender is faked.
    VAPID_PUBLIC_KEY: "test-vapid-public-key",
    VAPID_PRIVATE_KEY: "test-vapid-private-key",
  });
}

type App = Awaited<ReturnType<typeof buildApp>>;
type InjectOptions = Parameters<App["inject"]>[0] & object;

/** Log in and return a cookie header usable for API and WS requests. */
export async function loginHeaders(app: App): Promise<{ cookie: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: TEST_PASSWORD },
  });
  const cookie = res.cookies.find((c) => c.name === "session");
  if (res.statusCode !== 200 || !cookie) {
    throw new Error(`test login failed: ${res.statusCode} ${res.body}`);
  }
  return { cookie: `${cookie.name}=${cookie.value}` };
}

export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "drizzle",
    ),
  });
  return db as unknown as Db;
}

export interface FakeSender extends SmsSender {
  calls: Array<{ to: string; from: string; body: string; statusCallback?: string }>;
  failNextWith: Error | null;
}

export function createFakeSender(): FakeSender {
  let counter = 0;
  const sender: FakeSender = {
    calls: [],
    failNextWith: null,
    async send(opts) {
      if (sender.failNextWith) {
        const err = sender.failNextWith;
        sender.failNextWith = null;
        throw err;
      }
      sender.calls.push(opts);
      counter += 1;
      return { sid: `SM_test_${counter}`, status: "queued" };
    },
  };
  return sender;
}

export interface FakePushSender extends PushSender {
  sent: Array<{ endpoint: string; payload: string }>;
  goneEndpoints: Set<string>;
}

export function createFakePushSender(): FakePushSender {
  const sender: FakePushSender = {
    sent: [],
    goneEndpoints: new Set(),
    async send(subscription, payload) {
      if (sender.goneEndpoints.has(subscription.endpoint)) {
        throw new PushGoneError(410);
      }
      sender.sent.push({ endpoint: subscription.endpoint, payload });
    },
  };
  return sender;
}

export interface FakeMediaFetcher extends MediaFetcher {
  fetched: string[];
  failUrls: Set<string>;
}

export function createFakeMediaFetcher(): FakeMediaFetcher {
  let counter = 0;
  const fetcher: FakeMediaFetcher = {
    fetched: [],
    failUrls: new Set(),
    async fetchAndStore(url, contentType) {
      if (fetcher.failUrls.has(url)) throw new Error("download failed");
      fetcher.fetched.push(url);
      counter += 1;
      return {
        path: `test-media-${counter}${extensionFor(contentType)}`,
        contentType,
        sizeBytes: 1024,
      };
    },
  };
  return fetcher;
}

export async function createTestApp() {
  const config = testConfig();
  const db = await createTestDb();
  const sender = createFakeSender();
  const pushSender = createFakePushSender();
  const mediaFetcher = createFakeMediaFetcher();
  const app = await buildApp({ config, db, sender, pushSender, mediaFetcher });
  const authHeaders = await loginHeaders(app);
  const inject = (opts: InjectOptions) =>
    app.inject({
      ...opts,
      headers: { ...authHeaders, ...(opts.headers ?? {}) },
    });
  return {
    app,
    db,
    sender,
    pushSender,
    mediaFetcher,
    config,
    authHeaders,
    inject,
  };
}

/** Build a signed, form-encoded webhook request body + headers. */
export function signedWebhook(
  urlPath: string,
  params: Record<string, string>,
) {
  const signature = twilio.getExpectedTwilioSignature(
    TEST_AUTH_TOKEN,
    `${TEST_PUBLIC_URL}${urlPath}`,
    params,
  );
  return {
    payload: new URLSearchParams(params).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
  };
}
