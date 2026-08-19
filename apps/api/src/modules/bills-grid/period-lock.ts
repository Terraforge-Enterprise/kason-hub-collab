// Bills & Expenses Grid — recurring-charges shared predicates + target resolvers.
//
// LEAF MODULE (recurring-charges feature). Imported by recurring.service.ts (R3 sync),
// repository.ts (R4 materialize-on-open) and service.ts (R5 mint) WITHOUT creating an
// import cycle: this file imports ONLY Prisma types, never service.ts or repository.ts
// (service.ts→repository.ts already, so repository.ts must not reach back into service.ts).
//
// It owns the ONE predicate the spec (R8) requires every sync path to share —
// isPeriodSnapshotSyncable — and the owner/tenant target resolution reused by preview,
// apply and materialize. These are PURE reads (no Charge/OwnerLedger writes), so they are
// safe under the module's forbidden-writes guard.
import type { Prisma } from "@kason/db";
// lib/ only — no cycle (same trust boundary as lib/rent-math in service.ts).
import { tenancyPeriodWhere, primaryTenancyForPeriod } from "../../lib/tenancy-period";
import {
  SCALAR_RECURRING_KIND_LIST,
  isScalarRecurringKind,
  noScalarGovernance,
  type ScalarGovernance,
} from "@kason/shared";

/** The apartment's owner party + a representative live listing id (the same shape and rule
 * service.ts's resolveApartmentOwner uses — the first non-archived listing carrying an
 * ownerPartyId; every listing of one apartment shares the owner). Null when unassigned. */
export async function resolveApartmentOwner(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
): Promise<{ ownerPartyId: string; listingId: string } | null> {
  const apt = await tx.apartment.findFirst({
    where: { id: apartmentId, organizationId: orgId },
    select: { listings: { where: { listingStatus: { not: "archived" } }, select: { id: true, ownerPartyId: true } } },
  });
  if (!apt) return null;
  const owned = apt.listings.find((l) => l.ownerPartyId);
  if (!owned) return null;
  return { ownerPartyId: owned.ownerPartyId!, listingId: owned.id };
}

/** The tenancy that occupied the apartment during `period`, shaped for a tenant-borne
 * recurring target. Mirrors service.ts's resolveWholeUnitTenancy: tenant-borne recurring
 * lines bill the period's occupant. Null for a vacant apartment (→ a period conflict,
 * never a silent drop).
 *
 * PERIOD-scoped, not `status: "active"`: a recurring line effective for a past month
 * must resolve to that month's tenant, not to whoever lives there now. */
export async function resolveTenancyForPeriod(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  period: Date,
): Promise<{ tenancyId: string; partyId: string; unitId: string } | null> {
  const candidates = await tx.tenancy.findMany({
    where: { organizationId: orgId, unit: { apartmentId }, ...tenancyPeriodWhere(period) },
    orderBy: [{ startDate: "desc" }, { id: "asc" }],
    select: { id: true, tenantPartyId: true, unitId: true, startDate: true, endDate: true, status: true },
  });
  const t = primaryTenancyForPeriod(candidates, period);
  if (!t) return null;
  return { tenancyId: t.id, partyId: t.tenantPartyId, unitId: t.unitId };
}

/** The resolved billing target (party/tenancy/unit) a recurring line snapshots, frozen. */
export type RecurringTarget = { resolvedPartyId: string; resolvedTenancyId: string | null; resolvedUnitId: string };

/** Resolve the target a recurring revision bills for this apartment: owner-borne → the
 * apartment owner (no tenancy); tenant-borne → the active tenancy. Null = unresolvable
 * (surfaces as a period conflict in preview/apply and materialize — never a silent drop). */
export async function resolveRecurringTarget(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  bearer: string,
  period: Date,
): Promise<RecurringTarget | null> {
  if (bearer === "owner") {
    const o = await resolveApartmentOwner(tx, orgId, apartmentId);
    return o ? { resolvedPartyId: o.ownerPartyId, resolvedTenancyId: null, resolvedUnitId: o.listingId } : null;
  }
  const t = await resolveTenancyForPeriod(tx, orgId, apartmentId, period);
  return t ? { resolvedPartyId: t.partyId, resolvedTenancyId: t.tenancyId, resolvedUnitId: t.unitId } : null;
}

