import { getDb } from "@kason/db";

export async function getOrgName(orgId: string) {
  const db = getDb();
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  return org?.name ?? "Organization";
}

export async function getCounts(orgId: string) {
  const db = getDb();
  const [
    propertyCount,
    unitCount,
    occupiedUnitCount,
    vacantUnitCount,
    ownerCount,
    tenantCount,
    tenancyCount,
    chargeCount,
    postedChargeCount,
    paymentCount,
    activeRecurringCount,
  ] = await Promise.all([
    db.property.count({ where: { organizationId: orgId } }),
    db.listing.count({ where: { organizationId: orgId } }),
    db.listing.count({ where: { organizationId: orgId, occupancyStatus: "occupied" } }),
    db.listing.count({ where: { organizationId: orgId, occupancyStatus: "vacant" } }),
    db.partyRole.count({ where: { organizationId: orgId, roleType: "owner" } }),
    db.partyRole.count({ where: { organizationId: orgId, roleType: "tenant" } }),
    db.tenancy.count({ where: { organizationId: orgId, status: "active" } }),
    db.charge.count({ where: { organizationId: orgId } }),
    db.charge.count({ where: { organizationId: orgId, status: "posted" } }),
    db.payment.count({ where: { organizationId: orgId } }),
    db.recurringCharge.count({ where: { organizationId: orgId, isActive: true } }),
  ]);

  return {
    propertyCount,
    unitCount,
    occupiedUnitCount,
    vacantUnitCount,
    ownerCount,
    tenantCount,
    tenancyCount,
    chargeCount,
    postedChargeCount,
    paymentCount,
    activeRecurringCount,
  };
}

export async function getPostedCharges(orgId: string) {
  const db = getDb();
  return db.charge.findMany({
    where: { organizationId: orgId, status: "posted" },
    select: { amount: true, outstandingAmount: true, dueDate: true },
  });
}
