import { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { generateTenancyCodeTx } from "../tenancy/tenancy-code-generator";
import { findTenancyForRow } from "./repository";
import type { ImportSession, RawTenantRow } from "./types";

function tenancyStatus(moveOut: Date | null, now: Date): "active" | "ended" {
  if (!moveOut) return "active";
  return moveOut.getTime() >= now.getTime() ? "active" : "ended";
}

export interface EnsureTenancyArgs {
  partyId: string;
  propertyId: string;
  unitId: string;
  monthlyRent: number;
  now: Date;
}

/** Create a room tenancy if absent. Idempotent on (party, unit, startDate). */
export async function ensureTenancy(
  tx: Prisma.TransactionClient,
  session: ImportSession,
  row: RawTenantRow,
  args: EnsureTenancyArgs,
): Promise<{ created: boolean; tenancyId: string }> {
  const startDate = row.moveIn ?? args.now;
  const existing = await findTenancyForRow(tx, session.orgId, args.partyId, args.unitId, startDate);
  if (existing) return { created: false, tenancyId: existing.id };

  const tenancyCode = await generateTenancyCodeTx(tx, session.orgId);
  const notes = row.coTenantNames.length
    ? `Import co-tenants: ${row.coTenantNames.join(" | ")}`
    : null;

  const created = await tx.tenancy.create({
    data: {
      organizationId: session.orgId,
      propertyId: args.propertyId,
      unitId: args.unitId,
      tenantPartyId: args.partyId,
      tenancyCode,
      status: tenancyStatus(row.moveOut, args.now),
      billingStatus: "current",
      startDate,
      endDate: row.moveOut ?? null,
      monthlyRentAmount: args.monthlyRent,
      termMonths: row.termMonths ?? null,
      numberOfPax: row.numberOfPax,
      agentLabel: row.agentLabel,
      accessCardNo: row.accessCardNo,
      moveInNotes: notes,
      noticePeriodDays: 30,
    },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: session.orgId,
    actorUserId: session.userId,
    actorRole: session.role,
    action: "data-import.tenancy.create",
    entityType: "Tenancy",
    entityId: created.id,
    meta: { source: "data-import", sheet: row.sheet, row: row.rowNumber },
  });
  return { created: true, tenancyId: created.id };
}
