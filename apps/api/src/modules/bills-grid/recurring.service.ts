// Bills & Expenses Grid — recurring-charge definition/revision service + effective-month
// sync (recurring-charges feature, spec R1/R3/R5/R8). The config engine is SHARED across
// all three kinds (CLEANING/WIFI/CUSTOM); only the period WRITE TARGET differs (scalar
// entry.cleaning/wifi for CLEANING/WIFI, a GridEntryRecurringLine child for CUSTOM).
//
// PURE CONFIG + SNAPSHOT writes — this module writes ONLY the recurring tables and the grid
// entry's own scalar fields; it NEVER mints a Charge / OwnerLedgerEntry (that is billing,
// Task 5). previewRecurringService performs NO writes. applyRecurringService performs ALL
// writes in ONE $transaction, block-all on any conflict (spec R3/R5).
import { getDb, Prisma } from "@kason/db";
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../lib/audit";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import type {
  RecurringApplyInput,
  RecurringApplyResult,
  RecurringDefinitionDto,
  RecurringLineDto,
  RecurringPreview,
  RecurringUpsertInput,
} from "@kason/shared";
import { SCALAR_RECURRING_KINDS, isScalarRecurringKind } from "@kason/shared";
import { currentBillingMonthUTC } from "./service";

/** Read one Decimal money column off an entry row by name, as a 2dp string (null when unset).
 *  The indexed access is the price of a config-driven column map; it is confined to this helper
 *  so no call site hand-rolls an `as any`. */
function readEntryDecimal(entry: object, field: string): string | null {
  const raw = (entry as Record<string, { toFixed(dp: number): string } | null | undefined>)[field];
  return raw ? raw.toFixed(2) : null;
}
import { isPeriodSnapshotSyncable, nonSyncableReason, resolveRecurringTarget, type RecurringTarget } from "./period-lock";
import { resolveRecurringForPeriod } from "./repository";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

type Db = ReturnType<typeof getDb>;
const prisma: Db = getDb();

type Result<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };
const ok = <T>(data: T, status = 200): Result<T> => ({ ok: true, status, data });
const err = (status: number, error: string): Result<never> => ({ ok: false, status, error });

/** Apply's result envelope — a 409 carries the per-period `conflicts` payload (spec API). */
export type ApplyOutcome =
  | { ok: true; status: 200; data: RecurringApplyResult }
  | { ok: false; status: 404 | 400; error: string }
  | { ok: false; status: 409; error: string; conflicts: RecurringPreview["conflicts"] };

const toMonth = (s: string): Date => new Date(`${s.slice(0, 7)}-01T00:00:00.000Z`);
const isoMonth = (d: Date): string => d.toISOString().slice(0, 10);
const dec2 = (s: string): string => Number(s).toFixed(2);

/** Sentinel thrown inside the apply $transaction to force a full block-all rollback. */
class ApplyConflict extends Error {
  constructor(public conflicts: RecurringPreview["conflicts"]) { super("recurring_conflict"); }
}
class ApplyStale extends Error { constructor() { super("STALE"); } }
class RevisionOverlap extends Error { constructor() { super("REVISION_OVERLAP"); } }
class DefinitionNotFound extends Error { constructor() { super("DEFINITION_NOT_FOUND"); } }
class BadCategory extends Error { constructor() { super("CATEGORY_UNRESOLVED"); } }

const CUSTOM_CATEGORY_CODE = { owner: "recurring_other_owner", tenant: "recurring_other_tenant" } as const;

type ResolvedCategory = { id: string; code: string; name: string; family: string };

/** Resolve the ONE seeded custom-recurring category for a bearer (Open Question 3, LOCKED:
 * exactly one tenant-income + one owner-income category, no generic picker). */
async function resolveCustomCategory(tx: Prisma.TransactionClient, orgId: string, bearer: string): Promise<ResolvedCategory | null> {
  const code = bearer === "owner" ? CUSTOM_CATEGORY_CODE.owner : CUSTOM_CATEGORY_CODE.tenant;
  const cat = await tx.chargeCategory.findFirst({ where: { organizationId: orgId, code }, select: { id: true, code: true, name: true, family: true } });
  return cat ?? null;
}

/** The apartment's grid entries at or after `fromMonth`, oldest-first, with the fields the
 * syncability predicate + snapshot writers need. */
