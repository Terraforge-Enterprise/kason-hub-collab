import { describe, expect, it } from "vitest";
import { adjustedBilledAmount, resolveChargedAmount } from "../charged-amount";

/**
 * The owner ledger shows two money figures side by side: what the counterparty was
 * BILLED and what has been COLLECTED. `amount` (collected) has always been netted of
 * active credit/debit notes at sync time (collectedString + netAdjustmentsByChargeId).
 * The billed figure beside it was read straight off `Charge.amount`, unnetted — so the
 * two were computed on different bases and could not be reconciled by a reader.
 */
describe("adjustedBilledAmount", () => {
  it("returns the raw amount when the charge carries no active notes", () => {
    expect(adjustedBilledAmount("50.00", undefined)).toBe("50.00");
    expect(adjustedBilledAmount("50.00", { debitCents: 0, creditCents: 0 })).toBe("50.00");
  });

  it("a CREDIT note lowers the billed figure — so it stops reading as an underpayment", () => {
    // The reported shape: a RM 50 charge with a RM 30 credit note, fully settled. The
    // ledger's collected figure is already 20. Reading billed as a bare 50 made the row
    // say "billed 50 / collected 20" — identical on screen to a tenant who underpaid.
    expect(adjustedBilledAmount("50.00", { debitCents: 0, creditCents: 3000 })).toBe("20.00");
  });

  it("a DEBIT note raises the billed figure", () => {
    // Real UAT row: GRIDRECUR charge 50.00 with DN-0003 +20.00 → the tenant owes 70.
    expect(adjustedBilledAmount("50.00", { debitCents: 2000, creditCents: 0 })).toBe("70.00");
  });

  it("nets both directions on one charge", () => {
    expect(adjustedBilledAmount("100.30", { debitCents: 5000, creditCents: 2000 })).toBe("130.30");
  });

  it("clamps at zero — a credit note larger than the charge never goes negative", () => {
    // Same reasoning as collectedString's clamp: clawbacks are the reversal machinery's
    // job, never this display figure.
    expect(adjustedBilledAmount("50.00", { debitCents: 0, creditCents: 8000 })).toBe("0.00");
  });

  it("is cent-exact — no float drift", () => {
    expect(adjustedBilledAmount("0.10", { debitCents: 20, creditCents: 0 })).toBe("0.30");
    expect(adjustedBilledAmount("1612.90", { debitCents: 1, creditCents: 0 })).toBe("1612.91");
  });
});

// The BILLED price for a ledger row's display. Income rows store `amount` =
// COLLECTED-so-far (0 until the tenant pays) for the payout math; the billed
// figure lives on the source Charge. Expense rows already store their full
// billed amount in `amount`, so they resolve to null and the client falls back.
describe("resolveChargedAmount", () => {
  it("S1: income row → billed amount from the source charge", () => {
    const billed = new Map([["chg-1", "800.00"]]);
    expect(
      resolveChargedAmount({ direction: "income", sourceChargeId: "chg-1" }, billed),
    ).toBe("800.00");
  });

  it("S2: expense row → null (client falls back to collected `amount`, already billed)", () => {
    const billed = new Map([["chg-2", "150.00"]]);
    expect(
      resolveChargedAmount({ direction: "expense", sourceChargeId: "chg-2" }, billed),
    ).toBeNull();
  });

  it("S3: income row whose charge is unresolved (deleted/out-of-scope) → null fallback", () => {
    expect(
      resolveChargedAmount({ direction: "income", sourceChargeId: "gone" }, new Map()),
    ).toBeNull();
  });

  it("S4: income row with no linked charge → null fallback", () => {
    expect(
      resolveChargedAmount({ direction: "income", sourceChargeId: null }, new Map()),
    ).toBeNull();
  });

  it("S5: the map it reads is the ADJUSTED one — the caller nets before building it", () => {
    // owner-ledger.service.ts builds billedByChargeId through adjustedBilledAmount, so
    // this resolver never sees a raw Charge.amount. Pinned here because the seam is
    // invisible from inside the function: it would happily surface an unnetted figure.
    const billed = new Map([["chg-1", adjustedBilledAmount("50.00", { debitCents: 0, creditCents: 3000 })]]);
    expect(resolveChargedAmount({ direction: "income", sourceChargeId: "chg-1" }, billed)).toBe("20.00");
  });
});
