import { getDb } from "@kason/db";
import { Decimal } from "@prisma/client/runtime/client";
import { formatMyPhoneDisplay, readPhoneAnyFormat } from "@kason/shared";
import { markIcKeysConsumed } from "../tenant-ic/tenant-ic.service";
import { objectExists } from "../../../lib/storage";
import { enqueueClaimNotification } from "../notifications/dispatcher";
import { getWhatsAppSender } from "../../../lib/whatsapp";
import {
  getAgentDashboardFull, listAgentClaims, findAgentClaim,
  resolveTierPercentage, searchProperties, generateClaimNumberTx,
  listActiveRoomTypes,   // NEW
} from "./portal.commissions.repository";
import { validateAll, validateRuleA, validateRuleD, type ValidatorPayload } from "./claim-validator";
import { ClaimError, claimErrorToHttpStatus, isClaimError, type ClaimErrorCode, type ClaimErrorPayloads } from "./claim-errors";
import { assertTransition, type ClaimStatus } from "./claim-state-machine";
import { recordAudit } from "../../../lib/audit";
import { computeNettPayout } from "../../commissions/calc/compute-nett-payout";
import { walkUplineChain } from "../notifications/recipients";

type PortalSession = { userId: string; orgId: string; userType: string; partyId: string; role?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTxForTaTier = any;

/**
 * Assert that `chargesByKaen` matches the per-org TaTier companyMinimum for
 * the given `monthlyRental`. Throws `ClaimError("ta_tier_mismatch")` (→ 422)
 * when the value diverges from the table. Applies uniformly to all claim types.
 */
async function assertTaTierMatch(
  tx: PrismaTxForTaTier,
  orgId: string,
  monthlyRental: Decimal,
  chargesByKaen: Decimal,
): Promise<void> {
  const tiers = await tx.taTier.findMany({
    where: { organizationId: orgId },
    orderBy: { rentalMin: "asc" },
  });

  const match = (tiers as Array<{ rentalMin: string; rentalMax: string | null; companyMinimum: string }>).find((t) => {
    const min = new Decimal(t.rentalMin);
    const max = t.rentalMax ? new Decimal(t.rentalMax) : null;
    return (
      monthlyRental.greaterThanOrEqualTo(min) &&
      (max === null || monthlyRental.lessThanOrEqualTo(max))
    );
  });

  if (!match) {
    throw new ClaimError("ta_tier_mismatch", {
      message: "No TA tier covers this rental",
      expected: null,
      given: chargesByKaen.toFixed(2),
      reason: "No TA tier covers this rental",
    });
  }

  const expected = new Decimal(match.companyMinimum);
  if (!expected.equals(chargesByKaen)) {
    throw new ClaimError("ta_tier_mismatch", {
      message: `TA charge mismatch: expected ${expected.toFixed(2)}, given ${chargesByKaen.toFixed(2)}`,
      expected: expected.toFixed(2),
      given: chargesByKaen.toFixed(2),
    });
  }
}

/**
 * Derive whether a claim item is a cobroke, server-authoritative.
 *
 * Rules (OR):
 *  1. hasCobrokeIntent === true — the agent explicitly flagged cobroke.
 *  2. commissionPercentage < 100 — the agent is only claiming a share.
 *  3. An existing active CommissionClaimItem exists for the same
 *     (propertyId, unitCode, roomType, moveInDate) key in a submitted,
 *     approved, paid, or amended claim — a sibling already owns part.
 *
 * NEVER accept this value from the client.
 */
async function deriveIsCobroke(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  item: { commissionPercentage: string | Decimal; hasCobrokeIntent?: boolean | null },
  key: { propertyId: string; unitCode: string; roomType: string; moveInDate: Date },
): Promise<boolean> {
  if (item.hasCobrokeIntent === true) return true;
  const pct = new Decimal(item.commissionPercentage);
  if (pct.lessThan(100)) return true;
  const existing = await tx.commissionClaimItem.count({
    where: {
      organizationId: orgId,
      propertyId: key.propertyId,
      unitCode: key.unitCode,
      roomType: key.roomType,
      moveInDate: key.moveInDate,
      claim: { status: { in: ["submitted", "approved", "paid", "amended"] } },
    },
  });
  return existing > 0;
}

/**
 * Derive the TA share percentage for a given item.
 *
 * Rules (uniform across all claim types — listing_portion treated same as tenant):
 *  - Solo (isCobroke=false) → 100% of TA profit stays with this agent.
 *  - Cobroke with no explicit userTaShare → default to 100.
 *  - Cobroke with explicit userTaShare → use that value.
 */
function deriveTaSharePercent(
  _claimType: string,
  isCobroke: boolean,
  userTaShare: string | number | null | undefined,
): Decimal | null {
  if (!isCobroke) return new Decimal(100);
  if (userTaShare == null) return new Decimal(100);
  return new Decimal(userTaShare);
}

/**
 * After inserting/updating a cobroke item, recompute all OTHER active siblings
 * on the same key (excluding paid — those are frozen) so their shortfall share
 * reflects the new total commission percentage on the key.
 *
 * Uses a raw SQL SELECT … FOR UPDATE so the recompute runs safely under
 * Serializable isolation without racing concurrent sibling inserts.
 */
async function recomputeCobrokeSiblings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  key: {
    propertyId: string;
    unitCode: string;
    roomType: string;
    moveInDate: Date;
  },
  newTotalCommissionPct: Decimal,
): Promise<void> {
  // Lock cobroke siblings on this key (excluding paid — frozen).
  const siblings = await tx.$queryRaw<Array<{
    id: string;
    monthlyRental: string;
    tierPct: string;
    commissionPct: string;
    chargesByAgent: string;
    chargesByKaen: string;
    numberOfPax: number | null;
    paxDeductionAmount: string | null;
    hasPaxDeduction: boolean;
    claimId: string;
    taSharePercent: string | null;
  }>>`
    SELECT
      i."id", i."monthlyRental"::text, i."agentTierPercentage"::text AS "tierPct",
      i."commissionPercentage"::text AS "commissionPct",
      i."tenancyChargesByAgent"::text AS "chargesByAgent",
      i."tenancyChargesByKaen"::text AS "chargesByKaen",
      i."numberOfPax", p."paxDeductionAmount"::text, p."hasPaxDeduction",
      i."claimId",
      i."taSharePercent"::text AS "taSharePercent"
    FROM "CommissionClaimItem" i
    JOIN "CommissionClaim" c ON c.id = i."claimId"
    JOIN "Property" p ON p.id = i."propertyId"
    WHERE i."organizationId" = ${orgId}::uuid
      AND i."propertyId" = ${key.propertyId}::uuid
      AND i."unitCode" = ${key.unitCode}
      AND i."roomType" = ${key.roomType}
      AND i."moveInDate" = ${key.moveInDate}
      AND i."isCobroke" = true
      AND c.status IN ('submitted','approved','amended')
    FOR UPDATE OF i;
  `;

  for (const s of siblings) {
    const payout = computeNettPayout({
      monthlyRental: new Decimal(s.monthlyRental),
      pax: s.numberOfPax ?? 0,
      paxDeductionAmount: s.hasPaxDeduction && s.paxDeductionAmount ? new Decimal(s.paxDeductionAmount) : null,
      tierPercentage: new Decimal(s.tierPct),
      commissionPercentage: new Decimal(s.commissionPct),
      chargesByAgent: new Decimal(s.chargesByAgent),
      chargesByKaen: new Decimal(s.chargesByKaen),
      taSharePercent: s.taSharePercent != null ? new Decimal(s.taSharePercent) : new Decimal(100),
      totalCommissionPctOnKey: newTotalCommissionPct,
    });
    await tx.commissionClaimItem.update({
      where: { id: s.id },
      data: {
        nettPayout: payout.nettPayout,
        shortfallApplied: payout.shortfallApplied.greaterThan(0) ? payout.shortfallApplied : null,
        outstandingBalance: payout.outstandingBalance.greaterThan(0) ? payout.outstandingBalance : null,
      },
    });

    // Recompute parent claim's totalNettPayout.
    const agg = await tx.commissionClaimItem.aggregate({
      _sum: { nettPayout: true },
      where: { claimId: s.claimId },
    });
    await tx.commissionClaim.update({
      where: { id: s.claimId },
      data: { totalNettPayout: new Decimal(agg._sum.nettPayout ?? 0) },
    });
  }
}

