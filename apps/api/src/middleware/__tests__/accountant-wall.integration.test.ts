/**
 * accountant-wall.integration.test.ts
 *
 * Leak-guard meta-test (P1 T7). Proves accountantScope is actually MOUNTED on
 * the real app and fires over real routes for a real authenticated accountant
 * — Task 3's test proves the allow/deny logic in isolation (session-injector,
 * no auth); this proves the wiring.
 *
 * Hits a real LOCAL Postgres. Skipped by default. Run explicitly:
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 <repo>/node_modules/.bin/vitest run \
 *     src/middleware/__tests__/accountant-wall.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../app";
import { createSessionToken } from "../../lib/auth";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint prefix ("e5") from other integration tests' constants.
const ORG = "e5000000-0000-4000-8000-0000000000a1";
const USERS = {
  acc: "e5000000-0000-4000-8000-0000000000a2",
  adm: "e5000000-0000-4000-8000-0000000000a3",
  mgr: "e5000000-0000-4000-8000-0000000000a4",
  edt: "e5000000-0000-4000-8000-0000000000a5",
  vwr: "e5000000-0000-4000-8000-0000000000a6",
} as const;

async function seedActive(db: ReturnType<typeof getDb>, id: string, role: string) {
  await db.user.upsert({
    where: { id },
    update: { role, status: "active", organizationId: ORG },
    create: {
      id,
      organizationId: ORG,
      role,
      status: "active",
      userType: "operator",
      email: `${id}@t.test`,
      fullName: id,
      passwordHash: "x",
    },
  });
}

async function tokenFor(role: string, userId: string) {
  // iss/aud MUST be "admin" — authMiddleware verifies {issuer:"admin",audience:"admin"}.
  return createSessionToken(userId, ORG, role, { userType: "operator", iss: "admin", aud: "admin" });
}

async function callAs(role: string, userId: string, method: string, path: string) {
  // Auth via the Authorization: Bearer header, NOT a cookie — adminCsrfIfCookie
  // short-circuits CSRF when a Bearer header is present with no cookie; a cookie
  // would 403 the POST/PUT denied routes via CSRF (wrong body) before reaching
  // the wall. Bearer is the clean path to the {error:"workspace_forbidden"} body.
  const headers = { Authorization: `Bearer ${await tokenFor(role, userId)}` };
  return app.request(path, { method, headers });
}

const DENIED: Array<[string, string]> = [
  ["GET", "/api/bills-grid"],
  ["POST", "/api/payments/p1/post"],
  ["POST", "/api/payments/fpx/p1/cancel"],
  ["POST", "/api/tenancy/landlord-tenancies"],
  ["POST", "/api/inventory/units"],
];

dn("accountant wall (integration)", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.organization.upsert({
      where: { id: ORG },
      update: {},
      create: {
        id: ORG,
        name: "Accountant Wall Int Org",
        slug: "accountant-wall-int-org",
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
    await seedActive(db, USERS.acc, "accountant");
    await seedActive(db, USERS.adm, "admin");
    await seedActive(db, USERS.mgr, "manager");
    await seedActive(db, USERS.edt, "editor");
    await seedActive(db, USERS.vwr, "viewer");
  });

  afterAll(async () => {
    const db = getDb();
    await db.user.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
  });

  it("denies the accountant on operational + leaky routes with workspace_forbidden", async () => {
    for (const [m, p] of DENIED) {
      const res = await callAs("accountant", USERS.acc, m, p);
      expect(res.status, `${m} ${p} status`).toBe(403);
      expect(await res.json(), `${m} ${p} body`).toEqual({ error: "workspace_forbidden" });
    }
  });

  it("lets the accountant PAST the wall on the documents register", async () => {
    const res = await callAs("accountant", USERS.acc, "GET", "/api/billing-documents");
    expect(res.status).not.toBe(403); // reaches requireWorkspace('accounting') (Task 4)
  });

  it("does not wall admin/manager on the accounting routes", async () => {
    for (const [role, uid] of [["admin", USERS.adm], ["manager", USERS.mgr]] as const) {
      const res = await callAs(role, uid, "GET", "/api/billing-documents");
      expect(res.status).not.toBe(403);
    }
  });

  it("admits correction/reverse/void for the accountant (not 403)", async () => {
    // The wall fires on PATH before the handler — literal placeholder ids are fine; only 403 fails the wall.
    for (const [m, p] of [
      ["POST", "/api/billing/charges/c1/void"],
      ["POST", "/api/payments/p1/allocations/a1/reverse"],
      ["PUT", "/api/payments/p1/status"],
    ] as const) {
      const res = await callAs("accountant", USERS.acc, m, p);
      expect(res.status, `${m} ${p}`).not.toBe(403);
    }
  });

  it("admits the owner-remittance create route for the accountant (Task 6 fix — not 403)", async () => {
    // GC8 authz requires the accounting workspace be able to post remittances;
    // the router's own requireWorkspaceOrRank("accounting","manager") already
    // grants it via the workspace path — this proves the request actually
    // REACHES that check through the real wall (no body needed: the wall
    // fires on PATH before the router's flag-gate/JSON parsing even runs).
    const res = await callAs("accountant", USERS.acc, "POST", "/api/owner-remittances");
    expect(res.status).not.toBe(403);
  });

  it("admits the owner-remittance allocate route for the accountant (Task 7 fix — not 403)", async () => {
    // Task 6's ACCOUNTING_ALLOW entry for POST /api/owner-remittances is an
    // EXACT-path rule (accountant-scope.ts's `exact()` helper) — it does NOT
    // also cover POST /api/owner-remittances/:id/allocate, a DIFFERENT
    // literal path. Without its own rule this 403s at the wall before ever
    // reaching requireWorkspaceOrRank. Placeholder id is fine — the wall
    // fires on PATH before the handler; only 403 fails the wall.
    const res = await callAs("accountant", USERS.acc, "POST", "/api/owner-remittances/p1/allocate");
    expect(res.status).not.toBe(403);
  });

  it("admits the owner-receivable-offset create route for the accountant (Task 8 fix — not 403)", async () => {
    // Task 6's ACCOUNTING_ALLOW entry for POST /api/owner-remittances is an
    // EXACT-path rule (accountant-scope.ts's `exact()` helper) — it does NOT
    // also cover POST /api/owner-receivable-offsets, a DIFFERENT literal base
    // path (a non-cash offset, not a remittance). Without its own rule this
    // 403s at the wall before ever reaching requireWorkspaceOrRank. No body
    // needed — the wall fires on PATH before the router's flag-gate/JSON
    // parsing even runs; only 403 fails the wall.
    const res = await callAs("accountant", USERS.acc, "POST", "/api/owner-receivable-offsets");
    expect(res.status).not.toBe(403);
  });

  it("admits the owner-remittance reverse route for the accountant (Task 9 fix — not 403)", async () => {
    // Task 6's ACCOUNTING_ALLOW entry for POST /api/owner-remittances is an
    // EXACT-path rule — it does NOT also cover POST
    // /api/owner-remittances/:id/reverse, a DIFFERENT literal path (same
    // theme as Task 7's /:id/allocate entry above). Without its own rule
    // this 403s at the wall before ever reaching requireWorkspaceOrRank.
    // Placeholder id is fine — the wall fires on PATH before the handler;
    // only 403 fails the wall.
    const res = await callAs("accountant", USERS.acc, "POST", "/api/owner-remittances/p1/reverse");
    expect(res.status).not.toBe(403);
  });

  it("admits the owner-receivable-offset reverse route for the accountant (Task 9 fix — not 403)", async () => {
    // Same rationale as the remittance-reverse case above, for the
    // DIFFERENT /api/owner-receivable-offsets base path (Task 8's exact()
    // entry covers only the bare create path).
    const res = await callAs("accountant", USERS.acc, "POST", "/api/owner-receivable-offsets/p1/reverse");
    expect(res.status).not.toBe(403);
  });

  it("(E16 accountant_workspace_only) admits the owner-account GET read route for the accountant (Task 10 fix — not 403)", async () => {
    // GET, unlike every existing owner-remittance entry above — the wall
    // fires on (method, path) for ALL HTTP methods, not just POST, so a GET
    // route needs its OWN allowlist entry even though the router's
    // requireWorkspaceOrRank("accounting","manager") already grants an
    // accountant via the workspace path (same OR-logic Task 6-9 rely on).
    const res = await callAs("accountant", USERS.acc, "GET", "/api/owner-remittances/owner/p1");
    expect(res.status).not.toBe(403);
  });

  it("(E13 regex_precision) does NOT admit sibling GET paths under /api/owner-remittances for the accountant (anchored regex, not a leaky prefix)", async () => {
    // Task 7's own precedent for this exact concern: the file's header warns
    // "Keep this list EXACT — a bare prefix would leak" sibling routes. The
    // new rule must match ONLY /owner/:ownerPartyId, never a bare base path
    // or a same-prefix-different-shape path.
    for (const p of ["/api/owner-remittances", "/api/owner-remittances/owner", "/api/owner-remittances/p1"]) {
      const res = await callAs("accountant", USERS.acc, "GET", p);
      expect(res.status, `GET ${p}`).toBe(403);
      expect(await res.json(), `GET ${p} body`).toEqual({ error: "workspace_forbidden" });
    }
  });

  it("keeps the accountant 403 on un-opened siblings", async () => {
    for (const [m, p] of [
      ["POST", "/api/payments"],
      ["POST", "/api/payments/p1/post"],
      ["POST", "/api/billing-documents/apply-credit"],
      ["GET", "/api/billing/charges/c1"],
    ] as const) {
      const res = await callAs("accountant", USERS.acc, m, p);
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(await res.json()).toEqual({ error: "workspace_forbidden" });
    }
  });

  it("PUT /payments/:id/status matrix — manager+admin admitted, editor+viewer denied", async () => {
    for (const [role, uid] of [["manager", USERS.mgr], ["admin", USERS.adm]] as const) {
      expect((await callAs(role, uid, "PUT", "/api/payments/p1/status")).status, role).not.toBe(403);
    }
    for (const [role, uid] of [["editor", USERS.edt], ["viewer", USERS.vwr]] as const) {
      expect((await callAs(role, uid, "PUT", "/api/payments/p1/status")).status, role).toBe(403);
    }
  });
});
