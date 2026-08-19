import { getDb, Prisma } from "@kason/db";

// R8 — durable reconciliation finding persistence (stub; TDD in progress).

export type ReconCheckKind = "source_to_ledger" | "frozen_integrity";

export interface FindingUpsertInput {
  organizationId: string;
  ownerPartyId: string;
  apartmentId?: string | null;
  unitId?: string | null;
  carparkId?: string | null;
  checkKind: ReconCheckKind;
  findingType: string;
  sourceType: string;
  sourceId: string;
  sourceUpdatedAt?: Date | null;
  originalBillingMonth?: Date | null;
  expectedPostingMonth?: Date | null;
  expectedDirection?: string | null;
  expectedAmountC?: number | null;
  actualAmountC?: number | null;
  severity: "critical" | "warning";
  detailsJson?: Prisma.InputJsonValue | null;
}

/** Stable within-checkKind dedupe key: `${sourceType}|${sourceId}|${findingType}`. */
export function findingKey(f: { sourceType: string; sourceId: string; findingType: string }): string {
  return `${f.sourceType}|${f.sourceId}|${f.findingType}`;
}

export async function upsertFinding(input: FindingUpsertInput): Promise<{ id: string; opened: boolean }> {
  const db = getDb();
  const now = new Date();

  // Refreshed-on-every-detect diagnostic fields (the identity of the finding is the
  // dedupe key; these are the latest evidence).
  const diagnostics = {
    ownerPartyId: input.ownerPartyId,
    apartmentId: input.apartmentId ?? null,
    unitId: input.unitId ?? null,
    carparkId: input.carparkId ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    originalBillingMonth: input.originalBillingMonth ?? null,
    expectedPostingMonth: input.expectedPostingMonth ?? null,
    expectedDirection: input.expectedDirection ?? null,
    expectedAmountC: input.expectedAmountC ?? null,
    actualAmountC: input.actualAmountC ?? null,
    severity: input.severity,
    detailsJson: input.detailsJson ?? Prisma.JsonNull,
  };

  const dedupeWhere = {
    organizationId_checkKind_sourceType_sourceId_findingType: {
      organizationId: input.organizationId,
      checkKind: input.checkKind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      findingType: input.findingType,
    },
  };

  let existing = await db.ownerLedgerReconciliationFinding.findUnique({
    where: dedupeWhere,
    select: { id: true, status: true },
  });

  if (!existing) {
    try {
      const created = await db.ownerLedgerReconciliationFinding.create({
        data: {
          organizationId: input.organizationId,
          checkKind: input.checkKind,
          findingType: input.findingType,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          status: "open",
          lastDetectedAt: now,
          ...diagnostics,
        },
      });
      return { id: created.id, opened: true };
    } catch (e) {
      // Lost the create race: a concurrent run inserted this exact dedupe key between our
      // findUnique and create (P2002). Re-read and fall through to the update/bump path so
      // exactly one row survives — never a duplicate, never a thrown error.
      const code = (e as { code?: string }).code;
      if (code !== "P2002") throw e;
      existing = await db.ownerLedgerReconciliationFinding.findUnique({ where: dedupeWhere, select: { id: true, status: true } });
      if (!existing) throw e;
    }
  }

  // NEVER touch an ignored finding — an admin deliberately suppressed it (with a
  // reason). Not even a lastDetectedAt bump or a diagnostics refresh.
  if (existing.status === "ignored") {
    return { id: existing.id, opened: false };
  }

  // A previously-RESOLVED finding that re-detects means the corruption came back —
  // reopen it (clear the resolution) and count it as newly opened.
  const reopen = existing.status === "resolved";
  await db.ownerLedgerReconciliationFinding.update({
    where: { id: existing.id },
    data: {
      lastDetectedAt: now,
      ...diagnostics,
      ...(reopen ? { status: "open", resolvedAt: null, resolvedById: null } : {}),
    },
  });
  return { id: existing.id, opened: reopen };
}

/**
 * Auto-resolve stale findings: any `open`/`acknowledged` finding of this checkKind
 * (optionally scoped to an owner/month) whose dedupe key was NOT re-emitted by the
 * current run transitions to `resolved` (the underlying data is now valid). NEVER
 * touches `ignored` (deliberately suppressed) or already-`resolved` findings.
 */
export async function autoResolveStale(args: {
  organizationId: string;
  checkKind: ReconCheckKind;
  emittedKeys: Set<string>;
  ownerPartyId?: string;
  originalBillingMonth?: Date | null;
}): Promise<number> {
  const db = getDb();
  const candidates = await db.ownerLedgerReconciliationFinding.findMany({
    where: {
      organizationId: args.organizationId,
      checkKind: args.checkKind,
      status: { in: ["open", "acknowledged"] },
      // The per_unit_frozen_without_combined orphan finding (R6 frozen-integrity) has a
      // DEDICATED resolve pass that owns its full lifecycle across every month/owner scope;
      // exclude it from this generic emittedKeys-driven sweep so it can never be resolved as
      // a side-effect of a combined-period scan. No-op for source_to_ledger (never emits it).
      findingType: { not: "per_unit_frozen_without_combined" },
      ...(args.ownerPartyId ? { ownerPartyId: args.ownerPartyId } : {}),
      ...(args.originalBillingMonth ? { originalBillingMonth: args.originalBillingMonth } : {}),
    },
    select: { id: true, sourceType: true, sourceId: true, findingType: true },
  });
  const staleIds = candidates.filter((f) => !args.emittedKeys.has(findingKey(f))).map((f) => f.id);
  if (staleIds.length === 0) return 0;
  const res = await db.ownerLedgerReconciliationFinding.updateMany({
    where: { id: { in: staleIds } },
    data: { status: "resolved", resolvedAt: new Date() },
  });
  return res.count;
}