/**
 * Sum the commissionPercentage of all existing CommissionClaimItems for a
 * given (propertyId, unitCode, roomType, moveInDate) key, across active
 * statuses. Used by the submit/amend paths to feed `totalCommissionPctOnKey`
 * into computeNettPayout so shortfall is split proportionally across cobroke
 * agents.
 *
 * `includeSelf` is the current item's commissionPercentage — it is added to
 * the DB sum so the key total reflects "all active items including this one".
 *
 * When `includeAmended` is true, "amended" claims are included in the active
 * set (used during amend so the item being replaced still counts).
 */
async function getTotalCommissionPctOnKey(
  tx: PrismaTxForTaTier,
  orgId: string,
  opts: {
    propertyId: string;
    unitCode: string;
    roomType: string;
    moveInDate: Date;
    includeSelf: Decimal;
    includeAmended: boolean;
  },
): Promise<Decimal> {
  const statuses = opts.includeAmended
    ? ["submitted", "approved", "paid", "amended"]
    : ["submitted", "approved", "paid"];
  const existing = await tx.commissionClaimItem.aggregate({
    _sum: { commissionPercentage: true },
    where: {
      organizationId: orgId,
      propertyId: opts.propertyId,
      unitCode: opts.unitCode,
      roomType: opts.roomType,
      moveInDate: opts.moveInDate,
      claim: { status: { in: statuses } },
    },
  });
  const existingPct = new Decimal(existing._sum.commissionPercentage ?? 0);
  return existingPct.plus(opts.includeSelf);
}

export async function dashboardService(session: PortalSession) {
  return getAgentDashboardFull(session.orgId, session.partyId);
}

