import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Hub } from "../realtime.js";
import { deleteMediaFiles } from "../services/media.js";
import type { Db } from "../services/messaging.js";
import {
  attachmentPathsForConversation,
  countRecentOutbound,
  createOutboundMessage,
  deleteConversation,
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
  setArchived,
  setDisplayName,
  setMessageSid,
  setOptedOut,
} from "../services/messaging.js";
import type { SmsSender } from "../twilio.js";

/** Twilio's error for "recipient has opted out of receiving messages". */
const OPT_OUT_ERROR_CODE = "21610";

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
  app.get<{ Querystring: { archived?: string } }>(
    "/api/conversations",
    async (req) => {
      return {
        conversations: await listConversations(db, {
          archived: req.query.archived === "true",
        }),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/conversations/:id/messages",
    async (req, reply) => {
      const conversation = await getConversation(db, req.params.id);
      if (!conversation) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      const before = req.query.before ? new Date(req.query.before) : undefined;
      if (before && Number.isNaN(before.getTime())) {
        return reply.status(400).send({ error: "invalid before cursor" });
      }
      const page = await listMessages(db, conversation.id, {
        before,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      return { conversation, ...page };
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

  // Rename a thread and/or archive it.
  app.patch<{ Params: { id: string } }>(
    "/api/conversations/:id",
    async (req, reply) => {
      const { displayName, archived } = (req.body ?? {}) as {
        displayName?: unknown;
        archived?: unknown;
      };
      if (displayName !== undefined) {
        if (displayName !== null && typeof displayName !== "string") {
          return reply
            .status(400)
            .send({ error: "displayName must be a string or null" });
        }
      }
      if (archived !== undefined && typeof archived !== "boolean") {
        return reply.status(400).send({ error: "archived must be a boolean" });
      }

      let updated = await getConversation(db, req.params.id);
      if (!updated) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      if (displayName !== undefined) {
        const trimmed =
          typeof displayName === "string" ? displayName.trim() : null;
        updated = (await setDisplayName(db, req.params.id, trimmed || null)) ?? updated;
      }
      if (archived !== undefined) {
        updated = (await setArchived(db, req.params.id, archived)) ?? updated;
      }
      hub.broadcast({ type: "conversation.updated", conversation: updated });
      return { conversation: updated };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/conversations/:id",
    async (req, reply) => {
      const conversation = await getConversation(db, req.params.id);
      if (!conversation) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      // Rows cascade, but the files on the media volume do not.
      const paths = await attachmentPathsForConversation(db, conversation.id);
      await deleteConversation(db, conversation.id);
      await deleteMediaFiles(config.mediaDir, paths).catch((err) =>
        req.log.warn({ err }, "media cleanup failed"),
      );
      hub.broadcast({
        type: "conversation.deleted",
        conversationId: conversation.id,
      });
      return reply.status(204).send();
    },
  );

  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    return { results: await searchMessages(db, req.query.q ?? "") };
  });

  /** Shared spend ceiling for first sends and retries. */
  async function overDailyCap(): Promise<boolean> {
    return (await countRecentOutbound(db)) >= config.maxSendsPerDay;
  }

  // Burst guard; the daily ceiling below is counted in the database.
  const sendRateLimit = {
    config: {
      rateLimit: {
        max: config.maxSendsPerMinute,
        timeWindow: 60_000,
      },
    },
  };

  app.post("/api/messages", sendRateLimit, async (req, reply) => {
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

    if (await overDailyCap()) {
      return reply.status(429).send({
        error: `daily send limit reached (${config.maxSendsPerDay}); raise MAX_SENDS_PER_DAY to send more`,
      });
    }

    const { conversation, message } = await createOutboundMessage(db, {
      to: toNumber,
      from: config.twilio.phoneNumber,
      body,
    });

    if (conversation.optedOut) {
      const failed = await markMessageFailed(db, message.id, OPT_OUT_ERROR_CODE);
      const result = { ...(failed ?? message), attachments: [] };
      hub.broadcast({ type: "message.new", conversation, message: result });
      return reply.status(201).send({
        conversationId: conversation.id,
        message: result,
      });
    }

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
      const code = twilioErrorCode(err);
      const failed = await markMessageFailed(db, message.id, code);
      const result = { ...(failed ?? message), attachments: [] };
      hub.broadcast({ type: "message.new", conversation, message: result });

      if (code === OPT_OUT_ERROR_CODE) {
        const opted = await setOptedOut(db, conversation.id, true);
        if (opted) {
          hub.broadcast({ type: "conversation.updated", conversation: opted });
        }
      }
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
    sendRateLimit,
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
      if (conversation.optedOut) {
        return reply.status(409).send({
          error: "recipient has opted out; they must text START to resume",
        });
      }
      if (await overDailyCap()) {
        return reply.status(429).send({
          error: `daily send limit reached (${config.maxSendsPerDay}); raise MAX_SENDS_PER_DAY to send more`,
        });
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
        const code = twilioErrorCode(err);
        const failed = await markMessageFailed(db, existing.id, code);
        const result = { ...(failed ?? queued), attachments: [] };
        hub.broadcast({ type: "message.status", message: result });

        if (code === OPT_OUT_ERROR_CODE) {
          const opted = await setOptedOut(db, conversation.id, true);
          if (opted) {
            hub.broadcast({ type: "conversation.updated", conversation: opted });
          }
        }
        return { message: result };
      }
    },
  );
}
