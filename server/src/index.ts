import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
import { createWebPushSender } from "./push.js";
import { createMediaFetcher, sweepOrphanedMedia } from "./services/media.js";
import { allAttachmentPaths } from "./services/messaging.js";
import { createTwilioSender } from "./twilio.js";

const config = loadConfig();
const { pool, db } = createDb(config.databaseUrl);

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);
await runMigrations(db, migrationsFolder);

const sender = config.twilio ? createTwilioSender(config.twilio) : null;
const pushSender = config.vapid ? createWebPushSender(config.vapid) : null;
const mediaFetcher = config.twilio
  ? createMediaFetcher(config.mediaDir, config.twilio)
  : null;

// Must exist before the static route is registered.
await fs.mkdir(config.mediaDir, { recursive: true }).catch(() => {});

const app = await buildApp({
  config,
  pool,
  db,
  sender,
  pushSender,
  mediaFetcher,
});

// Drop media files left behind by interrupted deletions.
const swept = await sweepOrphanedMedia(
  config.mediaDir,
  await allAttachmentPaths(db),
).catch(() => 0);
if (swept > 0) {
  app.log.info({ swept }, "removed orphaned media files");
}

if (!config.appPassword) {
  app.log.warn("APP_PASSWORD not set — nobody can log in");
}
if (!config.twilio) {
  app.log.warn("TWILIO_* env vars not set — sending is disabled");
}
if (!config.vapid) {
  app.log.warn("VAPID_* not set — push notifications are disabled");
}
if (!config.publicUrl) {
  app.log.warn("PUBLIC_URL not set — webhook signature validation will reject all requests");
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
