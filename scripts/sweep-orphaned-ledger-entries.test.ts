import { describe, it, expect } from "vitest";
import { isOrphan, guardsSatisfied } from "./sweep-orphaned-ledger-entries";

describe("isOrphan", () => {
  // Mirrors the Task-9 reverse-pass dead-source predicate in
  // owner-ledger.sync.ts EXACTLY:
  //   (sourceChargeId && deadCharge.has(sourceChargeId)) ||
  //   (sourceInvoiceId && deadInvoice.has(sourceInvoiceId)) ||
  //   (sourceUtilityBillId && deadBill.has(sourceUtilityBillId))

  it("flags a row whose sourceChargeId is in the dead-charge set", () => {
    const dead = { charge: new Set(["c1"]), invoice: new Set<string>(), bill: new Set<string>() };
    expect(isOrphan({ sourceChargeId: "c1", sourceInvoiceId: null, sourceUtilityBillId: null }, dead)).toBe(true);
  });

  it("flags a row whose sourceInvoiceId is in the dead-invoice set", () => {
    const dead = { charge: new Set<string>(), invoice: new Set(["i1"]), bill: new Set<string>() };
    expect(isOrphan({ sourceChargeId: null, sourceInvoiceId: "i1", sourceUtilityBillId: null }, dead)).toBe(true);
  });

  it("flags a row whose sourceUtilityBillId is in the dead-bill set", () => {
    const dead = { charge: new Set<string>(), invoice: new Set<string>(), bill: new Set(["b1"]) };
    expect(isOrphan({ sourceChargeId: null, sourceInvoiceId: null, sourceUtilityBillId: "b1" }, dead)).toBe(true);
  });

  it("does not flag a row whose source ids are all null (no source link)", () => {
    const dead = { charge: new Set(["c1"]), invoice: new Set(["i1"]), bill: new Set(["b1"]) };
    expect(isOrphan({ sourceChargeId: null, sourceInvoiceId: null, sourceUtilityBillId: null }, dead)).toBe(false);
  });

  it("does not flag a row whose source id is present but NOT in the dead set (source still alive)", () => {
    const dead = { charge: new Set(["c-other"]), invoice: new Set<string>(), bill: new Set<string>() };
    expect(isOrphan({ sourceChargeId: "c1", sourceInvoiceId: null, sourceUtilityBillId: null }, dead)).toBe(false);
  });

  it("flags a row when ANY one of the three source links is dead, even if others are alive/null", () => {
    const dead = { charge: new Set<string>(), invoice: new Set(["i-dead"]), bill: new Set<string>() };
    expect(
      isOrphan({ sourceChargeId: "c-alive", sourceInvoiceId: "i-dead", sourceUtilityBillId: null }, dead),
    ).toBe(true);
  });
});

describe("guardsSatisfied (double-guard idiom)", () => {
  it("is false with no flag and no env (dry-run default)", () => {
    expect(guardsSatisfied([], {})).toBe(false);
  });

  it("is false with --apply flag but WITHOUT CLEANUP_CONFIRM=yes", () => {
    expect(guardsSatisfied(["--apply"], {})).toBe(false);
  });

  it("is false with CLEANUP_CONFIRM=yes but WITHOUT the --apply flag", () => {
    expect(guardsSatisfied([], { CLEANUP_CONFIRM: "yes" })).toBe(false);
  });

  it("is false when CLEANUP_CONFIRM is set to something other than the literal 'yes'", () => {
    expect(guardsSatisfied(["--apply"], { CLEANUP_CONFIRM: "true" })).toBe(false);
    expect(guardsSatisfied(["--apply"], { CLEANUP_CONFIRM: "1" })).toBe(false);
  });

  it("is true only when BOTH --apply AND CLEANUP_CONFIRM=yes are present", () => {
    expect(guardsSatisfied(["--apply"], { CLEANUP_CONFIRM: "yes" })).toBe(true);
  });
});
