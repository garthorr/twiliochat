import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signedWebhook } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe("Twilio webhooks", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const inboundParams = {
    MessageSid: "SM_inbound_1",
    From: "+15551234567",
    To: "+15005550006",
    Body: "hello there",
  };

  it("records an inbound message and threads it by sender", async () => {
    const res = await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", inboundParams),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");

    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const { conversations } = list.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].participants).toEqual(["+15551234567"]);
    expect(conversations[0].unreadCount).toBe(1);
    expect(conversations[0].lastMessage.body).toBe("hello there");
    expect(conversations[0].lastMessage.status).toBe("received");
  });

  it("ignores duplicate webhook deliveries (same MessageSid)", async () => {
    for (let i = 0; i < 2; i++) {
      await ctx.inject({
        method: "POST",
        url: "/webhooks/inbound",
        ...signedWebhook("/webhooks/inbound", inboundParams),
      });
    }
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const { conversations } = list.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].unreadCount).toBe(1);

    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${conversations[0].id}/messages`,
    });
    expect(msgs.json().messages).toHaveLength(1);
  });

  it("threads repeat messages from the same number into one conversation", async () => {
    for (const [sid, body] of [
      ["SM_a", "first"],
      ["SM_b", "second"],
    ]) {
      await ctx.inject({
        method: "POST",
        url: "/webhooks/inbound",
        ...signedWebhook("/webhooks/inbound", {
          ...inboundParams,
          MessageSid: sid!,
          Body: body!,
        }),
      });
    }
    const list = await ctx.inject({ method: "GET", url: "/api/conversations" });
    const { conversations } = list.json();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].unreadCount).toBe(2);
    expect(conversations[0].lastMessage.body).toBe("second");
  });

  it("rejects requests without a valid signature", async () => {
    const good = signedWebhook("/webhooks/inbound", inboundParams);
    const res = await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      payload: good.payload,
      headers: {
        ...good.headers,
        "x-twilio-signature": "obviously-wrong",
      },
    });
    expect(res.statusCode).toBe(403);

    const missing = await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      payload: good.payload,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(missing.statusCode).toBe(403);
  });

  it("applies status callbacks to the matching outbound message", async () => {
    const sendRes = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "outbound hi" },
    });
    const { message } = sendRes.json();
    expect(message.twilioSid).toBe("SM_test_1");

    for (const [twilioStatus, expected] of [
      ["sent", "sent"],
      ["delivered", "delivered"],
    ] as const) {
      const res = await ctx.inject({
        method: "POST",
        url: "/webhooks/status",
        ...signedWebhook("/webhooks/status", {
          MessageSid: "SM_test_1",
          MessageStatus: twilioStatus,
        }),
      });
      expect(res.statusCode).toBe(204);

      const msgs = await ctx.inject({
        method: "GET",
        url: `/api/conversations/${sendRes.json().conversationId}/messages`,
      });
      expect(msgs.json().messages[0].status).toBe(expected);
    }
  });

  it("records the error code on undelivered messages", async () => {
    const sendRes = await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "will bounce" },
    });
    await ctx.inject({
      method: "POST",
      url: "/webhooks/status",
      ...signedWebhook("/webhooks/status", {
        MessageSid: "SM_test_1",
        MessageStatus: "undelivered",
        ErrorCode: "30003",
      }),
    });
    const msgs = await ctx.inject({
      method: "GET",
      url: `/api/conversations/${sendRes.json().conversationId}/messages`,
    });
    expect(msgs.json().messages[0].status).toBe("failed");
    expect(msgs.json().messages[0].errorCode).toBe("30003");
  });
});