async function entriesFrom(tx: Prisma.TransactionClient, orgId: string, apartmentId: string, fromMonth: Date) {
  return tx.unitBillsGridEntry.findMany({
    where: { organizationId: orgId, apartmentId, periodMonth: { gte: fromMonth } },
    orderBy: { periodMonth: "asc" },
    select: {
      id: true, periodMonth: true, updatedAt: true, billedAt: true, invoicedAt: true, apartmentId: true,
      cleaning: true, wifi: true, cleaningBearer: true, wifiBearer: true,
    },
  });
}

/** Append an effective-dated revision, preserving the non-overlap invariant (R1): a same-month
 * re-edit UPDATES in place; a strictly-later existing revision rejects (forward-only edits);
 * otherwise close the currently-open revision to `F` and insert the new open-ended one. */
async function appendRevision(
  tx: Prisma.TransactionClient,
  definitionId: string,
  rev: { amount: string; bearer: string; categoryId: string | null; nature: string | null; effectiveFromMonth: Date; enabled: boolean; createdBy: string },
) {
  const F = rev.effectiveFromMonth;
  const revs = await tx.recurringChargeRevision.findMany({ where: { definitionId }, orderBy: { effectiveFromMonth: "asc" } });
  const sameMonth = revs.find((r) => r.effectiveFromMonth.getTime() === F.getTime());
  if (sameMonth) {
    return tx.recurringChargeRevision.update({
      where: { id: sameMonth.id },
      data: { amount: rev.amount, bearer: rev.bearer, categoryId: rev.categoryId, nature: rev.nature, enabled: rev.enabled, createdBy: rev.createdBy },
    });
  }
  if (revs.some((r) => r.effectiveFromMonth.getTime() > F.getTime())) throw new RevisionOverlap();
  const open = revs.find((r) => r.effectiveToMonth === null && r.effectiveFromMonth.getTime() < F.getTime());
  if (open) await tx.recurringChargeRevision.update({ where: { id: open.id }, data: { effectiveToMonth: F } });
  return tx.recurringChargeRevision.create({
    data: {
      definitionId, amount: rev.amount, bearer: rev.bearer, categoryId: rev.categoryId, nature: rev.nature,
      effectiveFromMonth: F, effectiveToMonth: null, enabled: rev.enabled, createdBy: rev.createdBy,
    },
  });
}

/** Resolve the target definition, creating it if this is a first-time create (no definitionId).
 * CLEANING/WIFI have a stable per-apartment code; CUSTOM mints a fresh unique code. */
async function resolveOrCreateDefinition(
  tx: Prisma.TransactionClient,
  orgId: string,
  apartmentId: string,
  actorUserId: string,
  body: { definitionId?: string; kind: string; name: string },
) {
  if (body.definitionId) {
    const def = await tx.recurringChargeDefinition.findFirst({ where: { id: body.definitionId, organizationId: orgId, apartmentId } });
    if (!def) throw new DefinitionNotFound();
    if (def.name !== body.name) await tx.recurringChargeDefinition.update({ where: { id: def.id }, data: { name: body.name } });
    return def;
  }
  if (isScalarRecurringKind(body.kind)) {
    const code = body.kind.toLowerCase();
    const existing = await tx.recurringChargeDefinition.findFirst({ where: { organizationId: orgId, apartmentId, code } });
    if (existing) return existing;
    return tx.recurringChargeDefinition.create({ data: { organizationId: orgId, apartmentId, kind: body.kind, code, name: body.name, createdBy: actorUserId } });
  }
  // CUSTOM — a fresh unique code per definition.
  const code = `custom-${randomUUID().slice(0, 8)}`;
  return tx.recurringChargeDefinition.create({ data: { organizationId: orgId, apartmentId, kind: "CUSTOM", code, name: body.name, createdBy: actorUserId } });
}

/** Write ONE entry's snapshot for a revision under an updatedAt-in-WHERE optimistic guard (R5).
 * A SCALAR kind → its entry money column (+ nature, where that kind has one);
 * CUSTOM → upsert/delete the GridEntryRecurringLine.
 * A 0-row entry guard means a concurrent edit → throw ApplyStale → whole apply rolls back.
 *
 * BEARER IS DELIBERATELY NOT WRITTEN HERE (2026-07-27). A recurring definition fixes the AMOUNT
 * only; the bearer stays owned by the unit Setting drawer's Owner/Tenant control, which remains
 * editable while the tick is on. Writing it from both places made the drawer's toggle silently
 * ineffective on any governed kind. */
