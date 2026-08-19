// Unit tests for entryHasActivePayment — the write-guard predicate behind the
// billed-but-unpaid unlock. Pure I/O shape: the Prisma tx is hand-mocked so each
// step's contribution is provable in isolation.
//
// The cases that matter are the ones where a WRONG answer costs something:
//  • "false" when money IS present   → a write is accepted that re-Bill will refuse
//  • "true"  when money is NOT present → the unlock silently does nothing
//  • an error swallowed into "false" → the guard opens on a failed check
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@kason/db";

vi.mock("../../payments/payments.repository", () => ({
  sumReversalsForAllocations: vi.fn(),
}));

// Imported from service.ts, not a leaf module: `Charge` access inside bills-grid is confined
// to service.ts + issue-grouped.ts by forbidden-writes.integration.test.ts's static guard, so
// the predicate lives beside its batched twin entriesWithPaidInvoice rather than widening that
// allowlist. Same import shape row-dto-mappers.test.ts already uses for the pure mappers.
import { entryHasActivePayment } from "../service";
import { sumReversalsForAllocations } from "../../payments/payments.repository";

const reversalsMock = vi.mocked(sumReversalsForAllocations);

type TxParts = {
  charges?: { id: string }[];
  liveLines?: { chargeId: string | null }[];
  allocs?: { id: string; allocatedAmount: number }[];
};

/** Minimal Prisma-tx stand-in exposing only the three reads the predicate performs. */
function makeTx(parts: TxParts) {
  const tx = {
    charge: { findMany: vi.fn().mockResolvedValue(parts.charges ?? []) },
    billingDocumentLine: { findMany: vi.fn().mockResolvedValue(parts.liveLines ?? []) },
    paymentAllocation: { findMany: vi.fn().mockResolvedValue(parts.allocs ?? []) },
  };
  return tx as unknown as Prisma.TransactionClient & typeof tx;
}

beforeEach(() => {
  reversalsMock.mockReset();
  reversalsMock.mockResolvedValue(new Map());
});

describe("entryHasActivePayment", () => {
  it("no charges tagged to the entry → false, and stops before touching documents", async () => {
    const tx = makeTx({ charges: [] });
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).resolves.toBe(false);
    expect(tx.billingDocumentLine.findMany).not.toHaveBeenCalled();
    expect(tx.paymentAllocation.findMany).not.toHaveBeenCalled();
  });

  it("charges exist but every document is CANCELLED → false (a superseded invoice is not live)", async () => {
    const tx = makeTx({ charges: [{ id: "c1" }], liveLines: [] });
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).resolves.toBe(false);
    expect(tx.paymentAllocation.findMany).not.toHaveBeenCalled();
  });

  it("only queries documents whose status is ISSUED", async () => {
    const tx = makeTx({ charges: [{ id: "c1" }], liveLines: [] });
    await entryHasActivePayment(tx, "org-1", "entry-1");
    const where = tx.billingDocumentLine.findMany.mock.calls[0]![0].where;
    expect(where.document).toMatchObject({ organizationId: "org-1", documentStatus: "ISSUED" });
  });

  it("live charge with no cash allocations → false", async () => {
    const tx = makeTx({ charges: [{ id: "c1" }], liveLines: [{ chargeId: "c1" }], allocs: [] });
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).resolves.toBe(false);
    expect(reversalsMock).not.toHaveBeenCalled();
  });

  it("applies the shared CASH_ALLOCATION_WHERE filter, so a non-cash payment never reads as money", async () => {
    // The abandoned-FPX case (c88b72b3): a `pending_approval` payment mints an allocation
    // at initiate but settles nothing. The filter is what keeps it out of this query.
    const tx = makeTx({ charges: [{ id: "c1" }], liveLines: [{ chargeId: "c1" }], allocs: [] });
    await entryHasActivePayment(tx, "org-1", "entry-1");
    const where = tx.paymentAllocation.findMany.mock.calls[0]![0].where;
    expect(where).toHaveProperty("payment");
    expect(where.chargeId).toEqual({ in: ["c1"] });
  });

  it("allocation fully reversed → false (net zero is not money)", async () => {
    const tx = makeTx({
      charges: [{ id: "c1" }],
      liveLines: [{ chargeId: "c1" }],
      allocs: [{ id: "a1", allocatedAmount: 50 }],
    });
    reversalsMock.mockResolvedValue(new Map([["a1", 50]]));
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).resolves.toBe(false);
  });

  it("allocation partially reversed → true (RM40 still received)", async () => {
    const tx = makeTx({
      charges: [{ id: "c1" }],
      liveLines: [{ chargeId: "c1" }],
      allocs: [{ id: "a1", allocatedAmount: 50 }],
    });
    reversalsMock.mockResolvedValue(new Map([["a1", 10]]));
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).resolves.toBe(true);
  });

  it("one net-positive allocation among several reversed ones → true", async () => {
    const tx = makeTx({
      charges: [{ id: "c1" }, { id: "c2" }],
      liveLines: [{ chargeId: "c1" }, { chargeId: "c2" }],
      allocs: [
        { id: "a1", allocatedAmount: 50 },
        { id: "a2", allocatedAmount: 1 },
      ],
    });
    reversalsMock.mockResolvedValue(new Map([["a1", 50]]));
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).resolves.toBe(true);
  });

  it("de-duplicates charge ids before querying allocations", async () => {
    const tx = makeTx({
      charges: [{ id: "c1" }],
      liveLines: [{ chargeId: "c1" }, { chargeId: "c1" }, { chargeId: null }],
      allocs: [],
    });
    await entryHasActivePayment(tx, "org-1", "entry-1");
    expect(tx.paymentAllocation.findMany.mock.calls[0]![0].where.chargeId).toEqual({ in: ["c1"] });
  });

  it("FAILS CLOSED: a query error rejects — it must never resolve to false", async () => {
    const tx = makeTx({});
    tx.charge.findMany.mockRejectedValue(new Error("db down"));
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).rejects.toThrow("db down");
  });

  it("FAILS CLOSED: a reversal-sum error rejects rather than reporting unpaid", async () => {
    const tx = makeTx({
      charges: [{ id: "c1" }],
      liveLines: [{ chargeId: "c1" }],
      allocs: [{ id: "a1", allocatedAmount: 50 }],
    });
    reversalsMock.mockRejectedValue(new Error("reversal read failed"));
    await expect(entryHasActivePayment(tx, "org-1", "entry-1")).rejects.toThrow("reversal read failed");
  });
});
