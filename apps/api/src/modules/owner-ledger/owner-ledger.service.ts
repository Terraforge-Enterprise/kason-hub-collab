/**
 * Owner Ledger Service — CRUD + audit + optimistic concurrency.
 *
 * Every mutation (create / update / void) writes the row AND the AuditLog row
 * in ONE $transaction so they are atomic.
 *
 * Concurrency is guarded by `expectedUpdatedAt` tokens (passed from the client
 * which received the row from getEntryService/listEntriesService). The
 * repository returns a count; count === 0 means a concurrent write changed the
 * row → 409.
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import type { OwnerLedgerEntryInput, OwnerLedgerEntryPatch } from "@kason/shared";
import type { OwnerLedgerLine, ClosedPeriodErrorBody } from "@kason/shared";
import { summarizeOwnerPeriod, summarizeTax, toCents, centsToString } from "@kason/shared";
import { findDepositsCollectedInMonth, depositWindowEndOfMonth } from "../owner-billing/owner-billing.repository";
import { computeOwnerPayout, fetchOwnerReceivablePayoutRows } from "../owner-billing/owner-statement-sections";
import { resolveOwnerPayoutForScope, type OwnerPayoutBreakdown } from "./owner-payout-scope.service";
import type { OwnerBillingActorCtx } from "../owner-billing/owner-billing.types";
import { syncOwnerLedgerForApartmentMonth, syncOwnerLedgerForOwnerMonth } from "./owner-ledger.sync-hook";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { recordAudit } from "../../lib/audit";
import { assertPeriodOpen } from "./assert-period-open";
import { ClosedPeriodError, toClosedPeriodBody } from "./closed-period";
import { materializeOwnerUnitMonths } from "./unit-month-ledger.materialize";
import { adjustedBilledAmount, resolveChargedAmount } from "./charged-amount";
import { adjustmentSumsByChargeId } from "../billing-documents/adjustment-sums";
import type { ChargeAdjustmentSums } from "../billing-documents/adjustment-sums";
import {
  createEntry,
  getEntry,
  listEntries,
  voidEntry,
  listForPeriod,
  resolveOwnerTree,
  resolveOwnersSummary,
  resolveOwnerBalance,
} from "./owner-ledger.repository";
import type { OwnerTree, OwnersSummary, OwnerBalanceResult } from "./owner-ledger.repository";
import type {
  DbOwnerLedgerEntry,
  OwnerLedgerActorCtx,
  OwnerLedgerListFilters,
  OwnerLedgerPagination,
  OwnerLedgerPeriodArgs,
} from "./owner-ledger.types";

// ─── DTO ─────────────────────────────────────────────────────────────────────

/**
 * Wire-safe view of a DbOwnerLedgerEntry: Decimal → string, Date → ISO string.
 * Matches the shape consumed by Task 7 routes.
 */
export type LedgerEntryRow = {
  id: string;
  organizationId: string;
  ownerPartyId: string;
  /** Task 6a: null = owner-level (not attributable to one property) — a Phase-2
   *  remittance payout spanning multiple properties (R9) or a combined-scope
   *  pre-statement payout. Manual per-property entries still always carry a
   *  real propertyId (createEntryService requires it via Zod). */
  propertyId: string | null;
  apartmentId: string | null;
  unitCode: string | null;
  listingId: string | null;
  tenancyId: string | null;
  statementMonth: string; // ISO string
  transactionDate: string; // ISO string
  direction: string;
  category: string;
  description: string | null;
  remarks: string | null;
  amount: string; // Decimal.toString() — COLLECTED-so-far for income rows; full billed for expenses
  /**
   * BILLED price for display, or null to fall back to `amount`. Income rows'
   * `amount` is collected-so-far (0 until paid); this surfaces the source
   * Charge's amount so the UI shows the price. Payout math still reads `amount`.
   *
   * CN/DN-ADJUSTED (see adjustedBilledAmount): `amount` beside it has always been
   * netted at sync time, so reading this one bare made the pair irreconcilable.
   */
  chargedAmount: string | null;
  /**
   * Σ active DEBIT-note lines against this row's source Charge, 2-dp string; "0.00"
   * when there are none or the row has no charge. Exists so the ledger can SAY that
   * an adjustment happened — previously a note silently changed the numbers with no
   * trace anywhere on the row, which is unauditable. Display-only.
   */
  debitAdjustmentAmount: string;
  /** Σ active CREDIT-note lines against this row's source Charge. See above. */
  creditAdjustmentAmount: string;
  sstAmount: string | null;
  paidBy: string;
  paymentStatus: string;
  taxCategory: string;
  includeInPayout: boolean;
  attachmentKeys: string[];
  sourceType: string;
  sourceChargeId: string | null;
  sourceUtilityBillId: string | null;
  status: string;
  createdById: string;
  updatedById: string;
  createdAt: string;
  updatedAt: string;
};

export function rowToDto(
  row: DbOwnerLedgerEntry,
  unitCode: string | null = null,
  chargedAmount: string | null = null,
  adjustments: ChargeAdjustmentSums | undefined = undefined,
): LedgerEntryRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    ownerPartyId: row.ownerPartyId,
    propertyId: row.propertyId,
    apartmentId: row.apartmentId,
    unitCode,
    listingId: row.listingId,
    tenancyId: row.tenancyId,
    statementMonth: row.statementMonth.toISOString(),
    transactionDate: row.transactionDate.toISOString(),
    direction: row.direction,
    category: row.category,
    description: row.description,
    remarks: row.remarks,
    amount: row.amount.toString(),
    chargedAmount,
    debitAdjustmentAmount: centsToString(adjustments?.debitCents ?? 0),
    creditAdjustmentAmount: centsToString(adjustments?.creditCents ?? 0),
    sstAmount: row.sstAmount != null ? row.sstAmount.toString() : null,
    paidBy: row.paidBy,
    paymentStatus: row.paymentStatus,
    taxCategory: row.taxCategory,
    includeInPayout: row.includeInPayout,
    attachmentKeys: row.attachmentKeys,
    sourceType: row.sourceType,
    sourceChargeId: row.sourceChargeId,
    sourceUtilityBillId: row.sourceUtilityBillId,
    status: row.status,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Result types ─────────────────────────────────────────────────────────────

type Ok<T> = { ok: true; status: 200 | 201; data: T };
// `body` carries the structured closed_period 409 payload (R2) when the write was
// rejected by the frozen-period guard; absent for every other error.
type Err = { ok: false; status: 400 | 404 | 409; error: string; body?: ClosedPeriodErrorBody };
type ServiceResult<T> = Ok<T> | Err;

// ─── Business-rule helpers ────────────────────────────────────────────────────

/**
 * Derive `includeInPayout` from `paidBy` and `direction`.
 * The rule: Kaen-paid items are included in owner payout; owner/tenant/other are not.
 * CRITICAL: payout entries must NEVER have includeInPayout=true — they reduce the
 * balance separately via the payout direction, not via the includeInPayout flag.
 */
