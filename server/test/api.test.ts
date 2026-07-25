import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createTestApp,
  createTestDb,
  loginHeaders,
  signedWebhook,
  testConfig,
  TEST_FROM_NUMBER,
  TEST_PUBLIC_URL,
} from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe("messages API", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("sends a message via Twilio and stores it as queued", async () => {
    const res = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "(555) 123-4567", body: "hey!" },
    });
    expect(res.statusCode).toBe(201);
    const { message } = res.json();
    expect(message.status).toBe("queued");
    expect(message.direction).toBe("outbound");
    expect(message.twilioSid).toBe("SM_test_1");

    expect(ctx.sender.calls).toHaveLength(1);
    expect(ctx.sender.calls[0]).toEqual({
      to: "+15551234567",
      from: TEST_FROM_NUMBER,
      body: "hey!",
      statusCallback: `${TEST_PUBLIC_URL}/webhooks/status`,
    });
  });

  it("threads outbound and inbound with the same number together", async () => {
    await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "outbound" },
    });
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_reply",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "inbound reply",
      }),
    });

    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const { conversations } = list.json();
    expect(conversations).toHaveLength(1);

    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversations[0].id}/messages`,
    });
    const bodies = msgs.json().messages.map((m: { body: string }) => m.body);
    expect(bodies).toEqual(["outbound", "inbound reply"]);
  });

  it("marks the message failed when Twilio rejects the send", async () => {
    const err = Object.assign(new Error("blocked"), { code: 21610 });
    ctx.sender.failNextWith = err;
    const res = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "nope" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().message.status).toBe("failed");
    expect(res.json().message.errorCode).toBe("21610");
  });

  it("rejects invalid numbers and empty bodies", async () => {
    const badNumber = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "not-a-number", body: "hi" },
    });
    expect(badNumber.statusCode).toBe(400);

    const emptyBody = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "   " },
    });
    expect(emptyBody.statusCode).toBe(400);
  });

  it("clears the unread count when a conversation is marked read", async () => {
    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_unread",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "unread",
      }),
    });
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const convo = list.json().conversations[0];
    expect(convo.unreadCount).toBe(1);

    const read = await ctx.inject({
      method: "POST",
      url: `/api/conversations/${convo.id}/read`,
    });
    expect(read.statusCode).toBe(204);

    const after = await ctx.inject({ method: "GET", url: "/api/conversations" });
    expect(after.json().conversations[0].unreadCount).toBe(0);
  });

  it("returns 503 for sends when Twilio is not configured", async () => {
    const config = { ...testConfig(), twilio: null };
    const db = await createTestDb();
    const app = await buildApp({ config, db, sender: null });
    const res = await app.inject({
      method: "POST",
      url: "/api/messages",
      headers: await loginHeaders(app),
      payload: { to: "+15551234567", body: "hi" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