async function writeSnapshot(
  tx: Prisma.TransactionClient,
  orgId: string,
  actorUserId: string,
  entry: { id: string; updatedAt: Date; periodMonth: Date },
  plan: {
    kind: string; definitionId: string; revisionId: string; effectiveAmount: string; bearer: string; enabled: boolean;
    nature: string | null; category: ResolvedCategory | null; target: RecurringTarget; name: string;
  },
) {
  // Optimistic entry guard (touches updatedAt via @updatedAt) — the R5 concurrency gate for
  // BOTH the scalar and the child-row paths.
  const scalar = isScalarRecurringKind(plan.kind) ? SCALAR_RECURRING_KINDS[plan.kind] : null;
  const g = await tx.unitBillsGridEntry.updateMany({
    where: { id: entry.id, updatedAt: entry.updatedAt },
    data: {
      // CUSTOM (scalar === null) touches only updatedById here — its money lives on the
      // GridEntryRecurringLine child row written below.
      ...(scalar ? { [scalar.entryAmountField]: plan.effectiveAmount } : {}),
      ...(scalar?.entryNatureField ? { [scalar.entryNatureField]: plan.nature } : {}),
      updatedById: actorUserId,
    },
  });
  if (g.count === 0) throw new ApplyStale();
  if (plan.kind === "CUSTOM") {
    if (!plan.enabled) {
      await tx.gridEntryRecurringLine.deleteMany({ where: { gridEntryId: entry.id, definitionId: plan.definitionId } });
      return;
    }
    const cat = plan.category!;
    const data = {
      organizationId: orgId,
      gridEntryId: entry.id,
      definitionId: plan.definitionId,
      revisionId: plan.revisionId,
      name: plan.name,
      amount: plan.effectiveAmount,
      bearer: plan.bearer,
      nature: plan.nature ?? null,
      categoryId: cat.id,
      categoryCode: cat.code,
      categoryName: cat.name,
      categoryFamily: cat.family,
      resolvedPartyId: plan.target.resolvedPartyId,
      resolvedTenancyId: plan.target.resolvedTenancyId,
      resolvedUnitId: plan.target.resolvedUnitId,
      effectiveMonth: entry.periodMonth,
      kind: "CUSTOM",
    };
    await tx.gridEntryRecurringLine.upsert({
      where: { gridEntryId_definitionId: { gridEntryId: entry.id, definitionId: plan.definitionId } },
      create: data,
      update: {
        revisionId: data.revisionId, name: data.name, amount: data.amount, bearer: data.bearer, nature: data.nature,
        categoryId: data.categoryId, categoryCode: data.categoryCode, categoryName: data.categoryName, categoryFamily: data.categoryFamily,
        resolvedPartyId: data.resolvedPartyId, resolvedTenancyId: data.resolvedTenancyId, resolvedUnitId: data.resolvedUnitId,
        effectiveMonth: data.effectiveMonth,
      },
    });
  }
}

/** GET recurring — every definition (incl. archived) + its revisions, for the settings editor. */
export async function listRecurringService(
  session: { orgId: string },
  apartmentId: string,
): Promise<Result<{ definitions: RecurringDefinitionDto[] }>> {
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId }, select: { id: true } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");
  const defs = await prisma.recurringChargeDefinition.findMany({
    where: { organizationId: session.orgId, apartmentId },
    orderBy: { createdAt: "asc" },
    include: { revisions: { orderBy: { effectiveFromMonth: "asc" } } },
  });
  return ok({
    definitions: defs.map((d) => ({
      id: d.id,
      kind: d.kind as RecurringDefinitionDto["kind"],
      code: d.code,
      name: d.name,
      archivedAt: d.archivedAt ? d.archivedAt.toISOString() : null,
      revisions: d.revisions.map((r) => ({
        id: r.id,
        amount: r.amount.toFixed(2),
        bearer: r.bearer as "owner" | "tenant",
        categoryId: r.categoryId,
        nature: r.nature as "expense" | "profit" | null,
        effectiveFromMonth: isoMonth(r.effectiveFromMonth),
        effectiveToMonth: r.effectiveToMonth ? isoMonth(r.effectiveToMonth) : null,
        enabled: r.enabled,
      })),
    })),
  });
}

