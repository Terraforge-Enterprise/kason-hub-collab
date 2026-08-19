import { describe, expect, it } from "vitest";
import { resolveRoutedSeries } from "../issue-grouped";

/**
 * Grid-expense series routing.
 *
 * An owner-borne expense used to have a THIRD fate here: behind
 * ENABLE_OWNER_BORNE_DEDUCT it was pulled off IVOWN entirely and routed onto its own
 * OEA- advice, with the money booked as an owner-ledger Source-6 payout deduction
 * instead. That flag was removed (2026-08-16): KAEN wants the expense to SHOW as an
 * IVOWN line the owner can see, and to be netted out of the payout when the rent is
 * collected — which auto-offset-on-rent.hook.ts already does.
 *
 * So the owner arm now has exactly ONE outcome, unconditionally. These cases pin it,
 * because a regression here does not throw — it silently stops billing the owner.
 *
 * Imports the real resolver rather than mirroring the condition.
 */
describe("grid-expense series routing", () => {
  it("owner + expense -> no override: it stays an IVOWN line", () => {
    expect(resolveRoutedSeries({ counterpartyType: "owner", isExpenseCharge: true, expenseBillOn: true })).toBe("");
    // …and identically with the tenant Expense Bill switched off — the owner arm does
    // not consult any flag at all.
    expect(resolveRoutedSeries({ counterpartyType: "owner", isExpenseCharge: true, expenseBillOn: false })).toBe("");
  });

  it("owner + profit -> no override (stays an IVOWN receivable)", () => {
    expect(resolveRoutedSeries({ counterpartyType: "owner", isExpenseCharge: false, expenseBillOn: true })).toBe("");
  });

  it("tenant + expense -> EB (unchanged)", () => {
    expect(resolveRoutedSeries({ counterpartyType: "tenant", isExpenseCharge: true, expenseBillOn: true })).toBe("EB");
  });

  it("tenant + profit -> no override (stays IVTEN)", () => {
    expect(resolveRoutedSeries({ counterpartyType: "tenant", isExpenseCharge: false, expenseBillOn: true })).toBe("");
  });

  it("tenant + expense with ENABLE_EXPENSE_BILL OFF -> no EB override (unchanged)", () => {
    expect(resolveRoutedSeries({ counterpartyType: "tenant", isExpenseCharge: true, expenseBillOn: false })).toBe("");
  });

  it("never routes an owner charge to EB, and never mints an OEA again", () => {
    for (const expenseBillOn of [true, false]) {
      for (const isExpenseCharge of [true, false]) {
        expect(resolveRoutedSeries({ counterpartyType: "owner", isExpenseCharge, expenseBillOn })).not.toBe("EB");
        for (const counterpartyType of ["owner", "tenant"] as const) {
          // "OEA" is no longer even in the return type — asserted at runtime too, so a
          // future edit that reintroduces the branch fails here and not in production.
          expect(resolveRoutedSeries({ counterpartyType, isExpenseCharge, expenseBillOn })).not.toBe("OEA");
        }
      }
    }
  });
});
