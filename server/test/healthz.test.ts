import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("GET /healthz", () => {
  it("reports ok without a database configured", async () => {
    const app = await buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "not_configured" });
    await app.close();
  });

  it("404s unknown API routes as JSON", async () => {
    const app = await buildApp({ config: loadConfig({}) });
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
