import { describe, it, expect } from "vitest";
import { deriveDocumentBadges } from "../derive-document-badges";

const base = {
  documentStatus: "ISSUED",
  isReBilled: false,
  settlementStatus: "UNPAID",
  originalTotalCents: 60000,
  activeNotes: [] as { docType: "credit_note" | "debit_note"; amountCents: number }[],
};

describe("deriveDocumentBadges", () => {
  it("unadjusted unpaid → UNPAID / NONE / adjusted = original", () => {
    expect(deriveDocumentBadges(base)).toMatchObject({
      paymentStatus: "UNPAID",
      adjustmentStatus: "NONE",
      adjustedCents: 60000,
      lifecycle: "ISSUED",
    });
  });

  it("payment status is REUSED from settlementStatus (SST-exclusive, already correct) — no re-derivation", () => {
    expect(deriveDocumentBadges({ ...base, settlementStatus: "PARTIALLY_PAID" }).paymentStatus).toBe("PARTIALLY_PAID");
    expect(deriveDocumentBadges({ ...base, settlementStatus: "PAID" }).paymentStatus).toBe("PAID");
    expect(deriveDocumentBadges({ ...base, settlementStatus: "OVERPAID" }).paymentStatus).toBe("OVERPAID");
  });

  it("SST-bearing invoice fully PAID → PAID (regression: must NOT read Part-paid from an incl/excl mismatch)", () => {
    // Owner mgmt fee: base 100 + 8% SST = 108 total (incl). settlementStatus is charge-basis (excl) = PAID.
    expect(
      deriveDocumentBadges({ ...base, settlementStatus: "PAID", originalTotalCents: 10800 }).paymentStatus,
    ).toBe("PAID");
  });

  it("FULLY credited (charge-backed CN nets the bill to 0) → FULLY_CREDITED, overriding settlementStatus", () => {
    const r = deriveDocumentBadges({
      ...base,
      settlementStatus: "UNPAID",
      activeNotes: [{ docType: "credit_note", amountCents: 60000 }], // full CN → adjusted 0
    });
    expect(r.paymentStatus).toBe("FULLY_CREDITED");
    expect(r.adjustmentStatus).toBe("FULLY_CREDITED");
    expect(r.adjustedCents).toBe(0);
  });

  it("PARTIALLY credited multi-charge invoice (adjusted > 0) → NOT fully credited; reuses settlementStatus (NEW-1 regression)", () => {
    // RM200 grouped invoice, only the RM100 charge credited → adjusted 100 ≠ 0. Legacy `offset` is set on the
    // whole doc when ANY charge is credited, so it must NOT be the FULLY_CREDITED trigger — adjustedCents is.
    const r = deriveDocumentBadges({
      ...base,
      originalTotalCents: 20000,
      settlementStatus: "UNPAID",
      activeNotes: [{ docType: "credit_note", amountCents: 10000 }],
    });
    expect(r.paymentStatus).toBe("UNPAID"); // NOT FULLY_CREDITED — RM100 still owed
    expect(r.adjustmentStatus).toBe("CREDIT_NOTE_ISSUED");
    expect(r.adjustedCents).toBe(10000);
  });

  it("full credit note on an SST invoice → FULLY_CREDITED + adjusted 0 on the SST-INCLUSIVE display basis", () => {
    // originalTotalCents 10800 (incl), charge-backed CN note total 10800 (incl) → adjusted 0 → FULLY_CREDITED.
    const r = deriveDocumentBadges({
      ...base,
      settlementStatus: "UNPAID",
      originalTotalCents: 10800,
      activeNotes: [{ docType: "credit_note", amountCents: 10800 }],
    });
    expect(r.paymentStatus).toBe("FULLY_CREDITED");
    expect(r.adjustedCents).toBe(0);
    expect(r.creditNoteCents).toBe(10800);
  });

  it("debit note (charge-backed) → DEBIT_NOTE_ISSUED, adjusted = original + DN", () => {
    const r = deriveDocumentBadges({ ...base, activeNotes: [{ docType: "debit_note", amountCents: 10000 }] });
    expect(r).toMatchObject({ paymentStatus: "UNPAID", adjustmentStatus: "DEBIT_NOTE_ISSUED", adjustedCents: 70000 });
  });

  it("partial credit note (charge-backed) → CREDIT_NOTE_ISSUED, adjusted reduced", () => {
    const r = deriveDocumentBadges({ ...base, activeNotes: [{ docType: "credit_note", amountCents: 10000 }] });
    expect(r).toMatchObject({ adjustmentStatus: "CREDIT_NOTE_ISSUED", adjustedCents: 50000 });
  });

  it("both CN and DN charge-backed → CREDIT_AND_DEBIT_NOTES_ISSUED, adjusted nets", () => {
    const r = deriveDocumentBadges({
      ...base,
      activeNotes: [
        { docType: "credit_note", amountCents: 5000 },
        { docType: "debit_note", amountCents: 5000 },
      ],
    });
    expect(r.adjustmentStatus).toBe("CREDIT_AND_DEBIT_NOTES_ISSUED");
    expect(r.adjustedCents).toBe(60000);
  });

  it("NO active notes (overpayment CN excluded by the caller) → adjustment NONE, adjusted = original", () => {
    // The caller passes only charge-backed notes; an invoice carrying only an overpayment CN
    // arrives here with activeNotes=[], so it is NOT reduced and NOT badged.
    const r = deriveDocumentBadges({ ...base, activeNotes: [] });
    expect(r.adjustmentStatus).toBe("NONE");
    expect(r.adjustedCents).toBe(60000);
  });

  it("re-Billed original → lifecycle CANCELLED", () => {
    expect(deriveDocumentBadges({ ...base, documentStatus: "CANCELLED", isReBilled: true }).lifecycle).toBe("CANCELLED");
  });

  it("unknown documentStatus → ISSUED, never throws; unknown settlementStatus → UNPAID", () => {
    expect(deriveDocumentBadges({ ...base, documentStatus: "WAT" }).lifecycle).toBe("ISSUED");
    expect(deriveDocumentBadges({ ...base, settlementStatus: "???" }).paymentStatus).toBe("UNPAID");
  });
});
