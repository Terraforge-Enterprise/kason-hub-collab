/**
 * R4 — prior-period-adjustment (PPA) backend SPIKE. Flag-dark: the whole feature is
 * gated on ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT (default OFF).
 *
 * An admin records a newly-discovered prior-period CHARGE dated into an already-FROZEN
 * owner-statement month WITHOUT corrupting the frozen statement. In ONE $transaction:
 *   - create/validate the source Charge with its TRUE frozen `billingMonth`, calling
 *     `assertPeriodOpen(tx, …, { intent: "prior_period_adjustment" })` — the ONLY
 *     authorised way past the frozen guard, passed SOLELY from this service;
 *   - create NO normal frozen-month ledger row (the freeze guard skips that month
 *     anyway, so a PPA source charge gets no automatic frozen-month row);
 *   - create ONE `prior_period_adjustment` OwnerLedgerEntry in the current OPEN
 *     `statementMonth`, `sourceChargeId = charge.id`, with the charge's NATURAL owner-
 *     ledger effect PRESERVED (income direction, amount = collected = amount −
 *     outstanding) — NO direction flip, NO reversal logic. Never touches the frozen
 *     snapshot/manifest.
 *
 * Idempotent: exactly one PPA per source charge — enforced by the partial unique index
 * on (org, sourceType, sourceChargeId) which INCLUDES `prior_period_adjustment`.
 *
 * Distinct from `prior_period_collection` (R3): that posts new CASH against an EXISTING
 * frozen charge; a PPA books a newly-discovered CHARGE.
 */
import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";
import { OWNER_CATEGORY_DEFAULTS } from "@kason/shared";
import type { ClosedPeriodErrorBody } from "@kason/shared";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";
import { findPeriod } from "../owner-billing/owner-statement-period.repository";
import { assertPeriodOpen } from "./assert-period-open";
import { ClosedPeriodError, toClosedPeriodBody } from "./closed-period";
import type { DbOwnerLedgerEntry, OwnerLedgerActorCtx } from "./owner-ledger.types";

export interface PriorPeriodAdjustmentSourceChargeInput {
  /** Optional explicit Charge id (client-driven idempotent creation). */
  id?: string;
  /** The owner's Listing ("Unit") — must be owned by `ownerPartyId`. */
  unitId: string;
  /** The tenant Party the charge is billed to (Charge.partyId is required). */
  partyId: string;
  /** Income charge type: rent | carpark | utility | aircond. */
  chargeType: string;
  /** Gross billed amount (2dp string). */
  amount: string;
  /** Outstanding (2dp string); default "0.00" (a discovered charge already collected). */
  outstandingAmount?: string;
  /** Charge status → the PPA row's paymentStatus; default "paid". */
  status?: string;
  tenancyId?: string | null;
  /** ISO date (YYYY-MM-DD) within the frozen month; default first-of-frozen-month. */
  dueDate?: string;
  chargeNumber?: string;
  currency?: string;
  description?: string | null;
}

export interface PriorPeriodAdjustmentInput {
  ownerPartyId: string;
  /** "YYYY-MM" — the FROZEN month the discovered charge truly belongs to. */
  originalBillingMonth: string;
  /** "YYYY-MM" — must be the current OPEN month; defaults to it. */
  targetPostingMonth?: string;
  /** Mode (a): reference an existing (draft) frozen-dated charge. */
  sourceChargeId?: string;
  /** Mode (b): create the source charge from details. */
  sourceChargeInput?: PriorPeriodAdjustmentSourceChargeInput;
}

export interface PriorPeriodAdjustmentData {
  charge: { id: string; billingMonth: string };
  ledgerEntry: DbOwnerLedgerEntry;
  /** true when an existing PPA for the source charge was returned unchanged (idempotent). */
  idempotentReplay: boolean;
}

export type PriorPeriodAdjustmentResult =
  | { ok: true; status: 201; data: PriorPeriodAdjustmentData }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; body?: ClosedPeriodErrorBody };

// ── Helpers ─────────────────────────────────────────────────────────────────

const PPA_SOURCE_TYPE = "prior_period_adjustment";

/** Income chargeType → owner-ledger income category (mirrors owner-ledger.sync). */
const INCOME_CHARGE_CATEGORY: Record<string, string> = {
  rent: "rental_income",
  carpark: "carpark_income",
  utility: "utility_income",
  aircond: "aircond_income",
};

function monthStart(ym: string): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
}

function currentOpenMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** collected = amount − outstanding, as a 2dp string (integer-cent math, no float drift). */
function collectedString(amount: string, outstanding: string): string {
  const c = Math.round(Number(amount) * 100) - Math.round(Number(outstanding) * 100);
  return (c / 100).toFixed(2);
}

