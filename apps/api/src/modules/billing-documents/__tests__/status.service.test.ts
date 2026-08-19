import { describe, it, expect } from "vitest";
import { deriveDocumentStatus, chargeIdsForFindMany, mapSettlementStatus } from "../status.service";

const c = (status: string, amountCents: number, outstandingCents: number) => ({ status, amountCents, outstandingCents });

describe("deriveDocumentStatus", () => {
  it("freshly posted (nothing collected) → issued", () => {
    expect(deriveDocumentStatus([c("posted", 10000, 10000)])).toBe("issued");
  });
  it("some collected → partially_settled", () => {
    expect(deriveDocumentStatus([c("partially_paid", 10000, 4000)])).toBe("partially_settled");
  });
  it("all outstanding zero and paid → settled", () => {
    expect(deriveDocumentStatus([c("paid", 10000, 0)])).toBe("settled");
  });
  it("void payment restored outstanding to full → back to issued", () => {
    expect(deriveDocumentStatus([c("posted", 10000, 10000), c("posted", 5000, 5000)])).toBe("issued");
  });
  it("mixed: one line paid, one open → partially_settled", () => {
    expect(deriveDocumentStatus([c("paid", 10000, 0), c("posted", 5000, 5000)])).toBe("partially_settled");
  });
  it("all charges credited (Plan 3 CN flow) → offset", () => {
    expect(deriveDocumentStatus([c("credited", 10000, 0)])).toBe("offset");
  });
  it("paid + credited mix, all zero outstanding → settled", () => {
    expect(deriveDocumentStatus([c("paid", 10000, 0), c("credited", 5000, 0)])).toBe("settled");
  });
  it("no charges (defensive) → issued", () => {
    expect(deriveDocumentStatus([])).toBe("issued");
  });
});

describe("mapSettlementStatus (legacy → derived settlementStatus map, R6/R7)", () => {
  // The map is the ONLY place the legacy status crosses into the derived axis;
  // a wrong mapping silently mis-reports every settlement read.
  it("issued → UNPAID", () => {
    expect(mapSettlementStatus("issued")).toBe("UNPAID");
  });
  it("partially_settled → PARTIALLY_PAID", () => {
    expect(mapSettlementStatus("partially_settled")).toBe("PARTIALLY_PAID");
  });
  it("settled → PAID", () => {
    expect(mapSettlementStatus("settled")).toBe("PAID");
  });
  it("offset (all charges credited) → PAID", () => {
    expect(mapSettlementStatus("offset")).toBe("PAID");
  });
  it("unknown/unexpected legacy value → UNPAID (safe default, never throws)", () => {
    expect(mapSettlementStatus("some_future_status")).toBe("UNPAID");
  });
});

describe("chargeIdsForFindMany", () => {
  it("drops null chargeIds", () => {
    expect(chargeIdsForFindMany([{ chargeId: "a" }, { chargeId: null }, { chargeId: "b" }])).toEqual(["a", "b"]);
  });
  it("returns [] when every chargeId is null (never null into an in-clause)", () => {
    expect(chargeIdsForFindMany([{ chargeId: null }, { chargeId: null }])).toEqual([]);
  });
});
