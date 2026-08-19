// owner-ledger.void-guard.test.ts
//
// Unit tests for the R2 "void-at-source" guard in `voidEntryService`
// (owner-ledger.service.ts:383). A shallow void of any SYNC-OWNED row (a
// non-null sourceChargeId OR sourceUtilityBillId) must be REJECTED with
// 409 VOID_AT_SOURCE and must never reach voidEntry/$transaction — the real
// money lives on the source Charge/UnitUtilityBill, which has its own void
// path. Only a MANUAL entry (both source ids null) may proceed to the
// existing void path.
//
// Deliberately a SEPARATE file from owner-ledger.service.test.ts: that file
// is a real-Postgres integration suite (describe.skip unless
// RUN_INTEGRATION=1, zero mocks). Mocking @kason/db / the repository at the
// top of that file would silently neuter its RUN_INTEGRATION=1 real-DB
// tests. This file instead mirrors the established pattern in
// owner-ledger.sync-hook.test.ts (hard vi.mock + vi.hoisted at the
// repository/@kason/db/audit seams) — a true unit test, NOT gated behind
// RUN_INTEGRATION, so it runs in the default `vitest run` / CI.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getEntry = vi.hoisted(() => vi.fn());
const voidEntry = vi.hoisted(() => vi.fn());
vi.mock("../owner-ledger.repository", () => ({
  createEntry: vi.fn(),
  getEntry,
  listEntries: vi.fn(),
  guardedUpdateEntry: vi.fn(),
  voidEntry,
  listForPeriod: vi.fn(),
  resolveOwnerTree: vi.fn(),
  resolveOwnersSummary: vi.fn(),
  resolveOwnerBalance: vi.fn(),
}));

const transaction = vi.hoisted(() => vi.fn());
vi.mock("@kason/db", () => ({
  getDb: () => ({ $transaction: transaction }),
}));

const recordAudit = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/audit", () => ({ recordAudit }));

import { voidEntryService } from "../owner-ledger.service";
import type { DbOwnerLedgerEntry, OwnerLedgerActorCtx } from "../owner-ledger.types";

