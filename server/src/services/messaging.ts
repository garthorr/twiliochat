import { and, desc, eq, gte, ilike, inArray, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema.js";
import { attachments, conversations, messages } from "../db/schema.js";

// Works for both the node-postgres db (runtime) and PGlite (tests).
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type MessageStatus = Message["status"];

/** A message plus its media, which is what clients always want to render. */
export interface MessageWithAttachments extends Message {
  attachments: Attachment[];
}

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
  /** Name from the imported address book, if any (displayName still wins). */
  contactName?: string | null;
}

export async function listConversations(
  db: Db,
  opts: { archived?: boolean } = {},
): Promise<ConversationSummary[]> {
  const convos = await db
    .select()
    .from(conversations)
    .where(eq(conversations.archived, opts.archived ?? false))
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

export async function addAttachments(
  db: Db,
  messageId: string,
  media: Array<{ path: string; contentType: string; sizeBytes: number }>,
): Promise<Attachment[]> {
  if (media.length === 0) return [];
  return db
    .insert(attachments)
    .values(media.map((m) => ({ messageId, ...m })))
    .returning();
}

export async function listAttachments(
  db: Db,
  messageIds: string[],
): Promise<Map<string, Attachment[]>> {
  const byMessage = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds))
    .orderBy(attachments.createdAt);
  for (const row of rows) {
    const list = byMessage.get(row.messageId);
    if (list) list.push(row);
    else byMessage.set(row.messageId, [row]);
  }
  return byMessage;
}

export const MESSAGE_PAGE_SIZE = 50;

export interface MessagePage {
  messages: MessageWithAttachments[];
  hasMore: boolean;
}

/**
 * One page of a thread, newest-last. Keyset pagination on `created_at` —
 * `before` walks backwards through history and is served by the existing
 * (conversation_id, created_at) index.
 */
export async function listMessages(
  db: Db,
  conversationId: string,
  opts: { before?: Date; limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(opts.limit ?? MESSAGE_PAGE_SIZE, 200);
  const rows = await db
    .select()
    .from(messages)
    .where(
      opts.before
        ? and(
            eq(messages.conversationId, conversationId),
            lt(messages.createdAt, opts.before),
          )
        : eq(messages.conversationId, conversationId),
    )
    // Newest first so the limit takes the most recent page, then reversed.
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
  const media = await listAttachments(
    db,
    page.map((m) => m.id),
  );
  return {
    messages: page.map((m) => ({ ...m, attachments: media.get(m.id) ?? [] })),
    hasMore,
  };
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

/**
 * Outbound messages sent in the trailing 24h. Counted in the database rather
 * than in memory so a crash-loop can't reset the spend ceiling.
 */
export async function countRecentOutbound(db: Db): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(eq(messages.direction, "outbound"), gte(messages.createdAt, since)),
    );
  return rows[0]?.count ?? 0;
}

export async function setOptedOut(
  db: Db,
  conversationId: string,
  optedOut: boolean,
): Promise<Conversation | null> {
  const updated = await db
    .update(conversations)
    .set({ optedOut })
    .where(eq(conversations.id, conversationId))
    .returning();
  return updated[0] ?? null;
}

const OPT_OUT_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "end",
  "quit",
  "cancel",
  "revoke",
  "optout",
]);
const OPT_IN_KEYWORDS = new Set(["start", "unstop", "yes"]);

/**
 * Twilio itself acts on these keywords; we mirror the resulting state so the
 * UI can stop offering a send that Twilio will reject with error 21610.
 */
export function optOutIntent(body: string): "out" | "in" | null {
  const word = body.trim().toLowerCase().replace(/[.!]$/, "");
  if (OPT_OUT_KEYWORDS.has(word)) return "out";
  if (OPT_IN_KEYWORDS.has(word)) return "in";
  return null;
}

export async function setArchived(
  db: Db,
  conversationId: string,
  archived: boolean,
): Promise<Conversation | null> {
  const updated = await db
    .update(conversations)
    .set({ archived })
    .where(eq(conversations.id, conversationId))
    .returning();
  return updated[0] ?? null;
}

/** Attachment paths for a conversation, so their files can be unlinked. */
export async function attachmentPathsForConversation(
  db: Db,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ path: attachments.path })
    .from(attachments)
    .innerJoin(messages, eq(attachments.messageId, messages.id))
    .where(eq(messages.conversationId, conversationId));
  return rows.map((r) => r.path);
}

export async function deleteConversation(
  db: Db,
  conversationId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(conversations)
    .where(eq(conversations.id, conversationId))
    .returning();
  return deleted.length > 0;
}

/** Every stored attachment path, for the startup orphan sweep. */
export async function allAttachmentPaths(db: Db): Promise<Set<string>> {
  const rows = await db.select({ path: attachments.path }).from(attachments);
  return new Set(rows.map((r) => r.path));
}

export async function setDisplayName(
  db: Db,
  conversationId: string,
  displayName: string | null,
): Promise<Conversation | null> {
  const updated = await db
    .update(conversations)
    .set({ displayName })
    .where(eq(conversations.id, conversationId))
    .returning();
  return updated[0] ?? null;
}

export interface SearchHit {
  conversation: Conversation;
  message: Message;
}

/** Full-text-ish search across message bodies, newest first. */
export async function searchMessages(
  db: Db,
  query: string,
  limit = 50,
): Promise<SearchHit[]> {
  const term = query.trim();
  if (!term) return [];
  const rows = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(ilike(messages.body, `%${term}%`))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows;
}

export async function getMessage(
  db: Db,
  id: string,
): Promise<Message | null> {
  const rows = await db.select().from(messages).where(eq(messages.id, id));
  return rows[0] ?? null;
}

export async function resetMessageForRetry(
  db: Db,
  id: string,
): Promise<Message | null> {
  const updated = await db
    .update(messages)
    .set({ status: "queued", errorCode: null, twilioSid: null })
    .where(eq(messages.id, id))
    .returning();
  return updated[0] ?? null;
}
