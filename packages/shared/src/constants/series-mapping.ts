// packages/shared/src/constants/series-mapping.ts
// Series is resolved CONFIGURATION, not accounting identity (Spec R1). Business logic
// resolves the document series through this default map (an org may override via config)
// and never hard-codes the literal RB/IVTEN/IVOWN code. A null result means the
// classification has no permitted series → the caller MUST fail closed (SERIES_NOT_CONFIGURED).

import type { CommercialDocumentType, LedgerTreatment } from "./document-classification";

export function DEFAULT_SERIES_FOR_CLASSIFICATION(
  commercialDocumentType: CommercialDocumentType,
  ledgerTreatment: LedgerTreatment,
): string | null {
  // Deposits FIRST — a DEPOSIT_INVOICE is also PAYABLE_TO_OWNER, so it would otherwise be
  // swallowed by the RB branch below and mint a refundable deposit into the rental-bill
  // series. DEPO is also what the CATEGORY path resolves to (tenancy_rental_deposit /
  // tenancy_utility_deposit both carry seriesCode "DEPO"), so BOTH routing paths produce a
  // DEPO- document and the series does not depend on whether
  // ENABLE_PHASE2_RENT_RECLASSIFICATION happens to be on in a given environment.
  if (ledgerTreatment === "PAYABLE_TO_OWNER" && commercialDocumentType === "DEPOSIT_INVOICE") {
    return "DEPO";
  }
  if (
    ledgerTreatment === "PAYABLE_TO_OWNER" &&
    (commercialDocumentType === "RENTAL_INVOICE" || commercialDocumentType === "OWNER_COLLECTION_INVOICE")
  ) {
    return "RB";
  }
  if (ledgerTreatment === "MANAGER_REVENUE" && commercialDocumentType === "OWNER_SERVICE_INVOICE") return "IVOWN";
  if (ledgerTreatment === "MANAGER_REVENUE" && commercialDocumentType === "TENANT_SERVICE_INVOICE") return "IVTEN";
  return null;
}

/**
 * The INVERSE of the map above, for the series codes where it is 1:1 — used to
 * populate commercialDocumentType/ledgerTreatment on documents minted through a
 * path that resolves its series from the charge's CATEGORY rather than from the
 * classification matrix (the bills-grid grouped path, and every legacy caller that
 * predates classification). Those documents were being written with both columns
 * NULL, which left every downstream consumer that reads them — the owner-receivable
 * offset guard among them — unable to recognise its own invoices.
 *
 * Lives HERE, immediately below its forward twin, so the pair cannot drift.
 *
 * Returns null for anything not 1:1, and the caller must leave the columns NULL
 * rather than guess:
 *   • RB   — ledgerTreatment is unambiguously PAYABLE_TO_OWNER, but the commercial
 *            type could be RENTAL_INVOICE **or** OWNER_COLLECTION_INVOICE. A half-
 *            filled classification is worse than an honest null, because a later
 *            backfill can no longer tell a derived value from a real one.
 *   • DEP  — carries aircond / utility_tnb / utility_water / utility_wifi /
 *            utility_indah_water / security_deposit / utility_deposit / carpark_deposit /
 *            access_card_deposit / legacy_other. No single classification describes them,
 *            and the forward map never sends anything here.
 *   • EB / OEA / CN / DN / RN / REM — carry no classification in the forward map.
 *
 * DEPO is deliberately ABSENT from that list: it is 1:1 with DEPOSIT_INVOICE /
 * PAYABLE_TO_OWNER (nothing else routes there), so it COULD be inverted. It is left out
 * only because no legacy DEPO document exists to back-fill — the series is new with this
 * feature and every document in it is minted already-classified.
 */
export function CLASSIFICATION_FOR_DEFAULT_SERIES(
  seriesCode: string,
): { commercialDocumentType: CommercialDocumentType; ledgerTreatment: LedgerTreatment } | null {
  if (seriesCode === "IVOWN") {
    return { commercialDocumentType: "OWNER_SERVICE_INVOICE", ledgerTreatment: "MANAGER_REVENUE" };
  }
  if (seriesCode === "IVTEN") {
    return { commercialDocumentType: "TENANT_SERVICE_INVOICE", ledgerTreatment: "MANAGER_REVENUE" };
  }
  return null;
}