/** GET recurring/lines?period= — the read-only CUSTOM recurring lines for this apartment-month,
 * for the grid dialog (R9). When the period's entry exists, its MATERIALIZED (frozen) snapshot
 * lines are authoritative. When no entry exists yet (the period has never been opened by a write),
 * PROJECT the same lines opening it would materialize (flag-gated) — so a configured recurring
 * charge shows as awaiting billing instead of a misleading empty state. Read-only either way. */
export async function listRecurringLinesService(
  session: { orgId: string },
  apartmentId: string,
  period: string,
): Promise<Result<{ lines: RecurringLineDto[] }>> {
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId }, select: { id: true } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");
  const entry = await prisma.unitBillsGridEntry.findFirst({
    where: { organizationId: session.orgId, apartmentId, periodMonth: toMonth(period) },
    select: { id: true },
  });
  if (!entry) {
    // No write has opened this period yet, so materialize-on-open (R4) has not run. Project the
    // SAME resolved CUSTOM lines opening it would write, so the dialog shows a configured recurring
    // charge awaiting billing instead of "No recurring charges". PURE read — no entry is created.
    // Flag-gated so the legacy (flag-off) read stays byte-identically empty.
    if (!isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS")) return ok({ lines: [] });
    const resolved = await resolveRecurringForPeriod(prisma, session.orgId, apartmentId, toMonth(period));
    return ok({
      lines: resolved.customLines.map((l) => ({
        id: l.definitionId, // no GridEntryRecurringLine row yet → stable synthetic id (the definition)
        name: l.name,
        amount: l.amount.toFixed(2),
        bearer: l.bearer as "owner" | "tenant",
        nature: null, // pre-open preview: the resolver has the revision but nature is authoritative once materialized onto the snapshot
        categoryName: l.category.name,
      })),
    });
  }
  const lines = await prisma.gridEntryRecurringLine.findMany({
    where: { organizationId: session.orgId, gridEntryId: entry.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, amount: true, bearer: true, nature: true, categoryName: true },
  });
  return ok({
    lines: lines.map((l) => ({ id: l.id, name: l.name, amount: l.amount.toFixed(2), bearer: l.bearer as "owner" | "tenant", nature: l.nature as "expense" | "profit" | null, categoryName: l.categoryName })),
  });
}

/** POST recurring/preview — READ-ONLY (spec R3). Returns the syncable-open periods that would
 * update, the count of unopened months that will materialize on open, the excluded
 * billed/invoiced/frozen periods, and any per-period target conflicts. Mutates NOTHING. */
export async function previewRecurringService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  body: RecurringUpsertInput,
): Promise<Result<RecurringPreview>> {
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId }, select: { id: true } });
  if (!apt) return err(404, "APARTMENT_NOT_FOUND");

  const F = toMonth(body.effectiveFromMonth);
  const newAmount = body.enabled ? dec2(body.amount) : "0.00";
  const target = await resolveRecurringTarget(prisma, session.orgId, apartmentId, body.bearer, F);

  const entries = await entriesFrom(prisma, session.orgId, apartmentId, F);
  // For an EDIT of a CUSTOM def, look up existing per-entry lines to show oldAmount.
  const existingLines = body.definitionId
    ? new Map(
        (await prisma.gridEntryRecurringLine.findMany({ where: { organizationId: session.orgId, definitionId: body.definitionId }, select: { gridEntryId: true, amount: true, bearer: true } }))
          .map((l) => [l.gridEntryId, l]),
      )
    : new Map();

  const willUpdate: RecurringPreview["willUpdate"] = [];
  const excluded: RecurringPreview["excluded"] = [];
  const conflicts: RecurringPreview["conflicts"] = [];
  for (const e of entries) {
    const reason = await nonSyncableReason(prisma, session.orgId, e);
    const period = isoMonth(e.periodMonth);
    if (reason) { excluded.push({ period, reason }); continue; }
    if (!target) { conflicts.push({ apartmentId, period, reason: body.bearer === "owner" ? "owner_unresolved" : "tenant_unresolved" }); continue; }
    // Current value for the preview's before/after. A SCALAR kind reads its own entry columns
    // (config-driven, so a new kind previews correctly with no change here); CUSTOM reads the
    // child line. Amount/bearer are READ ONLY for display — the apply writes amount alone.
    const previewScalar = isScalarRecurringKind(body.kind) ? SCALAR_RECURRING_KINDS[body.kind] : null;
    const old = previewScalar
      ? {
          amount: readEntryDecimal(e, previewScalar.entryAmountField),
          bearer: previewScalar.entryBearerField
            ? ((e as unknown as Record<string, string | null>)[previewScalar.entryBearerField] ?? null)
            : null,
        }
      : existingLines.has(e.id)
        ? { amount: existingLines.get(e.id)!.amount.toFixed(2), bearer: existingLines.get(e.id)!.bearer }
        : { amount: null, bearer: null };
    willUpdate.push({ period, oldAmount: old.amount, newAmount, oldBearer: old.bearer, newBearer: body.bearer, resolvedTarget: target.resolvedPartyId });
  }

  // willCreateOnOpen — unopened months in [F, current org month] that will materialize when
  // first opened (bounded, informational; future months beyond current are lazy/unbounded).
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: session.orgId }, select: { timezone: true } });
  const current = currentBillingMonthUTC(org.timezone);
  const have = new Set(entries.map((e) => e.periodMonth.getTime()));
  let willCreateOnOpen = 0;
  for (let m = new Date(F); m.getTime() <= current.getTime(); m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    if (!have.has(m.getTime())) willCreateOnOpen++;
  }

  return ok({ willUpdate, willCreateOnOpen, excluded, conflicts });
}

