// deposit-held-on-payment.hook.test.ts
//
// A tenant's deposit payment is payable onward to the owner. These tests pin
// partial/full triggers, leg mapping, delta idempotency, and the two
// "never break the money path" contracts: swallow every
// error, and leave a durable marker when it does.
import { describe, it, expect, vi, beforeEach } from "vitest";

const chargeFindMany = vi.hoisted(() => vi.fn());
const depositAggregate = vi.hoisted(() => vi.fn());
const depositCreate = vi.hoisted(() => vi.fn());
const reversalFindMany = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    charge: { findMany: chargeFindMany },
    deposit: { aggregate: depositAggregate, create: depositCreate },
    paymentAllocationReversal: { findMany: reversalFindMany },
    $transaction: transaction,
  }),
}));

const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/audit", () => ({ recordAudit }));

const isPhase2FlagEnabled = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled }));

import { recordDepositsHeldForPaidCharges } from "../deposit-held-on-payment.hook";

/** A paid deposit charge as the hook's own query would return it. */
function depositCharge(over: Record<string, unknown> = {}) {
  return {
    id: "ch-dep-1",
    tenancyId: "ten-1",
    unitId: "unit-1",
    partyId: "party-1",
    chargeType: "security_deposit",
    allocations: [{ id: "alloc-1", allocatedAmount: "4400.00" }],
    ...over,
  };
}

describe("recordDepositsHeldForPaidCharges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPhase2FlagEnabled.mockReturnValue(true);
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    recordAudit.mockResolvedValue(undefined);
    depositAggregate.mockResolvedValue({ _sum: { amount: null } });
    reversalFindMany.mockResolvedValue([]);
    depositCreate.mockResolvedValue({ id: "dep-1" });
  });

  // ── Trigger conditions ────────────────────────────────────────────────────

  it("releases a collected rental deposit to the owner", async () => {
    chargeFindMany.mockResolvedValue([depositCharge()]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(depositCreate).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        tenancyId: "ten-1",
        partyId: "party-1",
        unitId: "unit-1",
        type: "rental",
        amount: 4400,
        status: "released_to_owner",
      },
    });
  });

  it("maps a paid DEPUTIL charge to the utilities leg", async () => {
    chargeFindMany.mockResolvedValue([
      depositCharge({ id: "ch-dep-2", chargeType: "utility_deposit", allocations: [{ id: "alloc-2", allocatedAmount: "2200.00" }] }),
    ]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-2"]);

    expect(depositCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "utilities", amount: 2200, status: "released_to_owner" }),
      }),
    );
  });

  it("queries every live deposit charge with posted allocations", async () => {
    chargeFindMany.mockResolvedValue([]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-x"]);

    expect(chargeFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        id: { in: ["ch-x"] },
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: { notIn: ["void", "credited"] },
      },
      select: {
        id: true,
        tenancyId: true,
        unitId: true,
        partyId: true,
        chargeType: true,
        allocations: {
          where: { payment: { status: "posted" } },
          select: { id: true, allocatedAmount: true },
        },
      },
    });
    expect(depositCreate).not.toHaveBeenCalled();
  });

  it("records nothing when the settled charge is rent, not a deposit", async () => {
    // The query filters it out, so the hook sees an empty set.
    chargeFindMany.mockResolvedValue([]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-rent"]);

    expect(depositCreate).not.toHaveBeenCalled();
  });

  it("skips a deposit charge with no tenancy or unit", async () => {
    chargeFindMany.mockResolvedValue([
      depositCharge({ tenancyId: null }),
      depositCharge({ id: "ch-dep-3", unitId: null }),
    ]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1", "ch-dep-3"]);

    expect(depositCreate).not.toHaveBeenCalled();
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it("does not double the released figure when settlement runs again", async () => {
    chargeFindMany.mockResolvedValue([depositCharge()]);
    depositAggregate.mockResolvedValue({ _sum: { amount: "4400.00" } });

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(depositAggregate).toHaveBeenCalledWith({
      where: { organizationId: "org-1", tenancyId: "ten-1", type: "rental", status: "released_to_owner" },
      _sum: { amount: true },
    });
    expect(depositCreate).not.toHaveBeenCalled();
  });

  it("releases only the new delta after a second partial instalment", async () => {
    chargeFindMany.mockResolvedValue([depositCharge({ allocations: [
      { id: "alloc-1", allocatedAmount: "1000.00" },
      { id: "alloc-2", allocatedAmount: "500.00" },
    ] })]);
    depositAggregate.mockResolvedValue({ _sum: { amount: "1000.00" } });

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(depositCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 500 }) });
  });

  it("writes a negative correction when a posted allocation is reversed", async () => {
    chargeFindMany.mockResolvedValue([depositCharge({ allocations: [
      { id: "alloc-1", allocatedAmount: "1000.00" },
    ] })]);
    reversalFindMany.mockResolvedValue([{ amount: "250.00" }]);
    depositAggregate.mockResolvedValue({ _sum: { amount: "1000.00" } });

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(depositCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: -250 }) });
  });

  // ── Never break the money path ────────────────────────────────────────────

  it("swallows a DB failure and leaves a durable audit marker", async () => {
    chargeFindMany.mockRejectedValue(new Error("db down"));

    await expect(
      recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]),
    ).resolves.toBeUndefined();

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        action: "owner-billing.deposit_payable_to_owner.failed",
        entityType: "Deposit",
      }),
    );
  });

  it("never re-throws when the audit write itself fails", async () => {
    chargeFindMany.mockRejectedValue(new Error("db down"));
    transaction.mockRejectedValue(new Error("audit down"));

    await expect(
      recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]),
    ).resolves.toBeUndefined();
  });

  // ── Gate + short-circuits ─────────────────────────────────────────────────

  it("does nothing when the owner-billing flag is dark", async () => {
    isPhase2FlagEnabled.mockReturnValue(false);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(chargeFindMany).not.toHaveBeenCalled();
    expect(depositCreate).not.toHaveBeenCalled();
  });

  it("does nothing when no charge ids were settled", async () => {
    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", []);
    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", null);

    expect(chargeFindMany).not.toHaveBeenCalled();
  });
});
