import type { Conversation } from "./api";

export function formatNumber(raw: string): string {
  const m = /^\+1([2-9]\d{2})(\d{3})(\d{4})$/.exec(raw);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return raw;
}

export function conversationName(c: Conversation): string {
  return (
    c.displayName ??
    c.contactName ??
    c.participants.map(formatNumber).join(", ")
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function daysAgo(d: Date, now: Date): number {
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((startOf(now) - startOf(d)) / 86_400_000);
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "2-digit",
});

/** Sidebar row timestamp, like Messages: time today, then Yesterday, weekday, date. */
export function sidebarTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(d, now)) return timeFmt.format(d);
  const days = daysAgo(d, now);
  if (days === 1) return "Yesterday";
  if (days < 7) return weekdayFmt.format(d);
  return dateFmt.format(d);
}

/** Centered date divider label, e.g. "Today 2:41 PM". */
export function dividerLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  let day: string;
  if (isSameDay(d, now)) day = "Today";
  else if (daysAgo(d, now) === 1) day = "Yesterday";
  else if (daysAgo(d, now) < 7) day = weekdayFmt.format(d);
  else day = dateFmt.format(d);
  return `${day} ${timeFmt.format(d)}`;
}

const AVATAR_HUES = [210, 0, 30, 130, 270, 330, 180, 45];

export function avatarHue(seed: string): number {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length]!;
}

export function avatarInitials(c: Conversation): string | null {
  const name = c.displayName ?? c.contactName;
  if (!name) return null;
  const parts = name.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}
