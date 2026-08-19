// P4 Task 3/4: org-wide units-summary + apartment-context routes (service mocked).
import { describe, it, expect, vi, beforeAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

// The routes module imports every service export by name — the mock factory
// must provide ALL of them or the import itself throws.
vi.mock("../owner-ledger.service", () => ({
  createEntryService: vi.fn(),
  listEntriesService: vi.fn(),
  getEntryService: vi.fn(),
  updateEntryService: vi.fn(),
  voidEntryService: vi.fn(),
  getSummaryService: vi.fn(),
  getTaxSummaryService: vi.fn(),
  getOwnerTreeService: vi.fn(),
  getOwnersSummaryService: vi.fn(),
  getOwnerMonthsService: vi.fn(),
  getUnitsSummaryService: vi.fn(),
  getOrgUnitsSummaryService: vi.fn(),
  getApartmentContextService: vi.fn(),
}));

vi.mock("../owner-ledger.sync", () => ({
  syncMonthService: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

import { ownerLedgerRoutes } from "../owner-ledger.routes";
import {
  getOrgUnitsSummaryService,
  getApartmentContextService,
} from "../owner-ledger.service";

const managerSession: SessionPayload = {
  userId: "u2",
  orgId: "o1",
  role: "manager",
  userType: "operator",
};
const editorSession: SessionPayload = {
  userId: "u3",
  orgId: "o1",
  role: "editor",
  userType: "operator",
};

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", ownerLedgerRoutes);
  return app;
}

const ROW = {
  apartmentId: "f7000000-0000-4000-8000-0000000000a1",
  unitCode: "A-07-01",
  propertyId: "f7000000-0000-4000-8000-000000000006",
  propertyName: "Org Residences",
  ownerPartyId: "f7000000-0000-4000-8000-000000000004",
  ownerName: "Org Owner",
  occupancy: { activeTenancies: 1 },
  figures: { income: "1000.00", expenses: "100.00", netPayout: "900.00" },
  statement: null,
  openDocuments: 0,
};

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});

describe("GET /units-summary (org-wide, P4)", () => {
  it("returns 403 for editor role", async () => {
    const res = await makeApp(editorSession).request("/units-summary?month=2026-07-01");
    expect(res.status).toBe(403);
  });

  it("400s a YYYY-MM month (contract requires YYYY-MM-01)", async () => {
    const res = await makeApp(managerSession).request("/units-summary?month=2026-07");
    expect(res.status).toBe(400);
  });

  it("returns 200 with items+total and passes defaults page=1 pageSize=20", async () => {
    (getOrgUnitsSummaryService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [ROW], total: 1 },
    });
    const res = await makeApp(managerSession).request("/units-summary?month=2026-07-01");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.items[0].unitCode).toBe("A-07-01");
    expect(getOrgUnitsSummaryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({ month: "2026-07-01", page: 1, pageSize: 20 }),
    );
  });

  it("passes q, propertyId, page, pageSize through", async () => {
    (getOrgUnitsSummaryService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [], total: 0 },
    });
    await makeApp(managerSession).request(
      "/units-summary?month=2026-07-01&q=A-07&propertyId=f7000000-0000-4000-8000-000000000006&page=2&pageSize=10",
    );
    expect(getOrgUnitsSummaryService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      expect.objectContaining({
        month: "2026-07-01",
        q: "A-07",
        propertyId: "f7000000-0000-4000-8000-000000000006",
        page: 2,
        pageSize: 10,
      }),
    );
  });

  it("caps pageSize at 50", async () => {
    const res = await makeApp(managerSession).request("/units-summary?month=2026-07-01&pageSize=500");
    expect(res.status).toBe(400);
  });
});

describe("GET /units/:apartmentId/context (P4 — Task 4)", () => {
  it("returns 403 for editor role", async () => {
    const res = await makeApp(editorSession).request(
      "/units/f7000000-0000-4000-8000-0000000000a1/context",
    );
    expect(res.status).toBe(403);
  });

  it("400s a non-uuid apartment id", async () => {
    const res = await makeApp(managerSession).request("/units/apt-1/context");
    expect(res.status).toBe(400);
  });

  it("returns 200 with the context for manager", async () => {
    (getApartmentContextService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        apartmentId: "f7000000-0000-4000-8000-0000000000a1",
        unitCode: "A-07-01",
        listingMode: "WHOLE",
        propertyId: "f7000000-0000-4000-8000-000000000006",
        propertyName: "Org Residences",
        ownerPartyId: "f7000000-0000-4000-8000-000000000004",
        ownerName: "Org Owner",
        activeTenancies: [],
      },
    });
    const res = await makeApp(managerSession).request(
      "/units/f7000000-0000-4000-8000-0000000000a1/context",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.unitCode).toBe("A-07-01");
  });

  it("maps a service 404 through", async () => {
    (getApartmentContextService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      error: "Not found",
    });
    const res = await makeApp(managerSession).request(
      "/units/f7000000-0000-4000-8000-0000000000ff/context",
    );
    expect(res.status).toBe(404);
  });
});
