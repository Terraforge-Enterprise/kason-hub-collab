import { describe, it, expect } from "vitest";
import { foldTaxLines, type TaxFoldableLine } from "../fold-tax-lines";

type Line = TaxFoldableLine & { amount: string; sstAmount: string };

const line = (o: Partial<Line> & Pick<Line, "id">): Line => ({
  chargeId: o.id,
  isTax: false,
  taxParentChargeId: null,
  amount: "0.00",
  sstAmount: "0.00",
  paid: "0.00",
  outstanding: "0.00",
  ...o,
});

const sum = (values: string[]) =>
  (values.reduce((c, v) => c + Math.round(Number(v) * 100), 0) / 100).toFixed(2);

/**
 * The reported invoice, verbatim from UAT IVOWN-0013 — an owner-borne grid expense
 * of RM 1.00 @ 8% (SST sibling RM 0.08) plus a RM 0.80 cleaning expense.
 * Document totals: subtotal 1.80, sstAmount 0.08, total 1.88, balance 1.88.
 */
const IVOWN_0013: Line[] = [
  line({ id: "base", amount: "1.00", sstAmount: "0.08", outstanding: "1.00" }),
  line({ id: "tax", isTax: true, taxParentChargeId: "base", amount: "0.08", outstanding: "0.08" }),
  line({ id: "cleaning", amount: "0.80", outstanding: "0.80" }),
];

describe("foldTaxLines — the invoice must foot by eye", () => {
  it("collapses the SST sibling so the Amount column sums to SUBTOTAL, not TOTAL", () => {
    const folded = foldTaxLines(IVOWN_0013);

    expect(folded.map((l) => l.id)).toEqual(["base", "cleaning"]);
    // BEFORE the fold the Amount column summed to 1.88 while the document printed
    // Subtotal 1.80 underneath — the whole complaint.
    expect(sum(IVOWN_0013.map((l) => l.amount))).toBe("1.88");
    expect(sum(folded.map((l) => l.amount))).toBe("1.80");
    // …and the RM 0.08 is now shown exactly once, in the base line's SST column.
    expect(sum(folded.map((l) => l.sstAmount))).toBe("0.08");
  });

  it("merges the tax line's outstanding into its base, so Σ(Outstanding) === balance", () => {
    const folded = foldTaxLines(IVOWN_0013);

    expect(folded.find((l) => l.id === "base")!.outstanding).toBe("1.08");
    expect(sum(folded.map((l) => l.outstanding!))).toBe("1.88");
  });

  it("merges paid the same way", () => {
    const folded = foldTaxLines([
      line({ id: "base", amount: "1.00", paid: "1.00", outstanding: "0.00" }),
      line({ id: "tax", isTax: true, taxParentChargeId: "base", amount: "0.08", paid: "0.08", outstanding: "0.00" }),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0].paid).toBe("1.08");
  });
});

