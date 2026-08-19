import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @kason/db ───────────────────────────────────────────────────────────
const mockFindMany = vi.fn();
vi.mock("@kason/db", () => ({
  getDb: () => ({ draftConfig: { findMany: mockFindMany } }),
}));

// ── Mock feature-flags ───────────────────────────────────────────────────────
const mockIsPhase2FlagEnabled = vi.fn();
vi.mock("../../../lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => mockIsPhase2FlagEnabled(flag),
}));

// ── Mock the repository ──────────────────────────────────────────────────────
const mockResolveSystemActor = vi.fn();
vi.mock("../auto-draft.repository", () => ({
  resolveSystemActor: (orgId: string) => mockResolveSystemActor(orgId),
}));

// ── Mock the billing service ─────────────────────────────────────────────────
const mockRunAutoBill = vi.fn();
vi.mock("../auto-bill.service", () => ({
  AUTO_BILL_TRIGGERED_BY: "system:auto-bill",
  runAutoBillInvoices: (...args: unknown[]) => mockRunAutoBill(...args),
}));

import { runAutoBillInvoicesCron } from "../../../cron/auto-bill-invoices";

const NOW_15_AUG = new Date(Date.UTC(2026, 7, 15));

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPhase2FlagEnabled.mockReturnValue(true);
  mockResolveSystemActor.mockResolvedValue({ actorUserId: "user-1", actorRole: "admin" });
  mockRunAutoBill.mockResolvedValue({ billed: 0, skipped: 0, from: "2026-08", to: "2026-08" });
  mockFindMany.mockResolvedValue([]);
});

describe("runAutoBillInvoicesCron", () => {
  it("no-ops before touching the DB when the flag is OFF", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(false);
    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r).toEqual({ ranOrgs: 0, billed: 0, skipped: 0 });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("queries only active configs that have an auto-bill day at all", async () => {
    await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, autoBillDayOfMonth: { not: null } },
      }),
    );
  });

  it("bills an org whose day has arrived", async () => {
    mockFindMany.mockResolvedValue([{ organizationId: "org-1", autoBillDayOfMonth: 1 }]);
    mockRunAutoBill.mockResolvedValue({ billed: 3, skipped: 1, from: "2026-08", to: "2026-08" });

    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r).toEqual({ ranOrgs: 1, billed: 3, skipped: 1 });
    expect(mockRunAutoBill).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", triggeredBy: "system:auto-bill" }),
      NOW_15_AUG,
    );
  });

  it("skips an org whose day has NOT arrived yet", async () => {
    mockFindMany.mockResolvedValue([{ organizationId: "org-1", autoBillDayOfMonth: 25 }]);
    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r.ranOrgs).toBe(0);
    expect(mockRunAutoBill).not.toHaveBeenCalled();
  });

  it("keeps billing on every later day of the month, so a mid-month move-in is caught", async () => {
    // Day 1 configured, running on the 15th: the draft created for a tenant who
    // moved in on the 12th must not wait a full month for the next bill day.
    mockFindMany.mockResolvedValue([{ organizationId: "org-1", autoBillDayOfMonth: 1 }]);
    mockRunAutoBill.mockResolvedValue({ billed: 1, skipped: 0, from: "2026-08", to: "2026-08" });
    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r.billed).toBe(1);
  });

  it("skips an org with no admin actor rather than billing with a fake one", async () => {
    mockFindMany.mockResolvedValue([{ organizationId: "org-1", autoBillDayOfMonth: 1 }]);
    mockResolveSystemActor.mockResolvedValue(null);
    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r.ranOrgs).toBe(0);
    expect(mockRunAutoBill).not.toHaveBeenCalled();
  });

  it("isolates a failing org so later orgs still get billed", async () => {
    mockFindMany.mockResolvedValue([
      { organizationId: "org-bad", autoBillDayOfMonth: 1 },
      { organizationId: "org-good", autoBillDayOfMonth: 1 },
    ]);
    mockRunAutoBill
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ billed: 2, skipped: 0, from: "2026-08", to: "2026-08" });

    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r.ranOrgs).toBe(1);
    expect(r.billed).toBe(2);
    expect(mockRunAutoBill).toHaveBeenCalledTimes(2);
  });

  it("resolves the day rule per ORG, not once for the whole run", async () => {
    // Two orgs, different days: hoisting the gate out of the loop is the bug
    // that made one org's schedule apply to everyone in the draft cron.
    mockFindMany.mockResolvedValue([
      { organizationId: "org-due", autoBillDayOfMonth: 10 },
      { organizationId: "org-not-due", autoBillDayOfMonth: 28 },
    ]);
    mockRunAutoBill.mockResolvedValue({ billed: 1, skipped: 0, from: "2026-08", to: "2026-08" });

    const r = await runAutoBillInvoicesCron(NOW_15_AUG);
    expect(r.ranOrgs).toBe(1);
    expect(mockRunAutoBill).toHaveBeenCalledTimes(1);
    expect(mockRunAutoBill).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-due" }),
      NOW_15_AUG,
    );
  });
});
