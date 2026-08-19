/**
 * R6 — Reconciliation Check #2: frozen-snapshot-to-live integrity.
 *
 * Ledger-FIRST: for each frozen owner-statement period that has a write-once manifest
 * (R7), diff the LIVE OwnerLedgerEntry rows against the immutable manifest baseline and
 * the persisted firstFrozen* balances. Catches Family 2 (manual entry into a frozen
 * month) — which R5 structurally cannot, since a manual row has no money source — plus
 * every other post-freeze mutation of a closed month:
 *   - post_freeze_creation    : a live active frozen-month row created after firstFrozenAt;
 *   - unexplained_frozen_row  : a live active frozen-month row absent from the manifest
 *                               (regardless of createdAt — anti-backdate);
 *   - post_freeze_economic_edit / manifest_field_mismatch : a manifest row whose live
 *                               economic field (amount/direction/category/paidBy/
 *                               includeInPayout/sstAmount) or active status diverges;
 *   - frozen_balance_drift    : persisted opening/closing/net != the firstFrozen* header.
 *
 * Authorised forward entries (R3/R4) post to the OPEN month, so they never appear in the
 * frozen-month live scan and never false-positive. Legitimately-unpaid rows present at
 * freeze are IN the manifest, so they are not flagged. READ-ONLY w.r.t. money — writes
 * ONLY findings. Runs INDEPENDENT of ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER.
 */
