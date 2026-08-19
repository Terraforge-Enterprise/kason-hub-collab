// The expense dialog's PER-LINE edit lock, in isolation.
//
// This predicate decides whether an admin can type into an expense line whose money has
// already settled. It is small enough to state exhaustively, and it is consumed by three
// affordances in one render (the value controls, the Void button, the batch-save skip)
// that must all agree — so it gets its own table rather than only being observed through
// a render. Mirrors row-lock.test.ts, its sibling for the row grain.
import { describe, expect, it } from "vitest";
import type { SettlementState } from "@kason/shared";
import {
  expenseLockLabel,
  expenseLockState,
  isExpenseLineLocked,
  type ExpenseLockInput,
} from "../expense-lock";

function line(over: Partial<ExpenseLockInput> = {}): ExpenseLockInput {
  return { id: "exp-1", seeded: true, settlement: "none", ...over };
}

describe("expenseLockState", () => {
  describe("persisted lines, by settlement state", () => {
    const cases: [SettlementState, "editable" | "part-paid" | "paid"][] = [
      ["none", "editable"],   // never billed — no charge exists to freeze
      ["unpaid", "editable"], // billed, no money in — amend + re-Bill stays open
      ["partial", "part-paid"],
      ["paid", "paid"],
    ];
    for (const [settlement, expected] of cases) {
      it(`settlement "${settlement}" ⇒ ${expected}`, () => {
        expect(expenseLockState(line({ settlement }))).toBe(expected);
      });
    }
  });

  it("an unsaved line is always editable, whatever settlement claims", () => {
    // id === null ⇒ no charge was ever minted from it ⇒ nothing to freeze. A settlement
    // value arriving on an unsaved row must not strand it read-only.
    for (const settlement of ["none", "unpaid", "partial", "paid"] as const) {
      expect(expenseLockState({ id: null, settlement })).toBe("editable");
    }
    expect(expenseLockState({ id: null, settlement: undefined })).toBe("editable");
  });

  it("a line created THIS session stays editable after it gains an id", () => {
    // Regression: the attach-to-persist path writes an id into a row mid-session without
    // refreshing the list, so the row has an id and NO settlement. The fail-closed rule
    // below would lock it — and the admin's next amount edit would be swallowed by a
    // read-only field. Never billed ⇒ never paid ⇒ editable.
    expect(expenseLockState({ id: "exp-new-0", seeded: false })).toBe("editable");
    expect(isExpenseLineLocked({ id: "exp-new-0", seeded: false })).toBe(false);
  });

  it("treats an OMITTED seeded flag as seeded, so the fail-closed check still runs", () => {
    // A caller that forgets the flag must not get a free pass out of the settlement check.
    expect(expenseLockState({ id: "exp-1" })).toBe("unknown");
  });

  it("fails CLOSED on a persisted line with no settlement fact", () => {
    // The money-safe direction, and the OPPOSITE of row-lock.ts's absent-⇒-editable
    // default. Rendering an editable control over a line we cannot prove is unpaid is
    // precisely the bug this lock exists to remove: the admin types, saves, and the
    // server answers 409 ENTRY_LOCKED. Wrong-closed costs a refresh.
    expect(expenseLockState(line({ settlement: undefined }))).toBe("unknown");
    expect(isExpenseLineLocked(line({ settlement: undefined }))).toBe(true);
  });

  it("never claims 'Paid' for a line it has no settlement fact about", () => {
    // The label is read by an admin deciding whether money moved. "unknown" must not
    // borrow the paid pill — it says the UI is withholding the edit, not that the tenant
    // has paid.
    expect(expenseLockLabel(line({ settlement: undefined }))).toBe("Locked");
    expect(expenseLockLabel(line({ settlement: "paid" }))).toBe("Paid");
    expect(expenseLockLabel(line({ settlement: "partial" }))).toBe("Part paid");
    expect(expenseLockLabel(line({ settlement: "unpaid" }))).toBeNull();
  });

  it("locks exactly the states that carry money, and no others", () => {
    // The property that makes this safe against the server guard: entryHasActivePayment
    // freezes on ANY net-positive allocation, which surfaces here as partial|paid. If
    // this list ever drifts wider the UI withholds a legitimate edit; narrower and it
    // offers one the server rejects.
    const locking: SettlementState[] = ["partial", "paid"];
    for (const settlement of ["none", "unpaid", "partial", "paid"] as const) {
      expect(isExpenseLineLocked(line({ settlement }))).toBe(locking.includes(settlement));
    }
  });
});
