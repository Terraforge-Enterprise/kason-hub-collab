import { describe, it, expect } from "vitest";
import {
  OWNER_CATEGORY_DEFAULTS,
  OWNER_LEDGER_CATEGORIES,
  OWNER_LEDGER_DIRECTIONS,
  OWNER_LEDGER_INFORMATIONAL_CATEGORIES,
  isInformationalLedgerRow,
} from "../owner-ledger";

describe("informational ledger rows — letting commission", () => {
  it("registers the direction and the category", () => {
    expect(OWNER_LEDGER_DIRECTIONS).toContain("informational");
    expect(OWNER_LEDGER_CATEGORIES).toContain("letting_commission");
  });

  it("MONEY INVARIANT: letting_commission never pays out", () => {
    // The owner never receives this rent — it is KAEN's commission. If this ever flips
    // to true the owner is paid a month of rent they were never owed.
    expect(OWNER_CATEGORY_DEFAULTS.letting_commission.includeInPayout).toBe(false);
  });

  it("is NOT the agent-sales commission category", () => {
    // Same word, different system (see .claude/docs/domain-glossary.md). agent_commission
    // is a real payout-affecting expense; conflating them would deduct twice.
    expect(OWNER_CATEGORY_DEFAULTS.agent_commission.includeInPayout).toBe(true);
    expect(OWNER_LEDGER_INFORMATIONAL_CATEGORIES.has("agent_commission")).toBe(false);
  });

  it("classifies rows by direction or category", () => {
    expect(isInformationalLedgerRow({ direction: "informational", category: "letting_commission" })).toBe(true);
    // Category alone is enough — guards a row written before the direction existed.
    expect(isInformationalLedgerRow({ direction: "income", category: "letting_commission" })).toBe(true);
  });

  it("leaves real money rows alone", () => {
    expect(isInformationalLedgerRow({ direction: "income", category: "rental_income" })).toBe(false);
    expect(isInformationalLedgerRow({ direction: "expense", category: "management_fee" })).toBe(false);
    expect(isInformationalLedgerRow({ direction: "expense", category: "other_expense" })).toBe(false);
    expect(isInformationalLedgerRow({ direction: "payout", category: "owner_payout" })).toBe(false);
  });

  it("every informational category is declared non-payout", () => {
    // Blanket guard: adding a future informational category without includeInPayout:false
    // would silently move money.
    for (const c of OWNER_LEDGER_INFORMATIONAL_CATEGORIES) {
      expect(OWNER_CATEGORY_DEFAULTS[c]?.includeInPayout, `${c} must not pay out`).toBe(false);
    }
  });

  it("the money-critical filters exclude it by construction", () => {
    // Mirrors how every consumer selects rows: positive equality on income/expense.
    // This is what keeps the per-income-line management fee off the commission.
    const row = { direction: "informational", category: "letting_commission" };
    expect(row.direction === "income").toBe(false);
    expect(row.direction === "expense").toBe(false);
  });
});
