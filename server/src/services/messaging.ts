import { desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.js";
import { conversations, messages } from "../db/schema.js";

// Works for both the node-postgres db (runtime) and PGlite (tests).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageStatus = Message["status"];

export class InvalidNumberError extends Error {
  constructor(raw: string) {
    super(`Not a valid phone number: ${raw}`);
    this.name = "InvalidNumberError";
  }
}

/** Normalize to E.164. Bare 10-digit numbers are assumed to be US/Canada. */
export function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;
  if (/^[2-9]\d{9}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1[2-9]\d{9}$/.test(cleaned)) return `+${cleaned}`;
  throw new InvalidNumberError(raw);
}

/**
 * Twilio message statuses collapse onto our smaller state machine:
 * everything pre-flight is "queued", terminal failures are "failed".
 */
export function mapTwilioStatus(twilioStatus: string): MessageStatus | null {
  switch (twilioStatus) {
    case "accepted":
    case "queued":
    case "sending":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
    case "failed":
      return "failed";
    case "receiving":
      return "receiving";
    case "received":
      return "received";
    default:
      return null;
  }
}

export async function getOrCreateConversation(
  db: Db,
  participants: string[],
): Promise<Conversation> {
  const key = [...participants].sort();
  const existing = await db
    .select()
    .from(conversations)
    .where(eq(conversations.participants, key));
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(conversations)
    .values({ participants: key })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  // Lost a race with a concurrent insert; the row exists now.
  const retry = await db
    .select()
    .from(conversations)
    .where(eq(conversations.participants, key));
  return retry[0]!;
}

export async function recordInboundMessage(
  db: Db,
  params: { from: string; twilioSid: string; body: string },
): Promise<{ conversation: Conversation; message: Message } | null> {
  const conversation = await getOrCreateConversation(db, [params.from]);
  const inserted = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      twilioSid: params.twilioSid,
      direction: "inbound",
      fromNumber: params.from,
      body: params.body,
      status: "received",
    })
    .onConflictDoNothing({ target: messages.twilioSid })
    .returning();
  const message = inserted[0];
  if (!message) return null; // Twilio retried a webhook we already handled.

  const updated = await db
    .update(conversations)
    .set({
      lastMessageAt: message.createdAt,
      unreadCount: sql`${conversations.unreadCount} + 1`,
    })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return { conversation: updated[0] ?? conversation, message };
}

export async function createOutboundMessage(
  db: Db,
  params: { to: string; from: string; body: string },
): Promise<{ conversation: Conversation; message: Message }> {
  const conversation = await getOrCreateConversation(db, [params.to]);
  const inserted = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      direction: "outbound",
      fromNumber: params.from,
      body: params.body,
      status: "queued",
    })
    .returning();
  const message = inserted[0]!;
  const updated = await db
    .update(conversations)
    .set({ lastMessageAt: message.createdAt })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return { conversation: updated[0] ?? conversation, message };
}

export async function setMessageSid(
  db: Db,
  messageId: string,
  twilioSid: string,
): Promise<Message | null> {
  const updated = await db
    .update(messages)
    .set({ twilioSid })
    .where(eq(messages.id, messageId))
    .returning();
  return updated[0] ?? null;
}

export async function markMessageFailed(
  db: Db,
  messageId: string,
  errorCode: string | null,
): Promise<Message | null> {
  const updated = await db
    .update(messages)
    .set({ status: "failed", errorCode })
    .where(eq(messages.id, messageId))
    .returning();
  return updated[0] ?? null;
}

export async function updateMessageStatusBySid(
  db: Db,
  twilioSid: string,
  status: MessageStatus,
  errorCode: string | null,
): Promise<Message | null> {
  const updated = await db
    .update(messages)
    .set({ status, errorCode })
    .where(eq(messages.twilioSid, twilioSid))
    .returning();
  return updated[0] ?? null;
}

export interface ConversationSummary extends Conversation {
  lastMessage: Message | null;
}

export async function listConversations(
  db: Db,
): Promise<ConversationSummary[]> {
  const convos = await db
    .select()
    .from(conversations)
    .where(eq(conversations.archived, false))
    .orderBy(desc(conversations.lastMessageAt));
  if (convos.length === 0) return [];

  const previews = await db
    .selectDistinctOn([messages.conversationId])
    .from(messages)
    .where(
      inArray(
        messages.conversationId,
        convos.map((c) => c.id),
      ),
    )
    .orderBy(messages.conversationId, desc(messages.createdAt));
  const byConversation = new Map(previews.map((m) => [m.conversationId, m]));

  return convos.map((c) => ({
    ...c,
    lastMessage: byConversation.get(c.id) ?? null,
  }));
}

export async function getConversation(
  db: Db,
  id: string,
): Promise<Conversation | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  return rows[0] ?? null;
}

export async function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

export async function markConversationRead(
  db: Db,
  conversationId: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(eq(conversations.id, conversationId));
}
