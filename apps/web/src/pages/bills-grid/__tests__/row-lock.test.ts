// The bills-grid row edit lock, in isolation.
//
// This predicate decides whether an admin can type into money that has already
// started settling. It is small enough to state exhaustively, and it is consumed by
// three surfaces (render, keyboard nav, the page's save/bill filters) that must all
// agree — so it gets its own table rather than only being observed through a render.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySettlementCells, type SettlementBucket, type SettlementState } from "@kason/shared";
import { isCellLocked, isRowLocked, type RowLockInput } from "../row-lock";

const BILLED = "2026-08-01T00:00:00.000Z";

function row(over: Partial<RowLockInput> = {}): RowLockInput {
  return { billedAt: BILLED, paymentStatus: "unpaid", settlement: undefined, ...over };
}

function settled(status: SettlementState) {
  return { status, cells: emptySettlementCells(), rooms: {}, expenseLines: {} };
}

describe("isRowLocked", () => {
  it("never locks an unbilled row, whatever settlement claims", () => {
    // No issued document ⇒ nothing to freeze. A settlement roll-up arriving on an
    // unbilled row must not strand it read-only.
    for (const status of ["none", "unpaid", "partial", "paid"] as const) {
      expect(isRowLocked(row({ billedAt: null, settlement: settled(status) }))).toBe(false);
    }
  });

  describe("billed rows, by real settlement state", () => {
    const cases: [SettlementState, boolean][] = [
      ["none", false],    // nothing billed against it yet
      ["unpaid", false],  // billed, no money in — amend + re-Bill stays open (R7)
      ["partial", true],  // ANY payment freezes the entry server-side
      ["paid", true],
    ];
    for (const [status, locked] of cases) {
      it(`settlement "${status}" ⇒ ${locked ? "locked" : "editable"}`, () => {
        expect(isRowLocked(row({ settlement: settled(status) }))).toBe(locked);
      });
    }
  });

  it("locks on the legacy manual column too, with no settlement present", () => {
    // Preserved deliberately: an admin who marked the row paid by hand still locks
    // it exactly as before this predicate learned to read settlement.
    expect(isRowLocked(row({ paymentStatus: "paid" }))).toBe(true);
    expect(isRowLocked(row({ paymentStatus: "partial" }))).toBe(false);
  });

  it("is a strict superset of the OLD predicate — it never newly permits an edit", () => {
    // The property that makes this change safe to ship against money: every row the
    // old rule froze is still frozen. Anything else would mean the UI started
    // offering edits the server rejects.
    const oldPredicate = (r: RowLockInput) => r.billedAt != null && r.paymentStatus === "paid";
    const statuses: SettlementState[] = ["none", "unpaid", "partial", "paid"];
    for (const billedAt of [null, BILLED]) {
      for (const paymentStatus of ["unpaid", "pending", "partial", "paid"]) {
        for (const status of statuses) {
          const r = row({ billedAt, paymentStatus, settlement: settled(status) });
          if (oldPredicate(r)) expect(isRowLocked(r)).toBe(true);
        }
      }
    }
  });

  it("treats a missing settlement as 'nothing paid' rather than throwing", () => {
    // Older payloads and pre-settlement test fixtures reach this path.
    expect(isRowLocked(row({ settlement: undefined }))).toBe(false);
  });
});

