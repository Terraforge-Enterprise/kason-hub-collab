import { describe, it, expect } from "vitest";
import { foldPayableTaxSiblings, type FoldablePayableCharge } from "../fold-payable-tax-siblings";

type Row = FoldablePayableCharge & {
  chargeNumber: string;
  description: string | null;
  debitNoteTotal?: number;
  creditNoteTotal?: number;
  adjustedAmount?: number;
};

const row = (o: Partial<Row> & Pick<Row, "id">): Row => ({
  parentChargeId: null,
  isTax: false,
  amount: 0,
  outstandingAmount: 0,
  pendingVerification: false,
  chargeNumber: o.id,
  description: null,
  ...o,
});

const sum = (values: number[]) => values.reduce((c, v) => c + Math.round(v * 100), 0) / 100;

/**
 * The reported basket, verbatim from UAT IVTEN-0002 — a tenant-borne grid expense of
 * RM 0.50 @ 8% (SST sibling RM 0.04) alongside the month's other carve-outs. The
 * complaint was that the pay screen listed the RM 0.04 as its own bill.
 */
const IVTEN_0002: Row[] = [
  row({ id: "elec", chargeNumber: "GRIDUTIL-202608-ELECTRICITY", amount: 0.2, outstandingAmount: 0.2 }),
  row({ id: "expNoSst", chargeNumber: "GRIDEXP-202608-nosst", amount: 0.05, outstandingAmount: 0.05 }),
  row({ id: "expSst", chargeNumber: "GRIDEXP-202608-sst", amount: 0.5, outstandingAmount: 0.5 }),
  row({
    id: "expSstTax", chargeNumber: "GRIDEXP-202608-sst-SST", isTax: true, parentChargeId: "expSst",
    description: "test ten exp sst — SST 8%", amount: 0.04, outstandingAmount: 0.04,
  }),
];

