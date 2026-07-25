import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";
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
const app = await buildApp({ config, pool, db, sender });

if (!config.twilio) {
  app.log.warn("TWILIO_* env vars not set — sending is disabled");
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
