// deposit-held-on-payment.hook.test.ts
//
// A tenant's deposit payment is what records that KAEN now HOLDS that money.
// These tests pin the trigger conditions (deposit charge types + FULLY paid),
// the leg mapping, the idempotency that stops a re-settlement doubling the held
// figure, and the two "never break the money path" contracts: swallow every
// error, and leave a durable marker when it does.
import { describe, it, expect, vi, beforeEach } from "vitest";

const chargeFindMany = vi.hoisted(() => vi.fn());
const depositFindFirst = vi.hoisted(() => vi.fn());
const depositCreate = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})));
vi.mock("@kason/db", () => ({
  getDb: () => ({
    charge: { findMany: chargeFindMany },
    deposit: { findFirst: depositFindFirst, create: depositCreate },
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
    amount: "4400.00",
    chargeType: "security_deposit",
    ...over,
  };
}

describe("recordDepositsHeldForPaidCharges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPhase2FlagEnabled.mockReturnValue(true);
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));
    recordAudit.mockResolvedValue(undefined);
    depositFindFirst.mockResolvedValue(null);
    depositCreate.mockResolvedValue({ id: "dep-1" });
  });

  // ── Trigger conditions ────────────────────────────────────────────────────

  it("records a held rental deposit for a paid DEPRENT charge", async () => {
    chargeFindMany.mockResolvedValue([depositCharge()]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(depositCreate).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        tenancyId: "ten-1",
        partyId: "party-1",
        unitId: "unit-1",
        type: "rental",
        amount: "4400.00",
        status: "held",
      },
    });
  });

  it("maps a paid DEPUTIL charge to the utilities leg", async () => {
    chargeFindMany.mockResolvedValue([
      depositCharge({ id: "ch-dep-2", chargeType: "utility_deposit", amount: "2200.00" }),
    ]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-2"]);

    expect(depositCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "utilities", amount: "2200.00", status: "held" }),
      }),
    );
  });

  it("queries only deposit charge types, and only fully-paid ones", async () => {
    // Partial payments deliberately do nothing: the held figure would be
    // ambiguous and the owner-facing line would flicker as instalments arrive.
    chargeFindMany.mockResolvedValue([]);

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-x"]);

    expect(chargeFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        id: { in: ["ch-x"] },
        chargeType: { in: ["security_deposit", "utility_deposit"] },
        status: "paid",
      },
      select: {
        id: true,
        tenancyId: true,
        unitId: true,
        partyId: true,
        amount: true,
        chargeType: true,
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

  it("does not double the held figure when settlement runs again", async () => {
    // Re-settlement, reallocation and replayed webhooks all re-enter this hook
    // with the same chargeId. A second row would overstate what KAEN holds.
    chargeFindMany.mockResolvedValue([depositCharge()]);
    depositFindFirst.mockResolvedValue({ id: "dep-existing" });

    await recordDepositsHeldForPaidCharges("org-1", "user-1", "admin", ["ch-dep-1"]);

    expect(depositFindFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-1", tenancyId: "ten-1", type: "rental" },
      select: { id: true },
    });
    expect(depositCreate).not.toHaveBeenCalled();
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
        action: "owner-billing.deposit_held_on_payment.failed",
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