export async function listClaimsService(session: PortalSession, filters?: Record<string, string>) {
  const result = await listAgentClaims(session.orgId, session.partyId, {
    status: filters?.status,
    page: filters?.page ? parseInt(filters.page) : undefined,
    limit: filters?.limit ? parseInt(filters.limit) : undefined,
  });
  const limit = result.limit;
  const total = result.total;
  return {
    data: result.data.map((c) => ({
      id: c.id,
      claimNumber: c.claimNumber,
      status: c.status,
      totalNettPayout: Number(c.totalNettPayout),
      claimType: c.claimType,
      submittedAt: c.submittedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
    pagination: { page: result.page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getClaimService(session: PortalSession, claimId: string, db?: any) {
  const client = db ?? getDb();

  const raw = await client.commissionClaim.findUnique({
    where: { id: claimId, organizationId: session.orgId },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          property: {
            select: { id: true, hasPaxDeduction: true, paxDeductionAmount: true },
          },
        },
      },
      // Agent identity + bank details are needed by the agent-portal PDF/Excel
      // export flow (Phase 3 Task 3.6). Visibility is gated by the ownership/
      // upline/admin checks below — no role-based field stripping needed because
      // anyone who can view the claim should see the same payout context.
      agent: {
        select: {
          displayName: true,
          bankName: true,
          bankAccountHolder: true,
          bankAccountNumber: true,
        },
      },
    },
  });

  if (!raw) return { ok: false as const, status: 404, error: "Claim not found" };

  const isOwner = raw.agentPartyId === session.partyId;
  const isAdmin = session.role === "admin" || session.role === "manager";

  if (!isOwner && !isAdmin) {
    const chain = await walkUplineChain(raw.agentPartyId, client);
    if (!chain.includes(session.partyId)) {
      return { ok: false as const, status: 404, error: "Claim not found" };
    }
  }

  const claim = raw;

  const data = {
    id: claim.id,
    claimNumber: claim.claimNumber,
    status: claim.status,
    totalNettPayout: Number(claim.totalNettPayout),
    claimType: claim.claimType,
    rejectionReason: claim.rejectionReason,
    amendmentNote: claim.amendmentNote,
    submittedAt: claim.submittedAt?.toISOString() ?? null,
    approvedAt: claim.approvedAt?.toISOString() ?? null,
    createdAt: claim.createdAt.toISOString(),
    agentPartyId: claim.agentPartyId,
    agentName: claim.agent?.displayName ?? "",
    bankName: claim.agent?.bankName ?? null,
    bankAccountHolder: claim.agent?.bankAccountHolder ?? null,
    bankAccountNumber: claim.agent?.bankAccountNumber ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: claim.items.map((item: any) => {
      // Pre-format tenantPhone for the claim-detail render. Read-tolerant so
      // legacy `+60` rows on un-backfilled UAT data still surface canonical
      // (and a friendly formatted display) without a client-side parse.
      const canonicalTenantPhone = readPhoneAnyFormat(item.tenantPhone ?? null);
      return {
        id: item.id,
        propertyId: item.propertyId,
        condoName: item.condoName,
        unitCode: item.unitCode,
        roomType: item.roomType,
        tenantName: item.tenantName,
        tenantEmail: item.tenantEmail ?? null,
        tenantPhone: canonicalTenantPhone,
        formattedTenantPhone: canonicalTenantPhone ? formatMyPhoneDisplay(canonicalTenantPhone) : null,
        tenantLinkedinUrl: item.tenantLinkedinUrl ?? null,
        tenantInstagramHandle: item.tenantInstagramHandle ?? null,
        tenantJobPosition: item.tenantJobPosition ?? null,
        salesDate: item.salesDate.toISOString(),
        moveInDate: item.moveInDate.toISOString(),
        moveOutDate: item.moveOutDate ? item.moveOutDate.toISOString() : null,
        monthlyRental: Number(item.monthlyRental),
        agentTierPercentage: item.agentTierPercentage != null ? Number(item.agentTierPercentage) : null,
        commissionPercentage: Number(item.commissionPercentage),
        tenancyChargesByAgent: Number(item.tenancyChargesByAgent),
        tenancyChargesByKaen: Number(item.tenancyChargesByKaen),
        numberOfPax: item.numberOfPax,
        nettPayout: Number(item.nettPayout),
        // Denormalized from property for edit-draft hydration (Task 14).
        hasPaxDeduction: item.property?.hasPaxDeduction ?? false,
        paxDeductionAmount: item.property?.paxDeductionAmount != null ? Number(item.property.paxDeductionAmount) : 0,
      };
    }),
  };

  return { ok: true as const, status: 200 as const, data };
}

export async function tierMappingLookupService(session: PortalSession, claimType: string) {
  const validTypes = new Set(["tenant_portion", "listing_portion", "tenant_listing_portion"]);
  if (!validTypes.has(claimType)) {
    return { ok: false as const, status: 400, error: "Invalid claimType" };
  }

  const db = getDb();
  const party = await db.party.findFirst({
    where: { id: session.partyId },
    select: { agentLevel: true },
  });
  if (!party?.agentLevel) {
    return { ok: false as const, status: 400, error: "Agent level not set" };
  }

  const resolved = await resolveTierPercentage(session.orgId, claimType, party.agentLevel);
  if (!resolved.ok) {
    return { ok: false as const, status: 404, error: resolved.error };
  }
  return {
    ok: true as const,
    status: 200 as const,
    data: {
      percentage: Number(resolved.percentage),
      agentLevel: party.agentLevel,
      source: resolved.source,
    },
  };
}

export async function submitClaimService(session: PortalSession, claimId: string) {
  const db = getDb();
  const claim = await findAgentClaim(session.orgId, session.partyId, claimId);
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };

  // State-machine guard: only draft→submitted is allowed here.
  try {
    assertTransition(claim.status as ClaimStatus, "submitted", "agent_owner");
  } catch (err) {
    if (isClaimError(err)) {
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: err.toResponseBody().error,
      };
    }
    throw err;
  }

  const txResult = await db.$transaction(
    async (tx) => {
      // Rules A/B/C — delegated to the validator. One source of truth shared with
      // createAndSubmitClaimService and precheckClaimService. Running inside the
      // Serializable tx ensures the sum-cap read and the final status flip see
      // the same snapshot; concurrent submits racing 100% will be caught by
      // Postgres serialization failure (P2034) rather than sneak through.
      const validatorPayload: ValidatorPayload = {
        claimType: claim.claimType,
        items: claim.items.map((i) => ({
          propertyId: i.propertyId,
          unitCode: i.unitCode,
          roomType: i.roomType,
          tenantName: i.tenantName,
          salesDate: i.salesDate.toISOString().slice(0, 10),
          moveInDate: i.moveInDate.toISOString().slice(0, 10),
          commissionPercentage: i.commissionPercentage.toString(),
        })),
      };
      const validation = await validateAll(tx, validatorPayload, session, claimId);
      if (!validation.ok) throw validation.error;

      // Rule D: Σ taShare ≤ 100 on deal key (tenant-side only).
      await validateRuleD({
        db: tx,
        orgId: session.orgId,
        claimId,
        claimType: claim.claimType,
        items: claim.items.map((i) => ({
          propertyId: i.propertyId,
          unitCode: i.unitCode,
          roomType: i.roomType,
          moveInDate: i.moveInDate,
          taSharePercent: (i as unknown as Record<string, unknown>).taSharePercent != null
            ? String((i as unknown as Record<string, unknown>).taSharePercent)
            : null,
        })),
      });

      // Re-resolve agent tier percentage (fresh lookup)
      const party = await tx.party.findFirst({
        where: { id: session.partyId },
        select: { agentLevel: true },
      });
      if (!party?.agentLevel) {
        throw new ClaimError("validation", { message: "Agent level not set", fieldPath: "agentLevel" });
      }

      const resolved = await resolveTierPercentage(
        session.orgId, claim.claimType, party.agentLevel, tx,
      );
      if (!resolved.ok) {
        throw new ClaimError("validation", { message: resolved.error, fieldPath: "claimType" });
      }
      const tierPercentage = resolved.percentage;
      let totalNettPayout = new Decimal(0);

      // Batch-load properties once instead of N per-item findUnique calls.
      // Under Serializable isolation this also reduces the read-lock footprint
      // and fewer P2034 retries on concurrent submits.
      const propertyIds = Array.from(
        new Set(claim.items.map((i) => i.propertyId)),
      );
      const propertyRows = propertyIds.length
        ? await tx.property.findMany({
            where: { id: { in: propertyIds } },
            select: { id: true, hasPaxDeduction: true, paxDeductionAmount: true },
          })
        : [];
      const propertyById = new Map(propertyRows.map((p) => [p.id, p]));

      // Recalculate each item
      for (const item of claim.items) {
        const property = propertyById.get(item.propertyId);
        const monthlyRental = new Decimal(item.monthlyRental);

        // Listing-portion claims are "passive income" — TA charges come from
        // the tenant-side claim, not the listing-side. Both chargedToTenant
        // and chargesByKaen may legitimately be 0, so bypass the tier assert.
        if (claim.claimType !== "listing_portion") {
          await assertTaTierMatch(
            tx,
            session.orgId,
            monthlyRental,
            new Decimal(item.tenancyChargesByKaen),
          );
        }

        // Guard: if pax condo, numberOfPax * paxDeductionAmount <= monthlyRental
        const paxDed = property?.hasPaxDeduction && property.paxDeductionAmount
          ? new Decimal(property.paxDeductionAmount)
          : null;
        if (paxDed && item.numberOfPax) {
          const paxDeduction = new Decimal(item.numberOfPax).times(paxDed);
          if (paxDeduction.greaterThan(monthlyRental)) {
            throw new ClaimError("validation", {
              message: `Pax deduction (${paxDeduction}) exceeds monthly rental (${item.monthlyRental}) for item ${item.unitCode}`,
              fieldPath: "numberOfPax",
            });
          }
        }

        const itemKey = {
          propertyId: item.propertyId,
          unitCode: item.unitCode,
          roomType: item.roomType,
          moveInDate: item.moveInDate,
        };

        const totalPct = await getTotalCommissionPctOnKey(tx, session.orgId, {
          ...itemKey,
          includeSelf: new Decimal(item.commissionPercentage),
          includeAmended: true,
        });

        // (c) derive isCobroke server-side — NEVER from client
        const isCobroke = await deriveIsCobroke(
          tx, session.orgId,
          { commissionPercentage: item.commissionPercentage, hasCobrokeIntent: (item as unknown as Record<string, unknown>).hasCobrokeIntent as boolean | null | undefined },
          itemKey,
        );

        const taShare = deriveTaSharePercent(
          claim.claimType,
          isCobroke,
          (item as unknown as Record<string, unknown>).taSharePercent as string | number | null | undefined,
        );

        const payout = computeNettPayout({
          monthlyRental,
          pax: item.numberOfPax ?? 0,
          paxDeductionAmount: paxDed,
          tierPercentage,
          commissionPercentage: new Decimal(item.commissionPercentage),
          chargesByAgent: new Decimal(item.tenancyChargesByAgent),
          chargesByKaen: new Decimal(item.tenancyChargesByKaen),
          taSharePercent: taShare ?? new Decimal(100),
          totalCommissionPctOnKey: totalPct,
        });

        // Update item with recalculated snapshot; persist shortfall + outstanding (null when zero).
        await tx.commissionClaimItem.update({
          where: { id: item.id },
          data: {
            agentTierPercentage: tierPercentage,
            isCobroke,
            taSharePercent: taShare,
            nettPayout: payout.nettPayout,
            shortfallApplied: payout.shortfallApplied.greaterThan(0) ? payout.shortfallApplied : null,
            outstandingBalance: payout.outstandingBalance.greaterThan(0) ? payout.outstandingBalance : null,
          },
        });

        // If cobroke, recompute sibling items on the same key so their
        // shortfall share reflects the updated totalCommissionPctOnKey.
        if (isCobroke) {
          await recomputeCobrokeSiblings(tx, session.orgId, itemKey, totalPct);
        }

        // B2: promote IC pending uploads to consumed (verifies storage + asserts count)
        const icKeys = [(item as unknown as Record<string, unknown>).tenantIcFrontKey, (item as unknown as Record<string, unknown>).tenantIcBackKey].filter((k): k is string => Boolean(k));
        if (icKeys.length > 0) {
          await markIcKeysConsumed({
            tx,
            objectExists: (_bucket, key) => objectExists(key),
            keys: icKeys,
            partyId: session.partyId,
            organizationId: session.orgId,
            claimItemId: item.id,
          });
        }

        totalNettPayout = totalNettPayout.plus(payout.nettPayout);
      }

      // Atomic status update (prevents double-submit). Accepts either
      // 'draft' (first-time submit) or 'needs_amendment' (agent's re-submit
      // after admin sent it back). In both cases the agent's intent is the
      // same: "make this claim ready for admin review." Clearing
      // amendmentNote is a no-op when source was 'draft' (drafts have no
      // note); meaningful when source was 'needs_amendment'.
      const result = await tx.commissionClaim.updateMany({
        where: { id: claimId, status: { in: ["draft", "needs_amendment"] } },
        data: {
          status: "submitted",
          submittedAt: new Date(),
          totalNettPayout,
          amendmentNote: null,
        },
      });

      if (result.count !== 1) {
        throw new ClaimError("conflict", { message: "Claim was already submitted or modified" });
      }

      return { ok: true as const, status: 200 as const, data: { id: claimId } };
    },
    {
      isolationLevel: "Serializable",
      maxWait: 5000,
      timeout: 15000,
    },
  ).catch((err: unknown) => {
    if (isClaimError(err)) {
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: err.toResponseBody().error,
      };
    }
    // Convert transaction errors to structured responses.
    // Log the full error so deep bugs (FK violations, missing config, Prisma
    // internals) aren't silently flattened to a 422 without a server-side trace.
    console.error("[submitClaimService] transaction failed:", err);
    return { ok: false as const, status: 422 as const, error: (err as Error).message };
  });

  // Fire-and-forget WhatsApp notification to upline + admins.
  // Failures here NEVER affect the claim — they're logged + recorded in NotificationLog.
  if (txResult.ok) {
    enqueueClaimNotification(claimId, {
      prisma: db,
      sender: getWhatsAppSender(),
      baseUrl: process.env.APP_BASE_URL ?? "http://localhost:5173",
    });
  }

  return txResult;
}

export async function deleteClaimService(session: PortalSession, claimId: string) {
  const db = getDb();
  const claim = await findAgentClaim(session.orgId, session.partyId, claimId);
  if (!claim) return { ok: false as const, status: 404, error: "Claim not found" };
  if (claim.status !== "draft") return { ok: false as const, status: 409, error: "Only draft claims can be deleted" };

  await db.commissionClaim.delete({ where: { id: claimId } });
  return { ok: true as const, status: 200 as const, data: { id: claimId } };
}

