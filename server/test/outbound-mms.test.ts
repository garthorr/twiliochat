import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  signedMediaUrl,
  verifyMediaSignature,
} from "../src/services/media.js";
import { createTestApp, TEST_PUBLIC_URL } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

// A one-pixel PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("media URL signing", () => {
  const secret = "test-signing-secret";

  it("accepts a fresh signature and rejects tampering", () => {
    const url = signedMediaUrl(TEST_PUBLIC_URL, secret, "photo.jpg");
    const { searchParams } = new URL(url);
    const expires = searchParams.get("expires")!;
    const sig = searchParams.get("sig")!;

    expect(verifyMediaSignature(secret, "photo.jpg", expires, sig)).toBe(true);
    // A different file, a bad signature, or the wrong secret must all fail.
    expect(verifyMediaSignature(secret, "other.jpg", expires, sig)).toBe(false);
    expect(verifyMediaSignature(secret, "photo.jpg", expires, "deadbeef")).toBe(
      false,
    );
    expect(verifyMediaSignature("other-secret", "photo.jpg", expires, sig)).toBe(
      false,
    );
  });

  it("rejects an expired signature", () => {
    const past = Date.now() - 1000;
    const url = signedMediaUrl(TEST_PUBLIC_URL, secret, "photo.jpg", -1000);
    const sig = new URL(url).searchParams.get("sig")!;
    expect(verifyMediaSignature(secret, "photo.jpg", String(past), sig)).toBe(
      false,
    );
  });

  it("rejects missing parameters", () => {
    expect(verifyMediaSignature(secret, "photo.jpg", undefined, "x")).toBe(false);
    expect(verifyMediaSignature(secret, "photo.jpg", "123", undefined)).toBe(
      false,
    );
  });
});

describe("outbound MMS", () => {
  let ctx: TestApp;
  let mediaDir: string;

  beforeEach(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "twiliochat-out-"));
    ctx = await createTestApp({ MEDIA_DIR: mediaDir });
  });

  afterEach(async () => {
    await ctx.app.close();
    await fs.rm(mediaDir, { recursive: true, force: true });
  });

  async function upload() {
    const res = await ctx.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    return res;
  }

  it("stores an uploaded image and sends it as MediaUrl", async () => {
    const up = await upload();
    expect(up.statusCode).toBe(201);
    const staged = up.json();
    expect(staged.path).toMatch(/\.png$/);
    // The bytes really landed on disk.
    const onDisk = await fs.readFile(path.join(mediaDir, staged.path));
    expect(onDisk.equals(PNG)).toBe(true);

    const send = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "look", media: [staged] },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().message.attachments).toHaveLength(1);

    const call = ctx.sender.calls.at(-1)!;
    expect(call.mediaUrl).toHaveLength(1);
    const url = new URL(call.mediaUrl![0]!);
    expect(url.origin + url.pathname).toBe(
      `${TEST_PUBLIC_URL}/media/${staged.path}`,
    );
    // And that URL carries a signature Twilio can use without a session.
    expect(
      verifyMediaSignature(
        ctx.config.sessionSecret,
        staged.path,
        url.searchParams.get("expires") ?? undefined,
        url.searchParams.get("sig") ?? undefined,
      ),
    ).toBe(true);
  });

  it("lets Twilio fetch the media with a signature but not without one", async () => {
    const staged = (await upload()).json();
    const url = new URL(
      signedMediaUrl(TEST_PUBLIC_URL, ctx.config.sessionSecret, staged.path),
    );

    const anonymous = await ctx.app.inject({
      method: "GET",
      url: `/media/${staged.path}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const signed = await ctx.app.inject({
      method: "GET",
      url: `/media/${staged.path}${url.search}`,
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.rawPayload.equals(PNG)).toBe(true);
  });

  it("allows a photo with no text", async () => {
    const staged = (await upload()).json();
    const send = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "", media: [staged] },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().message.body).toBe("");
  });

  it("still requires text when there is no attachment", async () => {
    const send = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "   " },
    });
    expect(send.statusCode).toBe(400);
  });

  it("rejects unsupported upload types", async () => {
    const res = await ctx.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": "application/pdf" },
      payload: Buffer.from("%PDF-1.4"),
    });
    expect(res.statusCode).toBe(415);
  });

  it("requires a session to upload", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/attachments",
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect(res.statusCode).toBe(401);
  });
});
