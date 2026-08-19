// apps/api/src/modules/expenses/expenses.service.ts
// Accounting-document redesign P3 — the internal Expense (EXP-) create service.
// Records a supplier/property cost ONCE (EXP- numbered) with its Borne-By split
// allocations (recoveryStatus defaults "pending"; downstream routing to
// EB-/owner-ledger/KAEN-opex is P4/P5/P6). Money strings are 2-dp decimals.
import { getDb, type Prisma } from "@kason/db";
import { isFullyAllocated, type SupplierExpenseInput } from "@kason/shared";
import { mintDocumentNumberTx } from "../../lib/reference-codes/series-numbers";
import { ensureChargeCategorySeeds } from "../charge-categories/seed";
import { recordAudit } from "../../lib/audit";
import { isPhase2FlagEnabled } from "../../lib/feature-flags";

// The fallback category for a KAEN operating-expense row whose source allocation has no
// chargeCategoryId, or one that doesn't resolve (chargeCategoryId is a soft reference —
// no DB FK — see supplier-expense.ts). Mirrors the repo-wide OWNER_LEDGER fallback token
// (owner-ledger.sync.ts) so P&L category reporting has one consistent "misc" bucket name.
const KAEN_OPEX_FALLBACK_CATEGORY = "other_expense";

type CreatedAllocation = {
  id: string;
  borneBy: string;
  amount: Prisma.Decimal | string;
  chargeCategoryId: string | null;
  description: string | null;
};

/**
 * P6 — route each borneBy:"kaen" allocation to its own KaenOperatingExpense row (the
 * agency's internal opex ledger; never owner/tenant money). Runs INSIDE the caller's tx
 * so a failure here rolls back the whole SupplierExpense creation. Idempotent on
 * sourceExpenseAllocationId via `@@unique([organizationId, sourceExpenseAllocationId])` +
 * skipDuplicates — safe to re-run for the same allocation id without duplicating a row.
 * tenant/owner allocations are never touched here (P4/P5's concern, already shipped).
 */
async function routeKaenOperatingExpensesTx(
  tx: Prisma.TransactionClient,
  ctx: ExpenseActorCtx,
  allocations: CreatedAllocation[],
  expenseDate: Date,
): Promise<void> {
  const kaenAllocations = allocations.filter((a) => a.borneBy === "kaen");
  if (kaenAllocations.length === 0) return;

  // Batched + org-scoped on purpose: a per-allocation lookup would (a) N+1 the transaction
  // and (b) risk resolving a same-id category row from ANOTHER org. Deliberately NOT
  // filtered on `active`: a deactivated category's name is still valid provenance for a
  // past cost.
  const categoryIds = [
    ...new Set(kaenAllocations.map((a) => a.chargeCategoryId).filter((id): id is string => id !== null)),
  ];
  const categoryMap = new Map<string, string>();
  if (categoryIds.length > 0) {
    const categories = await tx.chargeCategory.findMany({
      where: { organizationId: ctx.orgId, id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    for (const c of categories) categoryMap.set(c.id, c.name);
  }

  await tx.kaenOperatingExpense.createMany({
    data: kaenAllocations.map((a) => ({
      organizationId: ctx.orgId,
      sourceExpenseAllocationId: a.id,
      category: (a.chargeCategoryId && categoryMap.get(a.chargeCategoryId)) || KAEN_OPEX_FALLBACK_CATEGORY,
      description: a.description ?? null,
      amount: a.amount,
      expenseDate,
      createdById: ctx.actorUserId,
    })),
    skipDuplicates: true,
  });
}

export type ExpenseActorCtx = {
  orgId: string;
  actorUserId: string;
  actorRole: string;
  ip?: string;
  userAgent?: string;
};

export class ExpenseError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = "ExpenseError";
  }
}

export async function createSupplierExpenseService(
  ctx: ExpenseActorCtx,
  input: SupplierExpenseInput,
): Promise<{ id: string; expenseNumber: string }> {
  // Defense-in-depth (review panel 2026-07-22): the route already zod-validates the
  // split, but this SERVICE is the writer — re-assert the invariant so no non-route
  // caller (a future PATCH / repair / batch) can persist a mis-split. See
  // supplier-expense.ts isFullyAllocated.
  if (!isFullyAllocated(input.totalAmount, input.allocations)) {
    throw new ExpenseError(400, "ALLOCATIONS_NOT_FULLY_ALLOCATED");
  }
  const db = getDb();
  await ensureChargeCategorySeeds(ctx.orgId); // guarantees the EXP series exists (own connection)
  return db.$transaction(async (tx) => {
    const series = await tx.documentSeries.findFirst({
      where: { organizationId: ctx.orgId, code: "EXP" },
    });
    if (!series) throw new ExpenseError(500, "EXP_SERIES_NOT_FOUND");
    const expenseNumber = await mintDocumentNumberTx(tx, ctx.orgId, series, new Date());
    const expenseDate = new Date(`${input.expenseDate}T00:00:00.000Z`);
    const created = await tx.supplierExpense.create({
      data: {
        organizationId: ctx.orgId,
        expenseNumber,
        supplierName: input.supplierName,
        supplierRef: input.supplierRef ?? null,
        expenseDate,
        totalAmount: input.totalAmount,
        propertyId: input.propertyId ?? null,
        apartmentId: input.apartmentId ?? null,
        unitId: input.unitId ?? null,
        description: input.description ?? null,
        createdById: ctx.actorUserId,
        allocations: {
          create: input.allocations.map((a) => ({
            organizationId: ctx.orgId,
            borneBy: a.borneBy,
            amount: a.amount,
            partyId: a.partyId ?? null,
            tenancyId: a.tenancyId ?? null,
            chargeCategoryId: a.chargeCategoryId ?? null,
            description: a.description ?? null,
          })),
        },
      },
      select: {
        id: true,
        expenseNumber: true,
        allocations: {
          select: { id: true, borneBy: true, amount: true, chargeCategoryId: true, description: true },
        },
      },
    });

    if (isPhase2FlagEnabled("ENABLE_KAEN_OPEX")) {
      await routeKaenOperatingExpensesTx(tx, ctx, created.allocations, expenseDate);
    }

    await recordAudit(tx, {
      organizationId: ctx.orgId,
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: "expenses.create",
      entityType: "SupplierExpense",
      entityId: created.id,
      meta: {
        expenseNumber: created.expenseNumber,
        total: input.totalAmount,
        allocations: input.allocations.length,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // Reconstruct the public shape — `select` above also pulls back `allocations` for
    // the KAEN-opex routing above; callers/tests must see only {id, expenseNumber}.
    return { id: created.id, expenseNumber: created.expenseNumber };
  });
}
