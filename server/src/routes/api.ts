import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../services/messaging.js";
import {
  createOutboundMessage,
  getConversation,
  InvalidNumberError,
  listConversations,
  listMessages,
  markConversationRead,
  markMessageFailed,
  normalizeNumber,
  setMessageSid,
} from "../services/messaging.js";
import type { SmsSender } from "../twilio.js";

export interface ApiDeps {
  config: Config;
  db: Db;
  sender: SmsSender | null;
}

export function registerApiRoutes(
  app: FastifyInstance,
  { config, db, sender }: ApiDeps,
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
      return reply.status(204).send();
    },
  );

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
      return reply.status(201).send({
        conversationId: conversation.id,
        message: updated ?? message,
      });
    } catch (err) {
      req.log.error({ err, messageId: message.id }, "twilio send failed");
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : null;
      const failed = await markMessageFailed(db, message.id, code);
      // The message row is the source of truth; clients render "Not Delivered".
      return reply.status(201).send({
        conversationId: conversation.id,
        message: failed ?? message,
      });
    }
  });
}
