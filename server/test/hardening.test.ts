import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestApp,
  signedWebhook,
  TEST_FROM_NUMBER,
  TEST_PASSWORD,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe("login brute-force protection", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp({ MAX_LOGIN_ATTEMPTS: "3" });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("blocks further attempts once the limit is hit", async () => {
    // createTestApp logs in once during setup, so 2 wrong tries remain.
    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/login",
        payload: { password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "wrong" },
    });
    expect(blocked.statusCode).toBe(429);

    // Even the correct password is refused while the window is open.
    const correct = await ctx.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: TEST_PASSWORD },
    });
    expect(correct.statusCode).toBe(429);
  });
});

describe("send cost guard", () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  it("rejects sends past the daily cap", async () => {
    ctx = await createTestApp({ MAX_SENDS_PER_DAY: "2" });
    for (let i = 0; i < 2; i++) {
      const ok = await ctx.inject({
        method: "POST",
        url: "/api/messages",
        payload: { to: "+15551234567", body: `msg ${i}` },
      });
      expect(ok.statusCode).toBe(201);
    }

    const capped = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "over the cap" },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error).toContain("daily send limit");
  });

  it("counts the daily cap in the database, so a restart cannot reset it", async () => {
    ctx = await createTestApp({ MAX_SENDS_PER_DAY: "2" });
    for (let i = 0; i < 2; i++) {
      await ctx.inject({
        method: "POST",
        url: "/api/messages",
        payload: { to: "+15551234567", body: `msg ${i}` },
      });
    }
    await ctx.app.close();

    // Fresh app instance (in-memory counters cleared), same database.
    ctx = await createTestApp({ MAX_SENDS_PER_DAY: "2" }, ctx.db);
    const capped = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "still capped" },
    });
    expect(capped.statusCode).toBe(429);
  });

  it("rejects bursts past the per-minute limit", async () => {
    ctx = await createTestApp({ MAX_SENDS_PER_MINUTE: "2" });
    for (let i = 0; i < 2; i++) {
      await ctx.inject({
        method: "POST",
        url: "/api/messages",
        payload: { to: "+15551234567", body: `burst ${i}` },
      });
    }
    const limited = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "too fast" },
    });
    expect(limited.statusCode).toBe(429);
  });
});

describe("opt-out (STOP) handling", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function inbound(body: string, sid: string) {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: sid,
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: body,
      }),
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    return list.json().conversations[0];
  }

  it("marks a conversation opted out when they text STOP", async () => {
    await inbound("hello", "SM_h1");
    const convo = await inbound("STOP", "SM_h2");
    expect(convo.optedOut).toBe(true);
  });

  it("recognizes the other opt-out keywords, case-insensitively", async () => {
    for (const [i, word] of ["unsubscribe", "Quit", "CANCEL"].entries()) {
      const fresh = await createTestApp();
      await fresh.inject({
        method: "POST",
        url: "/webhooks/inbound",
        ...signedWebhook("/webhooks/inbound", {
          MessageSid: `SM_kw_${i}`,
          From: "+15551234567",
          To: TEST_FROM_NUMBER,
          Body: word,
        }),
      });
      const list = await fresh.inject({
        method: "GET",
        url: "/api/conversations",
      });
      expect(list.json().conversations[0].optedOut).toBe(true);
      await fresh.app.close();
    }
  });

  it("refuses to send to an opted-out conversation without calling Twilio", async () => {
    await inbound("STOP", "SM_h3");
    const before = ctx.sender.calls.length;

    const res = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "are you there?" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.status).toBe("failed");
    expect(res.json().message.errorCode).toBe("21610");
    expect(ctx.sender.calls.length).toBe(before);
  });

  it("clears the flag when they text START", async () => {
    await inbound("STOP", "SM_h4");
    const convo = await inbound("start", "SM_h5");
    expect(convo.optedOut).toBe(false);

    const res = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "welcome back" },
    });
    expect(res.json().message.status).toBe("queued");
  });

  it("flips the flag when Twilio rejects a send with 21610", async () => {
    ctx.sender.failNextWith = Object.assign(new Error("opted out"), {
      code: 21610,
    });
    const send = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15559998888", body: "hi" },
    });
    expect(send.json().message.errorCode).toBe("21610");

    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    expect(list.json().conversations[0].optedOut).toBe(true);

    // And retry is refused rather than burning another API call.
    const retry = await ctx.inject({
      method: "POST",
      url: `/api/messages/${send.json().message.id}/retry`,
    });
    expect(retry.statusCode).toBe(409);
  });
});

