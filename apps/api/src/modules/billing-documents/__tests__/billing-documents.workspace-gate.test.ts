import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireWorkspace } from "../../../lib/workspace-access";
import type { SessionPayload } from "../../../lib/auth";

// The module gate under test in isolation: requireWorkspace("accounting").
async function gated(role: string) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { c.set("session", { role } as SessionPayload); await next(); });
  app.use("*", requireWorkspace("accounting"));
  app.get("/", (c) => c.json({ ok: true }));
  const res = await app.request("/", { method: "GET" });
  return res.status;
}

it("admits accountant, manager, admin to the register gate", async () => {
  for (const r of ["accountant", "manager", "admin"]) expect(await gated(r)).toBe(200);
});

it("denies editor and viewer at the register gate", async () => {
  for (const r of ["editor", "viewer"]) expect(await gated(r)).toBe(403);
});
