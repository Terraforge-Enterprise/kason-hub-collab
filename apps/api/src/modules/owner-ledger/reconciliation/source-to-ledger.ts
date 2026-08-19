/**
 * R5 — Reconciliation Check #1: source-to-ledger.
 *
 * Independently re-derives, from the money SOURCES (owner Charges + charged
 * UnitUtilityBills billed into a FROZEN owner-statement month), what the owner
 * ledger SHOULD contain, then asserts:
 *   (a) a valid normal (or prior_period_adjustment) ledger row exists for each
 *       source  →  else `missing_ledger_row` (Families 1/2: a source with no row);
 *   (b) the collected-cash identity for income sources
 *         current_effective_allocated(charge)
 *           == frozen_collected + Σ prior_period_collection − Σ prior_period_collection_reversal
 *       (all integer cents)  →  else `stale_collected_amount` (Family 3).
 *
 * READ-ONLY w.r.t. money — writes ONLY reconciliation findings. Runs INDEPENDENT
 * of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER (spec R10): it only reads owner data
 * and, when there are no frozen periods, returns trivially clean. Per-owner/period
 * isolation: one period's scan error cannot abort the sweep.
 */
import { getDb } from "@kason/db";
import { CASH_ALLOCATION_WHERE } from "@kason/shared";
import { netAdjustmentsByChargeId } from "../net-adjustments-by-charge";
import { signedToCents } from "../owner-ledger.repository";
import { expectedStatementLedgerRows } from "../owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import { FORWARD_SOURCE_TYPES } from "../owner-ledger.types";
import { autoResolveStale, findingKey, upsertFinding, type FindingUpsertInput } from "./findings-repo";

export interface RunReconResult {
  sourcesScanned: number;
  findingsOpened: number;
  findingsResolved: number;
}

/**
 * Income charge types the sync books 1:1 as an owner-ledger row whose amount is the
 * COLLECTED figure (charge.amount − outstanding). chargeType → the sync's sourceType.
 * These are the sources the collected-cash identity applies to.
 */
const INCOME_CHARGE_SOURCE_TYPE: Record<string, string> = {
  rent: "rent",
  carpark: "carpark",
  utility: "tenant_utility",
  aircond: "tenant_aircond",
};

/**
 * Per-category GROSS supplier-bill rows the sync books from a CHARGED UnitUtilityBill
 * (mirrors owner-ledger.sync's UTILITY_BILL_CATEGORY_ROWS). Each positive category on a
 * charged bill must have exactly one active expense ledger row.
 */
const UTILITY_BILL_CATEGORY_ROWS: ReadonlyArray<{
  field: "tnbTotal" | "airSelangor" | "indahWater" | "wifi";
  sourceType: string;
}> = [
  { field: "tnbTotal", sourceType: "utility_tnb" },
  { field: "airSelangor", sourceType: "utility_water" },
  { field: "indahWater", sourceType: "utility_indah_water" },
  { field: "wifi", sourceType: "utility_wifi" },
];

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function lastOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/**
 * Current effective allocated cash for a charge = Σ PaymentAllocation.allocatedAmount
 * − Σ PaymentAllocationReversal.amount (append-only event-sourcing), in integer cents.
 * For an income charge this equals the CURRENT collected figure (outstanding = amount −
 * effective_allocated), so it is the left side of the R5 identity.
 */