const actor: OwnerLedgerActorCtx = {
  orgId: "org-1",
  actorUserId: "user-1",
  actorRole: "admin",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

/** Prisma-Decimal stand-in (matches the convention in owner-ledger.service.test.ts's baseRow). */
const dec = (s: string) => ({ toString: () => s }) as unknown as DbOwnerLedgerEntry["amount"];

function row(overrides: Partial<DbOwnerLedgerEntry> = {}): DbOwnerLedgerEntry {
  return {
    id: "row-1",
    organizationId: "org-1",
    ownerPartyId: "owner-1",
    propertyId: "prop-1",
    apartmentId: null,
    listingId: null,
    tenancyId: null,
    statementMonth: new Date("2026-06-01"),
    transactionDate: new Date("2026-06-15"),
    direction: "income",
    category: "rental_income",
    description: null,
    remarks: null,
    amount: dec("1200.00"),
    sstAmount: null,
    paidBy: "kaen",
    paymentStatus: "paid",
    taxCategory: "check_with_tax_agent",
    includeInPayout: true,
    attachmentKeys: [],
    sourceType: "manual",
    sourceChargeId: null,
    sourceInvoiceId: null,
    sourceUtilityBillId: null,
    // Nullable (schema.prisma: `settlementKind String?`, Task-2 migration, no
    // backfill) — every legacy Phase-1 row is null. Explicit default (matching
    // this fixture's own convention for apartmentId/listingId/tenancyId above)
    // so a row() call that doesn't override it behaves like a REAL Prisma row,
    // not `undefined` — required for the Phase-2 guard tests below to be
    // meaningful and for the pre-existing R2 tests above to stay valid.
    settlementKind: null,
    payeeName: null,
    paidOnBehalfRef: null,
    paidOnBehalfDate: null,
    status: "active",
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  } as DbOwnerLedgerEntry;
}

describe("voidEntryService — void-at-source guard (R2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Sensible "would succeed if reached" defaults for the void transaction —
    // so a guarded test that WRONGLY falls through fails on a clean
    // ok:true/false + status mismatch, not a crash inside rowToDto(undefined).
    voidEntry.mockResolvedValue(1);
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ ownerLedgerEntry: { findFirst: vi.fn().mockResolvedValue(row({ status: "void" })) } }),
    );
    recordAudit.mockResolvedValue(undefined);
  });

  it("void at source charge: a charge-derived entry (sourceChargeId set) returns 409 VOID_AT_SOURCE and never voids", async () => {
    getEntry.mockResolvedValueOnce(
      row({ sourceType: "rent", sourceChargeId: "c-1", sourceUtilityBillId: null }),
    );

    // Deliberately-stale expectedUpdatedAt: the guard sits BEFORE the
    // concurrency check, so it must win unconditionally regardless of the
    // token's freshness (adversarial-audit finding).
    const result = await voidEntryService(actor, "row-1", "2020-01-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "VOID_AT_SOURCE" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("void at source bill: a bill-derived entry (sourceUtilityBillId set, sourceChargeId null) returns 409 VOID_AT_SOURCE and never voids", async () => {
    getEntry.mockResolvedValueOnce(
      row({ sourceType: "utility_tnb", sourceChargeId: null, sourceUtilityBillId: "b-1" }),
    );

    const result = await voidEntryService(actor, "row-1", "2020-01-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "VOID_AT_SOURCE" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("keys on id presence, not the sourceType label: a 'manual'-labelled row with sourceChargeId set still 409s", async () => {
    // Adversarial-audit finding: sourceType and id-nullness agree on every
    // real write path (createEntryService never sets a source id; sync.ts
    // sets sourceType alongside the matching id), so a matrix built only
    // from "realistic" fixtures can't tell an id-presence guard apart from a
    // forbidden `sourceType !== "manual"` guard. This disagreeing fixture
    // proves the former — the spec's explicit invariant.
    getEntry.mockResolvedValueOnce(
      row({ sourceType: "manual", sourceChargeId: "c-2", sourceUtilityBillId: null }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "VOID_AT_SOURCE" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("both source ids set (anomalous row) still returns 409 VOID_AT_SOURCE", async () => {
    getEntry.mockResolvedValueOnce(row({ sourceChargeId: "c-3", sourceUtilityBillId: "b-3" }));

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "VOID_AT_SOURCE" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("manual void proceeds: a manual entry (both source ids null) reaches the existing 200 success path", async () => {
    getEntry.mockResolvedValueOnce(
      row({ sourceType: "manual", sourceChargeId: null, sourceUtilityBillId: null, status: "active" }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.status).toBe("void");
    expect(voidEntry).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  // ── R3: voidEntry stamps updatedById so a manual void survives sync ────────
  it("forwards actor.actorUserId to voidEntry as the 5th argument (R3: manual void stamps updatedById)", async () => {
    getEntry.mockResolvedValueOnce(
      row({ sourceType: "manual", sourceChargeId: null, sourceUtilityBillId: null, status: "active" }),
    );

    await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(voidEntry).toHaveBeenCalledWith(
      expect.anything(),
      actor.orgId,
      "row-1",
      "2026-06-01T00:00:00.000Z",
      actor.actorUserId,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase-2 settlementKind guard (money-hole fix, whole-branch adversarial
// review): a Phase-2 OwnerLedgerEntry (remittance / offset / reversal, written
// by insertPayoutEntry — owner-remittance.repository.ts) ALWAYS has both
// source ids null (insertPayoutEntry's own contract), so it slips straight
// past the R2 guard above. An OWNER_RECEIVABLE_OFFSET entry has a SECOND,
// coupled money effect this shallow void does not know how to undo: an
// external Charge was settled via settleIvownChargeTx when the offset was
// created. Voiding only flips status "active"→"void", which drops the entry
// from computeAvailableOwnerPayableC's `status:"active"` filter — silently
// freeing owner payable while the settled Charge stays untouched (the agency
// loses the offset amount). Per GC5 (append-only invariant), EVERY Phase-2
// entry (remittance / offset / reversal — settlementKind non-null) must be
// undone ONLY via its dedicated reversal endpoint (POST
// /api/owner-remittances/:id/reverse or POST
// /api/owner-receivable-offsets/:id/reverse), which atomically undoes every
// coupled side effect — never via this shallow status:"void" flip.
// ─────────────────────────────────────────────────────────────────────────────
describe("voidEntryService — Phase-2 settlementKind guard (money-hole fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voidEntry.mockResolvedValue(1);
    transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ ownerLedgerEntry: { findFirst: vi.fn().mockResolvedValue(row({ status: "void" })) } }),
    );
    recordAudit.mockResolvedValue(undefined);
  });

  it("offset entry (settlementKind=OWNER_RECEIVABLE_OFFSET): returns 409 CANNOT_VOID_PHASE2_ENTRY and never voids", async () => {
    getEntry.mockResolvedValueOnce(
      row({ settlementKind: "OWNER_RECEIVABLE_OFFSET", sourceChargeId: null, sourceUtilityBillId: null }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("remittance entry (settlementKind=OWNER_REMITTANCE): returns 409 CANNOT_VOID_PHASE2_ENTRY and never voids", async () => {
    getEntry.mockResolvedValueOnce(
      row({ settlementKind: "OWNER_REMITTANCE", sourceChargeId: null, sourceUtilityBillId: null }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("pre-statement remittance entry (settlementKind=PRE_STATEMENT_REMITTANCE): returns 409 CANNOT_VOID_PHASE2_ENTRY and never voids", async () => {
    getEntry.mockResolvedValueOnce(
      row({ settlementKind: "PRE_STATEMENT_REMITTANCE", sourceChargeId: null, sourceUtilityBillId: null }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reversal entry (settlementKind set + reversalOfEntryId set): returns 409 CANNOT_VOID_PHASE2_ENTRY and never voids", async () => {
    // A reversal row reuses the SAME settlementKind as its original
    // (reverseOffsetService/reverseRemittanceService — no distinct "REVERSAL"
    // string exists) and is distinguished only by reversalOfEntryId being
    // set. The guard must reject it purely on settlementKind — GC5's
    // append-only invariant means even a reversal is never undone via
    // status:void.
    getEntry.mockResolvedValueOnce(
      row({
        settlementKind: "OWNER_RECEIVABLE_OFFSET",
        reversalOfEntryId: "orig-entry-1",
        sourceChargeId: null,
        sourceUtilityBillId: null,
      }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("fail-closed: an unrecognized non-null settlementKind also 409s (guard blocks by nullability, not an allowlist of the 3 known kinds)", async () => {
    getEntry.mockResolvedValueOnce(
      row({ settlementKind: "SOME_FUTURE_KIND", sourceChargeId: null, sourceUtilityBillId: null }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("guard wins even with a stale expectedUpdatedAt (fires before the concurrency check, mirrors R2)", async () => {
    getEntry.mockResolvedValueOnce(
      row({ settlementKind: "OWNER_RECEIVABLE_OFFSET", sourceChargeId: null, sourceUtilityBillId: null }),
    );

    const result = await voidEntryService(actor, "row-1", "2020-01-01T00:00:00.000Z");

    expect(result).toEqual({ ok: false, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" });
    expect(voidEntry).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("regression: a legacy Phase-1 manual entry (settlementKind:null) still voids successfully — the guard doesn't touch legacy entries", async () => {
    getEntry.mockResolvedValueOnce(
      row({
        settlementKind: null,
        sourceType: "manual",
        sourceChargeId: null,
        sourceUtilityBillId: null,
        status: "active",
      }),
    );

    const result = await voidEntryService(actor, "row-1", "2026-06-01T00:00:00.000Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(voidEntry).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
