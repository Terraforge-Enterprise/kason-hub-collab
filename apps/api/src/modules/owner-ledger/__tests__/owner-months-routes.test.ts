import { describe, it, expect, vi, beforeAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

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
  getOrgUnitsSummaryService: vi.fn(),
  getApartmentContextService: vi.fn(),
}));

vi.mock("../owner-ledger.sync", () => ({
  syncMonthService: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

import { ownerLedgerRoutes } from "../owner-ledger.routes";
import { getOwnerMonthsService } from "../owner-ledger.service";

const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

const mockItems = [
  {
    month: "2026-06",
    grossRental: "2000.00",
    totalExpenses: "216.00",
    netPayoutToOwner: "1784.00",
    depositCollected: "0.00",
    statementId: "stmt-1",
    statementStatus: "draft",
    hasData: true,
  },
];

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});

describe("GET /owners/:ownerPartyId/months", () => {
  it("returns 403 for editor role", async () => {
    const res = await makeApp(editorSession).request(`/owners/${OWNER}/months`);
    expect(res.status).toBe(403);
  });

  it("returns 200 with items for manager", async () => {
    (getOwnerMonthsService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: mockItems },
    });
    const res = await makeApp(managerSession).request(`/owners/${OWNER}/months`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].month).toBe("2026-06");
    expect(body.data.items[0].grossRental).toBe("2000.00");
  });

  it("passes year query param to service", async () => {
    (getOwnerMonthsService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [] },
    });
    await makeApp(managerSession).request(`/owners/${OWNER}/months?year=2026`);
    expect(getOwnerMonthsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      OWNER,
      "2026",
    );
  });

  it("returns 400 for invalid year", async () => {
    const res = await makeApp(managerSession).request(`/owners/${OWNER}/months?year=abc`);
    expect(res.status).toBe(400);
  });

  it("calls service without year when param omitted", async () => {
    (getOwnerMonthsService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [] },
    });
    await makeApp(managerSession).request(`/owners/${OWNER}/months`);
    expect(getOwnerMonthsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      OWNER,
      undefined,
    );
  });
});
