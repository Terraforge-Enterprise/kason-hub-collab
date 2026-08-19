// Returns the unit's current active Tenancy (if any), or null when the unit
// is free. "Active" is the same status value occupancy-tenancy-sync and
// tenancy.service use to mean "currently occupied" (see
// occupancy-tenancy-sync.ts, tenancy.service.ts TERMINAL_TENANCY_STATUSES).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function assertNoActiveTenancyTx(
  tx: any,
  orgId: string,
  unitId: string,
): Promise<{ id: string; tenantPartyId: string; startDate: Date } | null> {
  return tx.tenancy.findFirst({
    where: { organizationId: orgId, unitId, status: "active" },
    select: { id: true, tenantPartyId: true, startDate: true },
  });
}