/** True iff an OwnerStatementPeriod covering this apartment-month is FROZEN (Open Question 2,
 * LOCKED): a frozen owner statement makes the grid entry non-syncable even when unbilled. The
 * statement is keyed by owner party; apartmentId null = the combined (all-units) scope, set =
 * per-unit — either frozen scope freezes this apartment-month. No owner ⇒ never frozen. */
export async function ownerStatementFrozen(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  periodMonth: Date,
): Promise<boolean> {
  const owner = await resolveApartmentOwner(tx, orgId, apartmentId);
  if (!owner) return false;
  const frozen = await tx.ownerStatementPeriod.findFirst({
    where: {
      organizationId: orgId,
      ownerPartyId: owner.ownerPartyId,
      periodMonth,
      status: "frozen",
      OR: [{ apartmentId }, { apartmentId: null }],
    },
    select: { id: true },
  });
  return !!frozen;
}

/** Whether an ENABLED recurring definition GOVERNS each SCALAR kind for this apartment-month —
 * i.e. an applicable revision (its [from,to) range covers the month) that is enabled. A governed
 * scalar is settings-controlled → read-only + write-protected (R6); an UNgoverned one (no def, a
 * disabled def like the WiFi backfill default, or a month before the earliest revision) stays a
 * plain editable per-month cell, restoring the pre-recurring flow for units with nothing configured.
 *
 * Keyed by SCALAR_RECURRING_KIND_LIST rather than a hand-written {cleaning, wifi} shape, so adding
 * a kind to that map extends governance (and therefore cell locking) with no change here. */
export async function governingScalarKinds(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  periodMonth: Date,
): Promise<ScalarGovernance> {
  const defs = await tx.recurringChargeDefinition.findMany({
    where: { organizationId: orgId, apartmentId, kind: { in: SCALAR_RECURRING_KIND_LIST }, archivedAt: null },
    include: { revisions: true },
  });
  const t = periodMonth.getTime();
  const out = noScalarGovernance();
  for (const def of defs) {
    const rev = def.revisions.find((r) => r.effectiveFromMonth.getTime() <= t && (r.effectiveToMonth === null || t < r.effectiveToMonth.getTime()));
    // A CUSTOM (or unknown) kind can never reach here — the query filters to scalar kinds —
    // but the guard keeps `out[def.kind]` type-safe rather than an unchecked index.
    if (rev?.enabled && isScalarRecurringKind(def.kind)) out[def.kind] = true;
  }
  return out;
}

/** The Expense/Profit nature a WiFi/Cleaning scalar bills under, or null = undecided. */
export type ScalarNature = "expense" | "profit" | null;

/** The frozen per-entry nature columns {@link resolveScalarNatures} starts from. */
export type ScalarNatureEntry = { wifiNature: string | null; cleaningNature: string | null };

/** Narrow an untrusted string column to a ScalarNature (anything else ⇒ undecided). */
function asNature(raw: string | null | undefined): ScalarNature {
  return raw === "expense" || raw === "profit" ? raw : null;
}

/**
 * THE ONE precedence for a WiFi/Cleaning scalar's Expense/Profit nature (charge-nature gate,
 * 2026-07-27). Shared by the BILL-TIME guard (billableNatureUnresolved) and the MINT
 * (mintItemized…'s scalarNatureFor) so the two can NEVER disagree — that agreement, not the
 * old guard's pessimism, is the money-safety invariant the drift tests (B6/B7) really protect.
 *
 * Precedence, highest first:
 *   1. `entry.<x>Nature` — the FROZEN snapshot this month materialized/applied. A billed month
 *      keeps whatever it was billed under; nothing below can retro-change a decided period.
 *   2. the GOVERNING recurring revision's nature — the escape from an otherwise permanent dead
 *      end: once `billedAt`/`invoicedAt` are set the entry is non-syncable
 *      ({@link isPeriodSnapshotSyncable}) and materialize is create-only, so a NULL frozen
 *      column can never be written again. Without this step, naturing the definition makes the
 *      guard fire forever with an unactionable "re-save the definition" message.
 *   3. `UnitBillsBearerConfig.<x>Nature` — the unit-setting default, which is the ONLY source a
 *      BARE scalar (no recurring definition at all) has. This is what makes the drawer's new
 *      Nature control actually resolve an already-created entry.
 *   4. null — undecided. The caller MUST fail closed; never coerce to "profit".
 *
 * One query per kind-set + one config read, so callers resolve BOTH kinds in a single pass.
 */
