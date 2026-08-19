/**
 * Move-in DEPOSIT documents — rental deposit + utilities deposit, drafted ONCE per
 * tenancy (post-commit hook).
 *
 * A deposit is not rent. It is refundable money HELD on the landlord's behalf, so it
 * bills on the `pay_back_landlord` rail (categories `security_deposit` /
 * `utility_deposit`, DEP series) and is deliberately absent from every owner-ledger
 * chargeType allow-list — `owner-ledger.sync.ts` selects by explicit chargeType
 * (`"rent"`, `{ in: ["utility","aircond"] }`, …) and never sweeps, so a deposit can
 * never become owner rental income or be remitted in that month's payout. That is a
 * property of the design, not a filter someone has to remember to add.
 *
 * ── The four gates, all FAIL CLOSED ──────────────────────────────────────────────
 *  1. FLAG        — ENABLE_TENANCY_DEPOSIT_DOCS off ⇒ hard no-op.
 *  2. THIS MONTH  — the tenancy's START DATE must fall in the org-local CURRENT month.
 *                   A backdated move-in gets NOTHING, however recently the admin keyed
 *                   it in: assigning a June tenant in August must not raise an August
 *                   deposit. Uses currentBillingMonthUTC(org.timezone), the same
 *                   org-local month helper the bills-grid uses to refuse a past period
 *                   — NOT a UTC "now", which flips a day early/late for a UTC+8 org.
 *  3. MANAGEMENT  — Apartment.underManagement must be TRUE. When KAEN is not the
 *                   billing agent for an apartment it raises no charges for it at all;
 *                   a deposit is exactly the kind of money that must not appear for a
 *                   self-managed owner.
 *  4. OWNER       — the Listing must have an ownerPartyId. A deposit is PAYABLE_TO_OWNER,
 *                   and resolveOwnerReferences THROWS `PRINCIPAL_OWNER_REQUIRED` on an
 *                   owner-less unit. Checking here turns that into a quiet, audited skip
 *                   at assignment time instead of an exception that aborts the admin's
 *                   approval transaction later.
 *
 * ── Once per tenancy, forever ────────────────────────────────────────────────────
 * The charge numbers carry NO month component (`DEPRENT-{tenancyId}`), so the natural
 * `@@unique(organizationId, chargeNumber)` is itself the once-ever guard: a re-run, a
 * re-save, a renewal edit and a second assignment path all collapse onto the same row.
 * Re-pricing is likewise impossible — an existing charge is never rewritten, so a later
 * rent change cannot silently restate a deposit the tenant has already been given.
 *
 * Contract mirrors draft-catchup.hook.ts: callers fire AFTER their creating transaction
 * commits, every error is swallowed (a deposit failure must never fail a move-in), and a
 * durable `billing.tenancydeposit.failed` AuditLog marker is left behind.
 */
import { getDb, Prisma } from "@kason/db";
import { resolveDepositBasisRate } from "@kason/shared";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { isBillableStatus } from "../../lib/tenancy-period";
import { currentBillingMonthUTC } from "../../lib/billing-month";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { createInvoiceTx, recomputeInvoiceTotalTx } from "./auto-draft.repository";
import type { DraftCatchupCtx } from "./draft-catchup.hook";

export const TENANCY_DEPOSIT_TRIGGERED_BY = "system:tenancy-deposits";

/** Why a tenancy raised no deposit. Recorded in the audit meta so a miss stays findable. */
export type DepositSkipReason =
  | "flag_off"
  | "tenancy_not_found"
  | "not_billable_status"
  | "move_in_not_current_month"
  | "not_under_management"
  | "no_owner_party"
  | "is_renewal"
  | "no_rent_basis"
  | "no_deposit_months"
  | "already_created";

export type DepositOutcome =
  | { created: true; invoiceId: string; chargeNumbers: string[] }
  | { created: false; reason: DepositSkipReason };

/** The two deposit legs, each mapped to the seeded category it bills through. */
const DEPOSIT_LEGS = [
  {
    // categoryCode is the DEPO-series `tenancy_*_deposit`, NOT the older DEP-series
    // security_deposit / utility_deposit — those stay on the shared DEP series that also
    // carries utility and aircond debit notes, which cannot be retitled. See
    // seed-categories.ts for why new codes exist rather than repointed old ones.
    key: "rental" as const,
    categoryCode: "tenancy_rental_deposit",
    chargeType: "security_deposit",
    chargeNumberPrefix: "DEPRENT",
    description: "Rental deposit",
  },
  {
    key: "utilities" as const,
    categoryCode: "tenancy_utility_deposit",
    chargeType: "utility_deposit",
    chargeNumberPrefix: "DEPUTIL",
    description: "Utilities deposit",
  },
] as const;