/** POST recurring/apply — creates the revision and syncs every syncable open period in ONE
 * $transaction, BLOCK-ALL on any conflict (spec R3/R5): any unresolved target or stale entry
 * throws → the whole tx rolls back → NOTHING applied, 409 with every conflict returned. */
export async function applyRecurringService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  body: RecurringApplyInput & { nature?: "expense" | "profit" | null },
): Promise<ApplyOutcome> {
  const apt = await prisma.apartment.findFirst({ where: { id: apartmentId, organizationId: session.orgId }, select: { id: true } });
  if (!apt) return { ok: false, status: 404, error: "APARTMENT_NOT_FOUND" };
  if (body.kind === "CUSTOM") await ensureChargeCategorySeeds(session.orgId);

  const F = toMonth(body.effectiveFromMonth);
  const effectiveAmount = body.enabled ? dec2(body.amount) : "0.00";
  try {
    const result = await prisma.$transaction(async (tx) => {
      const def = await resolveOrCreateDefinition(tx, session.orgId, apartmentId, session.userId, body);
      const category = body.kind === "CUSTOM" ? await resolveCustomCategory(tx, session.orgId, body.bearer) : null;
      if (body.kind === "CUSTOM" && !category) throw new BadCategory();

      // Nature: an explicit value wins. An EDIT (definitionId present) with nature
      // omitted carries the latest revision's decided nature FORWARD — before this,
      // every amount edit silently reset a decided nature to null. A CREATE with
      // nature omitted stays null/undecided (the route 422s that case when
      // nature-routing is on).
      let nature: string | null = body.nature ?? null;
      if (body.nature === undefined && body.definitionId) {
        const prior = await tx.recurringChargeRevision.findFirst({
          where: { definitionId: def.id },
          orderBy: { effectiveFromMonth: "desc" },
          select: { nature: true },
        });
        nature = prior?.nature ?? null;
      }

      const revision = await appendRevision(tx, def.id, {
        amount: effectiveAmount, bearer: body.bearer, categoryId: category?.id ?? null, nature, effectiveFromMonth: F, enabled: body.enabled, createdBy: session.userId,
      });

      const target = await resolveRecurringTarget(tx, session.orgId, apartmentId, body.bearer, F);
      const entries = await entriesFrom(tx, session.orgId, apartmentId, F);

      const toSync: typeof entries = [];
      const conflicts: RecurringPreview["conflicts"] = [];
      let excluded = 0;
      for (const e of entries) {
        const reason = await nonSyncableReason(tx, session.orgId, e);
        if (reason) { excluded++; continue; }
        if (!target) { conflicts.push({ apartmentId, period: isoMonth(e.periodMonth), reason: body.bearer === "owner" ? "owner_unresolved" : "tenant_unresolved" }); continue; }
        toSync.push(e);
      }
      if (conflicts.length) throw new ApplyConflict(conflicts);

      let applied = 0;
      for (const e of toSync) {
        await writeSnapshot(tx, session.orgId, session.userId, e, {
          kind: body.kind, definitionId: def.id, revisionId: revision.id, effectiveAmount, bearer: body.bearer, enabled: body.enabled,
          nature: revision.nature, category, target: target!, name: body.name,
        });
        applied++;
      }

      await recordAudit(tx, {
        organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
        action: "grid.recurring.apply", entityType: "RecurringChargeDefinition", entityId: def.id,
        meta: { kind: body.kind, effectiveFromMonth: body.effectiveFromMonth, amount: effectiveAmount, bearer: body.bearer, enabled: body.enabled, applied, excluded },
      });
      return { applied, excluded, conflicts: [] as RecurringPreview["conflicts"] };
    });
    return { ok: true, status: 200, data: result };
  } catch (e) {
    if (e instanceof ApplyConflict) return { ok: false, status: 409, error: "recurring_conflict", conflicts: e.conflicts };
    if (e instanceof ApplyStale) return { ok: false, status: 409, error: "STALE", conflicts: [] };
    if (e instanceof RevisionOverlap) return { ok: false, status: 400, error: "REVISION_OVERLAP" };
    if (e instanceof DefinitionNotFound) return { ok: false, status: 404, error: "DEFINITION_NOT_FOUND" };
    if (e instanceof BadCategory) return { ok: false, status: 400, error: "CATEGORY_UNRESOLVED" };
    throw e;
  }
}