describe("foldTaxLines — money never disappears from view", () => {
  it("keeps an ORPHAN tax line whose base is not on this document", () => {
    const folded = foldTaxLines([
      line({ id: "tax", isTax: true, taxParentChargeId: "base-on-another-doc", amount: "0.08", outstanding: "0.08" }),
      line({ id: "cleaning", amount: "0.80", outstanding: "0.80" }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["tax", "cleaning"]);
  });

  it("keeps a tax line whose parent link was never written", () => {
    const folded = foldTaxLines([
      line({ id: "base", amount: "1.00" }),
      line({ id: "tax", isTax: true, taxParentChargeId: null, amount: "0.08" }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["base", "tax"]);
  });

  it("keeps the tax line when only the BASE carries adjustments — a note minted before the sibling mirror existed", () => {
    // Historically this was EVERY adjusted charge: crediting a base did not credit its
    // SST sibling, so the sibling stayed posted and payable while the base read
    // Adjusted 0.00 — folding left an unexplained 0.08 on screen.
    // charge-adjustment.service.ts now mirrors the note onto the sibling, so this
    // shape only survives in rows written before that fix (or whose sibling was
    // voided). It must still stay visible for exactly the original reason.
    const folded = foldTaxLines([
      line({
        id: "base",
        amount: "1.00",
        outstanding: "0.00",
        adjustments: [{ noteId: "cn1" }],
      }),
      line({ id: "tax", isTax: true, taxParentChargeId: "base", amount: "0.08", outstanding: "0.08" }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["base", "tax"]);
  });

  it("FOLDS when base and tax are adjusted IN STEP — the mirrored note keeps them consistent", () => {
    // The shape charge-adjustment.service.ts now produces: one note carrying a line
    // for the base AND a mirrored isTax line for its `-SST` sibling. The pair moved
    // together, so the folded row tells the whole truth and the reader gets ONE line
    // per cost again — the reported "adding a note splits the SST onto its own row".
    const folded = foldTaxLines([
      line({
        id: "base",
        amount: "1.00",
        paid: "0.00",
        outstanding: "0.50",
        adjustments: [{ noteId: "cn1" }],
      }),
      line({
        id: "tax",
        isTax: true,
        taxParentChargeId: "base",
        amount: "0.08",
        paid: "0.00",
        outstanding: "0.04",
        adjustments: [{ noteId: "cn1" }],
      }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["base"]);
    // 0.50 base + 0.04 sibling — what the tenant actually owes, on one row.
    expect(folded[0]!.outstanding).toBe("0.54");
  });

  it("keeps the tax line when the BASE cannot receive the merge — never drop money to fold", () => {
    // Review finding: `foldedAway.add` used to be unconditional once a base was found,
    // while the merge back was gated on the BASE's own field being present. A caller
    // whose base line omits settlement fields (a partial projection, a future export
    // mapper) removed the tax row AND discarded its money.
    const folded = foldTaxLines([
      { id: "base", chargeId: "base", isTax: false, taxParentChargeId: null, amount: "1.00" },
      {
        id: "tax", chargeId: "tax", isTax: true, taxParentChargeId: "base", amount: "0.08",
        paid: "0.00", outstanding: "0.08",
      },
    ]);
    expect(folded.map((l) => l.id)).toEqual(["base", "tax"]);
  });

  it("keeps a tax line carrying its OWN adjustments — hiding it would hide the note", () => {
    const folded = foldTaxLines([
      line({ id: "base", amount: "1.00", outstanding: "1.00" }),
      line({
        id: "tax",
        isTax: true,
        taxParentChargeId: "base",
        amount: "0.08",
        outstanding: "0.08",
        adjustments: [{ noteId: "cn1" }],
      }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["base", "tax"]);
    // The base keeps its own outstanding — nothing was merged in.
    expect(folded.find((l) => l.id === "base")!.outstanding).toBe("1.00");
  });
});

describe("foldTaxLines — contract", () => {
  it("returns an equivalent copy when the document has no tax line", () => {
    const input = [line({ id: "a", amount: "10.00" }), line({ id: "b", amount: "20.00" })];
    const out = foldTaxLines(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("never mutates its input", () => {
    const input = structuredClone(IVOWN_0013);
    foldTaxLines(input);
    expect(input).toEqual(IVOWN_0013);
  });

  it("drops the tax line without crashing when settlement fields are absent (the PDF shape)", () => {
    const pdfShape = [
      { id: "base", chargeId: "base", isTax: false, taxParentChargeId: null, amount: "1.00" },
      { id: "tax", chargeId: "tax", isTax: true, taxParentChargeId: "base", amount: "0.08" },
    ];
    expect(foldTaxLines(pdfShape).map((l) => l.id)).toEqual(["base"]);
  });

  it("merges in integer cents — no float drift", () => {
    const folded = foldTaxLines([
      line({ id: "base", paid: "0.10", outstanding: "0.20" }),
      line({ id: "tax", isTax: true, taxParentChargeId: "base", paid: "0.20", outstanding: "0.10" }),
    ]);
    // 0.1 + 0.2 === 0.30000000000000004 in floating point.
    expect(folded[0].paid).toBe("0.30");
    expect(folded[0].outstanding).toBe("0.30");
  });

  it("folds several tax siblings on one document, each into its own base", () => {
    const folded = foldTaxLines([
      line({ id: "b1", amount: "100.00", outstanding: "100.00" }),
      line({ id: "t1", isTax: true, taxParentChargeId: "b1", amount: "8.00", outstanding: "8.00" }),
      line({ id: "b2", amount: "50.00", outstanding: "50.00" }),
      line({ id: "t2", isTax: true, taxParentChargeId: "b2", amount: "4.00", outstanding: "4.00" }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["b1", "b2"]);
    expect(folded.map((l) => l.outstanding)).toEqual(["108.00", "54.00"]);
  });

  it("preserves the order of the surviving lines", () => {
    const folded = foldTaxLines([
      line({ id: "first", amount: "1.00" }),
      line({ id: "tax", isTax: true, taxParentChargeId: "last", amount: "0.08" }),
      line({ id: "last", amount: "2.00" }),
    ]);
    expect(folded.map((l) => l.id)).toEqual(["first", "last"]);
  });
});
