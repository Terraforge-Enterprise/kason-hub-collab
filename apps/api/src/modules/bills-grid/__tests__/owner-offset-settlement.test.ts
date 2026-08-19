/**
 * The two PURE rules that decide whether a re-Bill may destroy an owner's settled
 * invoice. Pinned without a database because they are money rules, not plumbing.
 */
import { describe, it, expect } from "vitest";
import { docsSafeToCancel } from "../owner-offset-settlement";
import { netOwnerOffsetByChargeId } from "../../owner-remittance/owner-offset-reader";

const doc = (id: string, docType: string) => ({ id, docType });
const charge = (id: string, documentId: string | null) => ({ id, documentId });

describe("netOwnerOffsetByChargeId", () => {
  const A = { chargeId: "c1", allocatedAmountC: 129, offsetEntryId: "e1" };

  it("counts an allocation whose offset entry is active and unreversed — in RINGGIT", () => {
    const out = netOwnerOffsetByChargeId({
      allocations: [A],
      activeOffsetEntryIds: new Set(["e1"]),
      reversedOffsetEntryIds: new Set(),
    });
    expect(out.get("c1")).toBe(1.29);
  });

  it("ignores an allocation whose offset entry is not active", () => {
    const out = netOwnerOffsetByChargeId({
      allocations: [A],
      activeOffsetEntryIds: new Set(),
      reversedOffsetEntryIds: new Set(),
    });
    expect(out.size).toBe(0);
  });

  it("ignores a REVERSED offset even though its entry is still active", () => {
    // reverseOffsetService appends a reversal row and leaves the original `active` — the
    // exact reason entry status alone cannot answer "is this still settled".
    const out = netOwnerOffsetByChargeId({
      allocations: [A],
      activeOffsetEntryIds: new Set(["e1"]),
      reversedOffsetEntryIds: new Set(["e1"]),
    });
    expect(out.size).toBe(0);
  });

  it("sums several offsets against one charge in cents before converting once", () => {
    const out = netOwnerOffsetByChargeId({
      allocations: [
        { chargeId: "c1", allocatedAmountC: 1, offsetEntryId: "e1" },
        { chargeId: "c1", allocatedAmountC: 1, offsetEntryId: "e2" },
        { chargeId: "c1", allocatedAmountC: 1, offsetEntryId: "e3" },
      ],
      activeOffsetEntryIds: new Set(["e1", "e2", "e3"]),
      reversedOffsetEntryIds: new Set(),
    });
    expect(out.get("c1")).toBe(0.03);
  });

  it("drops a reversed entry while keeping the live one on the same charge", () => {
    const out = netOwnerOffsetByChargeId({
      allocations: [
        { chargeId: "c1", allocatedAmountC: 100, offsetEntryId: "e1" },
        { chargeId: "c1", allocatedAmountC: 29, offsetEntryId: "e2" },
      ],
      activeOffsetEntryIds: new Set(["e1", "e2"]),
      reversedOffsetEntryIds: new Set(["e1"]),
    });
    expect(out.get("c1")).toBe(0.29);
  });
});

describe("docsSafeToCancel", () => {
  it("KEEPS an invoice that still carries a protected (settled) charge", () => {
    const ivown = doc("d-own", "invoice");
    const r = docsSafeToCancel({
      docs: [ivown],
      charges: [charge("c1", "d-own")],
      protectedChargeIds: new Set(["c1"]),
    });
    expect(r.kept).toEqual([ivown]);
    expect(r.cancel).toEqual([]);
  });

  it("CANCELS an invoice whose charges are all being replaced", () => {
    const ivown = doc("d-own", "invoice");
    const r = docsSafeToCancel({
      docs: [ivown],
      charges: [charge("c1", "d-own")],
      protectedChargeIds: new Set(),
    });
    expect(r.cancel).toEqual([ivown]);
    expect(r.kept).toEqual([]);
  });

  it("KEEPS a PARTLY settled invoice — one protected line is enough to pin it", () => {
    const ivown = doc("d-own", "invoice");
    const r = docsSafeToCancel({
      docs: [ivown],
      charges: [charge("c1", "d-own"), charge("c2", "d-own")],
      protectedChargeIds: new Set(["c1"]),
    });
    expect(r.kept).toEqual([ivown]);
  });

  it("CANCELS a proforma even when it carries a paid line — a draft strands nothing", () => {
    // The tenant path: a PI must still be superseded, or the unit-month is left with two
    // live proformas and the tenant reads the stale one.
    const pi = doc("d-pi", "proforma");
    const r = docsSafeToCancel({
      docs: [pi],
      charges: [charge("c1", "d-pi")],
      protectedChargeIds: new Set(["c1"]),
    });
    expect(r.cancel).toEqual([pi]);
    expect(r.kept).toEqual([]);
  });

  it("partitions a mixed re-Bill: proforma cancelled, settled IVOWN kept", () => {
    const pi = doc("d-pi", "proforma");
    const ivown = doc("d-own", "invoice");
    const r = docsSafeToCancel({
      docs: [pi, ivown],
      charges: [charge("t1", "d-pi"), charge("o1", "d-own")],
      protectedChargeIds: new Set(["t1", "o1"]),
    });
    expect(r.cancel).toEqual([pi]);
    expect(r.kept).toEqual([ivown]);
  });

  it("KEEPS a settled owner expense advice — OEA is a document of record too", () => {
    const oea = doc("d-oea", "owner_expense_advice");
    const r = docsSafeToCancel({
      docs: [oea],
      charges: [charge("c1", "d-oea")],
      protectedChargeIds: new Set(["c1"]),
    });
    expect(r.kept).toEqual([oea]);
  });

  it("a doc-less protected charge pins nothing (flag-off shape: empty protected set)", () => {
    const ivown = doc("d-own", "invoice");
    const r = docsSafeToCancel({
      docs: [ivown],
      charges: [charge("c1", null)],
      protectedChargeIds: new Set(["c1"]),
    });
    expect(r.cancel).toEqual([ivown]);
  });
});