describe("isCellLocked", () => {
  // The narrowing is flag-gated: it is only sound while partial re-Bill exists to carry
  // the edit onto a document. These cases describe the flag-ON world; the OFF case is
  // pinned separately at the bottom.
  beforeEach(() => vi.stubEnv("VITE_ENABLE_PROFORMA_INVOICES", "true"));
  afterEach(() => vi.unstubAllEnvs());

  // Partial re-Bill means paying the electricity no longer freezes the WiFi, so the row
  // lock became coarser than the money it represents. This narrows the render WITHOUT
  // widening it — the property the whole change rests on.

  const partPaid = (over: Partial<Record<SettlementBucket, SettlementState>> = {}) =>
    row({
      settlement: {
        status: "partial",
        cells: { ...emptySettlementCells(), ...over },
        rooms: {},
        expenseLines: {},
      },
    });

  it("an UNLOCKED row leaves every cell unlocked", () => {
    // The narrowing can never open a cell the row lock kept shut, and this is the other
    // half of that: it can never SHUT one the row lock left open.
    const unbilled = row({ billedAt: null, settlement: undefined });
    for (const col of ["airOwner", "airTenant", "tnbOwner", "wifiTenant", "unitCode"] as const) {
      expect(isCellLocked(unbilled, col)).toBe(false);
    }
  });

  it("locks only the settled bucket's cell", () => {
    const r = partPaid({ airOwner: "paid" });
    expect(isCellLocked(r, "airOwner")).toBe(true);
    expect(isCellLocked(r, "airTenant")).toBe(false);
    expect(isCellLocked(r, "tnbOwner")).toBe(false);
    expect(isCellLocked(r, "wifiTenant")).toBe(false);
  });

  it("a PARTIALLY paid bucket locks its cell too", () => {
    // Any money at all against a line freezes it — the server agrees, and a half-settled
    // line is not an editable one.
    const r = partPaid({ wifiTenant: "partial" });
    expect(isCellLocked(r, "wifiTenant")).toBe(true);
    expect(isCellLocked(r, "wifiOwner")).toBe(false);
  });

  it("a column with no bucket of its own inherits the ROW verdict", () => {
    // Fail-closed. `rental` and `unitCode` carry no money of their own, so nothing can
    // clear them once the row is locked. (The expense and recurring columns DO map to a
    // bucket in the shared paint map — they are read-only totals either way.)
    const r = partPaid({ airOwner: "paid" });
    for (const col of ["rental", "unitCode"] as const) {
      expect(isCellLocked(r, col)).toBe(true);
    }
  });

  it("derives from the paint map, overriding ONLY the meter columns", () => {
    // Pins the deliberate delta so neither map can drift into the other unnoticed. A
    // meter reading re-prices the tenant's electricity, so it locks with tnbTenant even
    // though it is never PAINTED as settled.
    const paidTnb = partPaid({ tnbTenant: "paid" });
    expect(isCellLocked(paidTnb, "previousKwh")).toBe(true);
    expect(isCellLocked(paidTnb, "currentKwh")).toBe(true);
    // Every other column takes the paint map's bucket unchanged.
    const paidWifi = partPaid({ wifiTenant: "paid" });
    expect(isCellLocked(paidWifi, "wifiTenant")).toBe(true);
    expect(isCellLocked(paidWifi, "previousKwh")).toBe(false);
  });

  it("locks the TNB Owner cell once the TENANT's electricity is settled", () => {
    // Reported on UAT: every room's electricity paid, `amount` greyed with its tick, but the
    // "Owner" cell under the TNB band stayed editable.
    //
    // That cell does NOT write an owner-only figure — it writes the SHARED `tnbTotal`
    // (bills-grid-page.tsx DIRECT_WIRE_FIELD), and every occupied room's tenant share is
    // derived from it (meter/compute.ts: leftoverTnb = tnbTotal - totalAircond, then
    // tnbShare = leftoverTnb / totalPax * pax). So editing it re-prices electricity the
    // tenant has already paid — exactly the property that earned the meter columns their
    // override. Its own `tnbOwner` bucket reads "none" unless the pattern is "absorbed",
    // so keying the lock on that bucket left the cell open over settled money.
    const paidTenantTnb = partPaid({ tnbTenant: "paid" });
    expect(isCellLocked(paidTenantTnb, "tnbOwner")).toBe(true);

    // The absorbed case is the mirror image: the owner's own electricity is settled while
    // the tenant side is not. Same field, same re-pricing, so it must lock from either side.
    const paidOwnerTnb = partPaid({ tnbOwner: "paid" });
    expect(isCellLocked(paidOwnerTnb, "tnbOwner")).toBe(true);

    // Still narrow: money elsewhere in the month leaves the TNB total editable.
    expect(isCellLocked(partPaid({ wifiTenant: "paid" }), "tnbOwner")).toBe(false);
  });

  it("fails CLOSED when the row is locked but carries no per-bucket detail", () => {
    // The row lock already concluded money is present; with no breakdown we cannot say
    // WHICH cell it belongs to, so we do not guess. An older payload must not silently
    // unlock every cell on a part-paid row.
    const r = row({ paymentStatus: "paid", settlement: undefined });
    expect(isRowLocked(r)).toBe(true);
    expect(isCellLocked(r, "airOwner")).toBe(true);
    expect(isCellLocked(r, "tnbOwner")).toBe(true);
  });

  it("is never wider than the row lock, across every settlement state", () => {
    // THE safety property: for any row and any column, a locked cell implies a locked row.
    // If this ever inverts, the grid starts offering edits the server rejects.
    const statuses: SettlementState[] = ["none", "unpaid", "partial", "paid"];
    for (const billedAt of [null, BILLED]) {
      for (const status of statuses) {
        const r = row({ billedAt, settlement: settled(status) });
        for (const col of ["airOwner", "airTenant", "tnbOwner", "wifiTenant"] as const) {
          if (isCellLocked(r, col)) expect(isRowLocked(r)).toBe(true);
        }
      }
    }
  });

  it("flag OFF ⇒ identical to the ROW lock, never narrower", () => {
    // Without partial re-Bill an edit to an unpaid cell has nowhere to go: the server's
    // guards are entry-wide and re-Bill refuses the month. Offering the edit anyway
    // recreates the 409-you-could-not-predict from the opposite direction.
    vi.stubEnv("VITE_ENABLE_PROFORMA_INVOICES", "false");
    const r = partPaid({ airOwner: "paid" });
    expect(isRowLocked(r)).toBe(true);
    for (const col of ["airOwner", "airTenant", "tnbOwner", "wifiTenant", "previousKwh"] as const) {
      expect(isCellLocked(r, col)).toBe(true);
    }
  });

  it("the per-room meter columns read the unit-level tenant electricity bucket", () => {
    const r = partPaid({ tnbTenant: "paid" });
    expect(isCellLocked(r, "previousKwh")).toBe(true);
    expect(isCellLocked(r, "currentKwh")).toBe(true);
    // A part-paid unit keeps them editable — tnbTenant only reads "paid" once EVERY
    // room's electricity is settled.
    const partial = partPaid({ tnbTenant: "unpaid", airOwner: "paid" });
    expect(isCellLocked(partial, "previousKwh")).toBe(false);
    expect(isCellLocked(partial, "currentKwh")).toBe(false);
  });
});
