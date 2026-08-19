import { getDb } from "@kason/db";

export const renovationStagesRepository = () => ({
  list: (orgId: string, includeArchived: boolean) => {
    const db = getDb();
    return db.renovationStage.findMany({
      where: { organizationId: orgId, ...(includeArchived ? {} : { archived: false }) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  },
  count: (orgId: string) => {
    const db = getDb();
    return db.renovationStage.count({ where: { organizationId: orgId, archived: false } });
  },
  findByKey: (orgId: string, key: string) => {
    const db = getDb();
    return db.renovationStage.findUnique({
      where: { organizationId_key: { organizationId: orgId, key } },
    });
  },
  create: (input: {
    orgId: string;
    key: string;
    label: string;
    description?: string;
    sortOrder: number;
  }) => {
    const db = getDb();
    return db.renovationStage.create({
      data: {
        organizationId: input.orgId,
        key: input.key,
        label: input.label,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
      },
    });
  },
  findById: (orgId: string, id: string) => {
    const db = getDb();
    return db.renovationStage.findFirst({ where: { id, organizationId: orgId } });
  },
  update: (
    orgId: string,
    id: string,
    patch: Partial<{
      label: string;
      description: string | null;
      sortOrder: number;
      archived: boolean;
    }>,
  ) => {
    const db = getDb();
    return db.renovationStage.updateMany({
      where: { id, organizationId: orgId },
      data: patch,
    });
  },
  reorder: async (orgId: string, items: Array<{ id: string; sortOrder: number }>) => {
    const db = getDb();
    await db.$transaction(
      items.map((it) =>
        db.renovationStage.updateMany({
          where: { id: it.id, organizationId: orgId },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return { count: items.length };
  },
});
