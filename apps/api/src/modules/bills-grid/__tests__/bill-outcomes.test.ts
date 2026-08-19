import { describe, it, expect } from "vitest";
import type { BillOutcome, BillRowResult } from "../service";

/** Compile-time exhaustiveness pin: the switch below only type-checks when EVERY
 *  BillOutcome arm is present. If the union is widened without a matching arm,
 *  the `default: assertNever` fails to compile — proving the union pins the set. */
const assertNever = (x: never): never => {
  throw new Error(`Unhandled BillOutcome: ${String(x)}`);
};
function isInvoiceOutcome(o: BillOutcome): boolean {
  switch (o) {
    case "billed":
    case "stale":
    case "already_billed":
    case "compute_error":
    case "no_entry":
    case "save_failed":
      return false;
    case "invoiced":
    case "reinvoiced":
    case "already_invoiced":
    case "pax_blocked":
    case "paid_locked":
    case "occupancy_changed":
    case "rebill_confirmation_required":
    case "rebill_blocked_previous_period":
    case "rebill_blocked_payment_exists":
    case "conflicting_invoice":
    case "recurring_unresolved":
    case "nature_unresolved":
    case "blocked_future_period":
      return true;
    default:
      return assertNever(o);
  }
}

describe("BillOutcome union", () => {
  it("includes the new invoice outcomes", () => {
    const all: BillOutcome[] = [
      "billed", "stale", "already_billed", "compute_error", "no_entry", "save_failed",
      "invoiced", "reinvoiced", "already_invoiced", "pax_blocked", "paid_locked", "occupancy_changed",
      "rebill_confirmation_required", "rebill_blocked_previous_period", "rebill_blocked_payment_exists", "conflicting_invoice",
      "recurring_unresolved", "nature_unresolved", "blocked_future_period",
    ];
    expect(all.length).toBe(19);
  });

  it("classifies the invoice outcomes exhaustively", () => {
    expect(isInvoiceOutcome("billed")).toBe(false);
    expect(isInvoiceOutcome("invoiced")).toBe(true);
    expect(isInvoiceOutcome("reinvoiced")).toBe(true);
    expect(isInvoiceOutcome("already_invoiced")).toBe(true);
    expect(isInvoiceOutcome("pax_blocked")).toBe(true);
    expect(isInvoiceOutcome("paid_locked")).toBe(true);
    expect(isInvoiceOutcome("occupancy_changed")).toBe(true);
    expect(isInvoiceOutcome("rebill_confirmation_required")).toBe(true);
    expect(isInvoiceOutcome("rebill_blocked_previous_period")).toBe(true);
    expect(isInvoiceOutcome("rebill_blocked_payment_exists")).toBe(true);
    expect(isInvoiceOutcome("conflicting_invoice")).toBe(true);
    expect(isInvoiceOutcome("recurring_unresolved")).toBe(true);
    expect(isInvoiceOutcome("nature_unresolved")).toBe(true);
  });

  it("carries invoice-id fields on BillRowResult", () => {
    const r: BillRowResult = {
      apartmentId: "apt-1",
      outcome: "invoiced",
      tenantInvoiceIds: ["inv-a", "inv-b"],
      ownerInvoiceIds: ["own-1"],
    };
    expect(r.tenantInvoiceIds).toHaveLength(2);
    expect(r.ownerInvoiceIds).toEqual(["own-1"]);

    const cleared: BillRowResult = { apartmentId: "apt-2", outcome: "pax_blocked", ownerInvoiceIds: [] };
    expect(cleared.ownerInvoiceIds).toEqual([]);
  });
});
