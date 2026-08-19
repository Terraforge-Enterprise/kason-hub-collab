// Feature-flag visibility endpoint: role matrix + live process.env readout.
// No mocks needed — the route reads process.env directly and touches no DB.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { PHASE2_FLAGS } from "@kason/shared";
import type { SessionPayload } from "../../../lib/auth";
import { featureFlagsRoutes } from "../routes";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", featureFlagsRoutes);
  return app;
}

const manager: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editor: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };

afterEach(() => {
  delete process.env.ENABLE_PHASE2_METER;
  delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
});

describe("GET /api/feature-flags", () => {
  it("editor → 403 (manager+ read)", async () => {
    const res = await makeApp(editor).request("/");
    expect(res.status).toBe(403);
  });

  it("manager → 200 with EVERY registry flag and its live value", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    // ENABLE_BILL_EXPENSES_AS_CHARGES left unset → false (absent means off).
    const res = await makeApp(manager).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: { name: string; api: boolean }[] };
    expect(body.flags.map((f) => f.name)).toEqual([...PHASE2_FLAGS]);
    const byName = new Map(body.flags.map((f) => [f.name, f.api]));
    expect(byName.get("ENABLE_PHASE2_METER")).toBe(true);
    expect(byName.get("ENABLE_BILL_EXPENSES_AS_CHARGES")).toBe(false);
  });

  it("answers even when every flag is off — the diagnostic is never flag-gated", async () => {
    const res = await makeApp(manager).request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: { name: string; api: boolean }[] };
    expect(body.flags).toHaveLength(PHASE2_FLAGS.length);
    expect(body.flags.every((f) => f.api === false)).toBe(true);
  });
});
