// owner-ledger.sync-hook.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const syncMonthService = vi.hoisted(() => vi.fn());
const postForwardReversalForFrozenMonth = vi.hoisted(() => vi.fn());
vi.mock("../owner-ledger.sync", () => ({ syncMonthService, postForwardReversalForFrozenMonth }));
const findFirst = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})));
vi.mock("@kason/db", () => ({
  getDb: () => ({ apartment: { findFirst }, charge: { findMany }, $transaction: transaction }),
}));
const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/audit", () => ({ recordAudit }));
const isPhase2FlagEnabled = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled }));
// Task 7: the hook now consults findPeriod (flag-gated) to route a FROZEN month to
// the forward-reversal path instead of a rebuild. These unit tests force every flag
// ON (isPhase2FlagEnabled → true), so the live-ledger branch's findPeriod would run;
// default it to null (= not frozen) so the normal syncMonthService path is exercised.
const findPeriod = vi.hoisted(() => vi.fn());
vi.mock("../../owner-billing/owner-statement-period.repository", () => ({ findPeriod }));

import { syncOwnerLedgerForApartmentMonth, syncOwnerLedgerForCharges } from "../owner-ledger.sync-hook";

describe("owner-ledger sync-hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncMonthService.mockResolvedValue({ ok: true });
    findPeriod.mockResolvedValue(null); // not frozen → normal syncMonthService path
    isPhase2FlagEnabled.mockReturnValue(true); // flag ON by default
    // Default: the dedicated audit tx runs its callback; recordAudit resolves.
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    recordAudit.mockResolvedValue(undefined);
  });

  it("resolves owner from the apartment's listing and calls syncMonthService with YYYY-MM", async () => {
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: "owner-1" }] });
    await syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z"));
    expect(syncMonthService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      { ownerPartyId: "owner-1", month: "2026-06" },
    );
  });

  it("skips when the apartment has no owner (no throw, no sync call)", async () => {
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: null }] });
    await syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z"));
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("NEVER throws even if syncMonthService rejects (money-path safety)", async () => {
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: "owner-1" }] });
    syncMonthService.mockRejectedValue(new Error("boom"));
    await expect(
      syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z")),
    ).resolves.toBeUndefined();
  });

  it("syncs each distinct (owner, month) pair once from a set of charges", async () => {
    findMany.mockResolvedValue([
      { unit: { ownerPartyId: "owner-1" }, billingMonth: new Date("2026-06-01T00:00:00.000Z") },
      { unit: { ownerPartyId: "owner-1" }, billingMonth: new Date("2026-06-01T00:00:00.000Z") },
      { unit: { ownerPartyId: "owner-2" }, billingMonth: new Date("2026-06-01T00:00:00.000Z") },
    ]);
    await syncOwnerLedgerForCharges("org-1", "user-1", "manager", ["c1", "c2", "c3"]);
    expect(syncMonthService).toHaveBeenCalledTimes(2);
  });

  it("routes a FROZEN month to postForwardReversalForFrozenMonth, NOT a rebuild (Task 7)", async () => {
    // Live-ledger flag ON (default true here) + the period is frozen → forward-reversal
    // path instead of syncMonthService; the frozen month's rows are never rebuilt.
    findPeriod.mockResolvedValue({ status: "frozen" });
    findMany.mockResolvedValue([
      { unit: { ownerPartyId: "owner-1" }, billingMonth: new Date("2026-06-01T00:00:00.000Z") },
    ]);
    await syncOwnerLedgerForCharges("org-1", "user-1", "manager", ["c1"]);
    expect(postForwardReversalForFrozenMonth).toHaveBeenCalledTimes(1);
    expect(postForwardReversalForFrozenMonth).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "owner-1",
      "2026-06",
    );
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("charge sync is a no-op on empty/null ids", async () => {
    await syncOwnerLedgerForCharges("org-1", "user-1", "admin", []);
    await syncOwnerLedgerForCharges("org-1", "user-1", "admin", null);
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  it("both functions are a no-op (no syncMonthService call) when ENABLE_PHASE2_OWNER_BILLING flag is OFF", async () => {
    isPhase2FlagEnabled.mockReturnValue(false);
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: "owner-1" }] });
    findMany.mockResolvedValue([
      { unit: { ownerPartyId: "owner-1" }, billingMonth: new Date("2026-06-01T00:00:00.000Z") },
    ]);
    await syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z"));
    await syncOwnerLedgerForCharges("org-1", "user-1", "admin", ["c1"]);
    expect(syncMonthService).not.toHaveBeenCalled();
  });

  // ── Durable "needs re-sync" marker on swallowed sync failures ──────────────
  it("apartment-month: a swallowed sync failure writes a durable owner_ledger.sync_failed audit (anchored to the owner)", async () => {
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: "owner-1" }] });
    syncMonthService.mockRejectedValue(new Error("boom"));

    await syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z"));

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(), // the dedicated-tx client
      expect.objectContaining({
        organizationId: "org-1",
        actorUserId: "user-1",
        actorRole: "admin",
        action: "owner_ledger.sync_failed",
        entityType: "OwnerLedgerEntry",
        entityId: "owner-1",
        meta: expect.objectContaining({ month: "2026-06", error: "boom" }),
      }),
    );
  });

  it("charges: a swallowed sync failure writes a durable owner_ledger.sync_failed audit (anchored to the owner)", async () => {
    findMany.mockResolvedValue([
      { unit: { ownerPartyId: "owner-9" }, billingMonth: new Date("2026-06-01T00:00:00.000Z") },
    ]);
    syncMonthService.mockRejectedValue(new Error("kaboom"));

    await syncOwnerLedgerForCharges("org-1", "user-1", "manager", ["c1"]);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "user-1",
        actorRole: "manager",
        action: "owner_ledger.sync_failed",
        entityType: "OwnerLedgerEntry",
        entityId: "owner-9",
        meta: expect.objectContaining({ month: "2026-06", error: "kaboom" }),
      }),
    );
  });

  it("a successful sync writes NO sync_failed audit", async () => {
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: "owner-1" }] });
    await syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z"));
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("an audit-write failure inside the catch is itself swallowed (never re-throws into the money path)", async () => {
    findFirst.mockResolvedValue({ listings: [{ ownerPartyId: "owner-1" }] });
    syncMonthService.mockRejectedValue(new Error("boom"));
    transaction.mockRejectedValue(new Error("audit db down")); // the dedicated audit tx fails
    await expect(
      syncOwnerLedgerForApartmentMonth("org-1", "user-1", "admin", "apt-1", new Date("2026-06-01T00:00:00.000Z")),
    ).resolves.toBeUndefined();
  });
});
