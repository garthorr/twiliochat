import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions } from "../src/db/schema.js";
import { createTestApp, signedWebhook, TEST_FROM_NUMBER } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const subscription = {
  endpoint: "https://push.example.test/sub-1",
  keys: { p256dh: "test-p256dh-key", auth: "test-auth-key" },
};

describe("web push", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("exposes the VAPID public key to logged-in clients only", async () => {
    const authed = await ctx.inject({
      method: "GET",
      url: "/api/push/public-key",
    });
    expect(authed.json()).toEqual({ publicKey: "test-vapid-public-key" });

    const anon = await ctx.app.inject({
      method: "GET",
      url: "/api/push/public-key",
    });
    expect(anon.statusCode).toBe(401);
  });

  it("stores a subscription and replaces it on re-subscribe", async () => {
    const res = await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: subscription,
    });
    expect(res.statusCode).toBe(201);

    await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: {
        ...subscription,
        keys: { p256dh: "rotated-key", auth: "rotated-auth" },
      },
    });

    const rows = await ctx.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keysP256dh).toBe("rotated-key");
  });

  it("rejects malformed subscriptions", async () => {
    const res = await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint: "https://push.example.test/x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("removes a subscription on unsubscribe", async () => {
    await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: subscription,
    });
    const res = await ctx.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      payload: { endpoint: subscription.endpoint },
    });
    expect(res.statusCode).toBe(204);
    expect(await ctx.db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("notifies subscribers when an inbound message arrives", async () => {
    await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: subscription,
    });

    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_push_1",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "ping!",
      }),
    });

    // The fan-out is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.pushSender.sent).toHaveLength(1);
    const payload = JSON.parse(ctx.pushSender.sent[0]!.payload) as {
      title: string;
      body: string;
      conversationId: string;
    };
    expect(payload.title).toBe("(555) 123-4567");
    expect(payload.body).toBe("ping!");
    expect(payload.conversationId).toBeTruthy();
  });

  it("prunes subscriptions the push service reports as gone", async () => {
    await ctx.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: subscription,
    });
    ctx.pushSender.goneEndpoints.add(subscription.endpoint);

    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_push_gone",
        From: "+15551234567",
        To: TEST_FROM_NUMBER,
        Body: "gone",
      }),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(await ctx.db.select().from(pushSubscriptions)).toHaveLength(0);
  });
});
