import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireWorkspace } from "../../../lib/workspace-access";
import type { SessionPayload } from "../../../lib/auth";

// The gate under test in isolation: requireWorkspace("accounting").
async function gated(role: string): Promise<number> {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { c.set("session", { role } as SessionPayload); await next(); });
  app.use("*", requireWorkspace("accounting"));
  app.post("/", (c) => c.json({ ok: true }));
  const res = await app.request("/", { method: "POST" });
  return res.status;
}

describe("record-and-allocate accounting gate", () => {
  it("admits accountant, manager, admin", async () => {
    for (const r of ["accountant", "manager", "admin"]) expect(await gated(r)).toBe(200);
  });
  it("denies editor, operator, viewer", async () => {
    for (const r of ["editor", "operator", "viewer"]) expect(await gated(r)).toBe(403);
  });
});
