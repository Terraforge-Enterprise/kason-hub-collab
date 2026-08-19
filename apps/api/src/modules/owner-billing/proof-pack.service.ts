// Proof-pack builder for the Owner-Billing module (Task C1). The proof pack is the
// SEPARATE, downloadable evidence bundle: one merged PDF of every bill attached to a
// single (owner, month, apartment) — kept OFF the clean financial statement (Part A).
//
// The merge itself — miss-resilient, bounded, PDF + image — lives in lib/bill-bundle so
// the billing-document PDF renders its attachments through the exact same code. Keeping
// two copies of those resilience rules is how they drift the first time one is fixed.
//
// This path does NO money math and writes NO audit — it is a pure read over the SAME
// bill list the on-screen Bills & Proof panel renders (`resolveStatementBillSources`:
// the append-only OwnerExpenseProof store unioned with flag-gated GridAttachment),
// apartment-scoped: an apartment with no bills → null.
import { buildBillBundlePdf } from "../../lib/bill-bundle";
import { resolveStatementBillSources } from "./statement-bills";
import type { OwnerBillingActorCtx } from "./owner-billing.types";

/** "YYYY-MM" → first-of-month UTC Date (the proof store's keyed month). */
function firstOfMonthUtc(statementMonth: string): Date {
  const [y, m] = statementMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/**
 * Build the merged proof-pack PDF for one (owner, month, apartment). Returns the PDF
 * bytes, or `null` when the scope has no usable proofs (no rows, or every bill's bytes
 * are missing/unreadable) — the route maps `null` → 404. `apartmentId` is matched
 * EXACTLY (value ⇒ `= value`, null ⇒ `IS NULL`), so a per-apartment pack never pulls
 * another apartment's (or the legacy combined) bills.
 */
export async function buildProofPackPdf(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  statementMonth: string,
  apartmentId: string | null,
): Promise<Uint8Array | null> {
  const month = firstOfMonthUtc(statementMonth);
  const proofs = await resolveStatementBillSources(
    ctx.orgId, ownerPartyId, month, apartmentId, statementMonth,
  );
  if (proofs.length === 0) return null;
  return buildBillBundlePdf(proofs, `proof-pack owner ${ownerPartyId} ${statementMonth}`);
}
