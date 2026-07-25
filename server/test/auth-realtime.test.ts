import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, signedWebhook, TEST_PASSWORD } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe("auth", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("rejects API requests without a session cookie", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/conversations" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong password and a tampered cookie", async () => {
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const forged = await ctx.app.inject({
      method: "GET",
      url: "/api/conversations",
      headers: { cookie: "session=authenticated" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("logs in, reports the session, and logs out", async () => {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "session")!;
    expect(cookie.httpOnly).toBe(true);

    const session = await ctx.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: `session=${cookie.value}` },
    });
    expect(session.json()).toEqual({ authenticated: true });

    const anon = await ctx.app.inject({ method: "GET", url: "/api/session" });
    expect(anon.json()).toEqual({ authenticated: false });
  });

  it("leaves healthz and webhooks reachable without a session", async () => {
    const health = await ctx.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    // Webhooks have their own (signature) auth — 403, not 401.
    const hook = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/inbound",
      payload: "From=%2B15551234567",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(hook.statusCode).toBe(403);
  });
});

describe("realtime", () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it("closes unauthenticated websocket connections", async () => {
    const ws = await ctx.app.injectWS("/ws");
    const code = await new Promise<number>((resolve) =>
      ws.on("close", (c: number) => resolve(c)),
    );
    expect(code).toBe(4401);
  });

  it("broadcasts inbound messages to connected clients", async () => {
    const ws = await ctx.app.injectWS("/ws", { headers: ctx.authHeaders });
    const received = new Promise<Record<string, unknown>>((resolve) =>
      ws.on("message", (data: Buffer) => resolve(JSON.parse(data.toString()))),
    );

    await ctx.inject({
      method: "POST",
      url: "/webhooks/inbound",
      ...signedWebhook("/webhooks/inbound", {
        MessageSid: "SM_ws_1",
        From: "+15551234567",
        To: "+15005550006",
        Body: "realtime!",
      }),
    });

    const event = (await received) as {
      type: string;
      message: { body: string; direction: string };
      conversation: { participants: string[]; unreadCount: number };
    };
    expect(event.type).toBe("message.new");
    expect(event.message.body).toBe("realtime!");
    expect(event.message.direction).toBe("inbound");
    expect(event.conversation.participants).toEqual(["+15551234567"]);
    expect(event.conversation.unreadCount).toBe(1);
    ws.terminate();
  });

  it("broadcasts status updates for outbound messages", async () => {
    await ctx.inject({
      method: "POST",
      url: "/api/messages",
      payload: { to: "+15551234567", body: "watch my status" },
    });

    const ws = await ctx.app.injectWS("/ws", { headers: ctx.authHeaders });
    const received = new Promise<Record<string, unknown>>((resolve) =>
      ws.on("message", (data: Buffer) => resolve(JSON.parse(data.toString()))),
    );

    await ctx.inject({
      method: "POST",
      url: "/webhooks/status",
      ...signedWebhook("/webhooks/status", {
        MessageSid: "SM_test_1",
        MessageStatus: "delivered",
      }),
    });

    const event = (await received) as {
      type: string;
      message: { status: string; twilioSid: string };
    };
    expect(event.type).toBe("message.status");
    expect(event.message.status).toBe("delivered");
    expect(event.message.twilioSid).toBe("SM_test_1");
    ws.terminate();
  });
});
