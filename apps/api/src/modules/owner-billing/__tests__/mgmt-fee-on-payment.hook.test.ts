// mgmt-fee-on-payment.hook.test.ts
//
// The fee is now issued by the tenant's rent payment, not by an admin clicking
// Issue. These tests pin the trigger conditions (rent + FULLY paid), the owner
// resolution, the append flag, and the two "never break the money path" contracts:
// swallow every error, and leave a durable marker when a fee is skipped.
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateStatementService = vi.hoisted(() => vi.fn());
vi.mock("../owner-billing.service", () => ({ generateStatementService }));

const findMany = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})));
vi.mock("@kason/db", () => ({
  getDb: () => ({ charge: { findMany }, $transaction: transaction }),
}));

const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/audit", () => ({ recordAudit }));

const isPhase2FlagEnabled = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled }));

import { issueMgmtFeeForPaidRent } from "../mgmt-fee-on-payment.hook";

const JUNE = new Date("2026-06-01T00:00:00.000Z");

/** A statement the service returns on success. */
function stmt(status: string) {
  return { ok: true, status: 200, data: { id: "stmt-1", status } };
}

describe("issueMgmtFeeForPaidRent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPhase2FlagEnabled.mockReturnValue(true);
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    recordAudit.mockResolvedValue(undefined);
    generateStatementService.mockResolvedValue(stmt("draft"));
  });

  it("issues the fee for the charge's owner + billing month, in APPEND mode", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
    ]);

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    expect(generateStatementService).toHaveBeenCalledTimes(1);
    expect(generateStatementService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      { ownerPartyId: "owner-1", billingMonth: "2026-06" },
      { appendToExistingDraft: true },
    );
  });

  it("queries ONLY fully-paid rent charges — a partial payment must not issue a fee", async () => {
    findMany.mockResolvedValue([]);

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    // The trigger condition lives in the query, so assert the query itself.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chargeType: "rent", status: "paid" }),
      }),
    );
    // Nothing matched ⇒ no statement, and no audit noise.
    expect(generateStatementService).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("resolves a carpark charge's owner via carpark.ownerPartyId, not the unit", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: null, carpark: { ownerPartyId: "bay-owner" } },
    ]);

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    expect(generateStatementService).toHaveBeenCalledWith(
      expect.anything(),
      { ownerPartyId: "bay-owner", billingMonth: "2026-06" },
      expect.anything(),
    );
  });

  it("collapses several charges for one owner+month into ONE generate call", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
      { id: "ch-2", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
      { id: "ch-3", billingMonth: JUNE, unit: { ownerPartyId: "owner-2" }, carpark: null },
    ]);

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1", "ch-2", "ch-3"]);

    // Two owners, one month each — not three calls.
    expect(generateStatementService).toHaveBeenCalledTimes(2);
  });

  it("skips a charge with no resolvable owner rather than throwing", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: null, carpark: null },
    ]);

    await expect(
      issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]),
    ).resolves.toBeUndefined();
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("records a DURABLE marker when the statement is already issued (fee not appended)", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
    ]);
    // Append mode returns an approved statement untouched — the new unit's fee is NOT on it.
    generateStatementService.mockResolvedValue(stmt("approved"));

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "owner-billing.mgmt_fee_on_payment.skipped",
        entityId: "owner-1",
      }),
    );
  });

  it("does NOT record a skip marker when the statement is a draft (the happy path)", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
    ]);

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records a marker when the service returns a failure result", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
    ]);
    generateStatementService.mockResolvedValue({ ok: false, status: 404, error: "OWNER_NOT_FOUND" });

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "owner-billing.mgmt_fee_on_payment.failed" }),
    );
  });

  it("SWALLOWS a thrown error — a fee failure must never roll back the payment", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
    ]);
    generateStatementService.mockRejectedValue(new Error("boom"));

    await expect(
      issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]),
    ).resolves.toBeUndefined();

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "owner-billing.mgmt_fee_on_payment.failed",
        entityId: "owner-1",
      }),
    );
  });

  it("still resolves when even the audit write fails (never re-throws)", async () => {
    findMany.mockResolvedValue([
      { id: "ch-1", billingMonth: JUNE, unit: { ownerPartyId: "owner-1" }, carpark: null },
    ]);
    generateStatementService.mockRejectedValue(new Error("boom"));
    transaction.mockRejectedValue(new Error("audit db down"));

    await expect(
      issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when ENABLE_PHASE2_OWNER_BILLING is dark", async () => {
    isPhase2FlagEnabled.mockReturnValue(false);

    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", ["ch-1"]);

    expect(findMany).not.toHaveBeenCalled();
    expect(generateStatementService).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty or missing charge list", async () => {
    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", []);
    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", null);
    await issueMgmtFeeForPaidRent("org-1", "user-1", "admin", undefined);
    expect(findMany).not.toHaveBeenCalled();
  });
});
