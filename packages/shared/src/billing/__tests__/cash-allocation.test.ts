import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES } from "../../constants/statuses";
import {
  CASH_ALLOCATION_WHERE,
  CASH_PAYMENT_STATUS,
  IS_CASH_PAYMENT_STATUS,
} from "../cash-allocation";

describe("cash-allocation — the single definition of 'this allocation is money'", () => {
  it("names 'posted' as the only cash-bearing Payment.status", () => {
    expect(CASH_PAYMENT_STATUS).toBe("posted");
  });

  it("exposes a Prisma where-fragment filtering allocations to posted payments", () => {
    expect(CASH_ALLOCATION_WHERE).toEqual({ payment: { status: "posted" } });
  });

  // Shape lock. A future edit adding a sibling key here would silently widen the
  // WHERE clause of every consumer — four money reads — with no type error,
  // because the fragment is spread into a Prisma filter that accepts any subset.
  it("is shape-locked to exactly one top-level key", () => {
    expect(Object.keys(CASH_ALLOCATION_WHERE)).toEqual(["payment"]);
    expect(Object.keys(CASH_ALLOCATION_WHERE.payment)).toEqual(["status"]);
  });

  it("classifies 'posted' as cash and every other live status as not-cash", () => {
    expect(IS_CASH_PAYMENT_STATUS).toEqual({
      pending_approval: false,
      posted: true,
      expired: false,
      failed: false,
      void: false,
      refunded: false,
      // An admin read the tenant's transfer slip and refused it — the claimed
      // money never arrived, so this can never count as cash.
      rejected: false,
      // A signed gateway success landed on a payment that was already closed
      // off by a human. The payer's bank very likely DID debit them, but
      // nothing has been applied to any charge and nothing should be until
      // someone resolves it — so for our books this is not cash.
      needs_reconciliation: false,
    });
  });

  it("marks exactly one status as cash", () => {
    const cash = Object.entries(IS_CASH_PAYMENT_STATUS).filter(([, isCash]) => isCash);
    expect(cash).toEqual([["posted", true]]);
  });

  // The drift guard that makes correcting PAYMENT_STATUSES load-bearing: the map
  // must classify every member of the constant and invent none. Without this a
  // status could be added to the array and left unclassified at runtime even
  // though the Record type-checks against a stale union.
  it("classifies every PAYMENT_STATUSES member and no others", () => {
    expect(Object.keys(IS_CASH_PAYMENT_STATUS).sort()).toEqual([...PAYMENT_STATUSES].sort());
  });
});

describe("PAYMENT_STATUSES — corrected to the real write-set", () => {
  // Verified against every payment.create/update in apps/api:
  //   pending_approval  portal/payments/portal.payments.repository.ts:118,204,239
  //   posted            payments/payments.repository.ts:287,312,495,880
  //   expired           portal.payments.repository.ts:208, payments.repository.ts:967
  //   failed            payments/fpx-callback.repository.ts:69
  //   void | refunded   payments/payments.repository.ts:653
  //   rejected          payments/payments.repository.ts rejectPaymentTx
  //   needs_reconciliation
  //                     payments/fpx-callback.repository.ts holdForReconciliationTx
  it("contains every status the code actually writes", () => {
    expect([...PAYMENT_STATUSES].sort()).toEqual(
      ["expired", "failed", "pending_approval", "posted", "refunded", "void", "rejected", "needs_reconciliation"].sort(),
    );
  });

  // "recorded" and "allocated" were in this list historically but are written
  // NOWHERE in the current codebase. A reader treating them as live states would
  // mis-handle real data — and an allow-list keyed on "posted" would silently
  // treat any such legacy row as unpaid, which is why the spec's pre-merge
  // legacy-status query against UAT and prod gates this change.
  it("does not carry the legacy values the code never writes", () => {
    expect(PAYMENT_STATUSES).not.toContain("recorded");
    expect(PAYMENT_STATUSES).not.toContain("allocated");
  });
});
