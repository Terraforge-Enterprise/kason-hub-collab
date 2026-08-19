import { describe, expect, it } from "vitest";
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

it("allows the accountant on the documents register", async () => {
  const res = await appFor("accountant").request("/api/billing-documents", { method: "GET" });
  expect(res.status).toBe(200);
});

it("denies the accountant on an operational route", async () => {
  const res = await appFor("accountant").request("/api/tenancy/landlord-tenancies", { method: "POST" });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "workspace_forbidden" });
});

it("does not scope a manager", async () => {
  const res = await appFor("manager").request("/api/tenancy/landlord-tenancies", { method: "POST" });
  expect(res.status).toBe(200);
});

// Task 3 addendum (folds in ahead of T7): iterate the full DENIED list at the
// scope level (no auth — session-injector), asserting 403 workspace_forbidden,
// and assert every ACCOUNTING_ALLOW rule passes (next()).
const DENIED: Array<[string, string]> = [
  ["GET", "/api/bills-grid"],
  ["POST", "/api/payments/p1/post"],
  ["POST", "/api/payments/fpx/p1/cancel"],
  ["POST", "/api/tenancy/landlord-tenancies"],
  ["POST", "/api/inventory/units"],
];

describe("accountantScope denies the full DENIED set", () => {
  for (const [method, path] of DENIED) {
    it(`denies accountant on ${method} ${path}`, async () => {
      const res = await appFor("accountant").request(path, { method });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "workspace_forbidden" });
    });
  }
});

const ALLOWED: Array<[string, string]> = [
  ["GET", "/api/billing-documents"],
  ["GET", "/api/billing-documents/x/pdf"],
  ["GET", "/api/charge-categories"],
  ["GET", "/api/dashboard/summary"],
  ["POST", "/api/payments/p1/allocations/a1/reverse"],
  ["PUT", "/api/payments/p1/status"],
  // Task 6 fix (owner-remittance): the accounting workspace admits POST — GC8
  // authz requires an accountant be able to post remittances, and the router's
  // own requireWorkspaceOrRank("accounting","manager") already grants it via
  // the workspace path; this wall entry is what lets the request REACH that check.
  ["POST", "/api/owner-remittances"],
  // Task 7 fix (owner-remittance): later allocation of a PRE_STATEMENT_REMITTANCE —
  // a DIFFERENT literal path from the exact rule above; needs its own entry.
  ["POST", "/api/owner-remittances/p1/allocate"],
  // Task 10 fix (owner-remittance): read-only owner-account GET — the wall
  // fires on (method,path) for every HTTP method, not just POST, so this
  // GET route needs its own entry too.
  ["GET", "/api/owner-remittances/owner/p1"],
];

describe("accountantScope allows every ACCOUNTING_ALLOW rule", () => {
  for (const [method, path] of ALLOWED) {
    it(`allows accountant on ${method} ${path}`, async () => {
      const res = await appFor("accountant").request(path, { method });
      expect(res.status).toBe(200);
    });
  }
});
