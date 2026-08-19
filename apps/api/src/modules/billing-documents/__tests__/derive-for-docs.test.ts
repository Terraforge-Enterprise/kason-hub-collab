// Pure-assembly unit tests for computeBadgesForDocs — per-document active + charge-backed
// note filtering that feeds deriveDocumentBadges. No DB. Proves overpayment (charge-less)
// CNs are excluded, CANCELLED/SUPERSEDED notes are dropped, payment reuses settlementStatus,
// FULLY_CREDITED comes from the adjusted amount netting to 0 (not the legacy offset flag),
// and notes never leak across documents.
import { describe, it, expect } from "vitest";
import { computeBadgesForDocs } from "../derive-for-docs";

const doc = (
  id: string,
  over: Partial<{ documentStatus: string; supersededByDocumentId: string | null; settlementStatus: string; totalCents: number }> = {},
) => ({
  id,
  documentStatus: "ISSUED",
  supersededByDocumentId: null,
  settlementStatus: "UNPAID",
  totalCents: 10000,
  ...over,
});

const note = (
  originalDocumentId: string,
  over: Partial<{ docType: string; documentStatus: string; totalCents: number; isChargeBacked: boolean }> = {},
) => ({
  originalDocumentId,
  docType: "credit_note",
  documentStatus: "ISSUED",
  totalCents: 10000,
  isChargeBacked: true,
  ...over,
});

describe("computeBadgesForDocs", () => {
  it("fully credited by a charge-backed CN (adjusted nets to 0) → FULLY_CREDITED", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1")], notes: [note("d1")] });
    expect(out.get("d1")).toMatchObject({ paymentStatus: "FULLY_CREDITED", adjustmentStatus: "FULLY_CREDITED", adjustedCents: 0 });
  });

  it("PARTIALLY credited (adjusted > 0) → NOT fully credited; reuses settlementStatus (NEW-1 regression)", () => {
    // A RM200 grouped invoice with only its RM100 charge credited: legacy `offset` is set on the whole
    // doc, but adjusted is 100 ≠ 0, so it must NOT read FULLY_CREDITED.
    const out = computeBadgesForDocs({ docs: [doc("d1", { totalCents: 20000 })], notes: [note("d1", { totalCents: 10000 })] });
    expect(out.get("d1")).toMatchObject({ paymentStatus: "UNPAID", adjustmentStatus: "CREDIT_NOTE_ISSUED", adjustedCents: 10000 });
  });

  it("payment status is reused from settlementStatus (no re-derivation)", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1", { settlementStatus: "PARTIALLY_PAID" })], notes: [] });
    expect(out.get("d1")!.paymentStatus).toBe("PARTIALLY_PAID");
  });

  it("charge-backed credit note (partial) → CREDIT_NOTE_ISSUED, adjusted reduced", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1")], notes: [note("d1", { totalCents: 4000 })] });
    expect(out.get("d1")).toMatchObject({ adjustmentStatus: "CREDIT_NOTE_ISSUED", adjustedCents: 6000 });
  });

  it("OVERPAYMENT credit note (isChargeBacked false) is EXCLUDED — bill not reduced, not badged", () => {
    const out = computeBadgesForDocs({
      docs: [doc("d1", { settlementStatus: "PAID" })],
      notes: [note("d1", { totalCents: 5000, isChargeBacked: false })],
    });
    expect(out.get("d1")).toMatchObject({ adjustmentStatus: "NONE", adjustedCents: 10000, paymentStatus: "PAID" });
  });

  it("CANCELLED note is excluded from the adjustment", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1")], notes: [note("d1", { documentStatus: "CANCELLED" })] });
    expect(out.get("d1")).toMatchObject({ adjustmentStatus: "NONE", adjustedCents: 10000 });
  });

  it("DRAFT note is excluded (canonical allowlist ISSUED-only; previously counted by the denylist)", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1")], notes: [note("d1", { documentStatus: "DRAFT" })] });
    expect(out.get("d1")).toMatchObject({ adjustmentStatus: "NONE", adjustedCents: 10000 });
  });

  it("debit note → DEBIT_NOTE_ISSUED, adjusted raised", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1")], notes: [note("d1", { docType: "debit_note", totalCents: 5000 })] });
    expect(out.get("d1")).toMatchObject({ adjustmentStatus: "DEBIT_NOTE_ISSUED", adjustedCents: 15000 });
  });

  it("does NOT leak notes across documents in one batch", () => {
    const out = computeBadgesForDocs({ docs: [doc("d1"), doc("d2")], notes: [note("d1")] });
    expect(out.get("d1")!.adjustmentStatus).toBe("FULLY_CREDITED");
    expect(out.get("d2")!.adjustmentStatus).toBe("NONE");
    expect(out.get("d2")!.adjustedCents).toBe(10000);
  });

  it("re-Billed original (CANCELLED + supersededByDocumentId) → isReBilled true, lifecycle CANCELLED", () => {
    const out = computeBadgesForDocs({
      docs: [doc("d1", { documentStatus: "CANCELLED", supersededByDocumentId: "d2" })],
      notes: [],
    });
    expect(out.get("d1")).toMatchObject({ isReBilled: true, lifecycle: "CANCELLED" });
  });
});
