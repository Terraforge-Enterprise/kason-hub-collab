// owner-ledger.void-updated-by.test.ts
//
// Unit test for the R3 fix: `voidEntry` (owner-ledger.repository.ts) must
// stamp `updatedById` with the ACTING ACTOR's user id on void, instead of
// leaving it untouched. Before this fix, a voided row kept whatever
// `updatedById` it had, which — combined with the sync engine's never-touch
// rule (`updatedById !== SYNC_ACTOR_ID` in owner-ledger.sync.ts) — meant a
// voided row could still look sync-owned to a later sync pass.
//
// This calls the REAL `voidEntry` directly (no `vi.mock` of the repository
// module — we're testing the function itself) with a fake `tx` object whose
// `ownerLedgerEntry.updateMany` is a spy, and asserts the exact Prisma call
// shape. Deliberately a dedicated file, not stacked into
// owner-ledger.void-guard.test.ts, because that file hard-mocks
// `../owner-ledger.repository` wholesale (so the real `voidEntry` body never
// runs there) — see this module's task-3-report.md for the split rationale.
import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@kason/db";
import { voidEntry } from "../owner-ledger.repository";
import { SYNC_ACTOR_ID } from "../owner-ledger.sync";

function fakeTx(count = 1) {
  const updateMany = vi.fn().mockResolvedValue({ count });
  const tx = { ownerLedgerEntry: { updateMany } } as unknown as Prisma.TransactionClient;
  return { tx, updateMany };
}

describe("voidEntry — updatedById stamping (R3)", () => {
  it("stamps updatedById with the acting admin's user id (never SYNC_ACTOR_ID), leaving the WHERE clause unchanged", async () => {
    const { tx, updateMany } = fakeTx();

    const count = await voidEntry(tx, "org-1", "row-1", "2026-06-01T00:00:00.000Z", "u-1");

    expect(count).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "row-1",
        organizationId: "org-1",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      data: { status: "void", updatedById: "u-1" },
    });
    // Never-touch invariant: a real admin id must never collide with the
    // sync sentinel, or the sync engine's `updatedById !== SYNC_ACTOR_ID`
    // check would treat this admin-voided row as still sync-owned.
    expect("u-1").not.toBe(SYNC_ACTOR_ID);
  });
});
