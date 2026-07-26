import type { FastifyInstance } from "fastify";
import type { Hub } from "../realtime.js";
import {
  clearContacts,
  countContacts,
  deleteContact,
  importContacts,
  listContacts,
  parseContactsFile,
} from "../services/contacts.js";
import type { Db } from "../services/messaging.js";

/** Guard against someone posting a huge file; ~8MB of vCard is a lot of people. */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export function registerContactRoutes(
  app: FastifyInstance,
  { db, hub }: { db: Db; hub: Hub },
): void {
  app.get("/api/contacts", async () => ({
    contacts: await listContacts(db),
    count: await countContacts(db),
  }));

  /**
   * Import a Google Contacts export. The body is the raw file text (vCard or
   * CSV) — it is parsed in memory and only name/number pairs are stored; the
   * file itself is never written to disk.
   */
  app.post("/api/contacts/import", {
    bodyLimit: MAX_IMPORT_BYTES,
  }, async (req, reply) => {
    const raw = req.body;
    const text =
      typeof raw === "string"
        ? raw
        : typeof (raw as { text?: unknown })?.text === "string"
          ? (raw as { text: string }).text
          : null;
    if (!text || !text.trim()) {
      return reply.status(400).send({ error: "empty import file" });
    }

    const parsed = parseContactsFile(text);
    if (parsed.length === 0) {
      return reply.status(400).send({
        error:
          "no contacts with phone numbers found — export from Google Contacts as vCard or Google CSV",
      });
    }

    const result = await importContacts(db, parsed);
    req.log.info(result, "contacts imported");
    // Names change how every thread is labelled, so refresh all clients.
    hub.broadcast({ type: "contacts.updated" });
    return reply.status(201).send(result);
  });

  app.delete("/api/contacts", async (_req, reply) => {
    await clearContacts(db);
    hub.broadcast({ type: "contacts.updated" });
    return reply.status(204).send();
  });

  app.delete<{ Params: { phone: string } }>(
    "/api/contacts/:phone",
    async (req, reply) => {
      await deleteContact(db, decodeURIComponent(req.params.phone));
      hub.broadcast({ type: "contacts.updated" });
      return reply.status(204).send();
    },
  );
}