// Agent-initiated cancel of a submitted claim. State machine permits
// `submitted → cancelled` for `agent_owner`; this is the wire for it.
// Atomic status flip inside a tx prevents racing an admin approve/reject.
export async function cancelClaimService(
  session: PortalSession,
  claimId: string,
  meta: { ip?: string; userAgent?: string; actorRole?: string } = {},
) {
  const db = getDb();
  const claim = await findAgentClaim(session.orgId, session.partyId, claimId);
  if (!claim) return { ok: false as const, status: 404 as const, error: "Claim not found" };

  try {
    assertTransition(claim.status as ClaimStatus, "cancelled", "agent_owner");
  } catch (err) {
    if (isClaimError(err)) {
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: err.toResponseBody().error,
      };
    }
    throw err;
  }

  return await db.$transaction(async (tx) => {
    // Accept cancel from either 'submitted' (agent withdraws an in-flight
    // claim) or 'needs_amendment' (agent gives up on re-working). State
    // machine already permits both transitions for agent_owner.
    const result = await tx.commissionClaim.updateMany({
      where: { id: claimId, status: { in: ["submitted", "needs_amendment"] } },
      data: { status: "cancelled" },
    });
    if (result.count !== 1) {
      return { ok: false as const, status: 409 as const, error: "Claim was already actioned" };
    }

    await recordAudit(tx, {
      organizationId: session.orgId,
      actorUserId: session.userId,
      actorRole: meta.actorRole ?? "agent",
      action: "claim.cancel",
      entityType: "CommissionClaim",
      entityId: claimId,
      diff: { before: { status: claim.status }, after: { status: "cancelled" } },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      ok: true as const,
      status: 200 as const,
      data: { id: claimId, status: "cancelled" as const },
    };
  });
}

export async function searchPropertiesService(session: PortalSession, query?: string) {
  return searchProperties(session.orgId, query);
}

export async function listRoomTypesService(session: PortalSession) {
  return listActiveRoomTypes(session.orgId);
}

// ── createAndSubmitClaimService ─────────────────────────────────────────────
// Atomic create-and-submit: validateAll (Rules A/B/C inside tx snapshot) →
// resolve tier → compute items/totals → create claim with status=submitted →
// audit log. Everything in a single Serializable transaction. ClaimError
// rolls the tx back (no orphan draft). P2034 (serialization failure) retries
// once before surfacing the conflict.

type CreateAndSubmitInput = {
  claimType: string;
  items: Array<{
    propertyId: string;
    condoName: string;
    unitCode: string;
    roomType: string;
    tenantName: string;
    tenantEmail?: string | null;
    tenantPhone?: string | null;
    tenantLinkedinUrl?: string | null;
    tenantInstagramHandle?: string | null;
    tenantJobPosition?: string | null;
    salesDate: string;
    moveInDate: string;
    moveOutDate: string;
    monthlyRental: string;
    commissionPercentage: string;
    tenancyChargesByAgent: string;
    tenancyChargesByKaen: string;
    numberOfPax?: number;
  }>;
};

type CreateAndSubmitOk = {
  ok: true;
  status: 201;
  data: { id: string; claimNumber: string };
};

type CreateAndSubmitErr = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: { code: ClaimErrorCode; message: string } & Partial<
    ClaimErrorPayloads[ClaimErrorCode]
  >;
};

export async function createAndSubmitClaimService(
  session: PortalSession,
  input: CreateAndSubmitInput,
): Promise<CreateAndSubmitOk | CreateAndSubmitErr> {
  const db = getDb();

  const runOnce = async (): Promise<{ id: string; claimNumber: string }> => {
    return db.$transaction(
      async (tx) => {
        // 1. Validate inside the tx snapshot (Rules A/B/C).
        //    Convert moveInDate/salesDate to the ISO YYYY-MM-DD shape the validator expects.
        const validatorPayload: ValidatorPayload = {
          claimType: input.claimType,
          items: input.items.map((i) => ({
            propertyId: i.propertyId,
            unitCode: i.unitCode,
            roomType: i.roomType,
            tenantName: i.tenantName,
            salesDate: i.salesDate,
            moveInDate: i.moveInDate,
            commissionPercentage: i.commissionPercentage,
          })),
        };
        const validation = await validateAll(tx, validatorPayload, session);
        if (!validation.ok) throw validation.error;

        // Rule D: Σ taShare ≤ 100 on deal key (tenant-side only).
        await validateRuleD({
          db: tx,
          orgId: session.orgId,
          claimId: null,
          claimType: input.claimType,
          items: input.items.map((it) => ({
            propertyId: it.propertyId,
            unitCode: it.unitCode,
            roomType: it.roomType,
            moveInDate: new Date(it.moveInDate),
            taSharePercent: (it as unknown as Record<string, unknown>).taSharePercent != null
              ? String((it as unknown as Record<string, unknown>).taSharePercent)
              : null,
          })),
        });

        // 2. Resolve agent tier percentage (in tx).
        const party = await tx.party.findFirst({
          where: { id: session.partyId },
          select: { agentLevel: true },
        });
        if (!party?.agentLevel) {
          throw new ClaimError("validation", {
            message: "Agent level not set",
            fieldPath: "agentLevel",
          });
        }

        const resolved = await resolveTierPercentage(
          session.orgId, input.claimType, party.agentLevel, tx,
        );
        if (!resolved.ok) {
          throw new ClaimError("validation", { message: resolved.error, fieldPath: "claimType" });
        }
        const tierPct = resolved.percentage;

        // 3. Fetch properties for pax-deduction info.
        const propertyIds = input.items.map((i) => i.propertyId);
        const properties = propertyIds.length
          ? await tx.property.findMany({
              where: { id: { in: propertyIds }, organizationId: session.orgId },
              select: { id: true, hasPaxDeduction: true, paxDeductionAmount: true },
            })
          : [];
        const propertyMap = new Map(properties.map((p) => [p.id, p]));

        // 4a. TaTier assertion — applies to tenant-side claim types only.
        // listing_portion is passive income; the listing agent's TA fields
        // may legitimately be 0 (charges come from the tenant-side claim).
        if (input.claimType !== "listing_portion") {
          for (const it of input.items) {
            await assertTaTierMatch(
              tx,
              session.orgId,
              new Decimal(it.monthlyRental),
              new Decimal(it.tenancyChargesByKaen),
            );
          }
        }

        // 4. Compute per-item nettPayout and the running total.
        let totalNettPayout = new Decimal(0);
        const itemsData: Array<{
          organizationId: string;
          propertyId: string;
          condoName: string;
          unitCode: string;
          roomType: string;
          tenantName: string;
          tenantEmail: string | null;
          tenantPhone: string | null;
          tenantLinkedinUrl: string | null;
          tenantInstagramHandle: string | null;
          tenantJobPosition: string | null;
          salesDate: Date;
          moveInDate: Date;
          moveOutDate: Date;
          monthlyRental: Decimal;
          agentTierPercentage: Decimal;
          commissionPercentage: Decimal;
          tenancyChargesByAgent: Decimal;
          tenancyChargesByKaen: Decimal;
          numberOfPax: number | null;
          isCobroke: boolean;
          taSharePercent: Decimal | null;
          nettPayout: Decimal;
          shortfallApplied: Decimal | null;
          outstandingBalance: Decimal | null;
        }> = [];
        for (const it of input.items) {
          const property = propertyMap.get(it.propertyId);
          const monthlyRental = new Decimal(it.monthlyRental);
          let numberOfPax: number | null = it.numberOfPax ?? null;

          const paxDed = property?.hasPaxDeduction && property.paxDeductionAmount
            ? new Decimal(property.paxDeductionAmount)
            : null;

          if (paxDed && it.numberOfPax) {
            const paxDeduction = new Decimal(it.numberOfPax).times(paxDed);
            if (paxDeduction.greaterThan(monthlyRental)) {
              throw new ClaimError("validation", {
                message: `Pax deduction (${paxDeduction}) exceeds monthly rental (${it.monthlyRental}) for item ${it.unitCode}`,
                fieldPath: "numberOfPax",
              });
            }
          } else if (!property?.hasPaxDeduction) {
            numberOfPax = null;
          }

          const itKey = {
            propertyId: it.propertyId,
            unitCode: it.unitCode,
            roomType: it.roomType,
            moveInDate: new Date(it.moveInDate),
          };

          const totalPct = await getTotalCommissionPctOnKey(tx, session.orgId, {
            ...itKey,
            includeSelf: new Decimal(it.commissionPercentage),
            includeAmended: true,
          });

          // derive isCobroke server-side — NEVER from client
          const isCobroke = await deriveIsCobroke(
            tx, session.orgId,
            { commissionPercentage: it.commissionPercentage, hasCobrokeIntent: (it as unknown as Record<string, unknown>).hasCobrokeIntent as boolean | null | undefined },
            itKey,
          );

          const taShare = deriveTaSharePercent(
            input.claimType,
            isCobroke,
            (it as unknown as Record<string, unknown>).taSharePercent as string | number | null | undefined,
          );

          const payout = computeNettPayout({
            monthlyRental,
            pax: it.numberOfPax ?? 0,
            paxDeductionAmount: paxDed,
            tierPercentage: tierPct,
            commissionPercentage: new Decimal(it.commissionPercentage),
            chargesByAgent: new Decimal(it.tenancyChargesByAgent),
            chargesByKaen: new Decimal(it.tenancyChargesByKaen),
            taSharePercent: taShare ?? new Decimal(100),
            totalCommissionPctOnKey: totalPct,
          });

          totalNettPayout = totalNettPayout.plus(payout.nettPayout);

          itemsData.push({
            organizationId: session.orgId,
            propertyId: it.propertyId,
            condoName: it.condoName,
            unitCode: it.unitCode,
            roomType: it.roomType,
            tenantName: it.tenantName,
            tenantEmail: it.tenantEmail ?? null,
            tenantPhone: it.tenantPhone ?? null,
            tenantLinkedinUrl: it.tenantLinkedinUrl ?? null,
            tenantInstagramHandle: it.tenantInstagramHandle ?? null,
            tenantJobPosition: it.tenantJobPosition ?? null,
            salesDate: new Date(it.salesDate),
            moveInDate: new Date(it.moveInDate),
            moveOutDate: new Date(it.moveOutDate),
            monthlyRental,
            agentTierPercentage: tierPct,
            commissionPercentage: new Decimal(it.commissionPercentage),
            tenancyChargesByAgent: new Decimal(it.tenancyChargesByAgent),
            tenancyChargesByKaen: new Decimal(it.tenancyChargesByKaen),
            numberOfPax,
            isCobroke,
            taSharePercent: taShare,
            nettPayout: payout.nettPayout,
            shortfallApplied: payout.shortfallApplied.greaterThan(0) ? payout.shortfallApplied : null,
            outstandingBalance: payout.outstandingBalance.greaterThan(0) ? payout.outstandingBalance : null,
          });
        }

        // 5. Generate claim number and create the claim with status=submitted.
        const claimNumber = await generateClaimNumberTx(tx, session.orgId);
        const claim = await tx.commissionClaim.create({
          data: {
            organizationId: session.orgId,
            agentPartyId: session.partyId,
            claimType: input.claimType,
            claimNumber,
            status: "submitted",
            submittedAt: new Date(),
            totalNettPayout,
            items: { create: itemsData },
          },
          select: { id: true, claimNumber: true },
        });

        // 5b. Sibling recompute — for each cobroke item, fire recompute so
        //     existing siblings' shortfall shares are updated with the new total.
        for (const it of itemsData) {
          if (it.isCobroke) {
            const totalPctForKey = await getTotalCommissionPctOnKey(tx, session.orgId, {
              propertyId: it.propertyId,
              unitCode: it.unitCode,
              roomType: it.roomType,
              moveInDate: it.moveInDate,
              includeSelf: new Decimal(0), // self already included in DB now
              includeAmended: true,
            });
            await recomputeCobrokeSiblings(tx, session.orgId, {
              propertyId: it.propertyId,
              unitCode: it.unitCode,
              roomType: it.roomType,
              moveInDate: it.moveInDate,
            }, totalPctForKey);
          }
        }

        // 6. Audit log.
        await tx.activityLog.create({
          data: {
            organizationId: session.orgId,
            entityType: "commission_claim",
            entityId: claim.id,
            action: "submit",
            description: `Claim ${claim.claimNumber} submitted (atomic flow)`,
            performedBy: session.userId,
            metadata: {
              claimNumber: claim.claimNumber,
              itemCount: itemsData.length,
              flow: "atomic",
            },
          },
        });

        return claim;
      },
      {
        // String literal matches Prisma.TransactionIsolationLevel.Serializable.
        isolationLevel: "Serializable",
        maxWait: 5000,
        timeout: 15000,
      },
    );
  };

  try {
    let data: { id: string; claimNumber: string };
    try {
      data = await runOnce();
    } catch (err) {
      const e = err as { code?: string; meta?: { target?: string[] | string } };
      const code = e.code;
      // meta.target format varies between Prisma versions: modern returns
      // string[], older returns string. Flatten defensively.
      const target = Array.isArray(e.meta?.target)
        ? e.meta!.target
        : [e.meta?.target].filter((t): t is string => typeof t === "string");
      const isClaimNumberRace =
        code === "P2002" &&
        target.some((t) => typeof t === "string" && t.toLowerCase().includes("claimnumber"));
      if (code === "P2034" || isClaimNumberRace) {
        // One retry on:
        //  - P2034: Postgres serialization failure (concurrent submits racing
        //    the 100% sum-cap check — the DB aborts one).
        //  - P2002 on claimNumber: two tx's both computed COUNT=N and produced
        //    the same CLM-YYYY-NNNN; the unique index rejected one.
        data = await runOnce();
      } else {
        throw err;
      }
    }
    return { ok: true as const, status: 201 as const, data };
  } catch (err) {
    if (isClaimError(err)) {
      const body = err.toResponseBody().error;
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: body,
      };
    }
    console.error("[createAndSubmitClaimService] unexpected error:", err);
    return {
      ok: false as const,
      status: 500 as const,
      error: { code: "internal", message: (err as Error).message },
    };
  }
}

