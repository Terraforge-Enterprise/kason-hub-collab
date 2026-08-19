import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @kason/db ───────────────────────────────────────────────────────────
const mockInvoiceFindMany = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    invoice: { findMany: mockInvoiceFindMany },
    $transaction: (fn: (tx: unknown) => unknown) => mockTransaction(fn),
  }),
}));

// ── Mock audit ───────────────────────────────────────────────────────────────
const mockRecordAudit = vi.fn();
vi.mock("../../../lib/audit", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

// ── Mock the repository ──────────────────────────────────────────────────────
// firstOfMonthUtc keeps its REAL behaviour: the period band it produces is the
// thing under test, and a stubbed date would make the where-clause assertions
// meaningless.
const mockGetDraftConfig = vi.fn();
vi.mock("../auto-draft.repository", () => ({
  getDraftConfig: (orgId: string) => mockGetDraftConfig(orgId),
  firstOfMonthUtc: (ym: string) => new Date(`${ym}-01T00:00:00.000Z`),
}));

// ── Mock the approval path ───────────────────────────────────────────────────
// Auto-billing must DELEGATE to approveBulkService, never reimplement approval.
// Mocking it is how that contract is asserted.
const mockApproveBulk = vi.fn();
vi.mock("../auto-draft.service", () => ({
  approveBulkService: (...args: unknown[]) => mockApproveBulk(...args),
}));

import { runAutoBillInvoices } from "../auto-bill.service";

const ORG = "org-1";
const CONFIG_ID = "cfg-1";
const NOW_1_AUG = new Date(Date.UTC(2026, 7, 1));
const ctx = {
  orgId: ORG,
  actorUserId: "user-1",
  actorRole: "admin" as const,
  triggeredBy: "system:auto-bill",
};

function config(over: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    isActive: true,
    autoBillDayOfMonth: 1,
    billPeriodOffset: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoiceFindMany.mockResolvedValue([]);
  mockApproveBulk.mockResolvedValue({ ok: true, status: 200, data: { approved: [], skipped: [] } });
});

describe("runAutoBillInvoices — the OFF switches", () => {
  it("bills nothing when the org has no DraftConfig", async () => {
    mockGetDraftConfig.mockResolvedValue(null);
    const r = await runAutoBillInvoices(ctx, NOW_1_AUG);
    expect(r.billed).toBe(0);
    expect(mockInvoiceFindMany).not.toHaveBeenCalled();
    expect(mockApproveBulk).not.toHaveBeenCalled();
  });

  it("bills nothing when the schedule is paused", async () => {
    mockGetDraftConfig.mockResolvedValue(config({ isActive: false }));
    const r = await runAutoBillInvoices(ctx, NOW_1_AUG);
    expect(r.billed).toBe(0);
    expect(mockApproveBulk).not.toHaveBeenCalled();
  });

  it("bills nothing when autoBillDayOfMonth is null — the DEFAULT for every org", async () => {
    // The single most important test in this file. NULL is the shipped default,
    // so if this regresses, every existing org starts billing unattended on the
    // next cron fire.
    mockGetDraftConfig.mockResolvedValue(config({ autoBillDayOfMonth: null }));
    const r = await runAutoBillInvoices(ctx, NOW_1_AUG);
    expect(r.billed).toBe(0);
    expect(mockInvoiceFindMany).not.toHaveBeenCalled();
    expect(mockApproveBulk).not.toHaveBeenCalled();
  });
});

describe("runAutoBillInvoices — what it selects", () => {
  it("selects ONLY draft tenant_rental invoices inside the period band", async () => {
    mockGetDraftConfig.mockResolvedValue(config({ billPeriodOffset: 0 }));
    await runAutoBillInvoices(ctx, NOW_1_AUG);

    const where = mockInvoiceFindMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
    expect(where.invoiceType).toBe("tenant_rental"); // never owner_statement
    expect(where.status).toBe("draft"); // never re-touches approved money
    expect(where.periodMonth.gte).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(where.periodMonth.lte).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("widens the band to the drafted month under advance billing (offset 1)", async () => {
    mockGetDraftConfig.mockResolvedValue(config({ billPeriodOffset: 1 }));
    await runAutoBillInvoices(ctx, NOW_1_AUG);

    const where = mockInvoiceFindMany.mock.calls[0][0].where;
    expect(where.periodMonth.gte).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(where.periodMonth.lte).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("never reaches into a PAST month", async () => {
    // Mirrors the drafting side: a frozen owner-statement period, or a draft an
    // admin parked on purpose, must not be billed by an unattended job.
    mockGetDraftConfig.mockResolvedValue(config({ billPeriodOffset: 2 }));
    await runAutoBillInvoices(ctx, new Date(Date.UTC(2026, 7, 20)));

    const where = mockInvoiceFindMany.mock.calls[0][0].where;
    expect(where.periodMonth.gte).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("short-circuits before approving when nothing is due", async () => {
    mockGetDraftConfig.mockResolvedValue(config());
    mockInvoiceFindMany.mockResolvedValue([]);
    const r = await runAutoBillInvoices(ctx, NOW_1_AUG);
    expect(r.billed).toBe(0);
    expect(mockApproveBulk).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

describe("runAutoBillInvoices — delegation and reporting", () => {
  beforeEach(() => {
    mockGetDraftConfig.mockResolvedValue(config());
    mockInvoiceFindMany.mockResolvedValue([{ id: "inv-1" }, { id: "inv-2" }]);
  });

  it("hands the ids to approveBulkService rather than approving them itself", async () => {
    mockApproveBulk.mockResolvedValue({
      ok: true, status: 200, data: { approved: ["inv-1", "inv-2"], skipped: [] },
    });
    const r = await runAutoBillInvoices(ctx, NOW_1_AUG);

    expect(mockApproveBulk).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
      ["inv-1", "inv-2"],
    );
    expect(r.billed).toBe(2);
    expect(r.skipped).toBe(0);
  });

  it("counts a concurrently-issued invoice as skipped, not as a failure", async () => {
    // A human clicking "Issue all" a second before the cron is CORRECT behaviour.
    mockApproveBulk.mockResolvedValue({
      ok: true, status: 200, data: { approved: ["inv-1"], skipped: ["inv-2"] },
    });
    const r = await runAutoBillInvoices(ctx, NOW_1_AUG);
    expect(r.billed).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("writes ONE run-level audit row naming the settings that caused the billing", async () => {
    mockApproveBulk.mockResolvedValue({
      ok: true, status: 200, data: { approved: ["inv-1", "inv-2"], skipped: [] },
    });
    await runAutoBillInvoices(ctx, NOW_1_AUG);

    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][1];
    expect(audit.action).toBe("billing.autobill.completed");
    expect(audit.entityId).toBe(CONFIG_ID);
    expect(audit.meta).toMatchObject({
      billed: 2,
      periodFrom: "2026-08",
      periodTo: "2026-08",
      autoBillDayOfMonth: 1,
      invoiceIds: ["inv-1", "inv-2"],
    });
  });

  it("writes NO audit row when every candidate was skipped", async () => {
    mockApproveBulk.mockResolvedValue({
      ok: true, status: 200, data: { approved: [], skipped: ["inv-1", "inv-2"] },
    });
    await runAutoBillInvoices(ctx, NOW_1_AUG);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("throws when the approval service itself fails, rather than reporting success", async () => {
    mockApproveBulk.mockResolvedValue({ ok: false, status: 500, error: "boom" });
    await expect(runAutoBillInvoices(ctx, NOW_1_AUG)).rejects.toThrow(/boom/);
  });
});