/** POST recurring/:definitionId/disable — effective-dated disable (spec R1). Appends an
 * enabled:false revision from the org-local current month and syncs open periods (removes the
 * custom line / zeroes the scalar) via the same block-all engine. */
export async function disableRecurringService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  definitionId: string,
): Promise<ApplyOutcome> {
  const def = await prisma.recurringChargeDefinition.findFirst({
    where: { id: definitionId, organizationId: session.orgId, apartmentId },
    include: { revisions: { orderBy: { effectiveFromMonth: "desc" }, take: 1 } },
  });
  if (!def) return { ok: false, status: 404, error: "DEFINITION_NOT_FOUND" };
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: session.orgId }, select: { timezone: true } });
  const current = currentBillingMonthUTC(org.timezone);
  const bearer = def.revisions[0]?.bearer ?? "owner";
  return applyRecurringService(session, apartmentId, {
    definitionId, kind: def.kind as RecurringApplyInput["kind"], name: def.name, amount: "0.00", bearer: bearer as "owner" | "tenant",
    effectiveFromMonth: isoMonth(current), enabled: false, confirm: true,
  });
}

/** POST recurring/:definitionId/archive — archive the definition (never hard-deleted, R1) and
 * remove its open-period custom snapshots >= current month via sync; billed/invoiced snapshots
 * are retained for history + re-Bill. */
export async function archiveRecurringService(
  session: { orgId: string; userId: string; role: string },
  apartmentId: string,
  definitionId: string,
): Promise<Result<{ id: string }>> {
  const def = await prisma.recurringChargeDefinition.findFirst({ where: { id: definitionId, organizationId: session.orgId, apartmentId }, select: { id: true, kind: true } });
  if (!def) return err(404, "DEFINITION_NOT_FOUND");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: session.orgId }, select: { timezone: true } });
  const current = currentBillingMonthUTC(org.timezone);
  await prisma.$transaction(async (tx) => {
    // Remove open (syncable) custom snapshots at/after the current month; keep billed ones.
    if (def.kind === "CUSTOM") {
      const lines = await tx.gridEntryRecurringLine.findMany({
        where: { organizationId: session.orgId, definitionId, gridEntry: { periodMonth: { gte: current } } },
        select: { id: true, gridEntry: { select: { id: true, billedAt: true, invoicedAt: true, apartmentId: true, periodMonth: true } } },
      });
      for (const ln of lines) {
        if (await isPeriodSnapshotSyncable(tx, session.orgId, ln.gridEntry)) {
          await tx.gridEntryRecurringLine.delete({ where: { id: ln.id } });
        }
      }
    }
    await tx.recurringChargeDefinition.update({ where: { id: definitionId }, data: { archivedAt: new Date() } });
    await recordAudit(tx, {
      organizationId: session.orgId, actorUserId: session.userId, actorRole: session.role,
      action: "grid.recurring.archive", entityType: "RecurringChargeDefinition", entityId: definitionId, meta: { kind: def.kind },
    });
  });
  return ok({ id: definitionId });
}