// ── Draft services (POST /claims, PATCH /claims/:id) ───────────────────────
// Permissive input shape — only propertyId is required per item. All other
// fields are optional; missing values get safe defaults server-side.

type SaveDraftInput = {
  claimType: "tenant_portion" | "listing_portion" | "tenant_listing_portion";
  items: Array<{
    propertyId: string;
    condoName?: string;
    unitCode?: string;
    roomType?: string;
    tenantName?: string;
    tenantEmail?: string | null;
    tenantPhone?: string | null;
    tenantLinkedinUrl?: string | null;
    tenantInstagramHandle?: string | null;
    tenantJobPosition?: string | null;
    salesDate?: string;
    moveInDate?: string;
    moveOutDate?: string;
    monthlyRental?: string;
    commissionPercentage?: string;
    tenancyChargesByAgent?: string;
    tenancyChargesByKaen?: string;
    numberOfPax?: number;
    remark?: string;
  }>;
};

/**
 * Resolve properties and tier, then map permissive draft items to Prisma
 * `CommissionClaimItem.create` data. Missing fields default to safe values
 * (empty strings, zeros, unix epoch dates). Throws ClaimError on:
 *   - Unknown/foreign propertyId (org-scoping security guard)
 *   - Missing agent level
 *   - Missing tier mapping
 *
 * Used by both saveDraftService (new) and updateDraftService (edit). The
 * submit path runs a stricter mapping with Zod-verified non-empty inputs.
 */
type PropertyRow = {
  id: string;
  name: string;
  hasPaxDeduction: boolean;
  paxDeductionAmount: number | null;
};

