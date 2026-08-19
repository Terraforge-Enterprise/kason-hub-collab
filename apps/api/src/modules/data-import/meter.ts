import { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import type { ImportSession, RawTenantRow } from "./types";

const DEFAULT_RATE = "0.6000";

export interface SeedMeterArgs {
  unitId: string;
  periodMonth: Date;
}

/** Seed a meter + baseline reading for a ROOM listing. Idempotent on the meter + reading uniques. */
export async function seedMeterBaseline(
  tx: Prisma.TransactionClient,
  session: ImportSession,
  row: RawTenantRow,
  args: SeedMeterArgs,
): Promise<{ created: boolean }> {
  if (row.latestReading === null) return { created: false };

  let meter = await tx.aircondMeter.findFirst({
    where: { organizationId: session.orgId, unitId: args.unitId },
    select: { id: true },
  });
  if (!meter) {
    meter = await tx.aircondMeter.create({
      data: { organizationId: session.orgId, unitId: args.unitId, ratePerKwh: DEFAULT_RATE, isActive: true },
      select: { id: true },
    });
  }

  const existingReading = await tx.meterReading.findFirst({
    where: { organizationId: session.orgId, unitId: args.unitId, periodMonth: args.periodMonth },
    select: { id: true },
  });
  if (existingReading) return { created: false };

  const value = row.latestReading;
  const reading = await tx.meterReading.create({
    data: {
      organizationId: session.orgId,
      meterId: meter.id,
      unitId: args.unitId,
      periodMonth: args.periodMonth,
      previousReading: value,
      currentReading: value,
      consumption: 0,
      ratePerKwh: DEFAULT_RATE,
      computedAmount: 0,
      status: "submitted",
      submittedBy: session.userId,
    },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role,
    action: "data-import.meter.seed",
    entityType: "MeterReading",
    entityId: reading.id,
    meta: { source: "data-import", baseline: value, monotonic: row.readingMonotonic },
  });
  return { created: true };
}