export function depositChargeNumber(prefix: string, tenancyId: string): string {
  return `${prefix}-${tenancyId}`;
}

/** First-of-month (UTC) for a date, for comparing a move-in against the current month. */
function firstOfMonthOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function toNumberOrNull(v: Prisma.Decimal | null): number | null {
  if (v == null) return null;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

/**
 * Durable marker for a swallowed failure. Best-effort, in its own try/catch, so an
 * audit-write failure can never re-throw into the creator that fired this hook.
 */
async function recordDepositFailure(
  ctx: DraftCatchupCtx,
  tenancyId: string,
  meta: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await getDb().$transaction((tx) =>
      recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action: "billing.tenancydeposit.failed",
        entityType: "Tenancy",
        entityId: tenancyId,
        meta,
      }),
    );
  } catch (auditErr) {
    console.error("[tenancy-deposits] failed to record failure audit (swallowed):", auditErr);
  }
}

/**
 * Draft this tenancy's two deposit charges, if every gate passes. Never throws.
 *
 * Returns what it did so callers and tests can observe the outcome; a skip is a normal,
 * expected result (most assignments are backdated, un-managed, or already deposited).
 */
export async function createTenancyDepositsForTenancy(
  ctx: DraftCatchupCtx,
  tenancyId: string,
  now: Date = new Date(),
): Promise<DepositOutcome> {
  // GATE 1 — flag. Dark ⇒ this feature does not exist.
  if (!isPhase2FlagEnabled("ENABLE_TENANCY_DEPOSIT_DOCS")) {
    return { created: false, reason: "flag_off" };
  }
  try {
    const db = getDb();
    const tenancy = await db.tenancy.findFirst({
      where: { id: tenancyId, organizationId: ctx.orgId },
      select: {
        id: true, unitId: true, tenantPartyId: true, propertyId: true,
        startDate: true, status: true, monthlyRentAmount: true, previousTenancyId: true,
        unit: {
          select: {
            id: true, rentalRate: true, ownerPartyId: true,
            depositMonths: true, utilitiesDepositMonths: true,
            apartment: { select: { underManagement: true } },
          },
        },
      },
    });
    if (!tenancy) return { created: false, reason: "tenancy_not_found" };
    if (!isBillableStatus(tenancy.status)) {
      return { created: false, reason: "not_billable_status" };
    }

    // A RENEWAL is a new Tenancy row for a tenant who is already sitting on a deposit
    // KAEN holds. `previousTenancyId` is the renewal chain's own link, so this holds
    // wherever the hook is called from — renewTenancyService is deliberately not wired
    // to it today, and this makes wiring it later harmless rather than a second charge.
    // "Once per tenancy" is the mechanism; "once per tenant relationship" is the intent.
    if (tenancy.previousTenancyId) {
      return { created: false, reason: "is_renewal" };
    }

    // GATE 2 — the move-in must be THIS month, in the ORG's local calendar.
    //
    // Equality, not `>=`: a move-in dated NEXT month is as out-of-scope as one dated
    // last month. Its deposit belongs to the month it actually starts, and drafting it
    // early would place a charge in a period the tenancy does not yet occupy.
    const org = await db.organization.findUnique({
      where: { id: ctx.orgId },
      select: { timezone: true },
    });
    // No org row / no timezone ⇒ we cannot know what "this month" means locally. Fail
    // closed rather than fall back to UTC and bill a deposit a day out at the boundary.
    if (!org?.timezone) {
      return { created: false, reason: "move_in_not_current_month" };
    }
    const currentMonth = currentBillingMonthUTC(org.timezone);
    if (firstOfMonthOf(tenancy.startDate).getTime() !== currentMonth.getTime()) {
      return { created: false, reason: "move_in_not_current_month" };
    }

    // GATE 3 — KAEN must be the billing agent for this apartment.
    // A missing apartment relation is treated as NOT managed (fail closed), never as
    // the `@default(true)` the column carries for rows that do exist.
    if (tenancy.unit?.apartment?.underManagement !== true) {
      return { created: false, reason: "not_under_management" };
    }

    // GATE 4 — a PAYABLE_TO_OWNER document needs a principal owner.
    if (!tenancy.unit.ownerPartyId) {
      return { created: false, reason: "no_owner_party" };
    }

    // The deposit basis is the TENANCY's rent (asking rate only as the vacant-unit
    // fallback, which cannot apply here — this tenancy exists). Shared with the
    // edit-unit display, so the admin's screen and the tenant's bill agree.
    const basisRate = resolveDepositBasisRate({
      tenancyMonthlyRent: toNumberOrNull(tenancy.monthlyRentAmount),
      rentalRate: toNumberOrNull(tenancy.unit.rentalRate),
    });
    if (basisRate == null || basisRate <= 0) {
      return { created: false, reason: "no_rent_basis" };
    }

    // Deposit MONTHS come from the listing as RECORDED. A null is NOT defaulted to
    // 2 / 0.5 here: the web form's defaults are a data-entry convenience, and turning
    // an un-entered field into a real receivable would bill money nobody keyed in.
    // Null or 0 ⇒ that leg is simply not raised.
    const monthsByKey: Record<(typeof DEPOSIT_LEGS)[number]["key"], number | null> = {
      rental: toNumberOrNull(tenancy.unit.depositMonths),
      utilities: toNumberOrNull(tenancy.unit.utilitiesDepositMonths),
    };
    const legs = DEPOSIT_LEGS.map((leg) => {
      const months = monthsByKey[leg.key];
      const amountCents =
        months == null || months <= 0 ? 0 : Math.round(basisRate * months * 100);
      return { ...leg, months, amountCents };
    }).filter((l) => l.amountCents > 0);

    if (legs.length === 0) return { created: false, reason: "no_deposit_months" };

    // Categories must exist before the charges reference them (idempotent per-org).
    await ensureChargeCategorySeeds(ctx.orgId);

    const idemKey = `deposit:${tenancy.id}`;
    const billingMonth = currentMonth;

    return await db.$transaction(async (tx) => {
      // Once-ever guard, check-first. The unique on (organizationId, chargeNumber)
      // is the real enforcement; this turns a replay into an ordinary skip instead of
      // a P2002 that aborts an interactive transaction (the same lesson
      // draftRentInvoiceForTenancy learned for its rent chargeNumber).
      //
      // ALL-OR-NOTHING across the two legs, deliberately. If a tenancy was assigned with
      // `utilitiesDepositMonths` still blank, only the rental leg was raised — and filling
      // that field in later does NOT top the tenancy up with a second deposit charge. Two
      // reasons: the deposit invoice may already be approved and issued (you cannot add a
      // line to a document the tenant holds), and money appearing on a tenant's account as
      // a side effect of editing a LISTING field is exactly the kind of silent billing this
      // codebase avoids. The late leg is an explicit manual charge, by a human who meant it.
      const existing = await tx.charge.findFirst({
        where: {
          organizationId: ctx.orgId,
          chargeNumber: { in: legs.map((l) => depositChargeNumber(l.chargeNumberPrefix, tenancy.id)) },
        },
        select: { id: true },
      });
      if (existing) return { created: false as const, reason: "already_created" as const };

      const categories = await tx.chargeCategory.findMany({
        where: { organizationId: ctx.orgId, code: { in: legs.map((l) => l.categoryCode) } },
        select: { id: true, code: true },
      });
      const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));

      const invoice = await createInvoiceTx(tx, {
        orgId: ctx.orgId,
        // FULL tenancy id, not an 8-char slice: the rent path's
        // `TR-{YYYYMM}-{tenancyId.slice(0,8)}` is a documented 32-bit collision key,
        // and a deposit has no month to disambiguate a collision with.
        invoiceNumber: `TD-${tenancy.id}`,
        partyId: tenancy.tenantPartyId,
        tenancyId: tenancy.id,
        propertyId: tenancy.propertyId,
        invoiceType: "tenant_deposit",
        invoiceDate: now,
        // Deposits fall due at move-in, not on the rent cycle.
        dueDate: tenancy.startDate,
        periodMonth: billingMonth,
        idempotencyKey: idemKey,
      });

      const chargeNumbers: string[] = [];
      for (const leg of legs) {
        const chargeNumber = depositChargeNumber(leg.chargeNumberPrefix, tenancy.id);
        const amount = (leg.amountCents / 100).toFixed(2);
        const charge = await tx.charge.create({
          data: {
            organizationId: ctx.orgId,
            chargeNumber,
            tenancyId: tenancy.id,
            unitId: tenancy.unitId,
            partyId: tenancy.tenantPartyId,
            categoryId: categoryIdByCode.get(leg.categoryCode) ?? null,
            chargeType: leg.chargeType,
            status: "draft",
            description: `${leg.description} (${leg.months} × RM${basisRate.toFixed(2)})`,
            dueDate: tenancy.startDate,
            amount,
            currency: "MYR",
            outstandingAmount: amount,
            billingMonth,
            attachmentKeys: [],
            invoiceId: invoice.id,
            // Economic classification — a deposit is the tenant's money collected for the
            // owner, never KAEN revenue. Routes to DEPOSIT_INVOICE / PAYABLE_TO_OWNER →
            // the DEP series, matching what the category path resolves to, so the document
            // series does not depend on ENABLE_PHASE2_RENT_RECLASSIFICATION.
            commercialPurpose: "DEPOSIT",
            fundedBy: "tenant_funded",
            revenueRecognition: "third_party_collection",
            settlementRecipient: "owner",
            // Deposits carry no service tax — nothing is being supplied.
            sstRate: "0",
          },
          select: { id: true },
        });
        await tx.chargeEvent.create({
          data: {
            organizationId: ctx.orgId,
            chargeId: charge.id,
            eventType: "draft.created",
            eventAt: now,
            actorUserId: ctx.userId,
            payloadJson: { invoiceId: invoice.id, source: TENANCY_DEPOSIT_TRIGGERED_BY, leg: leg.key },
          },
        });
        chargeNumbers.push(chargeNumber);
      }

      await recomputeInvoiceTotalTx(tx, ctx.orgId, invoice.id);
      await recordAudit(tx, {
        organizationId: ctx.orgId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action: "billing.tenancydeposit.drafted",
        entityType: "Invoice",
        entityId: invoice.id,
        meta: {
          tenancyId: tenancy.id,
          basisRate: basisRate.toFixed(2),
          legs: legs.map((l) => ({ leg: l.key, months: l.months, amount: (l.amountCents / 100).toFixed(2) })),
          triggeredBy: TENANCY_DEPOSIT_TRIGGERED_BY,
        },
      });

      return { created: true as const, invoiceId: invoice.id, chargeNumbers };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Lost the race to a concurrent assignment path. The goal — exactly one deposit
      // per tenancy — was reached by whoever won, so this is the ordinary skip.
      console.warn(`[tenancy-deposits] tenancy ${tenancyId}: P2002 — already created elsewhere`);
      return { created: false, reason: "already_created" };
    }
    console.error("[tenancy-deposits] failed (swallowed):", e);
    await recordDepositFailure(ctx, tenancyId, { error: (e as Error).message });
    return { created: false, reason: "tenancy_not_found" };
  }
}

/**
 * Unit-keyed variant for the inventory flows (edit-unit / create-unit), which
 * materialise the tenancy inside syncOccupancyTenancy and never see its id.
 *
 * Mirrors draftCatchupForUnit: resolve the unit's ACTIVE tenancies post-commit in a
 * deterministic order and run each. Every leg is idempotent, so covering all of them is
 * strictly safer than letting Postgres physical order pick one. Never throws.
 */
export async function createTenancyDepositsForUnit(
  ctx: DraftCatchupCtx,
  unitId: string,
  now: Date = new Date(),
): Promise<DepositOutcome[]> {
  if (!isPhase2FlagEnabled("ENABLE_TENANCY_DEPOSIT_DOCS")) return [];
  try {
    const active = await getDb().tenancy.findMany({
      where: { organizationId: ctx.orgId, unitId, status: "active" },
      select: { id: true },
      orderBy: [{ startDate: "desc" }, { id: "asc" }],
    });
    const out: DepositOutcome[] = [];
    for (const t of active) {
      out.push(await createTenancyDepositsForTenancy(ctx, t.id, now));
    }
    return out;
  } catch (e) {
    console.error("[tenancy-deposits] unit lookup failed (swallowed):", e);
    return [];
  }
}