describe("foldPayableTaxSiblings — one bill per thing the tenant recognises", () => {
  it("folds the SST sibling into its base so the row reads RM 0.54", () => {
    const folded = foldPayableTaxSiblings(IVTEN_0002);

    expect(folded.map((r) => r.id)).toEqual(["elec", "expNoSst", "expSst"]);
    const sst = folded.find((r) => r.id === "expSst")!;
    expect(sst.outstandingAmount).toBe(0.54);
    expect(sst.amount).toBe(0.54);
    // Total owed is unchanged by folding — only the row count is.
    expect(sum(folded.map((r) => r.outstandingAmount))).toBe(sum(IVTEN_0002.map((r) => r.outstandingAmount)));
  });

  it("carries BOTH charge ids as allocation components, base first", () => {
    const sst = foldPayableTaxSiblings(IVTEN_0002).find((r) => r.id === "expSst")!;

    expect(sst.components).toEqual([
      { chargeId: "expSst", outstandingAmount: 0.5 },
      { chargeId: "expSstTax", outstandingAmount: 0.04 },
    ]);
    // The validator demands each allocation equal that charge's OWN outstanding
    // exactly (ALLOC_BELOW/EXCEEDS_OUTSTANDING), so the components must never be
    // the merged figure — and together they must equal the row the tenant ticked.
    expect(sum(sst.components.map((k) => k.outstandingAmount))).toBe(sst.outstandingAmount);
  });

  it("gives every unfolded row a single self-component", () => {
    const elec = foldPayableTaxSiblings(IVTEN_0002).find((r) => r.id === "elec")!;
    expect(elec.components).toEqual([{ chargeId: "elec", outstandingAmount: 0.2 }]);
  });

  it("returns an equivalent copy when nothing is tax, without mutating the input", () => {
    const plain = [row({ id: "a", amount: 1, outstandingAmount: 1 })];
    const folded = foldPayableTaxSiblings(plain);

    expect(folded).toHaveLength(1);
    expect(folded[0].outstandingAmount).toBe(1);
    expect(folded[0].components).toEqual([{ chargeId: "a", outstandingAmount: 1 }]);
    expect(plain[0]).not.toHaveProperty("components");
  });

  // ─── SAFETY: money never disappears from view ──────────────────────────────
  //
  // Same contract as foldTaxLines. A row the tenant cannot see is worse than a
  // row they cannot immediately explain — an invisible charge is one they never
  // pay, and the document never reaches settled.

  it("keeps an ORPHAN tax row visible when its base is not in the basket", () => {
    // Base already paid (so absent from the payable list) while the tax sibling
    // still holds a live receivable — the pre-fold production state.
    const folded = foldPayableTaxSiblings([
      row({ id: "tax", isTax: true, parentChargeId: "paidBase", amount: 0.04, outstandingAmount: 0.04 }),
    ]);

    expect(folded.map((r) => r.id)).toEqual(["tax"]);
    expect(folded[0].outstandingAmount).toBe(0.04);
    expect(folded[0].components).toEqual([{ chargeId: "tax", outstandingAmount: 0.04 }]);
  });

  it("keeps a tax row visible when its parent link was never written", () => {
    const folded = foldPayableTaxSiblings([
      row({ id: "base", amount: 0.5, outstandingAmount: 0.5 }),
      row({ id: "tax", isTax: true, parentChargeId: null, amount: 0.04, outstandingAmount: 0.04 }),
    ]);

    expect(folded.map((r) => r.id)).toEqual(["base", "tax"]);
  });

  it("refuses to fold a tax row into another TAX row", () => {
    // Tax is not taxed again (the sibling is minted with sstRate "0"), so this
    // shape means the parent link points somewhere unexpected. Fail visible.
    const folded = foldPayableTaxSiblings([
      row({ id: "taxA", isTax: true, parentChargeId: "missing", amount: 0.04, outstandingAmount: 0.04 }),
      row({ id: "taxB", isTax: true, parentChargeId: "taxA", amount: 0.01, outstandingAmount: 0.01 }),
    ]);

    expect(folded.map((r) => r.id)).toEqual(["taxA", "taxB"]);
  });

  it("folds every sibling of a base that somehow carries two", () => {
    const folded = foldPayableTaxSiblings([
      row({ id: "base", amount: 1, outstandingAmount: 1 }),
      row({ id: "t1", isTax: true, parentChargeId: "base", amount: 0.05, outstandingAmount: 0.05 }),
      row({ id: "t2", isTax: true, parentChargeId: "base", amount: 0.03, outstandingAmount: 0.03 }),
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0].outstandingAmount).toBe(1.08);
    expect(folded[0].components.map((k) => k.chargeId)).toEqual(["base", "t1", "t2"]);
  });

  // ─── pendingVerification is OR, never AND ─────────────────────────────────

  it("marks the folded row pending when EITHER half awaits verification", () => {
    const baseOnly = foldPayableTaxSiblings([
      row({ id: "base", amount: 0.5, outstandingAmount: 0.5, pendingVerification: true }),
      row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.04, outstandingAmount: 0.04 }),
    ]);
    expect(baseOnly[0].pendingVerification).toBe(true);

    // The half-claimed case that matters most: a slip already claims the SST.
    // Presenting the merged row as freely payable would invite the tenant to pay
    // 0.54 again, and the validator rejects the WHOLE basket with a 409.
    const taxOnly = foldPayableTaxSiblings([
      row({ id: "base", amount: 0.5, outstandingAmount: 0.5 }),
      row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.04, outstandingAmount: 0.04, pendingVerification: true }),
    ]);
    expect(taxOnly[0].pendingVerification).toBe(true);
  });

  // ─── cent math ────────────────────────────────────────────────────────────

  it("merges in integer cents, so no float residue reaches the allocation", () => {
    const folded = foldPayableTaxSiblings([
      row({ id: "base", amount: 0.1, outstandingAmount: 0.1 }),
      row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.2, outstandingAmount: 0.2 }),
    ]);
    // 0.1 + 0.2 in floats is 0.30000000000000004, which fails the schema's
    // /^\d+(\.\d{1,2})?$/ on the way out as a string.
    expect(folded[0].outstandingAmount).toBe(0.3);
    expect(folded[0].outstandingAmount.toFixed(2)).toBe("0.30");
  });

  // ─── alsoMerge: surfaces with their own money columns ─────────────────────
  //
  // The Charges page and Billing → Invoices tab carry per-charge CN/DN columns.
  // `createChargeAdjustmentService` MIRRORS every note onto the SST sibling, so the
  // sibling holds its own share of the credit — fold without merging those and the
  // Total column silently understates the credit note.

  it("merges the named extra money fields alongside amount and outstanding", () => {
    // UAT IVTEN-0002 line 7: base 1.00 credited 0.50; sibling 0.08 credited 0.04.
    const folded = foldPayableTaxSiblings(
      [
        row({ id: "base", amount: 1, outstandingAmount: 0.5, creditNoteTotal: 0.5, debitNoteTotal: 0, adjustedAmount: 0.5 }),
        row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.08, outstandingAmount: 0.04, creditNoteTotal: 0.04, debitNoteTotal: 0, adjustedAmount: 0.04 }),
      ],
      { alsoMerge: ["debitNoteTotal", "creditNoteTotal", "adjustedAmount"] },
    );

    expect(folded).toHaveLength(1);
    expect(folded[0].amount).toBe(1.08);
    expect(folded[0].creditNoteTotal).toBe(0.54);
    expect(folded[0].debitNoteTotal).toBe(0);
    expect(folded[0].adjustedAmount).toBe(0.54);
    // The invariant the column has to satisfy by eye: adjusted = amount + DN − CN.
    expect(folded[0].adjustedAmount).toBe(folded[0].amount + folded[0].debitNoteTotal! - folded[0].creditNoteTotal!);
    expect(folded[0].outstandingAmount).toBe(0.54);
  });

  it("leaves amount and outstanding merged when alsoMerge is omitted", () => {
    // Regression guard: the pay screen passes no options and must be unchanged.
    const folded = foldPayableTaxSiblings([
      row({ id: "base", amount: 1, outstandingAmount: 0.5, creditNoteTotal: 0.5 }),
      row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.08, outstandingAmount: 0.04, creditNoteTotal: 0.04 }),
    ]);
    expect(folded[0].amount).toBe(1.08);
    expect(folded[0].outstandingAmount).toBe(0.54);
    // Untouched, because the caller did not ask for it.
    expect(folded[0].creditNoteTotal).toBe(0.5);
  });

  it("skips a named field the base does not carry, rather than inventing a zero", () => {
    // These DTO fields are optional (an older API omits them). A projection with no
    // adjustedAmount must come back with no adjustedAmount, not 0.
    const folded = foldPayableTaxSiblings(
      [
        row({ id: "base", amount: 1, outstandingAmount: 1 }),
        row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.08, outstandingAmount: 0.08 }),
      ],
      { alsoMerge: ["adjustedAmount"] },
    );
    expect(folded[0]).not.toHaveProperty("adjustedAmount");
    expect(folded[0].amount).toBe(1.08);
  });

  it("merges the extra fields in integer cents too", () => {
    const folded = foldPayableTaxSiblings(
      [
        row({ id: "base", amount: 1, outstandingAmount: 1, creditNoteTotal: 0.1 }),
        row({ id: "tax", isTax: true, parentChargeId: "base", amount: 0.08, outstandingAmount: 0.08, creditNoteTotal: 0.2 }),
      ],
      { alsoMerge: ["creditNoteTotal"] },
    );
    expect(folded[0].creditNoteTotal).toBe(0.3);
  });

  it("preserves the base row's identity fields, not the sibling's", () => {
    const sst = foldPayableTaxSiblings(IVTEN_0002).find((r) => r.id === "expSst")!;
    expect(sst.chargeNumber).toBe("GRIDEXP-202608-sst");
    expect(sst.description).toBeNull();
    expect(sst.isTax).toBe(false);
  });
});
