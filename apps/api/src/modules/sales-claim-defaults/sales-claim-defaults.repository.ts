import { getDb } from "@kason/db";

export const salesClaimDefaultsRepository = () => ({
  findByOrgAndAppliesTo: (orgId: string, appliesTo: string) => {
    const db = getDb();
    return db.salesClaimDefault.findUnique({
      where: { organizationId_appliesTo: { organizationId: orgId, appliesTo } },
      include: { defaultSplits: { orderBy: { sortOrder: "asc" } } },
    });
  },
  upsert: async (
    orgId: string,
    actorUserId: string,
    input: {
      appliesTo: string;
      commissionType: string;
      commissionValue: number;
      paymentType: string;
      notes: string | null;
      splits: Array<{ roleLabel: string; splitType: string; splitValue: number; sortOrder: number }>;
    },
  ) => {
    const db = getDb();
    return db.$transaction(async (tx) => {
      // Upsert the default row.
      const upserted = await tx.salesClaimDefault.upsert({
        where: { organizationId_appliesTo: { organizationId: orgId, appliesTo: input.appliesTo } },
        create: {
          organizationId: orgId,
          appliesTo: input.appliesTo,
          commissionType: input.commissionType,
          commissionValue: input.commissionValue,
          paymentType: input.paymentType,
          notes: input.notes,
          updatedById: actorUserId,
        },
        update: {
          commissionType: input.commissionType,
          commissionValue: input.commissionValue,
          paymentType: input.paymentType,
          notes: input.notes,
          updatedById: actorUserId,
        },
        select: { id: true },
      });
      // Replace splits.
      await tx.salesClaimDefaultSplit.deleteMany({
        where: { defaultId: upserted.id, organizationId: orgId },
      });
      await tx.salesClaimDefaultSplit.createMany({
        data: input.splits.map((s) => ({
          organizationId: orgId,
          defaultId: upserted.id,
          roleLabel: s.roleLabel,
          splitType: s.splitType,
          splitValue: s.splitValue,
          sortOrder: s.sortOrder,
        })),
      });
      return upserted;
    });
  },
});