/** Charge.status → OwnerLedgerEntry.paymentStatus (mirrors owner-ledger.sync). */
function chargeStatusToPaymentStatus(status: string): string {
  switch (status) {
    case "paid":
      return "paid";
    case "partially_paid":
      return "partial";
    case "void":
      return "cancelled";
    default:
      return "pending";
  }
}

/** The owner-ledger effect a source charge should book, resolved from the charge context. */
interface ResolvedEffect {
  chargeId: string;
  category: string;
  propertyId: string;
  apartmentId: string | null;
  listingId: string | null;
  tenancyId: string | null;
  transactionDate: Date;
  /** collected = amount − outstanding, 2dp string (the R5-expected magnitude). */
  amount: string;
  paidBy: string;
  taxCategory: string;
  paymentStatus: string;
}

export async function createPriorPeriodAdjustment(
  actor: OwnerLedgerActorCtx,
  input: PriorPeriodAdjustmentInput,
): Promise<PriorPeriodAdjustmentResult> {
  // Flag-dark: the whole feature 404s (writes nothing) while the PPA flag is OFF.
  if (!isPhase2FlagEnabled("ENABLE_PHASE2_PRIOR_PERIOD_ADJUSTMENT")) {
    return { ok: false as const, status: 404, error: "not_found" };
  }

  const frozenStart = monthStart(input.originalBillingMonth);
  const postingStart = currentOpenMonthStart();

  // The PPA effect posts ONLY into the current OPEN month. A caller-supplied
  // targetPostingMonth is honoured only when it names that month — anything else
  // (incl. the source frozen month, or another frozen month) is rejected, closing the
  // "post into a frozen month" hole the intent bypass would otherwise leave unchecked.
  if (input.targetPostingMonth && input.targetPostingMonth !== monthKey(postingStart)) {
    return { ok: false as const, status: 400, error: "posting_month_must_be_current_open" };
  }

  const db = getDb();
  const isRefMode = !!input.sourceChargeId;

  // ── Resolve + validate the source charge. Mode (a): reference an existing charge;
  //    Mode (b): create one from details. Both reject (writing nothing) on a non-income
  //    type / unknown unit / owner-unit mismatch / cross-org id. ───────────────────
  const resolved = isRefMode
    ? await resolveRefModeEffect(db, actor.orgId, input)
    : await resolveCreateModeEffect(db, actor.orgId, input);
  if (!resolved.ok) return resolved;
  const effect = resolved.effect;

  // ── The original billing month MUST be frozen (LIVE_LEDGER-INDEPENDENT: reads
  //    period.status directly, so PPA works even with LIVE_LEDGER off). An open month
  //    is not a PPA scenario — use the normal create path. ────────────────────────
  const period = await findPeriod(actor.orgId, {
    ownerPartyId: input.ownerPartyId,
    apartmentId: null,
    periodMonth: frozenStart,
  });
  if (period?.status !== "frozen") {
    return { ok: false as const, status: 400, error: "original_month_not_frozen" };
  }

  // Idempotency: exactly one PPA per source charge. When the charge id is known up-front
  // (ref-mode, or create-mode with an explicit id) an existing ACTIVE PPA is returned
  // unchanged. The DB partial unique on (org, sourceType, sourceChargeId) is the real
  // backstop; the concurrency race + a prior VOID PPA are handled in the P2002 catch.
  const knownChargeId = isRefMode ? input.sourceChargeId! : input.sourceChargeInput?.id;
  if (knownChargeId) {
    const existing = await db.ownerLedgerEntry.findFirst({
      where: { organizationId: actor.orgId, sourceType: PPA_SOURCE_TYPE, sourceChargeId: knownChargeId, status: "active" },
    });
    if (existing) return idempotentResult(existing, input);
  }

  const sci = input.sourceChargeInput; // present only in create-mode

  try {
    const data = await db.$transaction(async (tx) => {
      // The ONLY authorised frozen-dated write: passing the PPA intent short-circuits the
      // guard (it never reads the period). Kept here so the authorised bypass is exercised
      // at exactly one auditable point — the PPA service — and nowhere else.
      await assertPeriodOpen(tx, actor.orgId, input.ownerPartyId, frozenStart, {
        intent: PPA_SOURCE_TYPE,
      });

      // Ref-mode reuses the existing charge; create-mode mints it (raw tx.charge.create —
      // the normal charge-sync hook is NOT invoked here, so no stray frozen-month or
      // duplicate open-month ledger row appears beside the PPA).
      let chargeId = effect.chargeId;
      if (!isRefMode) {
        const charge = await tx.charge.create({
          data: {
            ...(sci!.id ? { id: sci!.id } : {}),
            organizationId: actor.orgId,
            chargeNumber: sci!.chargeNumber ?? `PPA-${Date.now()}`,
            partyId: sci!.partyId,
            tenancyId: sci!.tenancyId ?? null,
            unitId: sci!.unitId,
            chargeType: sci!.chargeType,
            status: sci!.status ?? "paid",
            postedAt: new Date(),
            dueDate: effect.transactionDate,
            amount: sci!.amount,
            currency: sci!.currency ?? "MYR",
            outstandingAmount: sci!.outstandingAmount ?? "0.00",
            billingMonth: frozenStart, // TRUE frozen month — never rewritten
            description: sci!.description ?? null,
          },
        });
        chargeId = charge.id;
      }

      const ledgerEntry = await createPpaLedgerRow(tx, actor, input, postingStart, {
        ...effect,
        chargeId,
      });

      return {
        charge: { id: chargeId, billingMonth: input.originalBillingMonth },
        ledgerEntry,
        idempotentReplay: false,
      };
    });

    return { ok: true as const, status: 201, data };
  } catch (err) {
    if (err instanceof ClosedPeriodError) {
      return { ok: false as const, status: 409, error: "closed_period", body: toClosedPeriodBody(err) };
    }
    // The PPA partial unique fired (concurrent second insert, or a prior — possibly VOID —
    // PPA for this charge). The tx has fully rolled back, so any create-mode charge is
    // gone (no orphan). Re-read: an ACTIVE PPA ⇒ idempotent success; otherwise the source
    // charge already carries a (voided) adjustment that must not be silently recreated.
    if (isUniqueViolation(err)) {
      const lookupChargeId = knownChargeId ?? effect.chargeId;
      const existing = await db.ownerLedgerEntry.findFirst({
        where: { organizationId: actor.orgId, sourceType: PPA_SOURCE_TYPE, sourceChargeId: lookupChargeId },
        orderBy: { createdAt: "desc" },
      });
      if (existing?.status === "active") return idempotentResult(existing, input);
      return { ok: false as const, status: 409, error: "prior_period_adjustment_exists" };
    }
    throw err;
  }
}

