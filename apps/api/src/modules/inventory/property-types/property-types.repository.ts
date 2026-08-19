import { getDb } from "@kason/db";
import type { Prisma } from "@kason/db";

export type PropertyTypeRow = {
  id: string;
  organizationId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function listPropertyTypesRepo(orgId: string, opts?: { activeOnly?: boolean }): Promise<PropertyTypeRow[]> {
  return getDb().propertyType.findMany({
    where: { organizationId: orgId, ...(opts?.activeOnly ? { isActive: true } : {}) },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function findPropertyTypeById(orgId: string, id: string): Promise<PropertyTypeRow | null> {
  return getDb().propertyType.findFirst({ where: { id, organizationId: orgId } });
}

export async function createPropertyTypeRow(
  tx: Prisma.TransactionClient, orgId: string, input: { name: string; sortOrder: number },
): Promise<PropertyTypeRow> {
  return tx.propertyType.create({ data: { organizationId: orgId, name: input.name, sortOrder: input.sortOrder } });
}

export async function updatePropertyTypeRow(
  tx: Prisma.TransactionClient, orgId: string, id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
): Promise<PropertyTypeRow | null> {
  const { count } = await tx.propertyType.updateMany({ where: { id, organizationId: orgId }, data: input });
  if (count === 0) return null;
  return tx.propertyType.findFirst({ where: { id, organizationId: orgId } });
}

export async function deletePropertyTypeRow(tx: Prisma.TransactionClient, orgId: string, id: string): Promise<void> {
  // propertyType is a free string on Property; deleting the catalog row leaves
  // existing Property.propertyType strings intact.
  await tx.propertyType.deleteMany({ where: { id, organizationId: orgId } });
}

// Usage = number of Property rows whose free-text propertyType equals this name
// (case/whitespace-sensitive, plain text equality — no normalization).
export async function getPropertyTypeUsageRepo(orgId: string, name: string): Promise<{ propertyCount: number }> {
  const propertyCount = await getDb().property.count({ where: { organizationId: orgId, propertyType: name } });
  return { propertyCount };
}
