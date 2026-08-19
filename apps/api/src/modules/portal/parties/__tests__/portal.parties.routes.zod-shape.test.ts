/**
 * Shape-verification tests: portal/parties routes must return
 * { error, fieldErrors } (never the old `details` key) when Zod rejects
 * a request body. Part of T11 — formatZodError sweep.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PortalEnv } from "../../auth/portal.auth.types";
import { portalPartiesRoutes } from "../portal.parties.routes";

vi.mock("../portal.parties.service", () => ({
  searchOwnersService: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createOwnerService: vi.fn(),
}));

const agentSession = {
  userId: "u1",
  orgId: "o1",
  role: "agent",
  userType: "agent" as const,
  partyId: "p1",
  iat: 0,
  absoluteExp: 9999999999,
};

function makeApp() {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    c.set("session", agentSession);
    c.set("authMethod", "bearer");
    await next();
  });
  app.route("/", portalPartiesRoutes);
  return app;
}

describe("portalPartiesRoutes — Zod error response shape", () => {
  it("POST /owners with empty body returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp();
    const res = await app.request("/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });

  it("POST /owners with invalid displayName type returns { error, fieldErrors } not { details }", async () => {
    const app = makeApp();
    const res = await app.request("/owners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("fieldErrors");
    expect(body).not.toHaveProperty("details");
  });
});
