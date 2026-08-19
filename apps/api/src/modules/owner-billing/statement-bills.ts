import { createSignedDownloadUrl } from "../../lib/storage";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { findProofsForOwnerMonth } from "./owner-expense-proof.repository";
import { findGridBillsForOwnerMonth } from "./statement-grid-bills.repository";
import type { OwnerBillingActorCtx, OwnerBillingServiceResult } from "./owner-billing.types";

/** Sentinel group for entry-level / unclassified grid bills. Humanises to "Bill Grid". */
export const GRID_FALLBACK_GROUP = "bill_grid";

/**
 * Grid ChargeCategory.ledgerCategory → owner-statement group key. A present, non-blank
 * ledgerCategory passes through (so a grid bill lands in the same group as its matching
 * owner-ledger category); null/blank (entry-level attachment, or a category with no ledger
 * projection) falls to the never-drop "bill_grid" group.
 */
export function gridBillGroupKey(ledgerCategory: string | null | undefined): string {
  return ledgerCategory && ledgerCategory.trim() ? ledgerCategory : GRID_FALLBACK_GROUP;
}

export interface StatementBillItem {
  id: string;
  filename: string;
  url: string;
  source: "manual" | "grid";
  readOnly: boolean;
}
export interface StatementBillGroup {
  category: string;
  proofs: StatementBillItem[];
}

/**
 * One bill BEFORE presentation — carries the storageKey, so it stays server-side.
 * The two consumers do different things with the key (the panel signs a URL, the
 * proof pack fetches bytes), which is exactly why the SOURCING has to be shared and
 * the presentation must not be.
 */
export interface StatementBillSource {
  id: string;
  storageKey: string;
  filename: string;
  /** Group key: manual proofs keep their raw category; grid bills map via gridBillGroupKey. */
  category: string;
  source: "manual" | "grid";
}

/** "YYYY-MM" → first-of-month UTC (mirrors owner-expense-proof.service firstOfMonthUtc). */
function firstOfMonthUtc(statementMonth: string): Date {
  const [y, m] = statementMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

/** Sign one bill INLINE; a per-item failure resolves to null so one bad object never fails the panel. */
async function signOrNull<T extends { storageKey: string }>(
  row: T,
): Promise<{ row: T; url: string } | null> {
  try {
    const url = await createSignedDownloadUrl(row.storageKey); // INLINE — renders, no filename opt
    return { row, url };
  } catch {
    return null;
  }
}

/** Push an item into its category group, preserving first-seen category order. */
function pushGrouped(map: Map<string, StatementBillItem[]>, category: string, item: StatementBillItem) {
  const arr = map.get(category) ?? [];
  arr.push(item);
  map.set(category, arr);
}

/**
 * THE bill list for one (owner, month, apartment) — the single sourcing authority,
 * shared by every surface that shows or prints an owner's supporting bills.
 *
 * Unions the manual OwnerExpenseProof store (always on) with GridAttachment
 * (flag-gated on ENABLE_GRID_BILLS_ON_OWNER_STATEMENT). AuthZ + apartment/owner
 * scoping live in the two repositories; nothing here trusts a caller-supplied key.
 * Flag OFF ⇒ manual proofs only, byte-identical to today.
 *
 * WHY THIS EXISTS: the on-screen Bills & Proof panel and the printed invoice's
 * appended bill pack used to source their bills independently — the panel unioned
 * both stores, the pack read only the manual one. An admin attached a bill on the
 * bills grid, saw it on screen, then printed an invoice with nothing appended. Two
 * readers of the same conceptual list must never source it twice; both now call this.
 *
 * A grid-query failure (e.g. a Prisma pool timeout) degrades to manual-only rather
 * than rejecting — the manual proofs are already resolved and must still come back;
 * one bad source should never blank the whole list.
 */
export async function resolveStatementBillSources(
  orgId: string,
  ownerPartyId: string,
  month: Date,
  apartmentId: string | null,
  /** For the degrade log only — the caller's "YYYY-MM" label. */
  monthLabel: string,
): Promise<StatementBillSource[]> {
  const out: StatementBillSource[] = [];

  // Source A — manual proofs (unchanged authority, always on).
  const manual = await findProofsForOwnerMonth(orgId, ownerPartyId, month, apartmentId);
  for (const row of manual) {
    out.push({
      id: row.id, storageKey: row.storageKey, filename: row.filename,
      category: row.category, source: "manual",
    });
  }

  // Source B — grid bills (flag-gated, apartment+owner scoped in the repo).
  if (isPhase2FlagEnabled("ENABLE_GRID_BILLS_ON_OWNER_STATEMENT")) {
    try {
      const grid = await findGridBillsForOwnerMonth(orgId, ownerPartyId, apartmentId, month);
      for (const row of grid) {
        out.push({
          id: row.id, storageKey: row.storageKey, filename: row.filename,
          category: gridBillGroupKey(row.ledgerCategory), source: "grid",
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[owner-billing] resolveStatementBillSources: grid bills degraded for owner ${ownerPartyId} ${monthLabel}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  return out;
}

/**
 * The read authority behind the owner-statement Bills & Proof panel. Takes the shared
 * source list above and turns it into signed, grouped display items. This layer never
 * returns a storageKey. A single sign failure degrades only that item — signOrNull
 * swallows it so one bad storageKey never fails the whole call.
 */
export async function resolveStatementBills(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  statementMonth: string,
  apartmentId: string | null,
): Promise<OwnerBillingServiceResult<StatementBillGroup[]>> {
  const month = firstOfMonthUtc(statementMonth);
  const rows = await resolveStatementBillSources(ctx.orgId, ownerPartyId, month, apartmentId, statementMonth);

  const byCategory = new Map<string, StatementBillItem[]>();
  const signed = await Promise.all(rows.map(signOrNull));
  for (const s of signed) {
    if (!s) continue;
    pushGrouped(byCategory, s.row.category, {
      id: s.row.id,
      filename: s.row.filename,
      url: s.url,
      source: s.row.source,
      // A grid bill is owned by the bills grid — the statement panel shows it but
      // must never offer to detach it from here.
      readOnly: s.row.source === "grid",
    });
  }

  const data = [...byCategory.entries()].map(([category, proofs]) => ({ category, proofs }));
  return { ok: true as const, status: 200, data };
}
