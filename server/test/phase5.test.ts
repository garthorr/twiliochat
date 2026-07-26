import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extensionFor } from "../src/services/media.js";
import { createTestApp, signedWebhook, TEST_FROM_NUMBER } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe("MMS attachments", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("re-hosts inbound media and returns it with the message", async () => {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_mms_1",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "check this out",
        NumMedia: "2",
        MediaUrl0: "https://api.twilio.com/media/img1",
        MediaContentType0: "image/jpeg",
        MediaUrl1: "https://api.twilio.com/media/img2",
        MediaContentType1: "image/png",
      }),
    });

    // Both media items were fetched from Twilio.
    expect(ctx.mediaFetcher.fetched).toEqual([
      "https://api.twilio.com/media/img1",
      "https://api.twilio.com/media/img2",
    ]);

    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const convoId = list.json().conversations[0].id;
    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${convoId}/messages`,
    });
    const message = msgs.json().messages[0];
    expect(message.body).toBe("check this out");
    expect(message.attachments).toHaveLength(2);
    expect(message.attachments[0].contentType).toBe("image/jpeg");
    expect(message.attachments[0].path).toMatch(/\.jpg$/);
    expect(message.attachments[1].path).toMatch(/\.png$/);
  });

  it("keeps the message when a media download fails", async () => {
    ctx.mediaFetcher.failUrls.add("https://api.twilio.com/media/bad");
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_mms_fail",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "broken media",
        NumMedia: "1",
        MediaUrl0: "https://api.twilio.com/media/bad",
        MediaContentType0: "image/jpeg",
      }),
    });

    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${list.json().conversations[0].id}/messages`,
    });
    expect(msgs.json().messages[0].body).toBe("broken media");
    expect(msgs.json().messages[0].attachments).toHaveLength(0);
  });

  it("maps content types to sensible file extensions", () => {
    expect(extensionFor("image/jpeg")).toBe(".jpg");
    expect(extensionFor("IMAGE/PNG")).toBe(".png");
    expect(extensionFor("application/x-unknown")).toBe(".bin");
  });

  it("requires a session to read media", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/media/whatever.jpg" });
    expect(res.statusCode).toBe(401);
  });
});

describe("contact names", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function seedConversation(): Promise<string> {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_name_1",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "hi",
      }),
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    return list.json().conversations[0].id;
  }

  it("sets and clears a display name", async () => {
    const id = await seedConversation();
    const named = await ctx.inject({
      method: "PATCH",
      url: `/api/conversations/${id}`,
      payload: { displayName: "  Jordan Rivera  " },
    });
    expect(named.json().conversation.displayName).toBe("Jordan Rivera");

    const cleared = await ctx.inject({
      method: "PATCH",
      url: `/api/conversations/${id}`,
      payload: { displayName: "" },
    });
    expect(cleared.json().conversation.displayName).toBeNull();
  });

  it("uses the contact name in push notifications", async () => {
    const id = await seedConversation();
    await ctx.inject({
      method: "PATCH",
      url: `/api/conversations/${id}`,
      payload: { displayName: "Jordan" },
    });
    await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: {
        endpoint: "https://push.example.test/s1",
        keys: { p256dh: "k", auth: "a" },
      },
    });

    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_name_2",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "second",
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const payload = JSON.parse(ctx.pushSender.sent[0]!.payload) as {
      title: string;
    };
    expect(payload.title).toBe("Jordan");
  });
});

describe("search", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
    for (const [sid, body] of [
      ["SM_s1", "let's get ramen tonight"],
      ["SM_s2", "package delivered"],
    ]) {
      await ctx.inject({
        method: "POST",
        url: "/webhooks/inbound",
        ...signedWebhook("/webhooks/inbound", {
          MessageSid: sid!,
          From: "+15551234567",
          To: TEST_FROM_NUMBER,
          Body: body!,
        }),
      });
    }
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("finds messages by content, case-insensitively", async () => {
    const res = await ctx.inject({ method: "GET", url: "/api/search?q=RAMEN" });
    const { results } = res.json();
    expect(results).toHaveLength(1);
    expect(results[0].message.body).toBe("let's get ramen tonight");
    expect(results[0].conversation.participants).toEqual(["+15551234567"]);
  });

  it("returns nothing for an empty query", async () => {
    const res = await ctx.inject({ method: "GET", url: "/api/search?q=" });
    expect(res.json().results).toEqual([]);
  });
});

describe("retrying failed sends", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function sendFailing(): Promise<string> {
    ctx.sender.failNextWith = Object.assign(new Error("blocked"), {
      code: 21610,
    });
    const res = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "retry me" },
    });
    return res.json().message.id;
  }

  it("re-sends a failed message on the same row and clears the error", async () => {
    const id = await sendFailing();

    const retry = await ctx.inject({
      method: "POST",
      url: `/api/messages/${id}/retry`,
    });
    expect(retry.statusCode).toBe(200);
    const message = retry.json().message;
    expect(message.id).toBe(id);
    expect(message.status).toBe("queued");
    expect(message.errorCode).toBeNull();
    expect(message.twilioSid).toBe("SM_test_1");
    expect(ctx.sender.calls.at(-1)?.body).toBe("retry me");

    // Still a single message in the thread — retry reuses the row.
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${list.json().conversations[0].id}/messages`,
    });
    expect(msgs.json().messages).toHaveLength(1);
  });

  it("marks it failed again when the retry also fails", async () => {
    const id = await sendFailing();
    ctx.sender.failNextWith = Object.assign(new Error("still blocked"), {
      code: 21610,
    });
    const retry = await ctx.inject({
      method: "POST",
      url: `/api/messages/${id}/retry`,
    });
    expect(retry.json().message.status).toBe("failed");
    expect(retry.json().message.errorCode).toBe("21610");
  });

  it("refuses to retry a message that did not fail", async () => {
    const ok = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "fine" },
    });
    const res = await ctx.inject({
      method: "POST",
      url: `/api/messages/${ok.json().message.id}/retry`,
    });
    expect(res.statusCode).toBe(409);
  });
});
