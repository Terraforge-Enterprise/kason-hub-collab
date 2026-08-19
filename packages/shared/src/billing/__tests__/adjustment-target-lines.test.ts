import { describe, it, expect } from "vitest";
import { adjustmentTargetLines, type AdjustmentTargetLine } from "../adjustment-target-lines";

type Line = AdjustmentTargetLine & { id: string; description: string };

const line = (o: Partial<Line> & Pick<Line, "id">): Line => ({
  chargeId: o.id,
  isTax: false,
  taxParentChargeId: null,
  sstRate: "0",
  description: o.id,
  ...o,
});

/**
 * The reported document, verbatim from UAT IVTEN-0002 (2026-08-17) — four owner-borne
 * grid expenses, one of which (RM 1.00 @ 8%) carries an SST sibling. The picker
 * offered that sibling as a fifth choice, "test own exp sst — SST 8% — RM 0.08".
 */
const IVTEN_0002: Line[] = [
  line({ id: "maintenance", description: "Maintenance 202608" }),
  line({ id: "recurring", description: "test recc owner 202608" }),
  line({ id: "sst-base", description: "test own exp sst", sstRate: "8" }),
  line({ id: "sst-tax", description: "test own exp sst — SST 8%", isTax: true, taxParentChargeId: "sst-base" }),
  line({ id: "water", description: "test own exp no sst" }),
];

describe("adjustmentTargetLines — the SST sibling is not a separate thing to credit", () => {
  it("drops the tax sibling of a base line on the same document", () => {
    const targets = adjustmentTargetLines(IVTEN_0002);

    expect(targets.map((l) => l.id)).toEqual(["maintenance", "recurring", "sst-base", "water"]);
    // The row the operator was being invited to double-credit.
    expect(targets.some((l) => l.description.includes("SST 8%"))).toBe(false);
  });

  it("keeps the base itself — crediting it is what moves the tax", () => {
    expect(adjustmentTargetLines(IVTEN_0002).map((l) => l.chargeId)).toContain("sst-base");
  });

  it("a document with no tax line comes back with every charge-backed line", () => {
    const plain = [line({ id: "rent" }), line({ id: "water" })];
    expect(adjustmentTargetLines(plain)).toEqual(plain);
  });
});

describe("adjustmentTargetLines — a tax line no mirror can reach stays adjustable", () => {
  it("ORPHAN: the base line is on a DIFFERENT document, so nothing else will ever relieve it", () => {
    // findTaxSibling only looks within one document — an orphan tax charge is
    // unreachable by any base adjustment and must stay directly pickable.
    const orphan = [line({ id: "tax", isTax: true, taxParentChargeId: "base-elsewhere" })];
    expect(adjustmentTargetLines(orphan).map((l) => l.id)).toEqual(["tax"]);
  });

  it("no parent link at all — nothing pairs it with a base, so it stays", () => {
    const unlinked = [line({ id: "base", sstRate: "8" }), line({ id: "tax", isTax: true })];
    expect(adjustmentTargetLines(unlinked).map((l) => l.id)).toEqual(["base", "tax"]);
  });

  it("ZERO-RATE base: taxSiblingMirror is a no-op there, so hiding the sibling would strand it", () => {
    const zeroRate = [
      line({ id: "base", sstRate: "0" }),
      line({ id: "tax", isTax: true, taxParentChargeId: "base" }),
    ];
    expect(adjustmentTargetLines(zeroRate).map((l) => l.id)).toEqual(["base", "tax"]);
  });

  it("FAIL OPEN: an unparseable base rate keeps the sibling offered", () => {
    const junk = [
      line({ id: "base", sstRate: "n/a" }),
      line({ id: "tax", isTax: true, taxParentChargeId: "base" }),
    ];
    expect(adjustmentTargetLines(junk).map((l) => l.id)).toEqual(["base", "tax"]);
  });
});

describe("adjustmentTargetLines — contract", () => {
  it("drops charge-less lines (overpayment CN) — the endpoint is charge-scoped", () => {
    const withOverpayment = [line({ id: "rent" }), line({ id: "credit", chargeId: null })];
    expect(adjustmentTargetLines(withOverpayment).map((l) => l.id)).toEqual(["rent"]);
  });

  it("never mutates its input", () => {
    const input = [...IVTEN_0002];
    const snapshot = JSON.stringify(input);
    adjustmentTargetLines(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toHaveLength(5);
  });

  it("a base itemised across several lines (meter path) takes its rate from the first", () => {
    // Mirrors foldTaxLines' first-wins tie-break, so the two agree on which base
    // line speaks for a charge.
    const split = [
      line({ id: "meter-a", chargeId: "meter", sstRate: "8" }),
      line({ id: "meter-b", chargeId: "meter", sstRate: "0" }),
      line({ id: "tax", isTax: true, taxParentChargeId: "meter" }),
    ];
    expect(adjustmentTargetLines(split).map((l) => l.id)).toEqual(["meter-a", "meter-b"]);
  });
});
