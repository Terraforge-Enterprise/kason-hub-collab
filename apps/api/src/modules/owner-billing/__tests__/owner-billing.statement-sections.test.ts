import { describe, it, expect, vi, beforeAll } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";

vi.mock("../owner-billing.service", () => ({
  createFeeConfigService: vi.fn(),
  listFeeConfigsService: vi.fn(),
  getFeeConfigService: vi.fn(),
  updateFeeConfigService: vi.fn(),
  retireFeeConfigService: vi.fn(),
  restoreFeeConfigService: vi.fn(),
  generateStatementService: vi.fn(),
  listStatementsService: vi.fn(),
  getStatementService: vi.fn(),
  addStatementLineService: vi.fn(),
  updateStatementLineService: vi.fn(),
  voidStatementLineService: vi.fn(),
  approveStatementService: vi.fn(),
  voidStatementService: vi.fn(),
  sendStatementService: vi.fn(),
  regenerateStatementPdf: vi.fn(),
  getStatementPdfUrl: vi.fn(),
  createCleaningBillService: vi.fn(),
  updateCleaningBillService: vi.fn(),
  voidCleaningBillService: vi.fn(),
  getStatementSectionsService: vi.fn(),
  getLiveStatementSectionsService: vi.fn(),
}));

vi.mock("../owner-billing-receipts.service", () => ({
  uploadReceiptsService: vi.fn(),
  detachReceiptService: vi.fn(),
}));

import { ownerBillingRoutes } from "../owner-billing.routes";
import { getStatementSectionsService } from "../owner-billing.service";

const STMT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const adminSession: SessionPayload = {
  userId: "u1",
  orgId: "o1",
  role: "admin",
  userType: "operator",
};
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
  app.route("/", ownerBillingRoutes);
  return app;
}

const mockSections = {
  header: {
    reportMonth: "June 2026",
    propertyName: "PV9",
    ownerName: "Ahmad",
    bankName: null,
    accountHolder: null,
    accountNumberMasked: null,
  },
  occupancy: { rows: [], occupiedCount: 0, vacantCount: 0, totalMonthlyRental: "0.00" },
  payoutSummary: { lines: [], netPayoutToOwner: "0.00", depositCollected: "0.00" },
  incomeBreakdown: { rows: [], totalIncome: "0.00", totalMgmtFee: "0.00" },
  expenseBreakdown: { rows: [], totalExpenses: "0.00" },
};

beforeAll(() => {
  process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
});

describe("GET /statements/:id/sections", () => {
  it("returns 403 for editor role", async () => {
    const res = await makeApp(editorSession).request(`/statements/${STMT_ID}/sections`);
    expect(res.status).toBe(403);
  });

  it("returns 200 with sections for manager", async () => {
    (getStatementSectionsService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: mockSections,
    });
    const res = await makeApp(managerSession).request(`/statements/${STMT_ID}/sections`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty("header");
    expect(body.data).toHaveProperty("occupancy");
    expect(body.data).toHaveProperty("payoutSummary");
    expect(body.data).toHaveProperty("incomeBreakdown");
    expect(body.data).toHaveProperty("expenseBreakdown");
  });

  it("returns 404 when statement not found", async () => {
    (getStatementSectionsService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      error: "Statement not found",
    });
    const res = await makeApp(managerSession).request(`/statements/${STMT_ID}/sections`);
    expect(res.status).toBe(404);
  });

  it("calls getStatementSectionsService with the statement id", async () => {
    (getStatementSectionsService as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      data: mockSections,
    });
    await makeApp(adminSession).request(`/statements/${STMT_ID}/sections`);
    expect(getStatementSectionsService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1" }),
      STMT_ID,
    );
  });
});