type DraftItemData = {
  organizationId: string;
  propertyId: string;
  condoName: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  tenantEmail: string | null;
  tenantPhone: string | null;
  tenantLinkedinUrl: string | null;
  tenantInstagramHandle: string | null;
  tenantJobPosition: string | null;
  salesDate: Date;
  moveInDate: Date;
  /** Drafts may have a null moveOutDate; required at the submit boundary. */
  moveOutDate: Date | null;
  monthlyRental: Decimal;
  agentTierPercentage: Decimal;
  commissionPercentage: Decimal;
  tenancyChargesByAgent: Decimal;
  tenancyChargesByKaen: Decimal;
  numberOfPax: number | null;
  /** Drafts are never active claims; flag is re-derived at submit time. */
  isCobroke: boolean;
  /** taSharePercent: 100 for solo, user value for cobroke. Uniform across claim types. */
  taSharePercent: Decimal | null;
  nettPayout: Decimal;
  shortfallApplied: Decimal | null;
  outstandingBalance: Decimal | null;
  remark?: string;
  // B2: tenant IC storage keys (optional)
  tenantIcFrontKey?: string | null;
  tenantIcBackKey?: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTxForDraft = any;

async function buildDraftItemsData(
  tx: PrismaTxForDraft,
  session: PortalSession,
  input: SaveDraftInput,
): Promise<{ itemsData: DraftItemData[]; totalNettPayout: Decimal; tierPct: Decimal }> {
  const party = await tx.party.findFirst({
    where: { id: session.partyId },
    select: { agentLevel: true },
  });
  if (!party?.agentLevel) {
    throw new ClaimError("validation", { message: "Agent level not set", fieldPath: "agentLevel" });
  }
  // Draft is forgiving — missing/inactive mapping resolves to 0% rather than
  // throwing, so agents can still save partial drafts before admin finishes
  // configuration. Submit paths re-resolve with a hard error, so an under-
  // configured draft can't graduate to a submitted claim silently.
  const resolved = await resolveTierPercentage(
    session.orgId, input.claimType, party.agentLevel, tx,
  );
  const tierPct = resolved.ok ? resolved.percentage : new Decimal(0);

  // Security: scope property lookup by organizationId. Reject if any
  // requested propertyId isn't in the agent's org (cross-org reference).
  const requestedPropertyIds = input.items.map((i) => i.propertyId);
  const properties: PropertyRow[] = requestedPropertyIds.length
    ? await tx.property.findMany({
        where: { id: { in: requestedPropertyIds }, organizationId: session.orgId },
        select: { id: true, name: true, hasPaxDeduction: true, paxDeductionAmount: true },
      })
    : [];
  const propertyMap = new Map<string, PropertyRow>(properties.map((p) => [p.id, p]));
  const missing = requestedPropertyIds.filter((id) => !propertyMap.has(id));
  if (missing.length > 0) {
    throw new ClaimError("validation", {
      message: "One or more properties were not found in your organization.",
      fieldPath: "items.propertyId",
    });
  }

  let totalNettPayout = new Decimal(0);
  const itemsData: DraftItemData[] = input.items.map((it) => {
    const property = propertyMap.get(it.propertyId)!;
    const rental = it.monthlyRental ? new Decimal(it.monthlyRental) : new Decimal(0);
    const commissionPct = it.commissionPercentage ? new Decimal(it.commissionPercentage) : new Decimal(0);
    const chargesAgent = it.tenancyChargesByAgent ? new Decimal(it.tenancyChargesByAgent) : new Decimal(0);
    const chargesKaen = it.tenancyChargesByKaen ? new Decimal(it.tenancyChargesByKaen) : new Decimal(0);

    const paxDed = property.hasPaxDeduction && property.paxDeductionAmount
      ? new Decimal(property.paxDeductionAmount)
      : null;

    // Draft: isCobroke=false (re-derived at submit time), taSharePercent derived from claimType.
    // Solo assumption: totalCommissionPctOnKey = commissionPct (no DB lookup for drafts).
    const draftTaShare = deriveTaSharePercent(
      input.claimType,
      false, // isCobroke=false for draft; re-derived at submit
      (it as unknown as Record<string, unknown>).taSharePercent as string | number | null | undefined,
    );
    const payout = computeNettPayout({
      monthlyRental: rental,
      pax: it.numberOfPax ?? 0,
      paxDeductionAmount: paxDed,
      tierPercentage: tierPct,
      commissionPercentage: commissionPct,
      chargesByAgent: chargesAgent,
      chargesByKaen: chargesKaen,
      taSharePercent: draftTaShare ?? new Decimal(100),
      totalCommissionPctOnKey: commissionPct,
    });
    totalNettPayout = totalNettPayout.plus(payout.nettPayout);

    const salesDate = it.salesDate ? new Date(it.salesDate) : new Date(0);
    const moveInDate = it.moveInDate ? new Date(it.moveInDate) : new Date(0);
    // Drafts are permissive: moveOutDate may be unset. Required at submit time.
    const moveOutDate = (it as unknown as Record<string, unknown>).moveOutDate
      ? new Date((it as unknown as Record<string, unknown>).moveOutDate as string)
      : null;

    return {
      organizationId: session.orgId,
      propertyId: it.propertyId,
      condoName: it.condoName ?? property.name ?? "",
      unitCode: it.unitCode ?? "",
      roomType: it.roomType ?? "",
      tenantName: it.tenantName ?? "",
      tenantEmail: it.tenantEmail ?? null,
      tenantPhone: it.tenantPhone ?? null,
      tenantLinkedinUrl: it.tenantLinkedinUrl ?? null,
      tenantInstagramHandle: it.tenantInstagramHandle ?? null,
      tenantJobPosition: it.tenantJobPosition ?? null,
      salesDate,
      moveInDate,
      moveOutDate,
      monthlyRental: rental,
      agentTierPercentage: tierPct,
      commissionPercentage: commissionPct,
      tenancyChargesByAgent: chargesAgent,
      tenancyChargesByKaen: chargesKaen,
      numberOfPax: property.hasPaxDeduction ? (it.numberOfPax ?? null) : null,
      // Drafts are not active claims — isCobroke is re-derived at submit time.
      isCobroke: false,
      taSharePercent: draftTaShare,
      nettPayout: payout.nettPayout,
      // Draft preview: do NOT persist shortfall/outstanding (no DB key-total lookup).
      shortfallApplied: null,
      outstandingBalance: null,
      ...(it.remark !== undefined ? { remark: it.remark } : {}),
      // B2: pass through IC storage keys if provided
      ...((it as unknown as Record<string, unknown>).tenantIcFrontKey != null
        ? { tenantIcFrontKey: (it as unknown as Record<string, unknown>).tenantIcFrontKey as string }
        : {}),
      ...((it as unknown as Record<string, unknown>).tenantIcBackKey != null
        ? { tenantIcBackKey: (it as unknown as Record<string, unknown>).tenantIcBackKey as string }
        : {}),
    };
  });

  return { itemsData, totalNettPayout, tierPct };
}

/**
 * Save a commission claim as a draft. Permissive: only propertyId required.
 * Rule A (intra-payload dedupe) runs; Rules B + C do not (sum cap is a
 * submit concern). No Serializable isolation — drafts are not a race target.
 */
export async function saveDraftService(
  session: PortalSession,
  input: SaveDraftInput,
): Promise<
  | { ok: true; status: 201; data: { id: string; claimNumber: string } }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422 | 500; error: { code: string; message: string } & Record<string, unknown> }
> {
  const db = getDb();
  try {
    // Rule A on the permissive shape — missing keys hash to "" consistently.
    const ruleAPayload = {
      claimType: input.claimType,
      items: input.items.map((it) => ({
        propertyId: it.propertyId,
        unitCode: it.unitCode ?? "",
        roomType: it.roomType ?? "",
        tenantName: it.tenantName ?? "",
        salesDate: it.salesDate ?? "",
        moveInDate: it.moveInDate ?? "",
        commissionPercentage: it.commissionPercentage ?? "0",
      })),
    };
    const a = validateRuleA(ruleAPayload);
    if (!a.ok) throw a.error;

    return await db.$transaction(async (tx) => {
      const { itemsData, totalNettPayout } = await buildDraftItemsData(tx, session, input);
      const claimNumber = await generateClaimNumberTx(tx, session.orgId);
      const claim = await tx.commissionClaim.create({
        data: {
          organizationId: session.orgId,
          agentPartyId: session.partyId,
          claimType: input.claimType,
          claimNumber,
          status: "draft",
          totalNettPayout,
          items: { create: itemsData },
        },
        select: { id: true, claimNumber: true },
      });

      // B2: promote IC pending uploads for each item that has IC keys
      const createdItems = await tx.commissionClaimItem.findMany({
        where: { claimId: claim.id },
        select: { id: true, tenantIcFrontKey: true, tenantIcBackKey: true },
        orderBy: { createdAt: "asc" },
      });
      for (const ci of createdItems) {
        const icKeys = [ci.tenantIcFrontKey, ci.tenantIcBackKey].filter((k): k is string => Boolean(k));
        if (icKeys.length > 0) {
          await markIcKeysConsumed({
            tx,
            objectExists: (_bucket, key) => objectExists(key),
            keys: icKeys,
            partyId: session.partyId,
            organizationId: session.orgId,
            claimItemId: ci.id,
          });
        }
      }

      await tx.activityLog.create({
        data: {
          organizationId: session.orgId,
          entityType: "commission_claim",
          entityId: claim.id,
          action: "create_draft",
          description: `Draft claim created (${itemsData.length} item${itemsData.length === 1 ? "" : "s"})`,
          performedBy: session.userId,
          metadata: { claimNumber: claim.claimNumber, flow: "save_draft" },
        },
      });

      return { ok: true as const, status: 201 as const, data: claim };
    });
  } catch (err) {
    if (isClaimError(err)) {
      const body = err.toResponseBody().error;
      return { ok: false as const, status: claimErrorToHttpStatus(err.code), error: body };
    }
    console.error("[saveDraftService] unexpected error:", err);
    return { ok: false as const, status: 500 as const, error: { code: "internal", message: (err as Error).message } };
  }
}