/** Postgres unique-violation (Prisma P2002) — duck-typed to avoid a runtime import. */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

function idempotentResult(
  existing: DbOwnerLedgerEntry,
  input: PriorPeriodAdjustmentInput,
): PriorPeriodAdjustmentResult {
  return {
    ok: true as const,
    status: 201,
    data: {
      charge: { id: existing.sourceChargeId ?? "", billingMonth: input.originalBillingMonth },
      ledgerEntry: existing,
      idempotentReplay: true,
    },
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

type ResolveResult =
  | { ok: true; effect: ResolvedEffect }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * Validate the create-mode input and derive the owner-ledger effect. Rejects
 * (writing nothing) on: missing source input, a non-income charge type, an unknown
 * unit, or a unit not owned by `ownerPartyId`. The derived effect uses the COLLECTED
 * figure (amount − outstanding) so it matches R5's expected magnitude exactly.
 */
async function resolveCreateModeEffect(
  db: ReturnType<typeof getDb>,
  orgId: string,
  input: PriorPeriodAdjustmentInput,
): Promise<ResolveResult> {
  const sci = input.sourceChargeInput;
  if (!sci) return { ok: false as const, status: 400, error: "source_charge_input_required" };

  const category = INCOME_CHARGE_CATEGORY[sci.chargeType];
  if (!category) return { ok: false as const, status: 400, error: "unsupported_charge_type" };

  const listing = await db.listing.findFirst({
    where: { id: sci.unitId, organizationId: orgId },
    select: { id: true, apartmentId: true, ownerPartyId: true },
  });
  if (!listing) return { ok: false as const, status: 404, error: "unit_not_found" };
  if (listing.ownerPartyId !== input.ownerPartyId) {
    return { ok: false as const, status: 403, error: "owner_unit_mismatch" };
  }
  const apartment = await db.apartment.findFirst({
    where: { id: listing.apartmentId },
    select: { propertyId: true },
  });
  if (!apartment) return { ok: false as const, status: 404, error: "apartment_not_found" };

  const defaults = OWNER_CATEGORY_DEFAULTS[category];
  const frozenStart = monthStart(input.originalBillingMonth);
  return {
    ok: true as const,
    effect: {
      chargeId: "", // filled after the charge is created
      category,
      propertyId: apartment.propertyId,
      apartmentId: listing.apartmentId,
      listingId: sci.unitId,
      tenancyId: sci.tenancyId ?? null,
      transactionDate: sci.dueDate ? new Date(sci.dueDate) : frozenStart,
      amount: collectedString(sci.amount, sci.outstandingAmount ?? "0.00"),
      paidBy: defaults?.defaultPaidBy ?? "kaen",
      taxCategory: defaults?.defaultTaxCategory ?? "check_with_tax_agent",
      paymentStatus: chargeStatusToPaymentStatus(sci.status ?? "paid"),
    },
  };
}

function firstOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Mode (a) — validate an EXISTING (org-scoped) source charge and derive its effect.
 * Rejects (writing nothing) on: not found / cross-org (404), a non-income type (400),
 * a carpark/unit-less source (400 — out of spike scope), a billingMonth that is not the
 * declared original month (400), an unknown unit (404), or an owner-unit mismatch (403).
 */
async function resolveRefModeEffect(
  db: ReturnType<typeof getDb>,
  orgId: string,
  input: PriorPeriodAdjustmentInput,
): Promise<ResolveResult> {
  const charge = await db.charge.findFirst({
    where: { id: input.sourceChargeId, organizationId: orgId },
    select: { id: true, chargeType: true, unitId: true, tenancyId: true, amount: true, outstandingAmount: true, billingMonth: true, dueDate: true, status: true },
  });
  if (!charge) return { ok: false as const, status: 404, error: "source_charge_not_found" };

  const category = INCOME_CHARGE_CATEGORY[charge.chargeType];
  if (!category) return { ok: false as const, status: 400, error: "unsupported_charge_type" };
  if (!charge.unitId) return { ok: false as const, status: 400, error: "unsupported_source" };

  const frozenStart = monthStart(input.originalBillingMonth);
  if (!charge.billingMonth || firstOfUtcMonth(charge.billingMonth).getTime() !== frozenStart.getTime()) {
    return { ok: false as const, status: 400, error: "charge_month_mismatch" };
  }

  const listing = await db.listing.findFirst({
    where: { id: charge.unitId, organizationId: orgId },
    select: { apartmentId: true, ownerPartyId: true },
  });
  if (!listing) return { ok: false as const, status: 404, error: "unit_not_found" };
  if (listing.ownerPartyId !== input.ownerPartyId) {
    return { ok: false as const, status: 403, error: "owner_unit_mismatch" };
  }
  const apartment = await db.apartment.findFirst({
    where: { id: listing.apartmentId },
    select: { propertyId: true },
  });
  if (!apartment) return { ok: false as const, status: 404, error: "apartment_not_found" };

  const defaults = OWNER_CATEGORY_DEFAULTS[category];
  return {
    ok: true as const,
    effect: {
      chargeId: charge.id,
      category,
      propertyId: apartment.propertyId,
      apartmentId: listing.apartmentId,
      listingId: charge.unitId,
      tenancyId: charge.tenancyId,
      transactionDate: charge.dueDate,
      amount: collectedString(charge.amount.toString(), charge.outstandingAmount.toString()),
      paidBy: defaults?.defaultPaidBy ?? "kaen",
      taxCategory: defaults?.defaultTaxCategory ?? "check_with_tax_agent",
      paymentStatus: chargeStatusToPaymentStatus(charge.status),
    },
  };
}

/**
 * Create the single `prior_period_adjustment` ledger row in the current OPEN month.
 * NO normal frozen-month row is created; the charge's NATURAL effect is preserved
 * (income direction, collected amount) — never flipped, never reversed.
 */
async function createPpaLedgerRow(
  tx: Prisma.TransactionClient,
  actor: OwnerLedgerActorCtx,
  input: PriorPeriodAdjustmentInput,
  postingStart: Date,
  effect: ResolvedEffect,
): Promise<DbOwnerLedgerEntry> {
  return tx.ownerLedgerEntry.create({
    data: {
      organizationId: actor.orgId,
      ownerPartyId: input.ownerPartyId,
      propertyId: effect.propertyId,
      apartmentId: effect.apartmentId,
      listingId: effect.listingId,
      tenancyId: effect.tenancyId,
      statementMonth: postingStart,
      transactionDate: effect.transactionDate,
      direction: "income",
      category: effect.category,
      description: `Prior-period adjustment: ${effect.category} (from ${input.originalBillingMonth})`,
      amount: effect.amount,
      sstAmount: null,
      paidBy: effect.paidBy,
      paymentStatus: effect.paymentStatus,
      taxCategory: effect.taxCategory,
      includeInPayout: true,
      sourceType: PPA_SOURCE_TYPE,
      sourceChargeId: effect.chargeId,
      status: "active",
      createdById: actor.actorUserId,
      updatedById: actor.actorUserId,
    },
  });
}
