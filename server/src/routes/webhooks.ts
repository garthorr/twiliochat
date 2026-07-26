import type { FastifyInstance, FastifyRequest } from "fastify";
import twilio from "twilio";
import type { Config } from "../config.js";
import type { Hub } from "../realtime.js";
import type { PushSender } from "../push.js";
import { notifyAll } from "../services/push.js";
import type { Db } from "../services/messaging.js";
import {
  mapTwilioStatus,
  normalizeNumber,
  recordInboundMessage,
  updateMessageStatusBySid,
} from "../services/messaging.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

export interface WebhookDeps {
  config: Config;
  db: Db;
  hub: Hub;
  pushSender: PushSender | null;
}

function formatNumberForNotification(raw: string): string {
  const m = /^\+1([2-9]\d{2})(\d{3})(\d{4})$/.exec(raw);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return raw;
}

/**
 * Every Twilio webhook is authenticated by X-Twilio-Signature: an HMAC of the
 * exact public URL plus the sorted POST params, keyed by the auth token.
 */
function isValidTwilioRequest(config: Config, req: FastifyRequest): boolean {
  if (!config.twilio || !config.publicUrl) return false;
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  const url = `${config.publicUrl}${req.raw.url ?? ""}`;
  return twilio.validateRequest(
    config.twilio.authToken,
    signature,
    url,
    (req.body ?? {}) as Record<string, string>,
  );
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  { config, db, hub, pushSender }: WebhookDeps,
): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/webhooks/")) return;
    if (!isValidTwilioRequest(config, req)) {
      return reply.status(403).send({ error: "invalid twilio signature" });
    }
  });

  app.post("/webhooks/inbound", async (req, reply) => {
    const body = req.body as Record<string, string | undefined>;
    const sid = body.MessageSid ?? body.SmsSid;
    if (!sid || !body.From) {
      return reply.status(400).send({ error: "missing MessageSid or From" });
    }

    let from: string;
    try {
      from = normalizeNumber(body.From);
    } catch {
      // Alphanumeric sender IDs etc. — keep the raw value as the thread key.
      from = body.From;
    }

    const result = await recordInboundMessage(db, {
      from,
      twilioSid: sid,
      body: body.Body ?? "",
    });
    if (result) {
      hub.broadcast({
        type: "message.new",
        conversation: result.conversation,
        message: result.message,
      });
      req.log.info(
        { conversationId: result.conversation.id, messageId: result.message.id },
        "inbound message recorded",
      );
      if (pushSender) {
        const title =
          result.conversation.displayName ?? formatNumberForNotification(from);
        const text = result.message.body;
        // Fire-and-forget: never let a slow push service delay the TwiML reply.
        void notifyAll(db, pushSender, {
          title,
          body: text.length > 120 ? `${text.slice(0, 119)}…` : text,
          conversationId: result.conversation.id,
        }).catch((err) => req.log.warn({ err }, "web push fan-out failed"));
      }
    } else {
      req.log.info({ twilioSid: sid }, "duplicate inbound webhook ignored");
    }

    return reply.type("text/xml").send(EMPTY_TWIML);
  });

  app.post("/webhooks/status", async (req, reply) => {
    const body = req.body as Record<string, string | undefined>;
    const sid = body.MessageSid ?? body.SmsSid;
    const rawStatus = body.MessageStatus ?? body.SmsStatus;
    if (!sid || !rawStatus) {
      return reply.status(400).send({ error: "missing MessageSid or MessageStatus" });
    }

    const status = mapTwilioStatus(rawStatus);
    if (status) {
      const updated = await updateMessageStatusBySid(
        db,
        sid,
        status,
        body.ErrorCode ?? null,
      );
      if (updated) hub.broadcast({ type: "message.status", message: updated });
    } else {
      req.log.warn({ twilioSid: sid, rawStatus }, "unknown twilio status");
    }

    return reply.status(204).send();
  });
}