async function effectiveAllocatedC(orgId: string, chargeId: string): Promise<number> {
  const db = getDb();
  // CASH_ALLOCATION_WHERE — "effective allocated" IS the collected figure on the
  // left of the R5 identity, so it must mean money that actually arrived. An
  // unsettled portal allocation (abandoned FPX basket, or a transfer slip an admin
  // refused) would otherwise read as collected and flag a false discrepancy.
  //
  // ⚠️ DELIBERATELY plain posted-only, unlike prior-period-collection's reversal
  // leg — do not "fix" this to match its sibling. Here the allocation and its
  // reversals drop out TOGETHER, netting 0, which is exactly the right effective
  // figure for a voided payment (the charge's outstanding is restored to match).
  // Widening it would double-count the reversal against an allocation already
  // excluded, and break the R5 equality this function exists to assert.
  const allocs = await db.paymentAllocation.findMany({
    where: { organizationId: orgId, chargeId, ...CASH_ALLOCATION_WHERE },
    select: { id: true, allocatedAmount: true },
  });
  if (allocs.length === 0) return 0;
  const allocIds = allocs.map((a) => a.id);
  const reversals = await db.paymentAllocationReversal.findMany({
    where: { organizationId: orgId, originalAllocationId: { in: allocIds } },
    select: { amount: true },
  });
  const allocC = allocs.reduce((s, a) => s + signedToCents(a.allocatedAmount.toFixed(2), "recon.alloc"), 0);
  const revC = reversals.reduce((s, r) => s + signedToCents(r.amount.toFixed(2), "recon.allocReversal"), 0);
  return allocC - revC;
}

/**
 * Net forward-posted collection for a charge across ALL months = Σ prior_period_collection
 * − Σ prior_period_collection_reversal (active rows), in integer cents. The right-side
 * "forward" term of the R5 identity.
 */
async function forwardNetC(orgId: string, ownerPartyId: string, chargeId: string): Promise<number> {
  const db = getDb();
  const fwd = await db.ownerLedgerEntry.findMany({
    where: {
      organizationId: orgId,
      ownerPartyId,
      sourceChargeId: chargeId,
      status: "active",
      sourceType: { in: ["prior_period_collection", "prior_period_collection_reversal"] },
    },
    select: { amount: true, sourceType: true },
  });
  return fwd.reduce((s, r) => {
    const c = signedToCents(r.amount.toFixed(2), "recon.forward");
    return s + (r.sourceType === "prior_period_collection" ? c : -c);
  }, 0);
}

