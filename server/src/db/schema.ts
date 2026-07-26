import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // E.164 numbers of the remote participants, sorted — the threading key.
    participants: text("participants").array().notNull(),
    displayName: text("display_name"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    unreadCount: integer("unread_count").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    // Mirrors Twilio's own opt-out state (it rejects sends with error 21610).
    optedOut: boolean("opted_out").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_participants_idx").on(t.participants),
    index("conversations_last_message_at_idx").on(t.lastMessageAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // Twilio Message SID; unique so webhook retries stay idempotent.
    twilioSid: text("twilio_sid"),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    // For inbound: the sender. For outbound: our Twilio number.
    fromNumber: text("from_number").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", {
      enum: ["receiving", "received", "queued", "sent", "delivered", "failed"],
    }).notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_twilio_sid_idx").on(t.twilioSid),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
  ],
);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  // Local path under the media volume; Twilio's media URLs expire.
  path: text("path").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Address book keyed by phone number, so a name applies to every thread with
 * that person — including ones that don't exist yet.
 */
export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpoint: text("endpoint").notNull().unique(),
  keysP256dh: text("keys_p256dh").notNull(),
  keysAuth: text("keys_auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
