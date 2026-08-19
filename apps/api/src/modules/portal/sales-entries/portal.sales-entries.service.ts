import { getDb } from "@kason/db";
import { resolveOrCreateProjectService } from "../projects/portal.projects.service";
import {
  computeSalesCommissionAmount,
  validateSalesSplitsHundredPercent,
} from "../../sales-claims/sales-claims.validators";
import type { CreateSalesEntryInput } from "./portal.sales-entries.validation";

export type SalesEntryCtx = { orgId: string; agentPartyId: string; actorUserId: string };

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 404 | 409; error: { code: string; message: string } };

type SalesEntryData = {
  salesUnit: { id: string; projectId: string; unitNumber: string; sourcingApproved: boolean };
  salesClaim: { id: string; status: string };
  renovationClaim: { id: string; status: string } | null;
  renovationProgress: { id: string; status: string; stagesSeeded: number } | null;
  project: { id: string; status: string } | null;
};

export async function createSalesEntryService(
  input: CreateSalesEntryInput,
  ctx: SalesEntryCtx,
): Promise<Result<SalesEntryData>> {
  // Pre-check (also enforced by Zod, but defensive).
  if (input.purpose === "rent" && (input.expectedRental == null || input.expectedRental <= 0)) {
    return {
      ok: false,
      status: 400,
      error: { code: "expected_rental_required", message: "expectedRental is required for purpose='rent'." },
    };
  }

  const db = getDb();
  return db.$transaction(async (tx: any) => {
    // 1. Resolve project (existing or new).
    const projectResult = await resolveOrCreateProjectService(tx, input.project, {
      orgId: ctx.orgId,
      actorUserId: ctx.actorUserId,
    });
    if (!projectResult.ok) return projectResult;
    const projectId = projectResult.data.id;

    // 2. Uniqueness check.
    const collision = await tx.salesUnit.findFirst({
      where: { organizationId: ctx.orgId, projectId, unitNumber: input.unitNumber },
      select: { id: true },
    });
    if (collision) {
      return {
        ok: false as const,
        status: 409 as const,
        error: { code: "unit_already_exists", message: "Another unit with this number already exists in this project." },
      };
    }

    // 3. Create SalesUnit.
    const salesUnit = await tx.salesUnit.create({
      data: {
        organizationId: ctx.orgId,
        projectId,
        unitNumber: input.unitNumber,
        ownerPartyId: input.ownerPartyId,
        salesDate: new Date(input.salesDate),
        purpose: input.purpose,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        parkingLots: input.parkingLots,
        expectedRental: input.expectedRental ?? null,
        purchasePrice: input.purchasePrice,
        agentPartyId: ctx.agentPartyId,
        sourceFlag: "AGENT_SOURCED",
        sourcingApproved: false,
        sourcingCancelled: false,
      },
      select: { id: true, projectId: true, unitNumber: true, sourcingApproved: true },
    });

    // 4. Auto-create SalesClaim from SalesClaimDefault.
    const def = await tx.salesClaimDefault.findFirst({
      where: { organizationId: ctx.orgId, appliesTo: "__catchall__" },
      include: { defaultSplits: { orderBy: { sortOrder: "asc" } } },
    });
    if (!def) {
      return {
        ok: false as const,
        status: 400 as const,
        error: {
          code: "sales_claim_defaults_invalid",
          message: "Organization has no SalesClaimDefault row. Ask admin to configure /commissions/settings → Sales Claim Defaults.",
        },
      };
    }
    const computedAmount = computeSalesCommissionAmount(
      def.commissionType,
      Number(def.commissionValue),
      Number(input.purchasePrice),
    );
    const splitsForValidation = def.defaultSplits.map((s: any) => ({
      splitType: s.splitType as "percent" | "fixed",
      splitValue: Number(s.splitValue),
    }));
    const splitCheck = validateSalesSplitsHundredPercent(splitsForValidation, computedAmount);
    if (!splitCheck.ok) {
      return {
        ok: false as const,
        status: 400 as const,
        error: {
          code: "sales_claim_defaults_invalid",
          message: `Default splits don't sum to 100% of computed amount: ${splitCheck.error}`,
        },
      };
    }
    const salesClaim = await tx.salesClaim.create({
      data: {
        organizationId: ctx.orgId,
        salesUnitId: salesUnit.id,
        commissionType: def.commissionType,
        commissionValue: def.commissionValue,
        computedAmount,
        paymentType: def.paymentType,
        notes: def.notes ?? null,
        status: "submitted",
        submittedById: ctx.actorUserId,
      },
      select: { id: true, status: true },
    });
    await tx.salesClaimSplit.createMany({
      data: def.defaultSplits.map((s: any) => ({
        organizationId: ctx.orgId,
        claimId: salesClaim.id,
        partyPartyId: null,
        partyDisplayName: s.roleLabel,
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: s.splitValue,
        sortOrder: s.sortOrder,
      })),
    });
    await tx.salesClaimTransition.create({
      data: {
        organizationId: ctx.orgId,
        claimId: salesClaim.id,
        fromStatus: null,
        toStatus: "submitted",
        changedById: ctx.actorUserId,
      },
    });

    // 5. Optional renovation chain.
    let renovationClaim: { id: string; status: string } | null = null;
    let renovationProgress: { id: string; status: string; stagesSeeded: number } | null = null;
    if (input.renovation) {
      // 5a. Verify package exists in this org.
      const pkg = await tx.renovationPackage.findFirst({
        where: { id: input.renovation.packageId, organizationId: ctx.orgId },
        select: { id: true },
      });
      if (!pkg) {
        return {
          ok: false as const,
          status: 404 as const,
          error: { code: "package_not_found", message: "Renovation package not found in this organization." },
        };
      }

      // 5b. Verify org has at least one active stage.
      const activeStages = await tx.renovationStage.findMany({
        where: { organizationId: ctx.orgId, archived: false },
        orderBy: { sortOrder: "asc" },
        select: { id: true },
      });
      if (activeStages.length === 0) {
        return {
          ok: false as const,
          status: 400 as const,
          error: {
            code: "no_active_stages",
            message: "Organization has no active renovation stages. Ask admin to add one at /commissions/settings.",
          },
        };
      }

      // 5c. Create RenovationClaim + splits + transition + documents.
      const rc = await tx.renovationClaim.create({
        data: {
          organizationId: ctx.orgId,
          salesUnitId: salesUnit.id,
          packageId: input.renovation.packageId,
          packagePrice: input.renovation.packagePrice,
          paymentType: input.renovation.paymentType,
          monthlyOffsetAmount: input.renovation.monthlyOffsetAmount ?? null,
          notes: input.renovation.notes ?? null,
          status: "submitted",
          submittedById: ctx.actorUserId,
        },
        select: { id: true, status: true },
      });
      await tx.renovationClaimSplit.createMany({
        data: input.renovation.splits.map((s) => ({
          organizationId: ctx.orgId,
          claimId: rc.id,
          partyPartyId: s.partyPartyId ?? null,
          partyDisplayName: s.partyDisplayName,
          roleLabel: s.roleLabel,
          splitType: s.splitType,
          splitValue: s.splitValue,
          isHouseKeep: s.isHouseKeep,
          sortOrder: s.sortOrder,
        })),
      });
      if (input.renovation.documents && input.renovation.documents.length > 0) {
        await tx.renovationClaimDocument.createMany({
          data: input.renovation.documents.map((d) => ({
            organizationId: ctx.orgId,
            claimId: rc.id,
            kind: d.kind,
            fileKey: d.fileKey,
            filename: d.filename,
            uploadedById: ctx.actorUserId,
          })),
        });
      }
      await tx.renovationClaimTransition.create({
        data: {
          organizationId: ctx.orgId,
          claimId: rc.id,
          fromStatus: null,
          toStatus: "submitted",
          changedById: ctx.actorUserId,
        },
      });
      renovationClaim = rc;

      // 5d. Create RenovationProgress + seed stage progress rows.
      const rp = await tx.renovationProgress.create({
        data: {
          organizationId: ctx.orgId,
          salesUnitId: salesUnit.id,
          status: "not_started",
        },
        select: { id: true, status: true },
      });
      await tx.renovationStageProgress.createMany({
        data: activeStages.map((s: any) => ({
          organizationId: ctx.orgId,
          progressId: rp.id,
          stageId: s.id,
          status: "pending",
        })),
      });
      renovationProgress = { id: rp.id, status: rp.status, stagesSeeded: activeStages.length };
    }

    return {
      ok: true as const,
      data: {
        salesUnit,
        salesClaim,
        renovationClaim,
        renovationProgress,
        project: projectResult.data.createdNew
          ? { id: projectResult.data.id, status: projectResult.data.status }
          : null,
      },
    };
  });
}