function deriveIncludeInPayout(paidBy: string, direction?: string): boolean {
  if (direction === "payout") return false; // payout reduces balance separately, not via includeInPayout
  return paidBy === "kaen";
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createEntryService(
  actor: OwnerLedgerActorCtx,
  input: OwnerLedgerEntryInput,
): Promise<ServiceResult<LedgerEntryRow>> {
  const [year, month] = input.statementMonth.split("-").map(Number);
  const statementMonth = new Date(Date.UTC(year!, month! - 1, 1));
  const transactionDate = new Date(input.transactionDate);
  const includeInPayout = deriveIncludeInPayout(input.paidBy, input.direction);

  try {
    const row = await getDb().$transaction(async (tx) => {
      // R1: a manual owner-ledger entry is a NEW dated impact — reject it if the
      // target statement month is frozen, IN-TX and BEFORE any write, so a throw
      // rolls back with no row/audit orphan. No-op when the live-ledger flag is off
      // or the period is open (intent is deliberately NOT forwarded from the input
      // — the PPA bypass is never reachable from this general create path).
      await assertPeriodOpen(tx, actor.orgId, input.ownerPartyId, statementMonth);

      const created = await createEntry(tx, {
        organizationId: actor.orgId,
        ownerPartyId: input.ownerPartyId,
        propertyId: input.propertyId,
        apartmentId: input.apartmentId ?? null,
        listingId: input.listingId ?? null,
        tenancyId: input.tenancyId ?? null,
        statementMonth,
        transactionDate,
        direction: input.direction,
        category: input.category,
        description: input.description ?? null,
        remarks: input.remarks ?? null,
        amount: input.amount,
        sstAmount: input.sstAmount ?? null,
        paidBy: input.paidBy,
        paymentStatus: input.paymentStatus,
        taxCategory: input.taxCategory,
        includeInPayout,
        attachmentKeys: input.attachmentKeys ?? [],
        status: "active",
        createdById: actor.actorUserId,
        updatedById: actor.actorUserId,
      });

      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_ledger.entry.create",
        entityType: "OwnerLedgerEntry",
        entityId: created.id,
        diff: { after: rowToDto(created) } as unknown as Prisma.InputJsonValue,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      return created;
    });

    return { ok: true as const, status: 201, data: rowToDto(row) };
  } catch (err) {
    // R2: translate the closed-period rejection into the structured 409 result the
    // POST /entries route surfaces verbatim.
    if (err instanceof ClosedPeriodError) {
      return { ok: false as const, status: 409, error: "closed_period", body: toClosedPeriodBody(err) };
    }
    throw err;
  }
}

// ─── Read (single) ────────────────────────────────────────────────────────────

export async function getEntryService(
  actor: OwnerLedgerActorCtx,
  id: string,
): Promise<ServiceResult<LedgerEntryRow>> {
  const row = await getEntry(actor.orgId, id);
  if (!row) return { ok: false as const, status: 404, error: "Not found" };

  // Resolve unitCode from apartmentId (no FK relation — separate lookup).
  let unitCode: string | null = null;
  if (row.apartmentId) {
    const apt = await getDb().apartment.findUnique({
      where: { id: row.apartmentId },
      select: { unitCode: true },
    });
    unitCode = apt?.unitCode ?? null;
  }

  // Same CN/DN resolution the LIST path does. Omitting it here emitted a hard "0.00" on
  // both adjustment fields, and because they are non-optional DTO members a consumer
  // could not tell "this charge has no notes" from "this endpoint does not look". The
  // whole point of the fields is that a silent adjustment becomes visible, so the two
  // read paths have to agree.
  const adjustments = row.sourceChargeId
    ? (await adjustmentSumsByChargeId(getDb(), actor.orgId, [row.sourceChargeId])).get(row.sourceChargeId)
    : undefined;

  return { ok: true as const, status: 200, data: rowToDto(row, unitCode, null, adjustments) };
}

// ─── Read (list) ─────────────────────────────────────────────────────────────

export async function listEntriesService(
  actor: OwnerLedgerActorCtx,
  filters: OwnerLedgerListFilters,
  page: OwnerLedgerPagination,
): Promise<ServiceResult<{ rows: LedgerEntryRow[]; total: number }>> {
  const { rows, total } = await listEntries(actor.orgId, filters, page);

  // Bulk-resolve unitCode for all rows that have an apartmentId.
  // OwnerLedgerEntry.apartmentId has no FK relation to Apartment in Prisma,
  // so we cannot use include — a separate lookup is required.
  const apartmentIds = [...new Set(rows.map((r) => r.apartmentId).filter(Boolean))] as string[];
  let unitCodeMap = new Map<string, string>();
  if (apartmentIds.length > 0) {
    const apts = await getDb().apartment.findMany({
      where: { id: { in: apartmentIds } },
      select: { id: true, unitCode: true },
    });
    unitCodeMap = new Map(apts.map((a) => [a.id, a.unitCode]));
  }

  // Bulk-resolve the BILLED price for income rows. Income `amount` is
  // collected-so-far (0 until the tenant pays); the price lives on the source
  // Charge, surfaced as `chargedAmount` for display only (payout math still
  // reads `amount`). Expense rows already store their full billed amount, so
  // they are excluded here and fall back to `amount` client-side.
  const incomeChargeIds = [
    ...new Set(
      rows
        .filter((r) => r.direction === "income" && r.sourceChargeId)
        .map((r) => r.sourceChargeId as string),
    ),
  ];
  // Notes are resolved for EVERY charge-backed row, not just the income ones whose
  // billed price we surface: an expense row's `amount` is already netted at sync time,
  // but the reader still has to be told WHY it differs from the document they remember.
  const adjustableChargeIds = [
    ...new Set(rows.map((r) => r.sourceChargeId).filter((id): id is string => id !== null)),
  ];
  const [charges, adjustmentSums] = await Promise.all([
    incomeChargeIds.length > 0
      ? getDb().charge.findMany({
          where: { id: { in: incomeChargeIds }, organizationId: actor.orgId },
          select: { id: true, amount: true },
        })
      : Promise.resolve([] as { id: string; amount: Prisma.Decimal }[]),
    adjustmentSumsByChargeId(getDb(), actor.orgId, adjustableChargeIds),
  ]);
  // ⚠️ MONEY-DISPLAY: netted, never `c.amount` bare. The collected figure beside this
  // one is netted at sync time, so a bare read here made the two irreconcilable — a
  // credited charge read exactly like an underpaid one. See adjustedBilledAmount.
  const billedByChargeId = new Map(
    charges.map((c) => [c.id, adjustedBilledAmount(c.amount.toString(), adjustmentSums.get(c.id))]),
  );

  return {
    ok: true as const,
    status: 200,
    data: {
      rows: rows.map((r) =>
        rowToDto(
          r,
          r.apartmentId ? (unitCodeMap.get(r.apartmentId) ?? null) : null,
          resolveChargedAmount(r, billedByChargeId),
          r.sourceChargeId ? adjustmentSums.get(r.sourceChargeId) : undefined,
        ),
      ),
      total,
    },
  };
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateEntryService(
  _actor: OwnerLedgerActorCtx,
  _id: string,
  _patch: OwnerLedgerEntryPatch,
): Promise<ServiceResult<LedgerEntryRow>> {
  // Owner-ledger entries are immutable once written. Corrections go through
  // Void + re-add (the Void action), or by fixing the source charge/bill.
  // Editing a synced row would also be silently clobbered by the next sync.
  return { ok: false as const, status: 409, error: "Ledger entries are read-only; void and re-add" };
}

// ─── Void ────────────────────────────────────────────────────────────────────

export async function voidEntryService(
  actor: OwnerLedgerActorCtx,
  id: string,
  expectedUpdatedAt: string,
): Promise<ServiceResult<LedgerEntryRow>> {
  // Pre-read for 404 check.
  const existing = await getEntry(actor.orgId, id);
  if (!existing) return { ok: false as const, status: 404, error: "Not found" };

  // R2: reject a shallow void of any sync-owned row (real money lives on the
  // source Charge/UnitUtilityBill, which has its own void path) — key on ID
  // PRESENCE, never on the `sourceType` label (spec invariant).
  if (existing.sourceChargeId !== null || existing.sourceUtilityBillId !== null) {
    return { ok: false as const, status: 409, error: "VOID_AT_SOURCE" };
  }

  // Phase-2 (GC5, append-only invariant — money-hole fix, whole-branch
  // adversarial review): reject a shallow void of any Phase-2 entry
  // (remittance / offset / reversal — settlementKind non-null). Unlike a
  // Phase-1 sync-derived row, a Phase-2 OWNER_RECEIVABLE_OFFSET payout has a
  // SECOND, coupled money effect the R2 guard above cannot see: an external
  // Charge was settled via settleIvownChargeTx when the offset was created,
  // and insertPayoutEntry's own contract (owner-remittance.repository.ts)
  // leaves sourceChargeId/sourceUtilityBillId null on EVERY Phase-2 entry —
  // so it always slips past R2. A shallow void here would flip
  // status "active"→"void", silently dropping the entry from
  // computeAvailableOwnerPayableC's `status:"active"` filter and freeing
  // owner payable WITHOUT restoring the settled charge. Fail-closed on
  // nullability (not an allowlist of known kinds) so a reversal row — which
  // reuses its original's settlementKind verbatim — is covered too. Route to
  // the dedicated reversal endpoint instead, which undoes every coupled side
  // effect atomically: POST /api/owner-remittances/:id/reverse (remittance /
  // pre-statement remittance) or POST /api/owner-receivable-offsets/:id/reverse
  // (offset).
  if (existing.settlementKind !== null) {
    return { ok: false as const, status: 409, error: "CANNOT_VOID_PHASE2_ENTRY" };
  }

  try {
    const voided = await getDb().$transaction(async (tx) => {
      const count = await voidEntry(tx, actor.orgId, id, expectedUpdatedAt, actor.actorUserId);
      if (count === 0) {
        throw new ConcurrencyError();
      }

      // Read back the voided row.
      const voidedRow = await tx.ownerLedgerEntry.findFirst({
        where: { id, organizationId: actor.orgId },
      });
      if (!voidedRow) throw new ConcurrencyError();

      await recordAudit(tx, {
        organizationId: actor.orgId,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "owner_ledger.entry.void",
        entityType: "OwnerLedgerEntry",
        entityId: id,
        diff: {
          before: rowToDto(existing),
          after: rowToDto(voidedRow),
        } as unknown as Prisma.InputJsonValue,
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      return voidedRow;
    });
    return { ok: true as const, status: 200, data: rowToDto(voided) };
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return { ok: false as const, status: 409, error: "stale" };
    }
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      return { ok: false as const, status: 404, error: "Not found" };
    }
    throw err;
  }
}

// ─── Summary services ─────────────────────────────────────────────────────────

/**
 * Aggregate summary for the owner over a [fromMonth, toMonth] window.
 * Calls listForPeriod (active rows only, org-scoped) then summarizeOwnerPeriod.
 * Also computes running balance (broughtForward, carriedForward) when ownerPartyId
 * is present in range.
 */
export async function getSummaryService(
  actor: OwnerLedgerActorCtx,
  range: OwnerLedgerPeriodArgs,
): Promise<ServiceResult<ReturnType<typeof summarizeOwnerPeriod> & OwnerBalanceResult>> {
  const lines = await listForPeriod(actor.orgId, range);
  const summary = summarizeOwnerPeriod(lines);
  const balance = range.ownerPartyId
    ? await resolveOwnerBalance(actor.orgId, range.ownerPartyId, range.fromMonth, range.toMonth)
    : {
        broughtForward: "0.00",
        periodGross: summary.grossRental,
        periodExpenses: summary.totalExpenses,
        periodPayouts: summary.payoutsTotal,
        netThisPeriod: summary.netPayoutToOwner,
        depositCollected: "0.00", // deposits are owner-scoped; no owner → not summable
        carriedForward: "0.00",
      };
  return { ok: true as const, status: 200, data: { ...summary, ...balance } };
}

/**
 * Tax-category summary for the owner over a [fromMonth, toMonth] window.
 * Calls listForPeriod (active rows only, org-scoped) then summarizeTax.
 */
export async function getTaxSummaryService(
  actor: OwnerLedgerActorCtx,
  range: OwnerLedgerPeriodArgs,
): Promise<ServiceResult<ReturnType<typeof summarizeTax>>> {
  const lines = await listForPeriod(actor.orgId, range);
  return { ok: true as const, status: 200, data: summarizeTax(lines) };
}

// ─── Owner-tree ───────────────────────────────────────────────────────────────

export async function getOwnerTreeService(
  actor: OwnerLedgerActorCtx,
  ownerPartyId: string,
): Promise<ServiceResult<OwnerTree>> {
  const tree = await resolveOwnerTree(actor.orgId, ownerPartyId);
  return { ok: true as const, status: 200, data: tree };
}

// ─── Owners summary ───────────────────────────────────────────────────────────

export async function getOwnersSummaryService(
  actor: OwnerLedgerActorCtx,
  query: { fromMonth?: string; toMonth?: string },
): Promise<ServiceResult<OwnersSummary>> {
  const data = await resolveOwnersSummary(actor.orgId, query.fromMonth, query.toMonth);
  return { ok: true as const, status: 200, data };
}

// ─── Internal error class ─────────────────────────────────────────────────────

class ConcurrencyError extends Error {
  constructor() {
    super("Stale concurrency token");
    this.name = "ConcurrencyError";
  }
}

// ─── Owner monthly summaries (2a-5) ──────────────────────────────────────────

export type MonthlyStatementSummary = {
  month: string;             // "YYYY-MM"
  grossRental: string;       // 2dp
  totalExpenses: string;     // 2dp
  netPayoutToOwner: string;  // 2dp (may be negative)
  depositCollected: string;  // 2dp — real deposit collected in-month (G5); matches assembleYannieStatement
  statementId: string | null;       // null = no statement generated yet
  statementStatus: string | null;   // "draft" | "approved" | "sent" | "paid" | "void" | null
  hasData: boolean;          // true when ≥1 OwnerLedgerEntry exists
};

/**
 * Group all active OwnerLedgerEntry rows for an owner by statementMonth.
 * For each distinct month, compute summarizeOwnerPeriod + look up the existing
 * owner-statement Invoice (if any). Returns months sorted descending (newest first).
 *
 * Optionally filter by year (4-digit string).
 *
 * When `apartmentId` is supplied the whole computation is scoped to that one
 * apartment — entries, the per-month owner_statement lookup, AND the owner's
 * listing set (so the deposit windowing scopes too). Absent ⇒ byte-identical to
 * the owner-combined behaviour. computeOwnerPayout + the deposit math are
 * untouched; only the entries/statements/listings SCOPE narrows.
 */
export async function getOwnerMonthsService(
  actor: OwnerLedgerActorCtx,
  ownerPartyId: string,
  year?: string,
  apartmentId?: string,
): Promise<ServiceResult<{ items: MonthlyStatementSummary[] }>> {
  const db = getDb();

  // Build year filter if provided
  let yearFilter: { gte: Date; lte: Date } | undefined;
  if (year && /^\d{4}$/.test(year)) {
    const y = parseInt(year, 10);
    yearFilter = {
      gte: new Date(Date.UTC(y, 0, 1)),
      lte: new Date(Date.UTC(y, 11, 31)),
    };
  }

  // 1. Fetch all active entries for this owner (optionally filtered by year)
  const entries = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: actor.orgId,
      ownerPartyId,
      status: "active",
      ...(yearFilter ? { statementMonth: yearFilter } : {}),
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: {
      direction: true,
      category: true,
      amount: true,
      sstAmount: true,
      includeInPayout: true,
      taxCategory: true,
      statementMonth: true,
      // ⚠️ MONEY. fetchOwnerReceivablePayoutRows uses this to skip any IVOWN charge
      // Source 2 has ALREADY booked as a ledger expense — the management fee. Without
      // it that dedupe set is empty and the fee is deducted twice on this card.
      sourceChargeId: true,
      // I-2: propertyId is required to resolve the per-income-line management fee
      // (property-specific config overrides the all-properties default) inside
      // computeOwnerPayout, so the card's net payout matches the statement.
      propertyId: true,
    },
    orderBy: { statementMonth: "desc" },
  });

  if (entries.length === 0) {
    return { ok: true as const, status: 200, data: { items: [] } };
  }

  // 2. Group by statementMonth (ISO string key)
  const monthMap = new Map<string, typeof entries>();
  for (const e of entries) {
    const key = `${e.statementMonth.getUTCFullYear()}-${String(e.statementMonth.getUTCMonth() + 1).padStart(2, "0")}`;
    const arr = monthMap.get(key) ?? [];
    arr.push(e);
    monthMap.set(key, arr);
  }

  // 3. Fetch all owner-statements for this owner in this org
  const statements = await db.invoice.findMany({
    where: {
      organizationId: actor.orgId,
      ownerPartyId,
      invoiceType: "owner_statement",
      ...(yearFilter ? { periodMonth: yearFilter } : {}),
      ...(apartmentId ? { apartmentId } : {}),
    },
    select: { id: true, periodMonth: true, status: true },
  });

  // Build month → { statementId, statementStatus } map
  const stmtByMonth = new Map<string, { id: string; status: string }>();
  for (const stmt of statements) {
    if (!stmt.periodMonth) continue;
    const key = `${stmt.periodMonth.getUTCFullYear()}-${String(stmt.periodMonth.getUTCMonth() + 1).padStart(2, "0")}`;
    stmtByMonth.set(key, { id: stmt.id, status: stmt.status });
  }

  // G5: resolve the owner's non-archived units (same listing set
  // assembleYannieStatement uses) so the per-month deposit-collected matches the
  // statement. Deposits are NOT ledger rows — they live on the Deposit table keyed
  // by collection month (createdAt).
  const ownedListings = await db.listing.findMany({
    where: { ownerPartyId, organizationId: actor.orgId, listingStatus: { not: "archived" }, ...(apartmentId ? { apartmentId } : {}) },
    select: { id: true },
  });
  const unitIds = ownedListings.map((l) => l.id);

  // I-2: the owner's active ManagementFeeConfig rows — fetched once, then resolved
  // per income line inside computeOwnerPayout (the SAME helper assembleYannieStatement
  // uses) so the card's netPayoutToOwner equals the statement's Total Payout, INCLUDING
  // pre-statement months (the per-line mgmt fee is COMPUTED, never read from ledger rows).
  const feeConfigRows = await db.managementFeeConfig.findMany({
    where: { organizationId: actor.orgId, ownerPartyId, isActive: true },
    select: { propertyId: true, feeType: true, feeValue: true, capAmount: true, sstPercent: true, updatedAt: true },
  });

  // 4. Build MonthlyStatementSummary per month
  const items: MonthlyStatementSummary[] = [];
  for (const [month, monthEntries] of monthMap) {
    const lines: OwnerLedgerLine[] = monthEntries.map((e) => ({
      direction: e.direction as "income" | "expense" | "payout",
      category: e.category,
      amount: e.amount.toString(),
      sstAmount: e.sstAmount != null ? e.sstAmount.toString() : null,
      includeInPayout: e.includeInPayout,
      taxCategory: e.taxCategory,
    }));

    const summary = summarizeOwnerPeriod(lines);
    const stmt = stmtByMonth.get(month);

    // G5: deposit collected this month — SAME [first-of-month, end-of-day-inclusive
    // last-of-month] window assembleYannieStatement uses (shared
    // depositWindowEndOfMonth), so the card and the statement agree and a last-day
    // deposit is attributed to this month, not the next (M-C1).
    const [my, mm] = month.split("-").map(Number);
    const monthStart = new Date(Date.UTC(my!, mm! - 1, 1));
    const monthEnd = depositWindowEndOfMonth(monthStart);
    const depositRows =
      unitIds.length > 0
        ? await findDepositsCollectedInMonth(actor.orgId, unitIds, monthStart, monthEnd)
        : [];
    const depositC = depositRows.reduce(
      (acc, r) => acc + toCents(r.amount, "getOwnerMonthsService"),
      0,
    );

    // I-2: netPayoutToOwner = the statement's "Total Payout to Owner" — collected
    // income + deposit collected − (deductible expenses + Σ per-line computed mgmt
    // fee). summarizeOwnerPeriod().netPayoutToOwner OMITS the deposit AND the per-line
    // fee (which the statement COMPUTES, not reads from ledger rows), so a pre-statement
    // card would OVERSTATE the payout and an admin acting on it would overpay. The
    // shared computeOwnerPayout makes the card and the statement agree by construction.
    // Owner-borne IVOWN costs for THIS month. Not ledger rows (the durable XOR keeps
    // a charge with a live IVOWN line out of Source 6), but money the owner bears —
    // and this card is the Live Ledger Summary the admin reads. Fetched through the
    // SAME helper the statement uses, so the two cannot drift.
    const receivableRows = await fetchOwnerReceivablePayoutRows(
      actor.orgId,
      ownerPartyId,
      monthStart,
      apartmentId ?? null, // optional param here; the helper's scope arg is nullable
      monthEntries,
    );

    const payout = computeOwnerPayout({
      rows: [...monthEntries, ...receivableRows] as typeof monthEntries,
      feeConfigRows,
      depositCollectedC: depositC,
    });

    items.push({
      month,
      grossRental: summary.grossRental,
      totalExpenses: summary.totalExpenses,
      netPayoutToOwner: centsToString(payout.totalPayoutC),
      depositCollected: centsToString(depositC),
      statementId: stmt?.id ?? null,
      statementStatus: stmt?.status ?? null,
      hasData: monthEntries.length > 0,
    });
  }

  // Sort by month descending (newest first)
  items.sort((a, b) => b.month.localeCompare(a.month));

  return { ok: true as const, status: 200, data: { items } };
}