describe("message pagination", () => {
  let ctx: TestApp;
  let conversationId: string;

  beforeEach(async () => {
    ctx = await createTestApp();
    for (let i = 0; i < 7; i++) {
      await ctx.inject({
        method: "POST",
        url: "/webhooks/inbound",
        ...signedWebhook("/webhooks/inbound", {
          MessageSid: `SM_page_${i}`,
          From: "+15551234567",
          To: TEST_FROM_NUMBER,
          Body: `message ${i}`,
        }),
      });
    }
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    conversationId = list.json().conversations[0].id;
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("returns the newest page in chronological order with hasMore", async () => {
    const res = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?limit=3`,
    });
    const { messages, hasMore } = res.json();
    expect(messages.map((m: { body: string }) => m.body)).toEqual([
      "message 4",
      "message 5",
      "message 6",
    ]);
    expect(hasMore).toBe(true);
  });

  it("walks backwards through history with the before cursor", async () => {
    const first = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?limit=3`,
    });
    const oldest = first.json().messages[0];

    const older = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?limit=3&before=${encodeURIComponent(oldest.createdAt)}`,
    });
    expect(older.json().messages.map((m: { body: string }) => m.body)).toEqual([
      "message 1",
      "message 2",
      "message 3",
    ]);
    expect(older.json().hasMore).toBe(true);

    const last = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?limit=3&before=${encodeURIComponent(older.json().messages[0].createdAt)}`,
    });
    expect(last.json().messages.map((m: { body: string }) => m.body)).toEqual([
      "message 0",
    ]);
    expect(last.json().hasMore).toBe(false);
  });

  it("rejects a malformed cursor", async () => {
    const res = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?before=not-a-date`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("archive and delete", () => {
  let ctx: TestApp;
  let mediaDir: string;

  beforeEach(async () => {
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "twiliochat-media-"));
    ctx = await createTestApp({ MEDIA_DIR: mediaDir });
  });

  afterEach(async () => {
    await ctx.app.close();
    await fs.rm(mediaDir, { recursive: true, force: true });
  });

  async function seed(body = "hi", sid = "SM_ad_1") {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: sid,
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: body,
      }),
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    return list.json().conversations[0].id;
  }

  it("hides archived conversations and lists them separately", async () => {
    const id = await seed();
    const res = await ctx.inject({
      method: "PATCH",
      url: `/api/conversations/${id}`,
      payload: { archived: true },
    });
    expect(res.json().conversation.archived).toBe(true);

    const active = await ctx.inject({ method: "GET", url: "/api/conversations" });
    expect(active.json().conversations).toHaveLength(0);

    const archived = await ctx.inject({
      method: "GET",
      url: "/api/conversations?archived=true",
    });
    expect(archived.json().conversations).toHaveLength(1);
  });

  it("deletes a conversation and removes its media from disk", async () => {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_del_mms",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "photo",
        NumMedia: "1",
        MediaUrl0: "https://api.twilio.com/media/x",
        MediaContentType0: "image/jpeg",
      }),
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const id = list.json().conversations[0].id;

    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${id}/messages`,
    });
    const stored = msgs.json().messages[0].attachments[0].path;
    // The fake fetcher records metadata only; create the file it stands for.
    await fs.writeFile(path.join(mediaDir, stored), "jpeg-bytes");

    const res = await ctx.inject({
      method: "DELETE",
      url: `/api/conversations/${id}`,
    });
    expect(res.statusCode).toBe(204);

    await expect(fs.access(path.join(mediaDir, stored))).rejects.toThrow();
    const after = await ctx.inject({ method: "GET", url: "/api/conversations" });
    expect(after.json().conversations).toHaveLength(0);
  });
});
