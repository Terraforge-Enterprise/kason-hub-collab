import { getDb } from "@kason/db";

export interface AnalyticsTicketRow {
  id: string;
  title: string;
  unitId: string;
  unitCode: string;
  propertyId: string;
  propertyName: string;
  category: string | null;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

const SELECT = {
  id: true,
  title: true,
  unitId: true,
  category: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
  unit: {
    select: {
      apartment: {
        select: {
          unitCode: true,
          propertyId: true,
          property: { select: { name: true } },
        },
      },
    },
  },
} as const;

function flatten(t: {
  id: string;
  title: string;
  unitId: string;
  category: string | null;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  unit: { apartment: { unitCode: string; propertyId: string; property: { name: string } } };
}): AnalyticsTicketRow {
  return {
    id: t.id,
    title: t.title,
    unitId: t.unitId,
    category: t.category,
    status: t.status,
    createdAt: t.createdAt,
    resolvedAt: t.resolvedAt,
    unitCode: t.unit.apartment.unitCode,
    propertyId: t.unit.apartment.propertyId,
    propertyName: t.unit.apartment.property.name,
  };
}

export async function fetchOrgTicketsForAnalytics(
  orgId: string,
  propertyId?: string,
): Promise<AnalyticsTicketRow[]> {
  const db = getDb();
  const rows = await db.ticket.findMany({
    where: {
      organizationId: orgId,
      status: { not: "void" },
      ...(propertyId ? { unit: { apartment: { propertyId } } } : {}),
    },
    select: SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(flatten);
}

export async function fetchUnitTicketsForAnalytics(
  orgId: string,
  unitId: string,
): Promise<AnalyticsTicketRow[]> {
  const db = getDb();
  const rows = await db.ticket.findMany({
    where: { organizationId: orgId, unitId, status: { not: "void" } },
    select: SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(flatten);
}

// Analytics grades ticket categories against ALL the org's WorkCategory names
// (active or inactive). Deactivating a category therefore does NOT retroactively
// move its historical tickets into "Other": the category still maps as long as its
// row exists, and an in-use category can only be deactivated, never hard-deleted.
// "Other"/unmapped is reserved for genuinely free-text categories.
export async function fetchWorkCategoryNames(orgId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.workCategory.findMany({
    where: { organizationId: orgId },
    select: { name: true },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((r) => r.name);
}