// ─── Units summary (Task 5) ───────────────────────────────────────────────────

/**
 * Wire-safe per-unit payout shape used by the units-summary endpoint.
 * All money values are 2dp decimal strings (same convention as other endpoints).
 */
export type UnitPayout = {
  /** Income collected (grossRentalC) — 2dp string. */
  incomeCollected: string;
  /** Deposit collected in-month — 2dp string. */
  depositCollected: string;
  /** Total deductible expenses (mgmt fee + non-fee deductibles) — 2dp string. */
  deductibleExpenses: string;
  /** Net payout to owner = incomeCollected + depositCollected − deductibleExpenses — 2dp string. */
  netPayout: string;
};

export type UnitPayoutRow = UnitPayout & {
  /** null only for the synthetic "Unassigned / property-level" residual bucket. */
  apartmentId: string | null;
  unitCode: string;
};

export type UnitsSummaryData = {
  month: string;
  /** Owner-combined payout (all apartments). null when no rows exist for this month. */
  combined: UnitPayout | null;
  /** Per-apartment breakdown. Empty when no rows exist for this month. */
  units: UnitPayoutRow[];
};

/**
 * Return per-apartment + combined payout summaries for an owner in a given month.
 * Converges with `getOwnerMonthsService` — the combined.netPayout EQUALS
 * the netPayoutToOwner card for the same month (both flow through
 * `resolveOwnerPayoutForScope` → `computeOwnerPayout`).
 *
 * DRY over micro-opt: loops `resolveOwnerPayoutForScope` per apartment — reuses
 * the tested shared helper. An owner has a bounded handful of apartments so this
 * is not a real N+1 hotspot.
 */