export async function resolveScalarNatures(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  periodMonth: Date,
  entry: ScalarNatureEntry,
): Promise<{ wifi: ScalarNature; cleaning: ScalarNature }> {
  const frozen = { wifi: asNature(entry.wifiNature), cleaning: asNature(entry.cleaningNature) };
  // Short-circuit: both frozen ⇒ nothing below can change the answer, so skip both reads.
  if (frozen.wifi && frozen.cleaning) return frozen;

  const defs = await tx.recurringChargeDefinition.findMany({
    where: { organizationId: orgId, apartmentId, kind: { in: ["WIFI", "CLEANING"] }, archivedAt: null },
    include: { revisions: true },
  });
  const t = periodMonth.getTime();
  const governing = { wifi: null as ScalarNature, cleaning: null as ScalarNature };
  for (const def of defs) {
    const rev = def.revisions.find((r) => r.effectiveFromMonth.getTime() <= t && (r.effectiveToMonth === null || t < r.effectiveToMonth.getTime()));
    if (!rev || !rev.enabled) continue; // no effective/enabled revision ⇒ this def does not govern the month
    if (def.kind === "WIFI") governing.wifi = asNature(rev.nature);
    else if (def.kind === "CLEANING") governing.cleaning = asNature(rev.nature);
  }

  const wifiAfterDef = frozen.wifi ?? governing.wifi;
  const cleaningAfterDef = frozen.cleaning ?? governing.cleaning;
  if (wifiAfterDef && cleaningAfterDef) return { wifi: wifiAfterDef, cleaning: cleaningAfterDef };

  const cfg = await tx.unitBillsBearerConfig.findUnique({
    where: { organizationId_apartmentId: { organizationId: orgId, apartmentId } },
    select: { wifiNature: true, cleaningNature: true },
  });
  return {
    wifi: wifiAfterDef ?? asNature(cfg?.wifiNature),
    cleaning: cleaningAfterDef ?? asNature(cfg?.cleaningNature),
  };
}

/** Minimal entry shape isPeriodSnapshotSyncable needs. */
export type SyncableEntry = { billedAt: Date | null; invoicedAt: Date | null; apartmentId: string; periodMonth: Date };

/** THE ONE predicate (spec R8): a period's snapshot may be synced/materialized ONLY when it
 * is neither billed nor invoiced nor owner-statement-frozen. Every sync path (R3 apply, R4
 * materialize) and the write-protection (R6) consult ONLY this. */
export async function isPeriodSnapshotSyncable(
  tx: Prisma.TransactionClient,
  orgId: string,
  entry: SyncableEntry,
): Promise<boolean> {
  if (entry.billedAt || entry.invoicedAt) return false;
  if (await ownerStatementFrozen(tx, orgId, entry.apartmentId, entry.periodMonth)) return false;
  return true;
}

/** The non-syncable reason for an entry, or null when it IS syncable. Used to populate the
 * preview's `excluded` list (billed | invoiced | frozen) — precedence billed > invoiced >
 * frozen (a billed entry is reported "billed" even if also frozen). */
export async function nonSyncableReason(
  tx: Prisma.TransactionClient,
  orgId: string,
  entry: SyncableEntry,
): Promise<"billed" | "invoiced" | "frozen" | null> {
  if (entry.billedAt) return "billed";
  if (entry.invoicedAt) return "invoiced";
  if (await ownerStatementFrozen(tx, orgId, entry.apartmentId, entry.periodMonth)) return "frozen";
  return null;
}
