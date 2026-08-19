import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";

/**
 * A persisted owner-expense proof row. The store is APPEND-ONLY and lives OFF the
 * continuously-re-synced owner ledger, keyed on
 * `(org, owner, statementMonth, apartmentId, category)` so it (a) survives a ledger
 * re-projection (the volatile `OwnerLedgerEntry.id` is never referenced) and (b)
 * keeps two apartments' same-category bills (e.g. two `utilities_tnb` rows) distinct
 * — statements are generated one per apartment, so proof must be apartment-scoped.
 */
export type OwnerExpenseProof = Prisma.OwnerExpenseProofGetPayload<Record<string, never>>;

/** Append payload. `statementMonth` is normalized to first-of-month UTC by the caller. */
export interface AppendProofInput {
  orgId: string;
  ownerPartyId: string;
  statementMonth: Date;
  apartmentId: string | null;
  category: string;
  storageKey: string;
  filename: string;
  uploadedById: string;
}

/**
 * Proofs for one (owner, month, apartment). The `apartmentId` filter is EXACT,
 * including `null`: Prisma renders `apartmentId = $1` for a value and
 * `apartmentId IS NULL` for `null`, so a legacy combined-statement (null-apartment)
 * proof never leaks into an apartment-scoped query and vice-versa.
 */
export async function findProofsForOwnerMonth(
  orgId: string,
  ownerPartyId: string,
  statementMonth: Date,
  apartmentId: string | null,
): Promise<OwnerExpenseProof[]> {
  const db = getDb();
  return db.ownerExpenseProof.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      statementMonth,
      apartmentId, // exact match — value ⇒ `= value`, null ⇒ `IS NULL`
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Append one proof row (in the caller's transaction, alongside the audit write). */
export async function appendProof(
  tx: Prisma.TransactionClient,
  input: AppendProofInput,
): Promise<OwnerExpenseProof> {
  return tx.ownerExpenseProof.create({
    data: {
      organizationId: input.orgId,
      ownerPartyId: input.ownerPartyId,
      statementMonth: input.statementMonth,
      apartmentId: input.apartmentId,
      category: input.category,
      storageKey: input.storageKey,
      filename: input.filename,
      uploadedById: input.uploadedById,
    },
  });
}

/** Org-scoped single-proof lookup (e.g. for detach — resolve the storageKey to delete). */
export async function findProofById(
  orgId: string,
  id: string,
): Promise<OwnerExpenseProof | null> {
  const db = getDb();
  return db.ownerExpenseProof.findFirst({
    where: { id, organizationId: orgId },
  });
}

/**
 * Delete one proof row in the caller's transaction. Org-scoped + `deleteMany` (not
 * `delete`) so it is idempotent and can never touch another org's row — a missing /
 * cross-org id is a no-op rather than a throw. The caller deletes the bucket object
 * AFTER commit (best-effort) so no orphaned bytes are left behind.
 */
export async function deleteProof(
  tx: Prisma.TransactionClient,
  orgId: string,
  id: string,
): Promise<void> {
  await tx.ownerExpenseProof.deleteMany({
    where: { id, organizationId: orgId },
  });
}