export async function getUnitsSummaryService(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  month: string,
): Promise<ServiceResult<UnitsSummaryData>> {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false as const, status: 400, error: `Invalid month "${month}" — expected YYYY-MM` };
  }

  const db = getDb();

  // 1. Resolve the owner's DISTINCT apartments that have active listings for any month.
  //    We include ALL non-archived listings (not month-filtered) so we show all units
  //    the owner ever had, consistent with getOwnerMonthsService's listing fetch.
  const ownedListings = await db.listing.findMany({
    where: {
      organizationId: ctx.orgId,
      ownerPartyId,
      listingStatus: { not: "archived" },
    },
    select: { apartmentId: true },
    distinct: ["apartmentId"],
  });

  // Fetch apartment unitCodes for display labels.
  const distinctApartmentIds = ownedListings.map((l) => l.apartmentId).filter((id): id is string => id != null);

  const apartments =
    distinctApartmentIds.length > 0
      ? await db.apartment.findMany({
          where: { id: { in: distinctApartmentIds }, organizationId: ctx.orgId },
          select: { id: true, unitCode: true },
        })
      : [];

  // 2. Per-apartment payout (loop — bounded, single digits at most).
  //    Track accumulated cents so we can compute the NULL-apartment residual below.
  const units: UnitPayoutRow[] = [];
  let sumGrossRentalC = 0;
  let sumDepositCollectedC = 0;
  let sumDeductibleExpensesC = 0;
  let sumTotalPayoutC = 0;

  for (const apt of apartments) {
    const breakdown = await resolveOwnerPayoutForScope(ctx, ownerPartyId, month, apt.id);
    if (!breakdown) continue; // No rows for this apartment in this month — omit.
    sumGrossRentalC       += breakdown.grossRentalC;
    sumDepositCollectedC  += breakdown.depositCollectedC;
    sumDeductibleExpensesC += breakdown.deductibleExpensesC;
    sumTotalPayoutC       += breakdown.totalPayoutC;
    units.push({
      apartmentId: apt.id,
      unitCode: apt.unitCode,
      incomeCollected: centsToString(breakdown.grossRentalC),
      depositCollected: centsToString(breakdown.depositCollectedC),
      deductibleExpenses: centsToString(breakdown.deductibleExpensesC),
      netPayout: centsToString(breakdown.totalPayoutC),
    });
  }

  // 3. Owner-combined payout (apartmentId = null). This is the canonical number —
  //    NOT a sum of unit payouts, which would introduce per-unit rounding drift.
  const combinedBreakdown = await resolveOwnerPayoutForScope(ctx, ownerPartyId, month, null);
  const combined: UnitPayout | null = combinedBreakdown
    ? {
        incomeCollected: centsToString(combinedBreakdown.grossRentalC),
        depositCollected: centsToString(combinedBreakdown.depositCollectedC),
        deductibleExpenses: centsToString(combinedBreakdown.deductibleExpensesC),
        netPayout: centsToString(combinedBreakdown.totalPayoutC),
      }
    : null;

  // 4. Compute the residual: combined may include ledger rows with apartmentId IS NULL
  //    (e.g. property-level charges like fire insurance). These rows land in combined
  //    but in no apartment bucket, so without this step Σ(units).netPayout < combined.netPayout.
  //    computeOwnerPayout is LINEAR across row partitions, so residual = combined − Σ(apt buckets)
  //    per field, EXACTLY. Append an "Unassigned / property-level" entry when non-zero.
  if (combinedBreakdown) {
    const residualIncomeC      = combinedBreakdown.grossRentalC       - sumGrossRentalC;
    const residualDepositC     = combinedBreakdown.depositCollectedC  - sumDepositCollectedC;
    const residualDeductibleC  = combinedBreakdown.deductibleExpensesC - sumDeductibleExpensesC;
    const residualNetC         = combinedBreakdown.totalPayoutC       - sumTotalPayoutC;
    if (residualIncomeC !== 0 || residualDepositC !== 0 || residualDeductibleC !== 0 || residualNetC !== 0) {
      units.push({
        apartmentId: null,
        unitCode: "Unassigned / property-level",
        incomeCollected: centsToString(residualIncomeC),
        depositCollected: centsToString(residualDepositC),
        deductibleExpenses: centsToString(residualDeductibleC),
        netPayout: centsToString(residualNetC),
      });
    }
  }

  return { ok: true as const, status: 200, data: { month, combined, units } };
}

