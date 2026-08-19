import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @kason/db ─────────────────────────────────────────────────────────
const mockFindMany = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    draftConfig: { findMany: mockFindMany },
    $transaction: (fn: (tx: unknown) => unknown) => mockTransaction(fn),
  }),
}));

// ── Mock audit ─────────────────────────────────────────────────────────────
const mockRecordAudit = vi.fn();
vi.mock("../../../lib/audit", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

// ── Mock feature-flags ─────────────────────────────────────────────────────
const mockIsPhase2FlagEnabled = vi.fn();
vi.mock("../../../lib/feature-flags", () => ({
  isPhase2FlagEnabled: (flag: string) => mockIsPhase2FlagEnabled(flag),
}));

// ── Mock auto-draft.service ────────────────────────────────────────────────
const mockRunAutoDraftInvoices = vi.fn();
const mockFindBillingGaps = vi.fn();
vi.mock("../auto-draft.service", () => ({
  runAutoDraftInvoices: (...args: unknown[]) => mockRunAutoDraftInvoices(...args),
  findBillingGapsService: (...args: unknown[]) => mockFindBillingGaps(...args),
}));

// ── Mock auto-draft.repository ─────────────────────────────────────────────
const mockResolveSystemActor = vi.fn();
vi.mock("../auto-draft.repository", () => ({
  resolveSystemActor: (orgId: string) => mockResolveSystemActor(orgId),
}));

// Import AFTER mocks are registered
import { runAutoDraftInvoicesCron } from "../../../cron/auto-draft-invoices";

const NOW_25_JUN = new Date(Date.UTC(2026, 5, 25)); // 25 Jun 2026, day=25

beforeEach(() => {
  vi.clearAllMocks();
  // Healthy default: no gaps. Individual tests opt into a gap.
  mockFindBillingGaps.mockResolvedValue({
    ok: true,
    status: 200,
    data: { targetPeriod: "2026-07", missingPeriods: [], lookbackMonths: 6, billPeriodOffset: 1 },
  });
});

describe("runAutoDraftInvoicesCron", () => {
  it("(a) no-ops when ENABLE_PHASE2_AUTODRAFT flag is OFF", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(false);

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(result).toEqual({ ranOrgs: 0, created: 0, skipped: 0, missingPeriods: 0 });
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockRunAutoDraftInvoices).not.toHaveBeenCalled();
  });

  it("(b) flag ON + config with runDayOfMonth:25 on the 25th → runs once, billing NEXT month", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    const orgId = "org-abc-123";
    mockFindMany.mockResolvedValue([{ organizationId: orgId, billPeriodOffset: 1 }]);
    mockResolveSystemActor.mockResolvedValue({ actorUserId: "user-admin-1", actorRole: "admin" });
    mockRunAutoDraftInvoices.mockResolvedValue({ runId: "run-1", status: "completed", draftsCreated: 2, draftsSkipped: 1 });

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    // findMany gates on runDayOfMonth: 25 and MUST select billPeriodOffset — without
    // it the offset is undefined and the target period cannot be resolved.
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { isActive: true, runDayOfMonth: 25 },
      select: { organizationId: true, billPeriodOffset: true },
    });

    // ADVANCE BILLING: a 25 Jun run with offset 1 drafts JULY, not June.
    expect(mockRunAutoDraftInvoices).toHaveBeenCalledTimes(1);
    expect(mockRunAutoDraftInvoices).toHaveBeenCalledWith(
      {
        orgId,
        actorUserId: "user-admin-1",
        actorRole: "admin",
        triggeredBy: "system:auto-draft",
      },
      "2026-07",
    );

    expect(result).toEqual({ ranOrgs: 1, created: 2, skipped: 1, missingPeriods: 0 });
  });

  it("(c) flag ON + org with no admin actor → org is skipped, runAutoDraftInvoices NOT called", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    const orgId = "org-no-admin";
    mockFindMany.mockResolvedValue([{ organizationId: orgId, billPeriodOffset: 1 }]);
    mockResolveSystemActor.mockResolvedValue(null); // no admin found

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(mockResolveSystemActor).toHaveBeenCalledWith(orgId);
    expect(mockRunAutoDraftInvoices).not.toHaveBeenCalled();
    expect(result).toEqual({ ranOrgs: 0, created: 0, skipped: 0, missingPeriods: 0 });
  });

  it("derives runDayOfMonth from the injected now (UTC date)", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockFindMany.mockResolvedValue([]);

    const now1st = new Date(Date.UTC(2026, 5, 1)); // 1 Jun 2026
    await runAutoDraftInvoicesCron(now1st);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ runDayOfMonth: 1 }) }),
    );
  });

  it("accumulates counts across multiple orgs", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockFindMany.mockResolvedValue([
      { organizationId: "org-1", billPeriodOffset: 1 },
      { organizationId: "org-2", billPeriodOffset: 1 },
    ]);
    mockResolveSystemActor
      .mockResolvedValueOnce({ actorUserId: "u1", actorRole: "admin" })
      .mockResolvedValueOnce({ actorUserId: "u2", actorRole: "admin" });
    mockRunAutoDraftInvoices
      .mockResolvedValueOnce({ runId: "r1", status: "completed", draftsCreated: 3, draftsSkipped: 0 })
      .mockResolvedValueOnce({ runId: "r2", status: "completed", draftsCreated: 1, draftsSkipped: 2 });

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(result).toEqual({ ranOrgs: 2, created: 4, skipped: 2, missingPeriods: 0 });
    expect(mockRunAutoDraftInvoices).toHaveBeenCalledTimes(2);
  });

  // ── Advance billing (billPeriodOffset) ──────────────────────────────────────
  // The whole point of the feature. KAEN runs on the 25th and bills the COMING
  // month; before this the cron hardcoded the CURRENT month, so the 25th drafted
  // the month that was already ending.
  describe("advance billing — which month the run day bills", () => {
    async function periodBilledWith(offset: number, now: Date): Promise<string> {
      mockIsPhase2FlagEnabled.mockReturnValue(true);
      mockFindMany.mockResolvedValue([{ organizationId: "org-1", billPeriodOffset: offset }]);
      mockResolveSystemActor.mockResolvedValue({ actorUserId: "u1", actorRole: "admin" });
      mockRunAutoDraftInvoices.mockResolvedValue({ runId: "r", status: "completed", draftsCreated: 0, draftsSkipped: 0 });
      await runAutoDraftInvoicesCron(now);
      return mockRunAutoDraftInvoices.mock.calls[0][1] as string;
    }

    it("offset 1 on 25 Jul drafts AUGUST — KAEN's process", async () => {
      expect(await periodBilledWith(1, new Date("2026-07-25T02:00:00Z"))).toBe("2026-08");
    });

    it("offset 0 preserves the legacy behaviour (drafts the run month)", async () => {
      expect(await periodBilledWith(0, new Date("2026-07-25T02:00:00Z"))).toBe("2026-07");
    });

    it("offset 2 drafts two months ahead", async () => {
      expect(await periodBilledWith(2, new Date("2026-07-25T02:00:00Z"))).toBe("2026-09");
    });

    it("a December run with offset 1 rolls into the next YEAR", async () => {
      expect(await periodBilledWith(1, new Date("2026-12-25T02:00:00Z"))).toBe("2027-01");
    });

    it("the offset is PER-ORG — two orgs on the same run day bill different months", async () => {
      // Regression guard: periodMonth used to be hoisted above the loop, which would
      // silently give every org whichever month the first one resolved.
      mockIsPhase2FlagEnabled.mockReturnValue(true);
      mockFindMany.mockResolvedValue([
        { organizationId: "org-next", billPeriodOffset: 1 },
        { organizationId: "org-same", billPeriodOffset: 0 },
      ]);
      mockResolveSystemActor.mockResolvedValue({ actorUserId: "u1", actorRole: "admin" });
      mockRunAutoDraftInvoices.mockResolvedValue({ runId: "r", status: "completed", draftsCreated: 0, draftsSkipped: 0 });

      await runAutoDraftInvoicesCron(new Date("2026-07-25T02:00:00Z"));

      expect(mockRunAutoDraftInvoices.mock.calls[0][1]).toBe("2026-08");
      expect(mockRunAutoDraftInvoices.mock.calls[1][1]).toBe("2026-07");
    });
  });

  // Pins the UTC-day semantics. runAutoDraftInvoicesCron uses now.getUTCDate(),
  // so a cron scheduled at 17:00Z on the 24th (= 01:00 on the 25th in Malaysia,
  // UTC+8) queries day 24, NOT 25. Do not "fix" the cron to fire earlier.
  it("utc day trap: 17:00Z on the 24th is the 25th in Malaysia but queries day 24", async () => {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockFindMany.mockResolvedValue([]);
    await runAutoDraftInvoicesCron(new Date("2026-07-24T17:00:00Z"));
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ runDayOfMonth: 24 }) }),
    );
  });
});

