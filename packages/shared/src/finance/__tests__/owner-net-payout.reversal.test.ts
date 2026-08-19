// packages/shared/src/finance/__tests__/owner-net-payout.reversal.test.ts
//
// Task 3 — reversal-aware owner-payable balance. A `payout` line carrying
// `reversalOfEntryId` restores payable (adds) instead of subtracting in
// computeOwnerRunningBalance, and is NETTED into summarizeOwnerPeriod's
// payoutsTotal (a reversal subtracts back out — payoutsTotal is gross payouts
// MINUS reversals, not gross payouts alone). This keeps the close-out identity
// (broughtForward + netThisPeriod − periodPayouts == carriedForward, see
// resolveOwnerBalance in owner-ledger.repository.ts) exact. See
// packages/shared/src/finance/owner-net-payout.ts.
import { describe, it, expect } from "vitest";
import { computeOwnerRunningBalance, summarizeOwnerPeriod, type OwnerLedgerLine } from "../owner-net-payout";
import { toCents, centsToString } from "../../utils/money-cents";

const L = (o: Partial<OwnerLedgerLine>): OwnerLedgerLine => ({
  direction: "payout",
  category: "x",
  amount: "0",
  includeInPayout: false,
  taxCategory: "n",
  ...o,
});

describe("computeOwnerRunningBalance — reversal-aware", () => {
  it("a reversal payout restores payable — original + reversal net to zero", () => {
    const lines = [
      L({ direction: "income", amount: "1000.00", includeInPayout: false }),
      L({ direction: "payout", amount: "400.00" }), // remittance −400
      L({ direction: "payout", amount: "400.00", reversalOfEntryId: "e1" }), // reversal +400
    ];
    expect(computeOwnerRunningBalance(lines)).toBe("1000.00"); // net: 1000 − 400 + 400
  });

  it("a normal payout still subtracts", () => {
    expect(
      computeOwnerRunningBalance([
        L({ direction: "income", amount: "1000.00" }),
        L({ direction: "payout", amount: "400.00" }),
      ]),
    ).toBe("600.00");
  });

  it("an unpaired reversal payout still restores (adds) even with no matching original payout present", () => {
    // Proves the branch reads each line's OWN reversalOfEntryId flag rather than
    // pairing/looking up a sibling "original" line — there is no plain payout
    // in this set at all, yet the reversal still adds.
    const lines = [
      L({ direction: "income", amount: "1000.00", includeInPayout: false }),
      L({ direction: "payout", amount: "400.00", reversalOfEntryId: "e1" }),
    ];
    expect(computeOwnerRunningBalance(lines)).toBe("1400.00");
  });
});

describe("summarizeOwnerPeriod — reversal-aware", () => {
  it("nets a reversal into payoutsTotal exactly once — asymmetric activity discriminates net from exclude/double-count/sign-invert", () => {
    const payout400 = L({ direction: "payout", category: "owner_payout", amount: "400.00" }); // original remittance #1
    const payout150 = L({ direction: "payout", category: "owner_payout", amount: "150.00" }); // unrelated remittance #2
    const reversalOf400 = L({ direction: "payout", category: "owner_payout", amount: "400.00", reversalOfEntryId: "e1" }); // reverses remittance #1
    const lines: OwnerLedgerLine[] = [
      L({ direction: "income", category: "rental_income", amount: "1000.00", includeInPayout: false }),
      payout400,
      payout150,
      reversalOf400,
    ];
    // Snapshot an input line BEFORE calling either function — asserts neither
    // summarizeOwnerPeriod nor computeOwnerRunningBalance mutates its input.
    const payout400Snapshot = { ...payout400 };
    const linesSnapshotLength = lines.length;

    const s = summarizeOwnerPeriod(lines);
    const runningBalance = computeOwnerRunningBalance(lines);

    // payoutsTotal is NET of reversals: 400 + 150 − 400 = 150. The asymmetric
    // amounts mean this can only land on 150 if the reversed 400 is counted
    // EXACTLY ONCE (subtracted once): the old exclude-bug drops the reversal
    // entirely and yields 550 (400+150, reversal ignored); an unconditional-add
    // guard double-counts and yields 950 (400+150+400, reversal treated as a
    // 3rd payout); a sign-inverted guard yields -150. Only the correct net form
    // yields 150 — see the sabotage proof in the Task 3 fix report.
    expect(s.payoutsTotal).toBe("150.00");

    // Pure-function analogue of the close-out identity documented on
    // resolveOwnerBalance (owner-ledger.repository.ts): with no brought-forward
    // balance and no expenses, broughtForward(0) + netThisPeriod − periodPayouts
    // == carriedForward collapses to:
    //   computeOwnerRunningBalance(lines) == grossRental − totalExpenses − payoutsTotal
    const grossC = toCents(s.grossRental, "test");
    const expensesC = toCents(s.totalExpenses, "test");
    const payoutsC = toCents(s.payoutsTotal, "test");
    expect(runningBalance).toBe(centsToString(grossC - expensesC - payoutsC));
    expect(runningBalance).toBe("850.00"); // 1000 − 400 − 150 + 400

    // Input immutability — neither function may mutate the lines array or the
    // line objects inside it.
    expect(lines.length).toBe(linesSnapshotLength);
    expect(payout400).toEqual(payout400Snapshot);
  });
});
