import { describe, it, expect } from "vitest";
import {
  COMMERCIAL_PURPOSES, COMMERCIAL_DOCUMENT_TYPES, LEDGER_TREATMENTS, FUNDED_BY, REVENUE_RECOGNITION,
  resolveDocumentClassification, resolveOwnerReferences,
} from "../constants/document-classification";
import { DEFAULT_SERIES_FOR_CLASSIFICATION } from "../constants/series-mapping";
import { SEED_DOCUMENT_SERIES, SEED_CHARGE_CATEGORIES } from "../constants/seed-categories";

describe("classification value-sets", () => {
  it("exposes the commercial purpose set", () => {
    expect([...COMMERCIAL_PURPOSES]).toEqual(["RENT", "UTILITY", "CARPARK", "SERVICE", "MANAGEMENT_FEE", "OTHER_OWNER_COLLECTION", "DEPOSIT"]);
  });
  it("exposes document types + ledger treatments", () => {
    expect([...COMMERCIAL_DOCUMENT_TYPES]).toEqual(["RENTAL_INVOICE", "OWNER_COLLECTION_INVOICE", "TENANT_SERVICE_INVOICE", "OWNER_SERVICE_INVOICE", "DEPOSIT_INVOICE"]);
    expect([...LEDGER_TREATMENTS]).toEqual(["PAYABLE_TO_OWNER", "MANAGER_REVENUE"]);
  });
  it("extends fundedBy with tenant_funded WITHOUT dropping tenant_direct (spec R3)", () => {
    expect(FUNDED_BY).toContain("tenant_funded");
    expect(FUNDED_BY).toContain("tenant_direct");
  });
  it("extends revenueRecognition with none (included services)", () => {
    expect(REVENUE_RECOGNITION).toContain("none");
  });
});

describe("resolveDocumentClassification (spec R4 — five outcomes)", () => {
  const collectedForOwner = { fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner" } as const;
  it("1c deposit → DEPOSIT_INVOICE / PAYABLE_TO_OWNER, and NEVER the RB rental-bill series", () => {
    const routed = resolveDocumentClassification({ commercialPurpose: "DEPOSIT", ...collectedForOwner });
    expect(routed).toEqual({ kind: "ISSUE", commercialDocumentType: "DEPOSIT_INVOICE", ledgerTreatment: "PAYABLE_TO_OWNER" });
    // A deposit is PAYABLE_TO_OWNER like rent, so without its own branch it would fall
    // through to OWNER_COLLECTION_INVOICE and mint into RB alongside rental bills.
    expect(routed).not.toMatchObject({ commercialDocumentType: "OWNER_COLLECTION_INVOICE" });
  });

  it("a deposit resolves to DEPO in BOTH routing paths — series cannot vary by environment", () => {
    // The classification path (ENABLE_PHASE2_RENT_RECLASSIFICATION on)...
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("DEPOSIT_INVOICE", "PAYABLE_TO_OWNER")).toBe("DEPO");
    // ...and the category path (flag off) both land on DEPO, so the same deposit gets the
    // same document series in UAT (flag off) and dev (flag on).
    const byCategory = SEED_CHARGE_CATEGORIES.filter(
      (c) => c.code === "tenancy_rental_deposit" || c.code === "tenancy_utility_deposit",
    );
    expect(byCategory).toHaveLength(2);
    for (const c of byCategory) expect(c.seriesCode).toBe("DEPO");
  });

  it("keeps rent and other owner collections on RB — the deposit split changes nothing else", () => {
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("RENTAL_INVOICE", "PAYABLE_TO_OWNER")).toBe("RB");
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("OWNER_COLLECTION_INVOICE", "PAYABLE_TO_OWNER")).toBe("RB");
  });

  it("1a rent → RENTAL_INVOICE / PAYABLE_TO_OWNER", () => {
    expect(resolveDocumentClassification({ commercialPurpose: "RENT", ...collectedForOwner }))
      .toEqual({ kind: "ISSUE", commercialDocumentType: "RENTAL_INVOICE", ledgerTreatment: "PAYABLE_TO_OWNER" });
  });
  it("1b same treatment, UTILITY purpose → OWNER_COLLECTION_INVOICE (purpose decides the doc, not treatment alone)", () => {
    expect(resolveDocumentClassification({ commercialPurpose: "UTILITY", ...collectedForOwner }))
      .toEqual({ kind: "ISSUE", commercialDocumentType: "OWNER_COLLECTION_INVOICE", ledgerTreatment: "PAYABLE_TO_OWNER" });
  });
  it("2 in-house service to owner → OWNER_SERVICE_INVOICE / MANAGER_REVENUE", () => {
    expect(resolveDocumentClassification({ commercialPurpose: "SERVICE", fundedBy: "owner", revenueRecognition: "manager_revenue", settlementRecipient: "manager" }))
      .toEqual({ kind: "ISSUE", commercialDocumentType: "OWNER_SERVICE_INVOICE", ledgerTreatment: "MANAGER_REVENUE" });
  });
  it("3 service to tenant → TENANT_SERVICE_INVOICE / MANAGER_REVENUE", () => {
    expect(resolveDocumentClassification({ commercialPurpose: "SERVICE", fundedBy: "tenant_funded", revenueRecognition: "manager_revenue", settlementRecipient: "manager" }))
      .toEqual({ kind: "ISSUE", commercialDocumentType: "TENANT_SERVICE_INVOICE", ledgerTreatment: "MANAGER_REVENUE" });
  });
  it("4 genuine owner pass-through → NO_DOCUMENT", () => {
    expect(resolveDocumentClassification({ commercialPurpose: "SERVICE", fundedBy: "owner", revenueRecognition: "owner_funds", settlementRecipient: "third_party" }).kind).toBe("NO_DOCUMENT");
  });
  it("5 included (revenueRecognition none) → NO_DOCUMENT; nonBillable → NO_DOCUMENT", () => {
    expect(resolveDocumentClassification({ commercialPurpose: "SERVICE", revenueRecognition: "none", settlementRecipient: "none" }).kind).toBe("NO_DOCUMENT");
    expect(resolveDocumentClassification({ nonBillable: true }).kind).toBe("NO_DOCUMENT");
  });
  it("absent commercialPurpose → NEEDS_ECONOMIC_CLASSIFICATION (fail closed; category name never routes)", () => {
    expect(resolveDocumentClassification({ ...collectedForOwner }).kind).toBe("NEEDS_ECONOMIC_CLASSIFICATION");
  });
});