// ── Un-drafted month reporting ───────────────────────────────────────────────
// The cron bills exactly ONE month per fire and gates on runDayOfMonth. A missed
// run — or a billPeriodOffset change, which skips a month by construction —
// leaves a hole nothing else would ever mention. A tenant's August rent simply
// did not exist while every August utility did, and no surface said so.
describe("runAutoDraftInvoicesCron — un-drafted month reporting", () => {
  function oneHealthyOrg(orgId = "org-1") {
    mockIsPhase2FlagEnabled.mockReturnValue(true);
    mockFindMany.mockResolvedValue([{ organizationId: orgId, billPeriodOffset: 1 }]);
    mockResolveSystemActor.mockResolvedValue({ actorUserId: "u1", actorRole: "admin" });
    mockRunAutoDraftInvoices.mockResolvedValue({ runId: "r", status: "completed", draftsCreated: 1, draftsSkipped: 0 });
  }

  it("counts and warns about a month that was never drafted", async () => {
    oneHealthyOrg();
    mockFindBillingGaps.mockResolvedValue({
      ok: true,
      status: 200,
      data: { targetPeriod: "2026-07", missingPeriods: ["2026-05", "2026-06"], lookbackMonths: 6, billPeriodOffset: 1 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(result.missingPeriods).toBe(2);
    // The operator must be able to act on the log line alone, so it names the
    // months AND the call that recovers them.
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toContain("2026-05");
    expect(line).toContain("2026-06");
    expect(line).toContain("POST /api/billing/draft-runs");
    warn.mockRestore();
  });

  it("leaves a durable audit row, not just a log line", async () => {
    oneHealthyOrg("org-gap");
    mockFindBillingGaps.mockResolvedValue({
      ok: true,
      status: 200,
      data: { targetPeriod: "2026-07", missingPeriods: ["2026-06"], lookbackMonths: 6, billPeriodOffset: 1 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      organizationId: "org-gap",
      action: "billing.draftrun.gap_detected",
      meta: { missingPeriods: ["2026-06"], targetPeriod: "2026-07" },
    });
    warn.mockRestore();
  });

  it("writes no audit row and no warning when there is no gap", async () => {
    oneHealthyOrg();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(result.missingPeriods).toBe(0);
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A gap REPORT must never fail a run that just drafted real invoices.
  it("a failing gap check does not fail the run or lose the drafts", async () => {
    oneHealthyOrg();
    mockFindBillingGaps.mockRejectedValue(new Error("db is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(result).toEqual({ ranOrgs: 1, created: 1, skipped: 0, missingPeriods: 0 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // The gap check must not run before the drafting it reports on, or the month
  // this very run is drafting reads as missing.
  it("checks for gaps only AFTER the run has drafted", async () => {
    oneHealthyOrg();
    const order: string[] = [];
    mockRunAutoDraftInvoices.mockImplementation(async () => {
      order.push("draft");
      return { runId: "r", status: "completed", draftsCreated: 1, draftsSkipped: 0 };
    });
    mockFindBillingGaps.mockImplementation(async () => {
      order.push("gap-check");
      return { ok: true, status: 200, data: { targetPeriod: "2026-07", missingPeriods: [], lookbackMonths: 6, billPeriodOffset: 1 } };
    });

    await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(order).toEqual(["draft", "gap-check"]);
  });

  it("passes the run's own clock to the gap check, not a fresh now()", async () => {
    oneHealthyOrg();

    await runAutoDraftInvoicesCron(NOW_25_JUN);

    expect(mockFindBillingGaps).toHaveBeenCalledWith(
      { orgId: "org-1", actorUserId: "u1", actorRole: "admin" },
      { now: NOW_25_JUN },
    );
  });
});
