// packages/shared/src/constants/document-classification.ts
// Authoritative billing-document classification (Spec 1: rent reclassification).
// Three orthogonal dimensions decide a document: commercial PURPOSE (what business
// thing it is), economic TREATMENT (whose money it is), and tax treatment (how it is
// taxed — NOT read here). Pure constants + pure functions: no DB, no money math.

export const COMMERCIAL_PURPOSES = [
  "RENT", "UTILITY", "CARPARK", "SERVICE", "MANAGEMENT_FEE", "OTHER_OWNER_COLLECTION",
  // A refundable security / utilities deposit taken at move-in. Its own purpose rather
  // than OTHER_OWNER_COLLECTION because the two route to DIFFERENT series (DEP vs RB):
  // a deposit is money HELD, not a collection that flows to the owner this month.
  "DEPOSIT",
] as const;
export const COMMERCIAL_DOCUMENT_TYPES = [
  "RENTAL_INVOICE", "OWNER_COLLECTION_INVOICE", "TENANT_SERVICE_INVOICE", "OWNER_SERVICE_INVOICE",
  // Deposit document (DEP series). Split out so the classification path and the legacy
  // category path agree on the series — see DEFAULT_SERIES_FOR_CLASSIFICATION.
  "DEPOSIT_INVOICE",
] as const;
export const LEDGER_TREATMENTS = ["PAYABLE_TO_OWNER", "MANAGER_REVENUE"] as const;

// fundedBy = the party economically BEARING the charge. `tenant_funded` (tenant funds,
// agency collects for the owner) is ADDED alongside the existing `tenant_direct` (tenant
// pays the third party directly) — a materially different meaning. Payment route /
// collection mechanism live in a separate settlement field, never in fundedBy.
export const FUNDED_BY = ["owner", "manager", "tenant_direct", "tenant_funded", "third_party"] as const;
export const REVENUE_RECOGNITION = [
  "manager_revenue", "owner_funds", "recovery_of_advance", "third_party_collection", "none",
] as const;
export const SETTLEMENT_RECIPIENTS = ["manager", "owner", "third_party", "none"] as const;

export type CommercialPurpose = (typeof COMMERCIAL_PURPOSES)[number];
export type CommercialDocumentType = (typeof COMMERCIAL_DOCUMENT_TYPES)[number];
export type LedgerTreatment = (typeof LEDGER_TREATMENTS)[number];
export type FundedBy = (typeof FUNDED_BY)[number];
export type RevenueRecognition = (typeof REVENUE_RECOGNITION)[number];
export type SettlementRecipient = (typeof SETTLEMENT_RECIPIENTS)[number];

type RoutingInput = {
  commercialPurpose?: CommercialPurpose | null;
  fundedBy?: FundedBy | null;
  revenueRecognition?: RevenueRecognition | null;
  settlementRecipient?: SettlementRecipient | null;
  nonBillable?: boolean;
};
export type RoutingResult =
  | { kind: "ISSUE"; commercialDocumentType: CommercialDocumentType; ledgerTreatment: LedgerTreatment }
  | { kind: "NO_DOCUMENT" }
  | { kind: "NEEDS_ECONOMIC_CLASSIFICATION"; reason: string };

/**
 * The single tested routing matrix (Spec R4). Reads ONLY commercialPurpose + economic
 * treatment — NEVER the category name, NEVER taxTreatment. Five routing outcomes:
 *   1a RENT collected-for-owner → RENTAL_INVOICE / PAYABLE_TO_OWNER
 *   1b other owner collection    → OWNER_COLLECTION_INVOICE / PAYABLE_TO_OWNER
 *   2  manager service to owner  → OWNER_SERVICE_INVOICE / MANAGER_REVENUE
 *   3  manager service to tenant → TENANT_SERVICE_INVOICE / MANAGER_REVENUE
 *   4  genuine owner pass-through → NO_DOCUMENT (owner-ledger deduction, no manager invoice)
 *   5  included in package        → NO_DOCUMENT (non-billable)
 * Anything else fails closed → NEEDS_ECONOMIC_CLASSIFICATION (never guessed).
 */
