import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireWorkspace } from "../../../lib/workspace-access";
import type { SessionPayload } from "../../../lib/auth";

async function gated(role: string, method: "POST" | "DELETE"): Promise<number> {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => { c.set("session", { role } as SessionPayload); await next(); });
  app.use("*", requireWorkspace("accounting"));
  app.on(method, "/", (c) => c.json({ ok: true }));
  const res = await app.request("/", { method });
  return res.status;
}

describe("refund-proofs accounting gate", () => {
  it("admits accountant, manager, admin (POST + DELETE)", async () => {
    for (const m of ["POST", "DELETE"] as const)
      for (const r of ["accountant", "manager", "admin"]) expect(await gated(r, m)).toBe(200);
  });
  it("denies editor, viewer", async () => {
    for (const r of ["editor", "viewer"]) expect(await gated(r, "POST")).toBe(403);
  });
});