// ─── Org-wide units summary (P4 unit-first ledger) ────────────────────────────

export type OrgUnitSummaryRow = {
  /** null only for the per-property "Unassigned / property-level" residual row. */
  apartmentId: string | null;
  /** null only for the residual row (client renders "Unassigned / property-level"). */
  unitCode: string | null;
  propertyId: string;
  propertyName: string;
  ownerPartyId: string | null;
  ownerName: string | null;
  occupancy: { activeTenancies: number };
  /**
   * 2dp strings. income = collected income (grossRentalC); expenses =
   * deductible expenses; netPayout = computeOwnerPayout totalPayoutC — the SAME
   * engine the statement uses (reuse manifest: no parallel payout math).
   */
  figures: { income: string; expenses: string; netPayout: string };
  /** The month's PER-UNIT owner statement (Invoice keyed by apartmentId), non-void, if any. */
  statement: { id: string; status: string } | null;
  /** BillingDocuments for this unit+month still open (issued|partially_settled). 0 while ENABLE_PHASE2_BILLING_DOCS is dark. */
  openDocuments: number;
};

export type OrgUnitsSummaryQuery = {
  /** First-of-month date string ("YYYY-MM-01") per the P4 interface contract. */
  month: string;
  q?: string;
  propertyId?: string;
  page: number;
  pageSize: number;
};

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return results;
}

/**
 * Org-wide, paginated, unit-first month summary — the Units-tab front door.
 * Cross-owner generalization of `getUnitsSummaryService` (per the reuse
 * manifest): the figures per apartment come from the SAME
 * `resolveOwnerPayoutForScope` → `computeOwnerPayout` engine, untouched.
 *
 * Base set = ALL apartments in the org (unit search must land even when the
 * month has no data yet). `q` = case-insensitive contains on unitCode OR
 * property name. Read-through sync materialises each VISIBLE apartment's
 * owner-month first (bounded concurrency 4; the hook is flag-gated and never
 * throws, so a sync failure can never 500 this read).
 *
 * "Unassigned / property-level" residual rows (apartmentId null ledger rows,
 * e.g. fire insurance) are APPENDED per (owner, property) NULL-apartment
 * partition present on the page's PROPERTIES when non-zero, via the SAME
 * payout engine (see `resolvePropertyResidualBreakdown`); they do not count
 * toward `total`.
 */
