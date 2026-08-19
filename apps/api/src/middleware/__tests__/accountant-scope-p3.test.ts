import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { accountantScope } from "../accountant-scope";
import type { SessionPayload } from "../../lib/auth";

function appFor(role: string) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("/api/*", async (c, next) => { c.set("session", { role } as SessionPayload); await next(); });
  app.use("/api/*", accountantScope);
  app.all("/api/*", (c) => c.json({ ok: true }));
  return app;
}

const ALLOWED: Array<[string, string]> = [
  ["POST", "/api/payments/record-and-allocate"],
  ["GET", "/api/payments/abc-123/proof-urls"],
  ["POST", "/api/billing-documents/invoices"],
  ["POST", "/api/billing-documents/refund-proofs"],
  ["DELETE", "/api/billing-documents/refund-proofs"],
  ["GET", "/api/charge-categories/series"],
  ["POST", "/api/payments/p1/allocations/a1/reverse"],
  ["PUT", "/api/payments/p1/status"],
];

const STILL_DENIED: Array<[string, string]> = [
  ["POST", "/api/payments/p1/post"],
  ["POST", "/api/payments/fpx/p1/cancel"],
];

describe("accountantScope P3 allowlist", () => {
  it("admits the accountant on every P3 accounting route", async () => {
    for (const [m, p] of ALLOWED) {
      const res = await appFor("accountant").request(p, { method: m });
      expect(res.status, `${m} ${p}`).toBe(200);
    }
  });
  it("still denies the payments siblings", async () => {
    for (const [m, p] of STILL_DENIED) {
      const res = await appFor("accountant").request(p, { method: m });
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(await res.json()).toEqual({ error: "workspace_forbidden" });
    }
  });
});
