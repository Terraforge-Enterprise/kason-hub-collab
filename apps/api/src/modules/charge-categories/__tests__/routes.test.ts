import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// NOTE: CATEGORY_DTO/SERIES_DTO and the service-mock fns are built inside
// vi.hoisted() (meter/__tests__/routes.test.ts precedent). Native ESM
// resolves ALL import statements in this file — including the later
// `import { chargeCategoriesRoutes } from "../routes"` below, which
// transitively imports "./service" — before any of the file's own
// top-level `const` bodies run. A plain `const CATEGORY_DTO = {...}`
// referenced inside `vi.mock("../service", () => ({...}))` therefore hits
// "Cannot access 'CATEGORY_DTO' before initialization"; vi.hoisted()
// sidesteps that by constructing the values inside the same hoisted block
// vi.mock's factories are compiled to run from.
const { CATEGORY_DTO, SERIES_DTO } = vi.hoisted(() => ({
  CATEGORY_DTO: {
    id: "cat-1", code: "rental", name: "Monthly rental", family: "pay_back_landlord",
    docType: "debit_note", seriesId: "series-dep", seriesCode: "DEP", defaultSstRate: "0",
    eInvoiceEligible: false, ledgerCategory: "rental_income", isSystem: true, active: true,
    sortOrder: 200, description: null, updatedAt: "2026-07-02T00:00:00.000Z",
  },
  SERIES_DTO: {
    id: "series-dep", code: "DEP", prefix: "DEP", padding: 4, includeYear: false,
    active: true, updatedAt: "2026-07-02T00:00:00.000Z",
  },
}));

vi.mock("../seed", () => ({ ensureChargeCategorySeeds: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../service", () => ({
  listChargeCategoriesService: vi.fn().mockResolvedValue([CATEGORY_DTO]),
  createChargeCategoryService: vi.fn().mockResolvedValue({ ok: true, data: CATEGORY_DTO }),
  updateChargeCategoryService: vi.fn().mockResolvedValue({ ok: true, data: CATEGORY_DTO }),
  deactivateChargeCategoryService: vi.fn().mockResolvedValue({
    ok: false, status: 409, error: { code: "CATEGORY_IS_SYSTEM", message: "System categories cannot be deactivated." },
  }),
  listDocumentSeriesService: vi.fn().mockResolvedValue([SERIES_DTO]),
  updateDocumentSeriesService: vi.fn().mockResolvedValue({ ok: true, data: SERIES_DTO }),
}));

import { chargeCategoriesRoutes } from "../routes";
import { ensureChargeCategorySeeds } from "../seed";

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", chargeCategoriesRoutes);
  return app;
}

const adminSession: SessionPayload = { userId: "u0", orgId: "o1", role: "admin", userType: "operator" };
const managerSession: SessionPayload = { userId: "u1", orgId: "o1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "o1", role: "editor", userType: "operator" };
const viewerSession: SessionPayload = { userId: "u3", orgId: "o1", role: "viewer", userType: "operator" };

beforeAll(() => {
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
});
afterAll(() => {
  delete process.env.ENABLE_PHASE2_BILLING_DOCS;
});

describe("flag gate", () => {
  it("returns canonical 404 while ENABLE_PHASE2_BILLING_DOCS is dark, even for an admin", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    try {
      const res = await makeApp(adminSession).request("/");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    } finally {
      process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    }
  });
});

describe("GET /", () => {
  it("lazy-seeds then lists for ANY admin session (viewer included)", async () => {
    const res = await makeApp(viewerSession).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [CATEGORY_DTO] });
    expect(vi.mocked(ensureChargeCategorySeeds)).toHaveBeenCalledWith("o1");
  });
});

describe("category mutations are manager-or-above", () => {
  it("editor POST / → 403", async () => {
    const res = await makeApp(editorSession).request("/", {
      method: "POST",
      body: JSON.stringify({ code: "misc_fee", name: "Misc fee", family: "tenant_income", docType: "invoice", seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("admin POST / → 201 with the created DTO", async () => {
    const res = await makeApp(adminSession).request("/", {
      method: "POST",
      body: JSON.stringify({ code: "misc_fee", name: "Misc fee", family: "tenant_income", docType: "invoice", seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: CATEGORY_DTO });
  });

  it("admin POST /:id/deactivate on a system category → 409 CATEGORY_IS_SYSTEM", async () => {
    const res = await makeApp(adminSession).request("/cat-1/deactivate", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CATEGORY_IS_SYSTEM");
  });

  it("invalid PATCH body → 400 before the service runs", async () => {
    const res = await makeApp(adminSession).request("/cat-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "x" }), // missing expectedUpdatedAt
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  // Widened 2026-08-03: the registry is maintained from Settings → Billing Config,
  // which managers run day-to-day. Editors stay 403 (asserted above).
  it("manager POST / → 201 (category create is no longer admin-only)", async () => {
    const res = await makeApp(managerSession).request("/", {
      method: "POST",
      body: JSON.stringify({ code: "pest_control_owner", name: "Pest control (owner)", family: "owner_income", docType: "invoice", seriesId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
  });

  it("manager PATCH /:id → 200", async () => {
    const res = await makeApp(managerSession).request("/cat-1", {
      method: "PATCH",
      body: JSON.stringify({ profitExpense: "expense", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("manager POST /:id/deactivate reaches the service (409 here = the system-category guard, not RBAC)", async () => {
    const res = await makeApp(managerSession).request("/cat-1/deactivate", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CATEGORY_IS_SYSTEM");
  });

  it("editor PATCH /:id and POST /:id/deactivate stay 403", async () => {
    const patch = await makeApp(editorSession).request("/cat-1", {
      method: "PATCH",
      body: JSON.stringify({ profitExpense: "expense", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }),
      headers: { "content-type": "application/json" },
    });
    expect(patch.status).toBe(403);
    const deactivate = await makeApp(editorSession).request("/cat-1/deactivate", { method: "POST" });
    expect(deactivate.status).toBe(403);
  });

  // DELIBERATE asymmetry: renumbering a document SERIES is org-wide and affects every
  // future document on it, so it was NOT widened with the category routes.
  it("manager PATCH /series/:id → 403 (series numbering stays admin-only)", async () => {
    const res = await makeApp(managerSession).request("/series/series-dep", {
      method: "PATCH",
      body: JSON.stringify({ padding: 5, expectedUpdatedAt: "2026-07-02T00:00:00.000Z" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
  });
});

describe("series", () => {
  it("GET /series lists for any admin session", async () => {
    const res = await makeApp(viewerSession).request("/series");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [SERIES_DTO] });
  });

  it("editor PATCH /series/:id → 403; admin → 200", async () => {
    const body = { prefix: "INV", expectedUpdatedAt: "2026-07-02T00:00:00.000Z" };
    const forbidden = await makeApp(editorSession).request("/series/series-dep", {
      method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    });
    expect(forbidden.status).toBe(403);
    const ok = await makeApp(adminSession).request("/series/series-dep", {
      method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
  });
});