export async function runSourceToLedger(
  ctx: OwnerLedgerActorCtx,
  filter: { ownerPartyId?: string; month?: string },
): Promise<RunReconResult> {
  const db = getDb();
  const orgId = ctx.orgId;

  // Scope: only FROZEN combined-scope periods (apartmentId=null) — the sync-hook's
  // freeze semantics. No frozen periods ⇒ nothing to check (clean).
  const monthStart = filter.month
    ? new Date(Date.UTC(Number(filter.month.split("-")[0]), Number(filter.month.split("-")[1]) - 1, 1))
    : undefined;
  const periods = await db.ownerStatementPeriod.findMany({
    where: {
      organizationId: orgId,
      status: "frozen",
      apartmentId: null,
      ...(filter.ownerPartyId ? { ownerPartyId: filter.ownerPartyId } : {}),
      ...(monthStart ? { periodMonth: monthStart } : {}),
    },
    select: { id: true, ownerPartyId: true, periodMonth: true },
  });

  let sourcesScanned = 0;
  let findingsOpened = 0;
  let findingsResolved = 0;

  for (const period of periods) {
    try {
      const ownerPartyId = period.ownerPartyId;
      const mStart = firstOfMonth(period.periodMonth);
      const mEnd = lastOfMonth(period.periodMonth);

      // Bug-3 fix (review I1): per-period emittedKeys + auto-resolve INSIDE the try
      // (mirrors frozen-integrity). A run-global emittedKeys with a single end-of-run
      // auto-resolve let a throwing period's un-emitted criticals be resolved by a
      // full-scope run (fail-OPEN → preflight false-pass). Scoping both to the period
      // contains the auto-resolve to this (owner, month) AND skips it entirely when the
      // period throws (fail-CLOSED — the still-real criticals persist).
      const emittedKeys = new Set<string>();
      const emit = async (f: FindingUpsertInput): Promise<void> => {
        emittedKeys.add(findingKey(f));
        const { opened } = await upsertFinding(f);
        if (opened) findingsOpened += 1;
      };

      // Owner's units (per-unit ownership via Listing.ownerPartyId — mirrors the sync).
      const listings = await db.listing.findMany({
        where: { ownerPartyId, organizationId: orgId, listingStatus: { not: "archived" } },
        select: { id: true, apartmentId: true },
      });
      const unitIds = listings.map((l) => l.id);
      const apartmentIds = [...new Set(listings.map((l) => l.apartmentId))];

      // Immutable frozen baseline (spec R7): frozen_collected and every frozen-side
      // value come from the write-once manifest, NEVER the mutable live row — else a
      // post-freeze amount edit could mask the very shortfall R5 exists to catch.
      // Map sourceChargeId → manifest amountC (the charge's normal booked row only).
      const manifestRows = await db.ownerStatementFreezeManifestRow.findMany({
        where: { organizationId: orgId, ownerStatementPeriodId: period.id },
        select: { sourceChargeId: true, amountC: true, sourceType: true },
      });
      const manifestByCharge = new Map<string, number>();
      for (const m of manifestRows) {
        if (m.sourceChargeId && !FORWARD_SOURCE_TYPES.includes(m.sourceType)) {
          manifestByCharge.set(m.sourceChargeId, m.amountC);
        }
      }

      // Income charges on the owner's units, billed into the frozen month (dueDate
      // window = the sync's grouping key), excluding void/credited (the sync skips them).
      const incomeCharges = unitIds.length
        ? await db.charge.findMany({
            where: {
              organizationId: orgId,
              unitId: { in: unitIds },
              chargeType: { in: Object.keys(INCOME_CHARGE_SOURCE_TYPE) },
              dueDate: { gte: mStart, lte: mEnd },
              status: { notIn: ["void", "credited"] },
            },
            select: { id: true, chargeType: true, unitId: true, amount: true, outstandingAmount: true },
          })
        : [];

      for (const charge of incomeCharges) {
        sourcesScanned += 1;
        const sourceType = INCOME_CHARGE_SOURCE_TYPE[charge.chargeType]!;
        // Expected collected for an income charge = amount − outstanding (what the sync
        // would book; also the PPA's expected magnitude).
        const expectedCollectedC =
          signedToCents(charge.amount.toFixed(2), "recon.chargeAmount") -
          signedToCents(charge.outstandingAmount.toFixed(2), "recon.chargeOutstanding");

        const normal = await db.ownerLedgerEntry.findFirst({
          where: {
            organizationId: orgId,
            ownerPartyId,
            statementMonth: mStart,
            sourceChargeId: charge.id,
            status: "active",
            sourceType: { notIn: FORWARD_SOURCE_TYPES },
          },
          select: { id: true, amount: true, direction: true, includeInPayout: true },
        });

        if (normal) {
          // Collected-cash identity (all integer cents):
          //   current_effective_allocated == frozen_collected + Σppc − Σppc_reversal
          const frozenCollectedC = manifestByCharge.has(charge.id)
            ? manifestByCharge.get(charge.id)!
            : signedToCents(normal.amount.toFixed(2), "recon.liveCollected");
          const effC = await effectiveAllocatedC(orgId, charge.id);
          const forwardC = await forwardNetC(orgId, ownerPartyId, charge.id);
          const actualC = frozenCollectedC + forwardC;
          if (effC !== actualC) {
            await emit({
              organizationId: orgId,
              ownerPartyId,
              unitId: charge.unitId ?? null,
              checkKind: "source_to_ledger",
              findingType: "stale_collected_amount",
              sourceType,
              sourceId: charge.id,
              originalBillingMonth: mStart,
              expectedDirection: normal.direction,
              expectedAmountC: effC,
              actualAmountC: actualC,
              severity: "critical",
              detailsJson: { frozenCollectedC, forwardC },
            });
          }
          continue;
        }

        // No live normal row. A legitimately backdated charge may instead be booked by an
        // authorised prior_period_adjustment (R4) in an OPEN month. Validate it: owner (scope),
        // sourceId (looked up by it), direction, amount, and posting-month must all match; else
        // it silently mis-books the owner → invalid_forward_adjustment.
        const ppa = await db.ownerLedgerEntry.findFirst({
          where: {
            organizationId: orgId,
            ownerPartyId,
            sourceChargeId: charge.id,
            status: "active",
            sourceType: "prior_period_adjustment",
          },
          select: { amount: true, direction: true, statementMonth: true },
        });
        if (ppa) {
          const ppaC = signedToCents(ppa.amount.toFixed(2), "recon.ppaAmount");
          const postingOpen = ppa.statementMonth.getTime() !== mStart.getTime(); // must NOT post into the frozen month
          const valid = ppa.direction === "income" && ppaC === expectedCollectedC && postingOpen;
          if (!valid) {
            await emit({
              organizationId: orgId,
              ownerPartyId,
              unitId: charge.unitId ?? null,
              checkKind: "source_to_ledger",
              findingType: "invalid_forward_adjustment",
              sourceType: "prior_period_adjustment",
              sourceId: charge.id,
              originalBillingMonth: mStart,
              expectedPostingMonth: postingOpen ? firstOfMonth(ppa.statementMonth) : null,
              expectedDirection: "income",
              expectedAmountC: expectedCollectedC,
              actualAmountC: ppaC,
              severity: "critical",
              detailsJson: { reason: !postingOpen ? "ppa_in_frozen_month" : ppa.direction !== "income" ? "direction_mismatch" : "amount_mismatch" },
            });
          }
          continue;
        }

        // If it WAS booked at freeze (manifest has it) the live row was voided/deleted after
        // freeze — that is R6 (frozen-integrity)'s domain, so R5 stays silent to avoid
        // double-flagging. Only a source NEVER booked is Family 1.
        if (manifestByCharge.has(charge.id)) continue;
        await emit({
          organizationId: orgId,
          ownerPartyId,
          unitId: charge.unitId ?? null,
          checkKind: "source_to_ledger",
          findingType: "missing_ledger_row",
          sourceType,
          sourceId: charge.id,
          originalBillingMonth: mStart,
          expectedDirection: "income",
          expectedAmountC: expectedCollectedC,
          severity: "critical",
        });
      }

      // Charged UnitUtilityBills on the owner's apartments, billed into the frozen month.
      // The sync books one GROSS expense row per positive category of a CHARGED bill; a draft
      // /void bill or a <= 0 category books nothing (so is legitimately unbooked).
      const bills = apartmentIds.length
        ? await db.unitUtilityBill.findMany({
            where: { organizationId: orgId, apartmentId: { in: apartmentIds }, periodMonth: mStart, status: "charged" },
            select: { id: true, tnbTotal: true, airSelangor: true, indahWater: true, wifi: true },
          })
        : [];

      for (const bill of bills) {
        for (const cat of UTILITY_BILL_CATEGORY_ROWS) {
          const raw = bill[cat.field];
          if (raw == null) continue;
          const catC = signedToCents(raw.toFixed(2), "recon.utilityCategory");
          if (catC <= 0) continue; // zero/negative category books nothing
          sourcesScanned += 1;

          const row = await db.ownerLedgerEntry.findFirst({
            where: {
              organizationId: orgId,
              ownerPartyId,
              statementMonth: mStart,
              sourceType: cat.sourceType,
              sourceUtilityBillId: bill.id,
              status: "active",
            },
            select: { id: true },
          });
          if (!row) {
            await emit({
              organizationId: orgId,
              ownerPartyId,
              checkKind: "source_to_ledger",
              findingType: "missing_ledger_row",
              sourceType: cat.sourceType,
              sourceId: bill.id,
              originalBillingMonth: mStart,
              expectedDirection: "expense",
              expectedAmountC: catC,
              severity: "critical",
            });
          }
        }
      }
      // ── Statement expenses (Source-2): each owner_statement Invoice's EXPECTED ledger
      //    rows — re-derived by the sync's OWN expectedStatementLedgerRows so R5 never
      //    duplicates (nor diverges from) the sync's display-only exclusions / SST rule —
      //    must each have an active `statement` ledger row (matching category + amount in
      //    cents). A missing one is a Family-1 EXPENSE drop the income/utility paths cannot
      //    see. The display-only utility twins (tnb/water/wifi/indah) are excluded by the
      //    shared helper, so R5 never flags a row the sync deliberately does NOT create.
      const statementInvoices = await db.invoice.findMany({
        // Mirror the sync's Source-2 scope exactly: owner_statement invoices for the frozen
        // month, excluding VOID (a voided statement books nothing / is reversed by the sync).
        where: { organizationId: orgId, ownerPartyId, invoiceType: "owner_statement", periodMonth: mStart, status: { not: "void" } },
        select: {
          id: true,
          sstAmount: true,
          // Mirror the sync's child filter — void/credited children book NO row, so R5
          // must not expect (nor flag) one for them.
          charges: {
            where: { status: { notIn: ["void", "credited"] } },
            select: { id: true, chargeType: true, amount: true },
          },
        },
      });
      // Seam #1: build ONE batched adjustments map across ALL this period's statement charge
      // IDs (never one query per charge) — the SAME helper the sync loop calls, so R5 nets
      // identically and never false-flags an adjusted charge (source-to-ledger.integration.test.ts
      // "nets active charge-adjustment notes").
      const allStmtChargeIds = statementInvoices.flatMap((inv) => inv.charges.map((c) => c.id));
      const stmtAdjustmentsByChargeId = await netAdjustmentsByChargeId(db, orgId, allStmtChargeIds);
      for (const inv of statementInvoices) {
        for (const exp of expectedStatementLedgerRows(inv, inv.charges, stmtAdjustmentsByChargeId)) {
          sourcesScanned += 1;
          const row = await db.ownerLedgerEntry.findFirst({
            where: {
              organizationId: orgId,
              ownerPartyId,
              statementMonth: mStart,
              sourceType: "statement",
              sourceChargeId: exp.sourceChargeId,
              status: "active",
            },
            select: { category: true, amount: true },
          });
          // The correctly-shaped expected row must exist ACTIVE and match category + amount in
          // cents. An absent row (never booked) OR a mis-shaped one (wrong category/amount) both
          // mean the owner's expense was not booked as billed.
          const rowAmountC = row ? signedToCents(row.amount.toFixed(2), "recon.statementAmount") : null;
          if (row && row.category === exp.category && rowAmountC === exp.amountC) continue;
          // If it WAS booked at freeze (manifest has it) any post-freeze divergence is R6
          // (frozen-integrity)'s domain — R5 stays silent to avoid double-flagging (mirrors the
          // income path). Only a source never booked as billed is R5's Family-1 case.
          if (manifestByCharge.has(exp.sourceChargeId)) continue;
          await emit({
            organizationId: orgId,
            ownerPartyId,
            checkKind: "source_to_ledger",
            findingType: "missing_ledger_row",
            sourceType: "statement",
            sourceId: exp.sourceChargeId,
            originalBillingMonth: mStart,
            expectedDirection: "expense",
            expectedAmountC: exp.amountC,
            actualAmountC: rowAmountC,
            severity: "critical",
            detailsJson: row
              ? { reason: "amount_or_category_mismatch", foundCategory: row.category }
              : { reason: "no_active_statement_row" },
          });
        }
      }

      // ── Safety net (review C1/Scen2): VOID/credited frozen-month income charges that
      //    carry forward rows. The income-charge loop above EXCLUDES void/credited (the
      //    sync skips them), so a forward booking that drifted out of balance for such a
      //    charge — an orphaned prior_period_collection (Bug-1 over-credit) or a
      //    double-reversal (Bug-2 under-credit) — is otherwise unchecked. Assert the total
      //    booked stays within [0, current_effective_allocated]:
      //      booked = frozen_collected + Σppc − Σppc_reversal − Σreversal   (integer cents)
      //    booked < 0 (reversed more than was ever collected → under-credit) or
      //    booked > effective_allocated (kept more than is currently allocated →
      //    over-credit) ⇒ orphaned_forward_collection. A void charge that never collected
      //    and carries no forward rows is legitimately unbooked (skipped — matches S7).
      const voidCharges = unitIds.length
        ? await db.charge.findMany({
            where: {
              organizationId: orgId,
              unitId: { in: unitIds },
              chargeType: { in: Object.keys(INCOME_CHARGE_SOURCE_TYPE) },
              dueDate: { gte: mStart, lte: mEnd },
              status: { in: ["void", "credited"] },
            },
            select: { id: true, chargeType: true, unitId: true },
          })
        : [];
      for (const charge of voidCharges) {
        const fwd = await db.ownerLedgerEntry.findMany({
          where: {
            organizationId: orgId,
            ownerPartyId,
            sourceChargeId: charge.id,
            status: "active",
            sourceType: { in: ["prior_period_collection", "prior_period_collection_reversal", "reversal", "reversal_forward_adjustment"] },
          },
          select: { amount: true, sourceType: true, direction: true },
        });
        const frozenCollectedC = manifestByCharge.has(charge.id) ? manifestByCharge.get(charge.id)! : null;
        if (frozenCollectedC === null && fwd.length === 0) continue; // never booked → nothing to check
        sourcesScanned += 1;
        // Split the forward rows so we can assert BOTH the net band AND the exact reversal
        // identity. The reversal FAMILY spans the write-once `reversal` (in whatever month it
        // froze) PLUS any `reversal_forward_adjustment` rows posted forward once that month
        // froze — summed SIGNED in the holdback direction (an income-charge reversal is an
        // EXPENSE → +; a give-back adjustment is INCOME → −), so the identity stays exact
        // whether the correction mutated one open row or accreted across frozen months.
        let ppcC = 0;
        let ppcRevC = 0;
        let revC = 0;
        for (const r of fwd) {
          const c = signedToCents(r.amount.toFixed(2), "recon.voidForward");
          if (r.sourceType === "prior_period_collection") ppcC += c;
          else if (r.sourceType === "prior_period_collection_reversal") ppcRevC += c;
          else revC += r.direction === "expense" ? c : -c; // reversal family, signed (income charge ⇒ reversalDir = expense)
        }
        const frozenC = frozenCollectedC ?? 0;
        const bookedC = frozenC + ppcC - ppcRevC - revC;
        const effC = await effectiveAllocatedC(orgId, charge.id);
        // The forward `reversal` must equal exactly the owner-recognised cash to hold back
        // for a void/credited charge: frozen collected PLUS post-freeze collections, less
        // collection-reversals, floored at 0. The +Σppc term (holdback rule) is what makes a
        // void charge that collected cash post-freeze but was never held back FAIL-CLOSED:
        // its booked total sits at effAlloc (band passes, booked == effAlloc), so ONLY this
        // exact identity `revC == max(0, frozen + Σppc − Σppc_reversal)` catches the
        // over-credit. Conversely a correctly held-back void (revC == that target) nets to 0
        // and passes cleanly — the retained cash is the tenant's credit, not owner income.
        const targetRevC = Math.max(0, frozenC + ppcC - ppcRevC);
        if (bookedC < 0 || bookedC > effC || revC !== targetRevC) {
          await emit({
            organizationId: orgId,
            ownerPartyId,
            unitId: charge.unitId ?? null,
            checkKind: "source_to_ledger",
            findingType: "orphaned_forward_collection",
            sourceType: INCOME_CHARGE_SOURCE_TYPE[charge.chargeType]!,
            sourceId: charge.id,
            originalBillingMonth: mStart,
            expectedDirection: "income",
            expectedAmountC: effC,
            actualAmountC: bookedC,
            severity: "critical",
            detailsJson: { frozenCollectedC: frozenC, ppcC, ppcRevC, revC, targetRevC },
          });
        }
      }

      // Auto-resolve per successfully-scanned period scope — contains a scoped run to its
      // own (owner, month) AND isolates a throwing period: a throw above skips this call,
      // so that period's still-real criticals persist instead of being resolved fail-open.
      findingsResolved += await autoResolveStale({
        organizationId: orgId,
        checkKind: "source_to_ledger",
        emittedKeys,
        ownerPartyId,
        originalBillingMonth: mStart,
      });
    } catch (e) {
      // Per-period isolation (spec Error Handling): one owner/period scan error must
      // not abort the sweep. The run-status/failureInfo record is Task 9's job.
      // eslint-disable-next-line no-console
      console.error(`[recon.source-to-ledger] period ${period.id} scan failed (isolated):`, e);
    }
  }

  return { sourcesScanned, findingsOpened, findingsResolved };
}