// ── updateDraftService (PATCH /claims/:id) ──────────────────────────────────
// State-machine-guarded pre-approval edit. Allowed when claim status is
// `draft` (draft→draft) or `submitted` (submitted→submitted, status preserved).
// Any other starting status (approved, amended, rejected, paid, etc.) yields
// 403 forbidden_transition — agent uses amendApprovedService for post-approval
// edits instead. Items are replaced atomically: deleteMany + recreate inside
// a single transaction.

export async function updateDraftService(
  session: PortalSession,
  claimId: string,
  input: SaveDraftInput,
): Promise<
  | { ok: true; status: 200; data: { id: string } }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 422 | 500;
      error: { code: string; message: string } & Record<string, unknown>;
    }
> {
  const db = getDb();
  try {
    const claim = await findAgentClaim(session.orgId, session.partyId, claimId);
    if (!claim) {
      return {
        ok: false as const,
        status: 404 as const,
        error: { code: "not_found", message: "Claim not found" },
      };
    }

    // State-machine: self-edit is allowed when in draft or submitted state.
    // Status is preserved (no DB status update below).
    const status = claim.status as ClaimStatus;
    assertTransition(status, status, "agent_owner");

    // Rule A — intra-payload dedupe on the NEW item set. B/C apply at submit.
    const ruleAPayload = {
      claimType: input.claimType,
      items: input.items.map((it) => ({
        propertyId: it.propertyId,
        unitCode: it.unitCode ?? "",
        roomType: it.roomType ?? "",
        tenantName: it.tenantName ?? "",
        salesDate: it.salesDate ?? "",
        moveInDate: it.moveInDate ?? "",
        commissionPercentage: it.commissionPercentage ?? "0",
      })),
    };
    const a = validateRuleA(ruleAPayload);
    if (!a.ok) throw a.error;

    return await db.$transaction(async (tx) => {
      await tx.commissionClaimItem.deleteMany({ where: { claimId } });

      const { itemsData, totalNettPayout } = await buildDraftItemsData(tx, session, input);

      await tx.commissionClaim.update({
        where: { id: claimId },
        data: {
          claimType: input.claimType,
          totalNettPayout,
          items: { create: itemsData },
        },
      });

      // B2: promote IC pending uploads for each item that has IC keys
      const updatedItems = await tx.commissionClaimItem.findMany({
        where: { claimId },
        select: { id: true, tenantIcFrontKey: true, tenantIcBackKey: true },
        orderBy: { createdAt: "asc" },
      });
      for (const ci of updatedItems) {
        const icKeys = [ci.tenantIcFrontKey, ci.tenantIcBackKey].filter((k): k is string => Boolean(k));
        if (icKeys.length > 0) {
          await markIcKeysConsumed({
            tx,
            objectExists: (_bucket, key) => objectExists(key),
            keys: icKeys,
            partyId: session.partyId,
            organizationId: session.orgId,
            claimItemId: ci.id,
          });
        }
      }

      await tx.activityLog.create({
        data: {
          organizationId: session.orgId,
          entityType: "commission_claim",
          entityId: claimId,
          action: "update",
          description: `Pre-approval claim updated (${itemsData.length} items, status=${claim.status})`,
          performedBy: session.userId,
          metadata: { itemCount: itemsData.length, flow: "draft_edit" },
        },
      });

      return { ok: true as const, status: 200 as const, data: { id: claimId } };
    });
  } catch (err) {
    if (isClaimError(err)) {
      const body = err.toResponseBody().error;
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: body,
      };
    }
    console.error("[updateDraftService] unexpected error:", err);
    return {
      ok: false as const,
      status: 500 as const,
      error: { code: "internal", message: (err as Error).message },
    };
  }
}

// ── amendClaimService (PATCH /claims/:id/amend) ─────────────────────────────
// Agent-only. Transitions a claim from `approved` → `amended` (first edit
// after approval) or `amended` → `amended` (further edits before re-approval).
// Owner-scoped: service loads via `agentPartyId === session.partyId` so an
// agent can never touch another agent's claim.
//
// Items, when provided, are replaced atomically via deleteMany + recreate —
// the same pattern `updateDraftService` uses. All writes (status flip, items
// replacement, audit row) sit inside a single `$transaction`, so rollback is
// Prisma's responsibility if anything downstream throws.
//
// v1 accepts `items` using the permissive `SaveDraftInput["items"]` shape
// (same as the draft edit path). A future patch may accept a richer remark
// field on the claim itself once the schema grows one.
//
// TODO(next phase): notify the approver via WhatsApp after amend lands
// (Section 5 of the Phase 1 expansion plan — held).

export type AmendClaimInput = {
  items?: SaveDraftInput["items"];
  claimType?: SaveDraftInput["claimType"];
};

export async function amendClaimService(
  session: PortalSession,
  claimId: string,
  input: AmendClaimInput,
  meta: { ip?: string; userAgent?: string; actorRole?: string } = {},
): Promise<
  | { ok: true; status: 200; data: { id: string; status: "amended" } }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 422 | 500;
      error: { code: string; message: string } & Record<string, unknown>;
    }
