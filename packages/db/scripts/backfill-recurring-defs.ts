/**
 * Data migration (recurring-charges, spec R10): convert each apartment's existing
 * UnitBillsBearerConfig into recurring-charge definitions.
 *
 *   • CLEANING → a RecurringChargeDefinition (code "cleaning") + one revision
 *       { amount = cleaningRecurringAmount (0/null ⇒ disabled), bearer = cleaningBearer,
 *         effectiveFromMonth = the org-local CURRENT month (Open Question 1, LOCKED),
 *         enabled = amount > 0 }.
 *   • WIFI → a RecurringChargeDefinition (code "wifi") + one revision
 *       { amount 0, bearer = wifiBearer, effectiveFromMonth = current month, enabled = false }
 *       (Open Question 4, LOCKED: WiFi starts disabled — nothing bills until configured).
 *
 * IDEMPOTENT + re-runnable: an apartment that already has a CLEANING/WIFI definition is skipped
 * (the deterministic per-(apartment,kind) `code` + @@unique([organizationId, apartmentId, code])
 * makes a re-run a no-op). Touches NO UnitBillsGridEntry row — existing entry.cleaning/wifi
 * values are never read or written, so already-created (incl. billed) periods are byte-identical
 * afterward. Runs per apartment in its own sub-transaction (def + revision atomic); a partial
 * failure leaves the money path untouched.
 */
import { getDb } from "@kason/db";

type Db = ReturnType<typeof getDb>;

/** The month (UTC first-of-month) that is "current" in the org's IANA timezone. Mirrors
 * bills-grid/service.ts's currentBillingMonthUTC (re-implemented here so packages/db carries no
 * dependency on apps/api). */
function currentBillingMonthUTC(orgTimezone: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: orgTimezone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return new Date(`${year}-${month}-01T00:00:00.000Z`);
}

const SYSTEM_ACTOR = "00000000-0000-4000-8000-000000000000";

export interface BackfillResult { createdCleaning: number; createdWifi: number; skipped: number }

export async function backfillRecurringDefs(
  db: Db,
  opts: { organizationId?: string; now?: Date } = {},
): Promise<BackfillResult> {
  const now = opts.now ?? new Date();
  const configs = await db.unitBillsBearerConfig.findMany({
    where: opts.organizationId ? { organizationId: opts.organizationId } : {},
    select: { organizationId: true, apartmentId: true, cleaningRecurringAmount: true, cleaningBearer: true, wifiBearer: true },
  });

  const tzByOrg = new Map<string, string>();
  const actorByOrg = new Map<string, string>();
  const res: BackfillResult = { createdCleaning: 0, createdWifi: 0, skipped: 0 };

  for (const cfg of configs) {
    // Org timezone → current month (cached per org).
    let tz = tzByOrg.get(cfg.organizationId);
    if (tz === undefined) {
      const org = await db.organization.findUnique({ where: { id: cfg.organizationId }, select: { timezone: true } });
      tz = org?.timezone ?? "UTC";
      tzByOrg.set(cfg.organizationId, tz);
    }
    const effectiveFromMonth = currentBillingMonthUTC(tz, now);

    // createdBy — the org's first user (identifies the backfill for rollback); a synthetic system
    // actor if the org has none. createdBy is a plain column (no FK), so a synthetic id is safe.
    let actor = actorByOrg.get(cfg.organizationId);
    if (actor === undefined) {
      const u = await db.user.findFirst({ where: { organizationId: cfg.organizationId }, select: { id: true } });
      actor = u?.id ?? SYSTEM_ACTOR;
      actorByOrg.set(cfg.organizationId, actor);
    }

    // CLEANING
    const hasCleaning = await db.recurringChargeDefinition.findFirst({ where: { organizationId: cfg.organizationId, apartmentId: cfg.apartmentId, code: "cleaning" }, select: { id: true } });
    if (hasCleaning) {
      res.skipped++;
    } else {
      const amount = cfg.cleaningRecurringAmount == null ? 0 : Number(cfg.cleaningRecurringAmount.toString());
      const enabled = amount > 0;
      await db.$transaction(async (tx) => {
        const def = await tx.recurringChargeDefinition.create({ data: { organizationId: cfg.organizationId, apartmentId: cfg.apartmentId, kind: "CLEANING", code: "cleaning", name: "Cleaning", createdBy: actor! } });
        await tx.recurringChargeRevision.create({ data: { definitionId: def.id, amount: amount.toFixed(2), bearer: cfg.cleaningBearer, categoryId: null, effectiveFromMonth, effectiveToMonth: null, enabled, createdBy: actor! } });
      });
      res.createdCleaning++;
    }

    // WIFI — always seeded DISABLED at 0 (Open Question 4).
    const hasWifi = await db.recurringChargeDefinition.findFirst({ where: { organizationId: cfg.organizationId, apartmentId: cfg.apartmentId, code: "wifi" }, select: { id: true } });
    if (hasWifi) {
      res.skipped++;
    } else {
      await db.$transaction(async (tx) => {
        const def = await tx.recurringChargeDefinition.create({ data: { organizationId: cfg.organizationId, apartmentId: cfg.apartmentId, kind: "WIFI", code: "wifi", name: "WiFi", createdBy: actor! } });
        await tx.recurringChargeRevision.create({ data: { definitionId: def.id, amount: "0.00", bearer: cfg.wifiBearer, categoryId: null, effectiveFromMonth, effectiveToMonth: null, enabled: false, createdBy: actor! } });
      });
      res.createdWifi++;
    }
  }
  return res;
}

// CLI entrypoint: `tsx packages/db/scripts/backfill-recurring-defs.ts [organizationId]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getDb();
  const organizationId = process.argv[2];
  backfillRecurringDefs(db, organizationId ? { organizationId } : {})
    .then((r) => { console.log("[backfill-recurring-defs]", JSON.stringify(r)); })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