import { getDb } from "@kason/db";
import { signedToCents } from "../owner-ledger.repository";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import type { RunReconResult } from "./source-to-ledger";
import { autoResolveStale, findingKey, upsertFinding, type FindingUpsertInput } from "./findings-repo";
import { findPerUnitFrozenWithoutCombined } from "./period-scope-invariants";

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function runFrozenIntegrity(
  ctx: OwnerLedgerActorCtx,
  filter: { ownerPartyId?: string; month?: string },
): Promise<RunReconResult> {
  const db = getDb();
  const orgId = ctx.orgId;

  const monthStart = filter.month
    ? new Date(Date.UTC(Number(filter.month.split("-")[0]), Number(filter.month.split("-")[1]) - 1, 1))
    : undefined;

  // Only frozen periods WITH a manifest (firstFrozenAt set). A period frozen before the
  // manifest feature shipped has no baseline → "integrity unknown" (the R9 preflight
  // treats it as not-passable); R6 cannot diff it and skips it.
  const periods = await db.ownerStatementPeriod.findMany({
    where: {
      organizationId: orgId,
      status: "frozen",
      apartmentId: null,
      firstFrozenAt: { not: null },
      ...(filter.ownerPartyId ? { ownerPartyId: filter.ownerPartyId } : {}),
      ...(monthStart ? { periodMonth: monthStart } : {}),
    },
  });

  let sourcesScanned = 0;
  let findingsOpened = 0;
  let findingsResolved = 0;

  for (const period of periods) {
    try {
      const firstFrozenAt = period.firstFrozenAt as Date;
      const mStart = firstOfMonth(period.periodMonth);
      const ownerPartyId = period.ownerPartyId;

      const emittedKeys = new Set<string>();
      const emit = async (f: FindingUpsertInput): Promise<void> => {
        emittedKeys.add(findingKey(f));
        const { opened } = await upsertFinding(f);
        if (opened) findingsOpened += 1;
      };

      const manifest = await db.ownerStatementFreezeManifestRow.findMany({
        where: { organizationId: orgId, ownerStatementPeriodId: period.id },
      });
      const manifestIds = new Set(manifest.map((m) => m.ledgerEntryId));

      // Pass 1 — manifest-driven: each frozen (manifest) row must still exist ACTIVE and
      // carry byte-identical economic fields. A void/delete removes owner money from the
      // closed month; an amount/direction/payout/paidBy/sst edit silently re-prices it.
      const liveById = new Map(
        (
          await db.ownerLedgerEntry.findMany({
            where: { organizationId: orgId, id: { in: manifest.map((m) => m.ledgerEntryId) } },
            select: {
              id: true, status: true, amount: true, direction: true, category: true,
              paidBy: true, includeInPayout: true, sstAmount: true, updatedAt: true,
            },
          })
        ).map((r) => [r.id, r] as const),
      );
      for (const m of manifest) {
        sourcesScanned += 1;
        const live = liveById.get(m.ledgerEntryId);
        if (!live || live.status !== "active") {
          // A frozen row voided/deleted after freeze — persisted balances may be unchanged,
          // so only this manifest-vs-live presence diff catches it.
          await emit({
            organizationId: orgId,
            ownerPartyId,
            checkKind: "frozen_integrity",
            findingType: "post_freeze_economic_edit",
            sourceType: "owner_ledger_entry",
            sourceId: m.ledgerEntryId,
            originalBillingMonth: mStart,
            expectedAmountC: m.amountC,
            actualAmountC: null,
            severity: "critical",
            detailsJson: { reason: live ? "voided_after_freeze" : "deleted_after_freeze" },
          });
          continue;
        }
        const liveAmountC = signedToCents(live.amount.toFixed(2), "recon.frozenLiveAmount");
        const liveSstC = live.sstAmount == null ? null : signedToCents(live.sstAmount.toFixed(2), "recon.frozenLiveSst");
        const mismatches: string[] = [];
        if (liveAmountC !== m.amountC) mismatches.push("amount");
        if (live.direction !== m.direction) mismatches.push("direction");
        if (live.category !== m.category) mismatches.push("category");
        if (live.paidBy !== m.paidBy) mismatches.push("paidBy");
        if (live.includeInPayout !== m.includeInPayout) mismatches.push("includeInPayout");
        if (liveSstC !== m.sstAmountC) mismatches.push("sstAmount");
        if (mismatches.length > 0) {
          // updatedAt advanced past the freeze snapshot → a genuine post-freeze edit; else
          // the divergence has no updatedAt trail (e.g. a raw write) → a plain manifest mismatch.
          const editedAfterFreeze = live.updatedAt.getTime() > m.ledgerUpdatedAtAtFreeze.getTime();
          await emit({
            organizationId: orgId,
            ownerPartyId,
            checkKind: "frozen_integrity",
            findingType: editedAfterFreeze ? "post_freeze_economic_edit" : "manifest_field_mismatch",
            sourceType: "owner_ledger_entry",
            sourceId: m.ledgerEntryId,
            originalBillingMonth: mStart,
            expectedAmountC: m.amountC,
            actualAmountC: liveAmountC,
            severity: "critical",
            detailsJson: { mismatches },
          });
        }
      }

      // Live ACTIVE rows in the frozen month, scoped exactly as the manifest was built
      // (per-unit period → its apartment only; combined → all owner rows that month).
      const liveRows = await db.ownerLedgerEntry.findMany({
        where: {
          organizationId: orgId,
          ownerPartyId,
          statementMonth: mStart,
          status: "active",
          ...(period.apartmentId ? { apartmentId: period.apartmentId } : {}),
        },
        select: { id: true, createdAt: true },
      });

      // Pass 2 — live-driven: a frozen-month active row absent from the manifest.
      for (const row of liveRows) {
        if (manifestIds.has(row.id)) continue;
        sourcesScanned += 1;
        const finding: FindingUpsertInput = {
          organizationId: orgId,
          ownerPartyId,
          checkKind: "frozen_integrity",
          findingType: row.createdAt > firstFrozenAt ? "post_freeze_creation" : "unexplained_frozen_row",
          sourceType: "owner_ledger_entry",
          sourceId: row.id,
          originalBillingMonth: mStart,
          severity: "critical",
        };
        await emit(finding);
      }

      // Pass 3 — persisted balance drift: the live period balances must still equal the
      // immutable firstFrozen* header. A re-freeze that changed them (or a raw write) drifts
      // a closed month's opening/closing/net — corrupting every later carried-forward opening.
      const balanceFields: Array<{ field: string; liveC: number; frozenC: number | null }> = [
        { field: "opening", liveC: period.openingBalanceC, frozenC: period.firstFrozenOpeningC },
        { field: "closing", liveC: period.closingBalanceC, frozenC: period.firstFrozenClosingC },
        { field: "net", liveC: period.netPayoutC, frozenC: period.firstFrozenNetC },
      ];
      const drifted = balanceFields.filter((b) => b.frozenC != null && b.liveC !== b.frozenC);
      if (drifted.length > 0) {
        sourcesScanned += 1;
        await emit({
          organizationId: orgId,
          ownerPartyId,
          checkKind: "frozen_integrity",
          findingType: "frozen_balance_drift",
          sourceType: "owner_statement_period",
          sourceId: period.id,
          originalBillingMonth: mStart,
          severity: "critical",
          expectedAmountC: drifted[0]!.frozenC,
          actualAmountC: drifted[0]!.liveC,
          detailsJson: { drifted: drifted.map((b) => ({ field: b.field, expectedC: b.frozenC, actualC: b.liveC })) },
        });
      }

      // Auto-resolve per successfully-scanned period scope — this both contains a scoped
      // run to its own (owner, month) and isolates a throwing period (its findings persist).
      findingsResolved += await autoResolveStale({
        organizationId: orgId,
        checkKind: "frozen_integrity",
        emittedKeys,
        ownerPartyId,
        originalBillingMonth: mStart,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[recon.frozen-integrity] period ${period.id} scan failed (isolated):`, e);
    }
  }

  // ── Orphan pass — per-unit frozen WITHOUT a frozen combined sibling (durable flag) ──
  // The combined-scope guard (assertPeriodOpen) + the R5/R6 passes above read only the
  // combined (apartmentId null) period, so a per-unit period frozen without its combined
  // sibling is neither guarded against post-freeze writes nor scanned for drift. The freeze
  // sites now PREVENT new such orphans; this makes any legacy/edge orphan CONTINUOUSLY
  // detected (a durable critical finding), agreeing with the preflight's Condition-7 count
  // by construction (shared helper). READ-ONLY w.r.t. money — writes ONLY a finding.
  const orphans = await findPerUnitFrozenWithoutCombined(orgId, {
    ownerPartyId: filter.ownerPartyId,
    monthStart,
  });
  for (const orphan of orphans) {
    const f: FindingUpsertInput = {
      organizationId: orgId,
      ownerPartyId: orphan.ownerPartyId,
      apartmentId: orphan.apartmentId,
      checkKind: "frozen_integrity",
      findingType: "per_unit_frozen_without_combined",
      sourceType: "owner_statement_period",
      sourceId: orphan.id,
      // Carry the period month (consistent with every other frozen_integrity finding) so the
      // admin findings triage — which filters `originalBillingMonth` — SURFACES the orphan
      // when an operator filters by its month. The combined-period loop's generic
      // autoResolveStale EXCLUDES this findingType (see findings-repo.autoResolveStale), so
      // this orphan pass stays the sole owner of the finding's lifecycle via its dedicated
      // resolve below — the month is safe to set here.
      originalBillingMonth: firstOfMonth(orphan.periodMonth),
      severity: "critical",
      detailsJson: { reason: "combined_sibling_not_frozen" },
    };
    const { opened } = await upsertFinding(f);
    if (opened) findingsOpened += 1;
    sourcesScanned += 1;
  }

  // Auto-resolve orphan findings whose per-unit period is NO LONGER an orphan (its combined
  // sibling is now frozen, or the per-unit period is itself no longer frozen). findingType-
  // scoped so it NEVER touches other frozen_integrity findings; owner-scoped for a scoped
  // run; NEVER touches `ignored` (deliberately suppressed). Robust even when the combined
  // sibling is frozen WITHOUT a manifest (which the combined-period loop skips), so this
  // pass — not the combined loop — is the sole, reliable owner of the orphan lifecycle.
  const openOrphanFindings = await db.ownerLedgerReconciliationFinding.findMany({
    where: {
      organizationId: orgId,
      checkKind: "frozen_integrity",
      findingType: "per_unit_frozen_without_combined",
      status: { in: ["open", "acknowledged"] },
      ...(filter.ownerPartyId ? { ownerPartyId: filter.ownerPartyId } : {}),
      // Month-scope via the finding's OWN originalBillingMonth (set above), so a
      // month-filtered run only reconciles ITS month's orphan findings — never resolving
      // (nor retaining) another month's. `orphans` above is month-scoped identically, so a
      // candidate not in the current orphan set is genuinely stale for this scope.
      ...(monthStart ? { originalBillingMonth: monthStart } : {}),
    },
    select: { id: true, sourceId: true },
  });
  if (openOrphanFindings.length > 0) {
    const currentOrphanIds = new Set(orphans.map((o) => o.id));
    const staleIds = openOrphanFindings
      .filter((of) => !currentOrphanIds.has(of.sourceId)) // no longer an orphan in scope → stale
      .map((of) => of.id);
    if (staleIds.length > 0) {
      const res = await db.ownerLedgerReconciliationFinding.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "resolved", resolvedAt: new Date() },
      });
      findingsResolved += res.count;
    }
  }

  return { sourcesScanned, findingsOpened, findingsResolved };
}