> {
  const db = getDb();
  try {
    // Ownership + existence check (same repository used by other portal services).
    const claim = await findAgentClaim(session.orgId, session.partyId, claimId);
    if (!claim) {
      return {
        ok: false as const,
        status: 404 as const,
        error: { code: "not_found", message: "Claim not found" },
      };
    }

    // State-machine: approved → amended OR amended → amended (further edits).
    assertTransition(claim.status as ClaimStatus, "amended", "agent_owner");

    // If items provided, run Rule A (intra-payload dedupe) on the NEW set
    // up-front so a malformed payload short-circuits before we open the tx.
    if (input.items) {
      const ruleAPayload = {
        claimType: input.claimType ?? (claim.claimType as SaveDraftInput["claimType"]),
        items: input.items.map((it) => ({
          propertyId: it.propertyId,
          unitCode: it.unitCode ?? "",
          roomType: it.roomType ?? "",
          tenantName: it.tenantName ?? "",
          salesDate: it.salesDate ?? "",
          moveInDate: it.moveInDate ?? "",
          commissionPercentage: it.commissionPercentage ?? "0",
        })),
      };
      const a = validateRuleA(ruleAPayload);
      if (!a.ok) throw a.error;
    }

    return await db.$transaction(async (tx) => {
      // Build the snapshot of the BEFORE state (claim header + items) so the
      // audit diff is self-contained. Include items in the before so reviewers
      // can see exactly what changed in a single row.
      // Items are deleted-and-recreated on each amend (see line below), so
      // every amend produces fresh UUIDs. Persisting `id` in the audit diff
      // would make every snapshot show a noisy "id changed" line even when
      // nothing functional moved. Identity for reviewers is the logical key
      // (propertyId + unitCode + roomType + moveInDate); omit the UUID.
      const before = {
        id: claim.id,
        status: claim.status,
        claimType: claim.claimType,
        totalNettPayout: claim.totalNettPayout.toString(),
        items: claim.items.map((it) => ({
          propertyId: it.propertyId,
          condoName: it.condoName,
          unitCode: it.unitCode,
          roomType: it.roomType,
          tenantName: it.tenantName,
          salesDate: it.salesDate.toISOString(),
          moveInDate: it.moveInDate.toISOString(),
          moveOutDate: it.moveOutDate ? it.moveOutDate.toISOString() : null,
          monthlyRental: it.monthlyRental.toString(),
          agentTierPercentage: it.agentTierPercentage?.toString() ?? null,
          commissionPercentage: it.commissionPercentage.toString(),
          tenancyChargesByAgent: it.tenancyChargesByAgent.toString(),
          tenancyChargesByKaen: it.tenancyChargesByKaen.toString(),
          numberOfPax: it.numberOfPax,
          remark: it.remark,
          nettPayout: it.nettPayout.toString(),
        })),
      };

      let newTotalNettPayout: Decimal = claim.totalNettPayout as unknown as Decimal;
      const claimType = input.claimType ?? claim.claimType;

      if (input.items) {
        // Delete-and-recreate — preserves referential integrity (no orphans;
        // the parent row stays, just its children are swapped inside the tx).
        await tx.commissionClaimItem.deleteMany({ where: { claimId } });

        // TaTier assertion — applies to tenant-side claim types only.
        // listing_portion is passive income (see notes at the other 2 call
        // sites), so its TA fields may legitimately be 0.
        if (claimType !== "listing_portion") {
          for (const it of input.items) {
            if (it.monthlyRental && it.tenancyChargesByKaen !== undefined) {
              await assertTaTierMatch(
                tx,
                session.orgId,
                new Decimal(it.monthlyRental),
                new Decimal(it.tenancyChargesByKaen ?? "0"),
              );
            }
          }
        }

        // Rule D: Σ taShare ≤ 100 on deal key (tenant-side only).
        await validateRuleD({
          db: tx,
          orgId: session.orgId,
          claimId,
          claimType,
          items: input.items.map((it) => ({
            propertyId: it.propertyId,
            unitCode: it.unitCode ?? "",
            roomType: it.roomType ?? "",
            moveInDate: new Date(it.moveInDate ?? 0),
            taSharePercent: (it as unknown as Record<string, unknown>).taSharePercent != null
              ? String((it as unknown as Record<string, unknown>).taSharePercent)
              : null,
          })),
        });

        const { itemsData, totalNettPayout } = await buildDraftItemsData(
          tx,
          session,
          {
            claimType: claimType as SaveDraftInput["claimType"],
            items: input.items,
          },
        );
        newTotalNettPayout = totalNettPayout;

        await tx.commissionClaim.update({
          where: { id: claimId },
          data: {
            status: "amended",
            claimType,
            totalNettPayout,
            items: { create: itemsData },
          },
        });

        // Re-derive isCobroke per item (buildDraftItemsData always sets false;
        // amend transitions to an active status so we must server-derive).
        // Fetch newly created items then update isCobroke + run sibling recompute.
        const newItems = await tx.commissionClaimItem.findMany({
          where: { claimId },
          select: { id: true, propertyId: true, unitCode: true, roomType: true, moveInDate: true, commissionPercentage: true, taSharePercent: true, tenantIcFrontKey: true, tenantIcBackKey: true },
        });
        for (const ni of newItems) {
          const niKey = {
            propertyId: ni.propertyId,
            unitCode: ni.unitCode,
            roomType: ni.roomType,
            moveInDate: ni.moveInDate,
          };
          const niIsCobroke = await deriveIsCobroke(
            tx, session.orgId,
            { commissionPercentage: ni.commissionPercentage, hasCobrokeIntent: (ni as unknown as Record<string, unknown>).hasCobrokeIntent as boolean | null | undefined },
            niKey,
          );
          const niTaShare = deriveTaSharePercent(
            claimType,
            niIsCobroke,
            (ni as unknown as Record<string, unknown>).taSharePercent as string | number | null | undefined,
          );
          await tx.commissionClaimItem.update({
            where: { id: ni.id },
            data: { isCobroke: niIsCobroke, taSharePercent: niTaShare },
          });
          if (niIsCobroke) {
            const totalPctForKey = await getTotalCommissionPctOnKey(tx, session.orgId, {
              ...niKey,
              includeSelf: new Decimal(0), // self already in DB
              includeAmended: true,
            });
            await recomputeCobrokeSiblings(tx, session.orgId, niKey, totalPctForKey);
          }

          // B2: promote IC pending uploads to consumed (verifies storage + asserts count)
          const icKeys = [ni.tenantIcFrontKey, ni.tenantIcBackKey].filter((k): k is string => Boolean(k));
          if (icKeys.length > 0) {
            await markIcKeysConsumed({
              tx,
              objectExists: (_bucket, key) => objectExists(key),
              keys: icKeys,
              partyId: session.partyId,
              organizationId: session.orgId,
              claimItemId: ni.id,
            });
          }
        }
      } else {
        // Status-flip only. Useful when an agent wants to mark the claim as
        // in-amendment before queueing detailed edits.
        await tx.commissionClaim.update({
          where: { id: claimId },
          data: { status: "amended" },
        });
      }

      // Re-fetch the AFTER shape (items in canonical order) for the audit row.
      const after = await tx.commissionClaim.findFirst({
        where: { id: claimId },
        include: { items: { orderBy: { createdAt: "asc" } } },
      });

      const afterSerialized = after
        ? {
            id: after.id,
            status: after.status,
            claimType: after.claimType,
            totalNettPayout: newTotalNettPayout.toString(),
            // `id` intentionally omitted per the BEFORE comment — items get
            // fresh UUIDs every amend, identity is the logical key.
            items: after.items.map((it) => ({
              propertyId: it.propertyId,
              condoName: it.condoName,
              unitCode: it.unitCode,
              roomType: it.roomType,
              tenantName: it.tenantName,
              salesDate: it.salesDate.toISOString(),
              moveInDate: it.moveInDate.toISOString(),
              moveOutDate: it.moveOutDate ? it.moveOutDate.toISOString() : null,
              monthlyRental: it.monthlyRental.toString(),
              agentTierPercentage: it.agentTierPercentage?.toString() ?? null,
              commissionPercentage: it.commissionPercentage.toString(),
              tenancyChargesByAgent: it.tenancyChargesByAgent.toString(),
              tenancyChargesByKaen: it.tenancyChargesByKaen.toString(),
              numberOfPax: it.numberOfPax,
              remark: it.remark,
              nettPayout: it.nettPayout.toString(),
            })),
          }
        : { id: claimId, status: "amended" };

      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        // Audit row captures the authz label we used to gate the transition.
        // `agent_owner` is the state-machine actor; pass through any richer
        // role label the route provided (defaults to "agent").
        actorRole: meta.actorRole ?? "agent",
        action: "claim.amend",
        entityType: "CommissionClaim",
        entityId: claimId,
        diff: { before, after: afterSerialized },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      return {
        ok: true as const,
        status: 200 as const,
        data: { id: claimId, status: "amended" as const },
      };
    });
  } catch (err) {
    if (isClaimError(err)) {
      const body = err.toResponseBody().error;
      return {
        ok: false as const,
        status: claimErrorToHttpStatus(err.code),
        error: body,
      };
    }
    console.error("[amendClaimService] unexpected error:", err);
    return {
      ok: false as const,
      status: 500 as const,
      error: { code: "internal", message: (err as Error).message },
    };
  }
}

// ── taTierOptionsService (GET /ta-tier-options) ─────────────────────────────
// Returns ALL tiers for the calling org as { tier, companyMinimum } pairs,
// sorted by tier asc. Drives the "Charges by KAEN" dropdown on the claim form
// so it stays in sync with admin-configured tier settings (no hardcoded list).

export async function taTierOptionsService(
  session: PortalSession,
): Promise<{ ok: true; status: 200; data: { tiers: { tier: number; companyMinimum: string }[] } }> {
  const db = getDb();
  const tiers = await db.taTier.findMany({
    where: { organizationId: session.orgId },
    orderBy: { tier: "asc" },
    select: { tier: true, companyMinimum: true },
  });
  return {
    ok: true as const,
    status: 200 as const,
    data: {
      tiers: tiers.map((t) => ({
        tier: t.tier,
        companyMinimum: t.companyMinimum.toString(),
      })),
    },
  };
}

// ── taTierLookupService (GET /ta-tier) ──────────────────────────────────────
// Returns the matching TaTier row for a given monthlyRental. Finds the highest
// rentalMin band that is <= the rental amount (largest lower bound wins).
// orgId is derived from the authenticated session — never accepted from query.

export async function taTierLookupService(
  session: PortalSession,
  input: { monthlyRental: string },
): Promise<
  | { ok: true; status: 200; data: { tier: number; rentalMin: string; rentalMax: string | null; companyMinimum: string } }
  | { ok: false; status: 404; error: string }
> {
  const db = getDb();
  const tier = await db.taTier.findFirst({
    where: {
      organizationId: session.orgId,
      rentalMin: { lte: input.monthlyRental },
    },
    orderBy: { rentalMin: "desc" },
    select: { tier: true, rentalMin: true, rentalMax: true, companyMinimum: true },
  });

  if (!tier) {
    return {
      ok: false as const,
      status: 404 as const,
      error: "No TA tier configured for this rental amount. Contact admin.",
    };
  }

  return {
    ok: true as const,
    status: 200 as const,
    data: {
      tier: tier.tier,
      rentalMin: tier.rentalMin.toString(),
      rentalMax: tier.rentalMax?.toString() ?? null,
      companyMinimum: tier.companyMinimum.toString(),
    },
  };
}
