import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TwilioConfig } from "../config.js";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/amr": ".amr",
  "application/pdf": ".pdf",
  "text/vcard": ".vcf",
};

export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.toLowerCase()] ?? ".bin";
}

export interface StoredMedia {
  /** Filename under the media directory; served as /media/<path>. */
  path: string;
  contentType: string;
  sizeBytes: number;
}

export interface MediaFetcher {
  /**
   * Download one Twilio media resource and store it locally. Twilio's media
   * URLs require auth and expire, so we re-host the bytes ourselves.
   */
  fetchAndStore(url: string, contentType: string): Promise<StoredMedia>;
}

/**
 * Twilio fetches MediaUrl anonymously, but /media is behind the session
 * guard. These short-lived HMAC signatures let exactly one file through for
 * long enough to be fetched, without opening the directory to the world.
 */
export function signMediaPath(
  secret: string,
  filePath: string,
  expiresAt: number,
): string {
  return createHmac("sha256", secret)
    .update(`${path.basename(filePath)}:${expiresAt}`)
    .digest("hex");
}

export function verifyMediaSignature(
  secret: string,
  filePath: string,
  expires: string | undefined,
  signature: string | undefined,
): boolean {
  if (!expires || !signature) return false;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = signMediaPath(secret, filePath, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signed absolute URL Twilio can fetch for the next `ttlMs`. */
export function signedMediaUrl(
  publicUrl: string,
  secret: string,
  filePath: string,
  ttlMs = 60 * 60 * 1000,
): string {
  const expiresAt = Date.now() + ttlMs;
  const name = path.basename(filePath);
  const sig = signMediaPath(secret, name, expiresAt);
  return `${publicUrl}/media/${name}?expires=${expiresAt}&sig=${sig}`;
}

/** Store an uploaded outbound attachment. */
export async function storeOutboundMedia(
  mediaDir: string,
  bytes: Buffer,
  contentType: string,
): Promise<StoredMedia> {
  const name = `${randomUUID()}${extensionFor(contentType)}`;
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, name), bytes);
  return { path: name, contentType, sizeBytes: bytes.byteLength };
}

/** Remove stored media files; missing files are not an error. */
export async function deleteMediaFiles(
  mediaDir: string,
  paths: string[],
): Promise<void> {
  await Promise.all(
    paths.map((p) =>
      fs.rm(path.join(mediaDir, path.basename(p)), { force: true }),
    ),
  );
}

/**
 * Delete media files with no attachment row — leftovers from deletions that
 * failed partway, so the volume doesn't grow forever.
 */
export async function sweepOrphanedMedia(
  mediaDir: string,
  known: Set<string>,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(mediaDir);
  } catch {
    return 0;
  }
  const orphans = entries.filter((name) => !known.has(name));
  await deleteMediaFiles(mediaDir, orphans);
  return orphans.length;
}

export function createMediaFetcher(
  mediaDir: string,
  twilio: TwilioConfig,
): MediaFetcher {
  const auth = Buffer.from(
    `${twilio.accountSid}:${twilio.authToken}`,
  ).toString("base64");

  return {
    async fetchAndStore(url, contentType) {
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${auth}` },
        redirect: "follow",
      });
      if (!res.ok) {
        throw new Error(`media download failed: ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `${randomUUID()}${extensionFor(contentType)}`;
      await fs.mkdir(mediaDir, { recursive: true });
      await fs.writeFile(path.join(mediaDir, name), buf);
      return { path: name, contentType, sizeBytes: buf.byteLength };
    },
  };
}
