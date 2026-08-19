import { getDb, Prisma } from "@kason/db";

export async function findPartyByNaturalKey(
  tx: Prisma.TransactionClient,
  orgId: string,
  normalizedPhone: string | null,
  idNumber: string | null,
): Promise<{ id: string; displayName: string; primaryPhone: string | null; idNumber: string | null } | null> {
  const or: Prisma.PartyWhereInput[] = [];
  if (normalizedPhone) or.push({ primaryPhone: normalizedPhone });
  if (idNumber) or.push({ idNumber });
  if (or.length === 0) return null;
  return tx.party.findFirst({
    where: { organizationId: orgId, OR: or },
    select: { id: true, displayName: true, primaryPhone: true, idNumber: true },
  });
}

export async function findTenancyForRow(
  tx: Prisma.TransactionClient,
  orgId: string,
  tenantPartyId: string,
  unitId: string,
  startDate: Date,
): Promise<{ id: string } | null> {
  return tx.tenancy.findFirst({
    where: { organizationId: orgId, tenantPartyId, unitId, startDate },
    select: { id: true },
  });
}

export async function findPropertyByCode(orgId: string, propertyCode: string) {
  return getDb().property.findFirst({
    where: { organizationId: orgId, propertyCode },
    select: { id: true },
  });
}

export async function findApartmentByCode(orgId: string, propertyId: string, unitCode: string) {
  return getDb().apartment.findFirst({
    where: { organizationId: orgId, propertyId, unitCode },
    select: { id: true },
  });
}

export async function findListing(orgId: string, apartmentId: string, listingType: string) {
  return getDb().listing.findFirst({
    where: { organizationId: orgId, apartmentId, listingType },
    select: { id: true },
  });
}

export async function createImportRun(
  orgId: string,
  dryRun: boolean,
  sourceFile: string,
  triggeredBy: string,
) {
  return getDb().importRun.create({
    data: { organizationId: orgId, dryRun, sourceFile, triggeredBy, status: "running" },
    select: { id: true },
  });
}

export async function finishImportRun(
  id: string,
  data: {
    status: "completed" | "failed";
    rowsParsed: number;
    partiesCreated: number;
    partiesMatched: number;
    tenanciesCreated: number;
    rowsSkipped: number;
    conflicts: number;
    reportKey?: string;
    errorText?: string;
  },
) {
  return getDb().importRun.update({ where: { id }, data });
}

export async function listImportRuns(orgId: string, limit: number) {
  return getDb().importRun.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getImportRun(orgId: string, id: string) {
  return getDb().importRun.findFirst({ where: { organizationId: orgId, id } });
}