export async function getOrgUnitsSummaryService(
  ctx: OwnerBillingActorCtx,
  query: OrgUnitsSummaryQuery,
): Promise<ServiceResult<{ items: OrgUnitSummaryRow[]; total: number }>> {
  if (!/^\d{4}-\d{2}-01$/.test(query.month)) {
    return {
      ok: false as const,
      status: 400,
      error: `Invalid month "${query.month}" — expected YYYY-MM-01`,
    };
  }
  const monthKey = query.month.slice(0, 7); // "YYYY-MM"
  const [y, m] = monthKey.split("-").map(Number);
  const monthStart = new Date(Date.UTC(y!, m! - 1, 1));

  const db = getDb();

  // 1. Page of apartments (org-wide unit directory).
  const where: Prisma.ApartmentWhereInput = {
    organizationId: ctx.orgId,
    ...(query.propertyId ? { propertyId: query.propertyId } : {}),
    ...(query.q
      ? {
          OR: [
            { unitCode: { contains: query.q, mode: "insensitive" } },
            { property: { name: { contains: query.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  // Deterministic global order (Finding 2): id:asc breaks ties when property
  // name + unitCode collide so pages never repeat or skip a row. Reused below
  // (Finding 3) for the boundary-property check — both MUST agree on the
  // exact same ordering for that check to be valid.
  const apartmentOrderBy: Prisma.ApartmentOrderByWithRelationInput[] = [
    { property: { name: "asc" } },
    { propertyId: "asc" },
    { unitCode: "asc" },
    { id: "asc" },
  ];
  const [apartments, total] = await Promise.all([
    db.apartment.findMany({
      where,
      select: {
        id: true,
        unitCode: true,
        propertyId: true,
        property: { select: { name: true } },
      },
      orderBy: apartmentOrderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    db.apartment.count({ where }),
  ]);
  const aptIds = apartments.map((a) => a.id);

  const useMaterialized =
    isPhase2FlagEnabled("ENABLE_PHASE2_OWNER_BILLING") &&
    isPhase2FlagEnabled("ENABLE_UNIT_MONTH_LEDGER");

  if (!useMaterialized) {
    // ── Legacy step 2: read-through sync ──────────────────────────────────
    await mapWithConcurrency(apartments, 4, (apt) =>
      syncOwnerLedgerForApartmentMonth(ctx.orgId, ctx.actorUserId, ctx.actorRole, apt.id, monthStart),
    );
  }

  // 3. Owner + occupancy per apartment from non-archived listings. The
  //    apartment-wide owner-propagation guard means all rooms share ONE owner —
  //    take the first non-null ownerPartyId.
  const listings =
    aptIds.length > 0
      ? await db.listing.findMany({
          where: {
            organizationId: ctx.orgId,
            apartmentId: { in: aptIds },
            listingStatus: { not: "archived" },
          },
          select: {
            apartmentId: true,
            ownerPartyId: true,
            tenancies: { where: { status: "active" }, select: { id: true } },
          },
        })
      : [];
  const ownerByApt = new Map<string, string>();
  const tenancyCountByApt = new Map<string, number>();
  for (const l of listings) {
    if (l.ownerPartyId && !ownerByApt.has(l.apartmentId)) ownerByApt.set(l.apartmentId, l.ownerPartyId);
    tenancyCountByApt.set(l.apartmentId, (tenancyCountByApt.get(l.apartmentId) ?? 0) + l.tenancies.length);
  }
  const ownerIds = [...new Set(ownerByApt.values())];
  const parties =
    ownerIds.length > 0
      ? await db.party.findMany({
          where: { id: { in: ownerIds }, organizationId: ctx.orgId },
          select: { id: true, displayName: true },
        })
      : [];
  const ownerNames = new Map(parties.map((p) => [p.id, p.displayName]));

  // 4. Figures per apartment: materialized (flag ON) or live payout engine (flag OFF).
  let figures: Map<string, { income: string; expenses: string; netPayout: string }>;

  if (useMaterialized) {
    // ── Materialized path ────────────────────────────────────────────────
    const ledgerRows =
      aptIds.length > 0
        ? await db.unitMonthLedger.findMany({
            where: {
              organizationId: ctx.orgId,
              periodMonth: monthStart,
              apartmentId: { in: aptIds },
            },
            select: {
              apartmentId: true,
              incomeC: true,
              deductibleExpensesC: true,
              netPayoutC: true,
            },
          })
        : [];
    const figByApt = new Map(ledgerRows.map((r) => [r.apartmentId, r]));

    // Lazy fallback for owned apartments missing a materialized row (bounded to this page).
    const missingOwned = apartments.filter(
      (a) => ownerByApt.get(a.id) && !figByApt.has(a.id),
    );
    if (missingOwned.length > 0) {
      const ownersToSync = [...new Set(missingOwned.map((a) => ownerByApt.get(a.id)!))];
      await mapWithConcurrency(ownersToSync, 4, (ownerId) =>
        syncOwnerLedgerForOwnerMonth(ctx.orgId, ctx.actorUserId, ctx.actorRole, ownerId, monthStart),
      );
      const refill = await db.unitMonthLedger.findMany({
        where: {
          organizationId: ctx.orgId,
          periodMonth: monthStart,
          apartmentId: { in: missingOwned.map((a) => a.id) },
        },
        select: {
          apartmentId: true,
          incomeC: true,
          deductibleExpensesC: true,
          netPayoutC: true,
        },
      });
      for (const r of refill) figByApt.set(r.apartmentId, r);
    }

    figures = new Map(
      apartments.map((apt) => {
        // Only trust a materialized row for an apartment that currently HAS an
        // owner. An unowned apartment must read zero even if a stale row lingers
        // (defense-in-depth for owner-clear; matches the legacy no-owner→zero).
        const f = ownerByApt.get(apt.id) ? figByApt.get(apt.id) : undefined;
        return [
          apt.id,
          {
            income: centsToString(f?.incomeC ?? 0),
            expenses: centsToString(f?.deductibleExpensesC ?? 0),
            netPayout: centsToString(f?.netPayoutC ?? 0),
          },
        ];
      }),
    );
  } else {
    // ── Legacy step 4: per-apartment payout via the ONE payout engine ────
    const breakdowns = await mapWithConcurrency(apartments, 4, async (apt) => {
      const owner = ownerByApt.get(apt.id);
      if (!owner) return null;
      return resolveOwnerPayoutForScope(ctx, owner, monthKey, apt.id);
    });
    figures = new Map(
      apartments.map((apt, i) => {
        const b = breakdowns[i] ?? null;
        return [
          apt.id,
          {
            income: centsToString(b?.grossRentalC ?? 0),
            expenses: centsToString(b?.deductibleExpensesC ?? 0),
            netPayout: centsToString(b?.totalPayoutC ?? 0),
          },
        ];
      }),
    );
  }

  // 5. Per-unit statements (non-void; Invoice.status is non-nullable so bare
  //    `not` is null-safe here) + open documents for the visible page.
  const [statements, docGroups] = await Promise.all([
    aptIds.length > 0
      ? db.invoice.findMany({
          where: {
            organizationId: ctx.orgId,
            invoiceType: "owner_statement",
            periodMonth: monthStart,
            apartmentId: { in: aptIds },
            status: { not: "void" },
          },
          select: { id: true, status: true, apartmentId: true },
        })
      : Promise.resolve([]),
    aptIds.length > 0
      ? db.billingDocument.groupBy({
          by: ["apartmentId"],
          where: {
            organizationId: ctx.orgId,
            apartmentId: { in: aptIds },
            billingMonth: monthStart,
            status: { in: ["issued", "partially_settled"] },
            // A proforma is a REQUEST for payment, not an open receivable, and its
            // `status` is written "issued" at mint and never re-derived
            // (isNonReceivableDocType short-circuits refreshDocumentStatusForCharges).
            // Counted here it never returns to zero — and while a proforma and the
            // invoice graduated from it are both live, it counts the same money twice.
            docType: { not: "proforma" },
          },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ apartmentId: string | null; _count: { _all: number } }>),
  ]);
  const stmtByApt = new Map<string, { id: string; status: string }>();
  for (const s of statements) {
    if (s.apartmentId) stmtByApt.set(s.apartmentId, { id: s.id, status: s.status });
  }
  const openDocsByApt = new Map<string, number>();
  for (const g of docGroups) {
    if (g.apartmentId) openDocsByApt.set(g.apartmentId, g._count._all);
  }

  const items: OrgUnitSummaryRow[] = apartments.map((apt) => {
    const owner = ownerByApt.get(apt.id) ?? null;
    const f = figures.get(apt.id) ?? { income: "0.00", expenses: "0.00", netPayout: "0.00" };
    return {
      apartmentId: apt.id,
      unitCode: apt.unitCode,
      propertyId: apt.propertyId,
      propertyName: apt.property.name,
      ownerPartyId: owner,
      ownerName: owner ? (ownerNames.get(owner) ?? null) : null,
      occupancy: { activeTenancies: tenancyCountByApt.get(apt.id) ?? 0 },
      figures: f,
      statement: stmtByApt.get(apt.id) ?? null,
      openDocuments: openDocsByApt.get(apt.id) ?? 0,
    };
  });

  // 6. "Unassigned / property-level" residual footer rows — one row per
  //    (owner, property) NULL-apartment partition present this month,
  //    computed via the SAME payout engine as everything else in this
  //    function (Finding 1: no parallel fee/SST math — the pre-fix code
  //    derived residual as raw incomeC − payoutExpenseC, which both
  //    overstated netPayout for a NULL-apartment INCOME row (no mgmt
  //    fee/SST applied) AND gave `expenses` GROSS semantics here vs
  //    DEDUCTIBLE-ONLY on the unit rows above). `resolvePropertyResidualBreakdown`
  //    fixes both: `figures.expenses` is deductibleExpensesC, matching the
  //    unit rows exactly.
  //
  //    Finding 3 — a property whose apartments span a page boundary must NOT
  //    repeat its residual row on every page it appears on. `apartments` is
  //    ordered by `apartmentOrderBy` above with property.name as the PRIMARY
  //    key, so one property's apartments are always CONTIGUOUS in the global
  //    order. A property's residual therefore belongs on this page only when
  //    this page contains that property's block START — i.e. the apartment
  //    immediately BEFORE this page (same order + filter) belongs to a
  //    DIFFERENT property (or there is no such apartment: page 1).
  const pagePropertyIds = [...new Set(apartments.map((a) => a.propertyId))];
  let propertiesEligibleForResidual: string[] = [];
  if (pagePropertyIds.length > 0) {
    let precedingPropertyId: string | null = null;
    const pageStartOffset = (query.page - 1) * query.pageSize;
    if (pageStartOffset > 0) {
      const preceding = await db.apartment.findFirst({
        where,
        orderBy: apartmentOrderBy,
        skip: pageStartOffset - 1,
        select: { propertyId: true },
      });
      precedingPropertyId = preceding?.propertyId ?? null;
    }
    const firstPropertyIdOnPage = apartments[0]!.propertyId;
    propertiesEligibleForResidual = pagePropertyIds.filter(
      (pid) => pid !== firstPropertyIdOnPage || precedingPropertyId !== firstPropertyIdOnPage,
    );
  }
  if (propertiesEligibleForResidual.length > 0) {
    const nullAptPartitionsRaw = await db.ownerLedgerEntry.findMany({
      where: {
        organizationId: ctx.orgId,
        status: "active",
        statementMonth: monthStart,
        apartmentId: null,
        propertyId: { in: propertiesEligibleForResidual },
      },
      select: { propertyId: true, ownerPartyId: true },
      distinct: ["propertyId", "ownerPartyId"],
    });
    // Task 6a: propertyId is now nullable on OwnerLedgerEntry (an owner-level
    // Phase-2 remittance payout spanning multiple properties carries no single
    // propertyId). The `propertyId: { in: [...] }` filter above never matches a
    // NULL propertyId in Postgres, so this narrowing is a runtime no-op — it
    // exists to (a) satisfy the type system now that the column is nullable,
    // and (b) make explicit that a cross-property/owner-level payout must NEVER
    // be attributed to one property's residual row here (a property-specific
    // view correctly excludes a null-propertyId entry; that breakdown instead
    // comes from OwnerRemittanceAllocation rows in a later task).
    const nullAptPartitions = nullAptPartitionsRaw.filter(
      (p): p is typeof p & { propertyId: string } => p.propertyId !== null,
    );
    if (nullAptPartitions.length > 0) {
      const propertyNameById = new Map(apartments.map((a) => [a.propertyId, a.property.name]));
      const residualOwnerIds = [...new Set(nullAptPartitions.map((p) => p.ownerPartyId))];
      const residualPropertyIds = [...new Set(nullAptPartitions.map((p) => p.propertyId))];
      const [breakdowns, unassignedDocs, residualOwnerParties] = await Promise.all([
        mapWithConcurrency(nullAptPartitions, 4, (p) =>
          resolvePropertyResidualBreakdown(ctx, p.ownerPartyId, p.propertyId, monthStart),
        ),
        db.billingDocument.groupBy({
          by: ["propertyId"],
          where: {
            organizationId: ctx.orgId,
            apartmentId: null,
            propertyId: { in: residualPropertyIds },
            billingMonth: monthStart,
            status: { in: ["issued", "partially_settled"] },
            // A proforma is a REQUEST for payment, not an open receivable, and its
            // `status` is written "issued" at mint and never re-derived
            // (isNonReceivableDocType short-circuits refreshDocumentStatusForCharges).
            // Counted here it never returns to zero — and while a proforma and the
            // invoice graduated from it are both live, it counts the same money twice.
            docType: { not: "proforma" },
          },
          _count: { _all: true },
        }),
        db.party.findMany({
          where: { id: { in: residualOwnerIds }, organizationId: ctx.orgId },
          select: { id: true, displayName: true },
        }),
      ]);
      const unassignedDocsByProperty = new Map<string, number>();
      for (const g of unassignedDocs) {
        if (g.propertyId) unassignedDocsByProperty.set(g.propertyId, g._count._all);
      }
      const residualOwnerNames = new Map(residualOwnerParties.map((p) => [p.id, p.displayName]));
      nullAptPartitions.forEach((p, i) => {
        const b = breakdowns[i];
        if (!b) return; // rows voided between the distinct query and the read — omit defensively.
        if (b.grossRentalC === 0 && b.deductibleExpensesC === 0 && b.totalPayoutC === 0) return;
        items.push({
          apartmentId: null,
          unitCode: null,
          propertyId: p.propertyId,
          propertyName: propertyNameById.get(p.propertyId) ?? p.propertyId,
          ownerPartyId: p.ownerPartyId,
          ownerName: residualOwnerNames.get(p.ownerPartyId) ?? null,
          occupancy: { activeTenancies: 0 },
          figures: {
            income: centsToString(b.grossRentalC),
            expenses: centsToString(b.deductibleExpensesC),
            netPayout: centsToString(b.totalPayoutC),
          },
          statement: null,
          openDocuments: unassignedDocsByProperty.get(p.propertyId) ?? 0,
        });
      });
    }
  }

  return { ok: true as const, status: 200, data: { items, total } };
}

/**
 * Compute the payout breakdown for ONE (owner, property) NULL-apartment row
 * partition — the "partition-engine" building block for the org-wide
 * units-summary's residual row (Finding 1). `computeOwnerPayout` is LINEAR
 * across row partitions: each income line's management fee/SST is resolved
 * from that line's OWN amount + property, independent of every other row —
 * there is no owner/month aggregate cap in the formula (see
 * `computeOwnerPayout`'s per-line `lineFees` loop). Running it over just this
 * partition's rows is therefore EXACTLY equal to
 * `combined(owner, month) − Σ(that owner's per-apartment buckets)`, without
 * needing to fetch the owner's other apartments (which the org-wide,
 * apartment-paginated caller does not otherwise have on hand).
 *
 * Deposits are NOT included: a NULL-apartment row carries no Listing/unit, so
 * this partition never contributes a deposit component (matches
 * `getUnitsSummaryService`'s residual, which is also deposit-free by
 * construction since deposits only exist per-unit).
 *
 * Returns `null` when the partition has no active rows for this month.
 */
async function resolvePropertyResidualBreakdown(
  ctx: OwnerBillingActorCtx,
  ownerPartyId: string,
  propertyId: string,
  monthStart: Date,
): Promise<OwnerPayoutBreakdown | null> {
  const db = getDb();
  const rows = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: ctx.orgId,
      ownerPartyId,
      propertyId,
      apartmentId: null,
      statementMonth: monthStart,
      status: "active",
    },
    orderBy: [{ direction: "asc" }, { category: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) return null;

  const feeConfigRows = await db.managementFeeConfig.findMany({
    where: { organizationId: ctx.orgId, ownerPartyId, isActive: true },
    select: {
      propertyId: true,
      feeType: true,
      feeValue: true,
      capAmount: true,
      sstPercent: true,
      updatedAt: true,
    },
  });

  return computeOwnerPayout({ rows, feeConfigRows, depositCollectedC: 0 });
}

// ─── Apartment context (P4 unit workspace resolve) ───────────────────────────

export type ApartmentContext = {
  apartmentId: string;
  unitCode: string;
  listingMode: string;
  propertyId: string;
  propertyName: string;
  /** First non-null Listing.ownerPartyId (apartment-wide propagation guard ⇒ single owner). */
  ownerPartyId: string | null;
  ownerName: string | null;
  /** One entry per occupied room (active Tenancy). Empty when fully vacant. */
  activeTenancies: Array<{
    tenancyId: string;
    listingId: string;
    listingType: string;
    /** The occupying tenant's Party id — pins ChargeForm's bill-to party to
     *  the tenancy chosen in the workspace's own picker (never an org-wide
     *  re-pick that could target the wrong room's tenant). */
    tenantPartyId: string;
    tenantDisplayName: string;
  }>;
};

/**
 * Resolve the unit workspace's header context + the inverted unit-first
 * cascade for EntryFormDrawer / ChargeForm: apartment → property, owner, and
 * the active tenancies of its non-archived rooms. Org-scoped; cross-org ids
 * resolve to 404.
 */
export async function getApartmentContextService(
  actor: OwnerLedgerActorCtx,
  apartmentId: string,
): Promise<ServiceResult<ApartmentContext>> {
  const db = getDb();
  const apt = await db.apartment.findFirst({
    where: { id: apartmentId, organizationId: actor.orgId },
    select: {
      id: true,
      unitCode: true,
      listingMode: true,
      propertyId: true,
      property: { select: { name: true } },
      listings: {
        where: { listingStatus: { not: "archived" } },
        select: {
          id: true,
          listingType: true,
          ownerPartyId: true,
          tenancies: {
            where: { status: "active" },
            select: { id: true, tenantParty: { select: { id: true, displayName: true } } },
            take: 1,
          },
        },
      },
    },
  });
  if (!apt) return { ok: false as const, status: 404, error: "Not found" };

  const ownerPartyId = apt.listings.find((l) => l.ownerPartyId)?.ownerPartyId ?? null;
  let ownerName: string | null = null;
  if (ownerPartyId) {
    const party = await db.party.findFirst({
      where: { id: ownerPartyId, organizationId: actor.orgId },
      select: { displayName: true },
    });
    ownerName = party?.displayName ?? null;
  }

  const activeTenancies = apt.listings.flatMap((l) => {
    const t = l.tenancies[0];
    return t
      ? [
          {
            tenancyId: t.id,
            listingId: l.id,
            listingType: l.listingType,
            tenantPartyId: t.tenantParty.id,
            tenantDisplayName: t.tenantParty.displayName,
          },
        ]
      : [];
  });

  return {
    ok: true as const,
    status: 200,
    data: {
      apartmentId: apt.id,
      unitCode: apt.unitCode,
      listingMode: apt.listingMode,
      propertyId: apt.propertyId,
      propertyName: apt.property.name,
      ownerPartyId,
      ownerName,
      activeTenancies,
    },
  };
}

// ─── Recompute (Task 8) ───────────────────────────────────────────────────────

/**
 * Manual escape hatch: re-materializes UnitMonthLedger figures for a given
 * month on demand. Accepts "YYYY-MM" or "YYYY-MM-01" (normalized to "YYYY-MM").
 * When `ownerPartyId` is provided, recomputes only that owner; otherwise
 * recomputes all owners with active OwnerLedgerEntry rows for the org + month.
 */
export async function recomputeUnitMonthLedgerService(
  ctx: OwnerBillingActorCtx,
  input: { month: string; ownerPartyId?: string },
): Promise<ServiceResult<{ recomputed: number }>> {
  const monthKey = input.month.slice(0, 7); // normalize "YYYY-MM-01" → "YYYY-MM"
  if (!/^\d{4}-\d{2}$/.test(monthKey))
    return { ok: false as const, status: 400, error: "Invalid month" };

  const db = getDb();
  let owners: string[];
  if (input.ownerPartyId) {
    owners = [input.ownerPartyId];
  } else {
    const [y, m] = monthKey.split("-").map(Number);
    const monthStart = new Date(Date.UTC(y!, m! - 1, 1));
    const grp = await db.ownerLedgerEntry.groupBy({
      by: ["ownerPartyId"],
      where: { organizationId: ctx.orgId, status: "active", statementMonth: monthStart },
    });
    owners = grp.map((g) => g.ownerPartyId);
  }

  let recomputed = 0;
  for (const o of owners) {
    const r = await materializeOwnerUnitMonths(ctx, o, monthKey);
    recomputed += r.upserted;
  }
  return { ok: true as const, status: 200, data: { recomputed } };
}
