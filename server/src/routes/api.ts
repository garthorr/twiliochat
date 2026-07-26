import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Hub } from "../realtime.js";
import type { Db } from "../services/messaging.js";
import {
  createOutboundMessage,
  getConversation,
  getMessage,
  InvalidNumberError,
  listConversations,
  listMessages,
  markConversationRead,
  markMessageFailed,
  normalizeNumber,
  resetMessageForRetry,
  searchMessages,
  setDisplayName,
  setMessageSid,
} from "../services/messaging.js";
import type { SmsSender } from "../twilio.js";

export interface ApiDeps {
  config: Config;
  db: Db;
  sender: SmsSender | null;
  hub: Hub;
}

function twilioErrorCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : null;
}

export function registerApiRoutes(
  app: FastifyInstance,
  { config, db, sender, hub }: ApiDeps,
): void {
  app.get("/api/conversations", async () => {
    return { conversations: await listConversations(db) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/messages",
    async (req, reply) => {
      const conversation = await getConversation(db, req.params.id);
      if (!conversation) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      return { conversation, messages: await listMessages(db, conversation.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/read",
    async (req, reply) => {
      const conversation = await getConversation(db, req.params.id);
      if (!conversation) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      await markConversationRead(db, conversation.id);
      hub.broadcast({ type: "conversation.read", conversationId: conversation.id });
      return reply.status(204).send();
    },
  );

  // Give a thread a contact name (or clear it back to the raw number).
  app.patch<{ Params: { id: string } }>(
    "/api/conversations/:id",
    async (req, reply) => {
      const { displayName } = (req.body ?? {}) as { displayName?: unknown };
      if (displayName !== null && typeof displayName !== "string") {
        return reply.status(400).send({ error: "displayName must be a string or null" });
      }
      const trimmed =
        typeof displayName === "string" ? displayName.trim() : null;
      const updated = await setDisplayName(db, req.params.id, trimmed || null);
      if (!updated) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      hub.broadcast({ type: "conversation.updated", conversation: updated });
      return { conversation: updated };
    },
  );

  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    return { results: await searchMessages(db, req.query.q ?? "") };
  });

  app.post("/api/messages", async (req, reply) => {
    if (!sender || !config.twilio) {
      return reply.status(503).send({ error: "twilio not configured" });
    }

    const { to, body } = (req.body ?? {}) as { to?: string; body?: string };
    if (typeof to !== "string" || typeof body !== "string" || !body.trim()) {
      return reply.status(400).send({ error: "to and body are required" });
    }

    let toNumber: string;
    try {
      toNumber = normalizeNumber(to);
    } catch (err) {
      if (err instanceof InvalidNumberError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }

    const { conversation, message } = await createOutboundMessage(db, {
      to: toNumber,
      from: config.twilio.phoneNumber,
      body,
    });

    try {
      const result = await sender.send({
        to: toNumber,
        from: config.twilio.phoneNumber,
        body,
        ...(config.publicUrl
          ? { statusCallback: `${config.publicUrl}/webhooks/status` }
          : {}),
      });
      const updated = await setMessageSid(db, message.id, result.sid);
      const sent = { ...(updated ?? message), attachments: [] };
      hub.broadcast({ type: "message.new", conversation, message: sent });
      return reply.status(201).send({
        conversationId: conversation.id,
        message: sent,
      });
    } catch (err) {
      req.log.error({ err, messageId: message.id }, "twilio send failed");
      const failed = await markMessageFailed(db, message.id, twilioErrorCode(err));
      const result = { ...(failed ?? message), attachments: [] };
      hub.broadcast({ type: "message.new", conversation, message: result });
      // The message row is the source of truth; clients render "Not Delivered".
      return reply.status(201).send({
        conversationId: conversation.id,
        message: result,
      });
    }
  });

  // Re-send a message that Twilio rejected, reusing the existing row.
  app.post<{ Params: { id: string } }>(
    "/api/messages/:id/retry",
    async (req, reply) => {
      if (!sender || !config.twilio) {
        return reply.status(503).send({ error: "twilio not configured" });
      }
      const existing = await getMessage(db, req.params.id);
      if (!existing) {
        return reply.status(404).send({ error: "message not found" });
      }
      if (existing.direction !== "outbound" || existing.status !== "failed") {
        return reply
          .status(409)
          .send({ error: "only failed outbound messages can be retried" });
      }
      const conversation = await getConversation(db, existing.conversationId);
      if (!conversation) {
        return reply.status(404).send({ error: "conversation not found" });
      }

      const queued = (await resetMessageForRetry(db, existing.id)) ?? existing;
      hub.broadcast({
        type: "message.status",
        message: { ...queued, attachments: [] },
      });

      try {
        const result = await sender.send({
          to: conversation.participants[0]!,
          from: config.twilio.phoneNumber,
          body: existing.body,
          ...(config.publicUrl
            ? { statusCallback: `${config.publicUrl}/webhooks/status` }
            : {}),
        });
        const updated = await setMessageSid(db, existing.id, result.sid);
        const sent = { ...(updated ?? queued), attachments: [] };
        hub.broadcast({ type: "message.status", message: sent });
        return { message: sent };
      } catch (err) {
        req.log.error({ err, messageId: existing.id }, "twilio retry failed");
        const failed = await markMessageFailed(db, existing.id, twilioErrorCode(err));
        const result = { ...(failed ?? queued), attachments: [] };
        hub.broadcast({ type: "message.status", message: result });
        return { message: result };
      }
    },
  );
}