describe("resolveOwnerReferences (spec R2)", () => {
  it("derives collectedOnBehalfOfOwnerId from principalOwnerId", () => {
    expect(resolveOwnerReferences({ ledgerTreatment: "PAYABLE_TO_OWNER", principalOwnerId: "O1" }))
      .toEqual({ principalOwnerId: "O1", collectedOnBehalfOfOwnerId: "O1" });
  });
  it("requires a principal owner for PAYABLE_TO_OWNER", () => {
    expect(resolveOwnerReferences({ ledgerTreatment: "PAYABLE_TO_OWNER" })).toEqual({ error: "PRINCIPAL_OWNER_REQUIRED" });
  });
  it("rejects differing owner refs without an audit reason", () => {
    expect(resolveOwnerReferences({ ledgerTreatment: "PAYABLE_TO_OWNER", principalOwnerId: "O1", collectedOnBehalfOfOwnerId: "O2" }))
      .toEqual({ error: "OWNER_REF_DIFFERS_WITHOUT_REASON" });
  });
  it("MANAGER_REVENUE needs no principal owner", () => {
    expect(resolveOwnerReferences({ ledgerTreatment: "MANAGER_REVENUE" })).toEqual({ principalOwnerId: null, collectedOnBehalfOfOwnerId: null });
  });
});

describe("series mapping (spec R1 — resolved config)", () => {
  it("seeds RB alongside the existing series", () => {
    expect(SEED_DOCUMENT_SERIES.some((s) => s.code === "RB")).toBe(true);
  });
  it("maps each classification to its default series", () => {
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("RENTAL_INVOICE", "PAYABLE_TO_OWNER")).toBe("RB");
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("OWNER_COLLECTION_INVOICE", "PAYABLE_TO_OWNER")).toBe("RB");
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("OWNER_SERVICE_INVOICE", "MANAGER_REVENUE")).toBe("IVOWN");
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("TENANT_SERVICE_INVOICE", "MANAGER_REVENUE")).toBe("IVTEN");
  });
  it("returns null for an unmapped classification (caller fails closed)", () => {
    expect(DEFAULT_SERIES_FOR_CLASSIFICATION("RENTAL_INVOICE", "MANAGER_REVENUE")).toBeNull();
  });
});