export function resolveDocumentClassification(input: RoutingInput): RoutingResult {
  const needs = (reason: string): RoutingResult => ({ kind: "NEEDS_ECONOMIC_CLASSIFICATION", reason });
  if (input.nonBillable) return { kind: "NO_DOCUMENT" };
  const cp = input.commercialPurpose;
  const rr = input.revenueRecognition;
  const sr = input.settlementRecipient;
  if (!cp) return needs("commercialPurpose is required");
  if (!rr || !sr) return needs("revenueRecognition and settlementRecipient are required");

  if (rr === "none") return { kind: "NO_DOCUMENT" }; // outcome 5
  if (rr === "owner_funds" && sr === "third_party") return { kind: "NO_DOCUMENT" }; // outcome 4

  if (rr === "manager_revenue" && sr === "manager") {
    // outcome 2 vs 3: owner-borne (or a management fee) → billed to owner; else billed to tenant.
    if (input.fundedBy === "owner" || cp === "MANAGEMENT_FEE") {
      return { kind: "ISSUE", commercialDocumentType: "OWNER_SERVICE_INVOICE", ledgerTreatment: "MANAGER_REVENUE" };
    }
    return { kind: "ISSUE", commercialDocumentType: "TENANT_SERVICE_INVOICE", ledgerTreatment: "MANAGER_REVENUE" };
  }
  if (rr === "third_party_collection" && sr === "owner") {
    // outcomes 1a/1b/1c: purpose decides the commercial document type.
    //   RENT     → RENTAL_INVOICE            (RB)
    //   DEPOSIT  → DEPOSIT_INVOICE           (DEP) — refundable, HELD not remitted
    //   other    → OWNER_COLLECTION_INVOICE  (RB)
    // DEPOSIT is checked BEFORE the else-branch so it can never silently fall through
    // to OWNER_COLLECTION_INVOICE, which would mint it into the RB rental-bill series.
    const commercialDocumentType: CommercialDocumentType =
      cp === "RENT" ? "RENTAL_INVOICE"
      : cp === "DEPOSIT" ? "DEPOSIT_INVOICE"
      : "OWNER_COLLECTION_INVOICE";
    return { kind: "ISSUE", commercialDocumentType, ledgerTreatment: "PAYABLE_TO_OWNER" };
  }
  return needs(`unroutable treatment: purpose=${cp} rr=${rr} sr=${sr}`);
}

/**
 * Owner-reference invariant (Spec R2). PAYABLE_TO_OWNER docs require a principal owner;
 * collectedOnBehalfOfOwnerId derives from it and may differ only with an audit reason.
 */
export function resolveOwnerReferences(input: {
  ledgerTreatment: LedgerTreatment;
  principalOwnerId?: string | null;
  collectedOnBehalfOfOwnerId?: string | null;
  ownerRefDiffersReason?: string | null;
}):
  | { principalOwnerId: string | null; collectedOnBehalfOfOwnerId: string | null }
  | { error: "PRINCIPAL_OWNER_REQUIRED" | "OWNER_REF_DIFFERS_WITHOUT_REASON" } {
  if (input.ledgerTreatment !== "PAYABLE_TO_OWNER") {
    return { principalOwnerId: input.principalOwnerId ?? null, collectedOnBehalfOfOwnerId: input.collectedOnBehalfOfOwnerId ?? null };
  }
  if (!input.principalOwnerId) return { error: "PRINCIPAL_OWNER_REQUIRED" };
  const collected = input.collectedOnBehalfOfOwnerId ?? input.principalOwnerId;
  if (collected !== input.principalOwnerId && !input.ownerRefDiffersReason) return { error: "OWNER_REF_DIFFERS_WITHOUT_REASON" };
  return { principalOwnerId: input.principalOwnerId, collectedOnBehalfOfOwnerId: collected };
}
