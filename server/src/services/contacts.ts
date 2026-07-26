import { eq, inArray, sql } from "drizzle-orm";
import { contacts } from "../db/schema.js";
import { normalizeNumber, type Conversation, type Db } from "./messaging.js";

export type Contact = typeof contacts.$inferSelect;

export interface ParsedContact {
  name: string;
  phones: string[];
}

/**
 * Unfold RFC 6350 line folding: a CRLF followed by a space or tab is a
 * continuation of the previous line, not a new one.
 */
function unfold(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

/** Decode the quoted-printable encoding some exporters use for names. */
function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function cleanVCardValue(rawKey: string, rawValue: string): string {
  const value = /encoding=quoted-printable/i.test(rawKey)
    ? decodeQuotedPrintable(rawValue)
    : rawValue;
  // Unescape vCard text escapes (\, \; \n).
  return value.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ").trim();
}

/** Build a display name from a vCard N (structured name) value. */
function nameFromStructured(value: string): string {
  const [family = "", given = "", additional = ""] = value.split(";");
  return [given, additional, family]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

export function parseVCard(text: string): ParsedContact[] {
  const results: ParsedContact[] = [];
  let current: { fn?: string; n?: string; phones: string[] } | null = null;

  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:VCARD")) {
      current = { phones: [] };
      continue;
    }
    if (upper.startsWith("END:VCARD")) {
      if (current) {
        const name = current.fn || (current.n ? nameFromStructured(current.n) : "");
        if (name && current.phones.length > 0) {
          results.push({ name, phones: current.phones });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const keyName = key.split(";")[0]?.toUpperCase();

    if (keyName === "FN") current.fn = cleanVCardValue(key, value);
    else if (keyName === "N") current.n = cleanVCardValue(key, value);
    else if (keyName === "TEL") {
      const tel = cleanVCardValue(key, value);
      if (tel) current.phones.push(tel);
    }
  }
  return results;
}

/** Minimal RFC 4180 CSV reader (handles quotes, embedded commas/newlines). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/**
 * Google Contacts CSV: a "Name"/"Given Name" style column plus numbered
 * "Phone 1 - Value" columns, where one cell may hold several numbers
 * separated by " ::: ".
 */
export function parseGoogleCsv(text: string): ParsedContact[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) return [];

  const index = (predicate: (h: string) => boolean) =>
    header.findIndex((h) => predicate(h.trim().toLowerCase()));

  const nameIdx = index((h) => h === "name" || h === "display name");
  const firstIdx = index((h) => h === "given name" || h === "first name");
  const middleIdx = index((h) => h === "additional name" || h === "middle name");
  const lastIdx = index((h) => h === "family name" || h === "last name");
  const orgIdx = index((h) => h === "organization name" || h === "organization 1 - name");
  const phoneIdxs = header
    .map((h, i) => ({ h: h.trim().toLowerCase(), i }))
    .filter(({ h }) => /^phone \d+ - value$/.test(h) || h === "phone" || h === "phone 1 - value")
    .map(({ i }) => i);

  const results: ParsedContact[] = [];
  for (const row of rows.slice(1)) {
    const phones = phoneIdxs
      .flatMap((i) => (row[i] ?? "").split(/\s*:::\s*/))
      .map((p) => p.trim())
      .filter(Boolean);
    if (phones.length === 0) continue;

    const name =
      (nameIdx >= 0 ? (row[nameIdx] ?? "").trim() : "") ||
      [firstIdx, middleIdx, lastIdx]
        .filter((i) => i >= 0)
        .map((i) => (row[i] ?? "").trim())
        .filter(Boolean)
        .join(" ") ||
      (orgIdx >= 0 ? (row[orgIdx] ?? "").trim() : "");
    if (!name) continue;

    results.push({ name, phones });
  }
  return results;
}

export function parseContactsFile(text: string): ParsedContact[] {
  return /BEGIN:VCARD/i.test(text) ? parseVCard(text) : parseGoogleCsv(text);
}

export interface ImportResult {
  contactsImported: number;
  numbersImported: number;
  skippedNumbers: number;
}

/**
 * Normalize every number and upsert one row per number. Numbers we cannot
 * parse as E.164 are counted and skipped rather than failing the import.
 */
export async function importContacts(
  db: Db,
  parsed: ParsedContact[],
): Promise<ImportResult> {
  const byPhone = new Map<string, string>();
  let skipped = 0;

  for (const entry of parsed) {
    for (const raw of entry.phones) {
      try {
        byPhone.set(normalizeNumber(raw), entry.name);
      } catch {
        skipped += 1;
      }
    }
  }
  if (byPhone.size === 0) {
    return { contactsImported: 0, numbersImported: 0, skippedNumbers: skipped };
  }

  const now = new Date();
  const values = [...byPhone].map(([phone, name]) => ({ phone, name }));
  // Chunked: Postgres caps bind parameters per statement.
  for (let i = 0; i < values.length; i += 500) {
    await db
      .insert(contacts)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: contacts.phone,
        // `excluded` is the row proposed for insertion.
        set: { name: sql.raw("excluded.name"), updatedAt: now },
      });
  }

  return {
    contactsImported: new Set(parsed.map((p) => p.name)).size,
    numbersImported: byPhone.size,
    skippedNumbers: skipped,
  };
}

export async function listContacts(db: Db): Promise<Contact[]> {
  return db.select().from(contacts).orderBy(contacts.name);
}

export async function countContacts(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts);
  return rows[0]?.count ?? 0;
}

export async function clearContacts(db: Db): Promise<void> {
  await db.delete(contacts);
}

export async function deleteContact(db: Db, phone: string): Promise<void> {
  await db.delete(contacts).where(eq(contacts.phone, phone));
}

/** Names for a set of numbers, used to label conversations at read time. */
export async function namesForNumbers(
  db: Db,
  numbers: string[],
): Promise<Map<string, string>> {
  if (numbers.length === 0) return new Map();
  const rows = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.phone, numbers));
  return new Map(rows.map((r) => [r.phone, r.name]));
}

/**
 * A conversation's effective name: an explicit per-thread rename always wins
 * over the imported address book.
 */
export function resolveName(
  conversation: Conversation,
  names: Map<string, string>,
): string | null {
  if (conversation.displayName) return conversation.displayName;
  const resolved = conversation.participants
    .map((p) => names.get(p))
    .filter((n): n is string => Boolean(n));
  return resolved.length === conversation.participants.length && resolved.length > 0
    ? resolved.join(", ")
    : null;
}
