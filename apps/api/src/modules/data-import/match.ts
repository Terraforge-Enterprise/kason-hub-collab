import { normalizeMyPhone } from "@kason/shared";
import { Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { findPartyByNaturalKey } from "./repository";
import { parseIdType } from "./parse/cells";
import type { RawTenantRow } from "./types";

export interface PartyCreateData {
  organizationId: string;
  partyType: "tenant";
  displayName: string;
  status: "active";
  primaryPhone: string | null;
  primaryEmail: string | null;
  idType: string | null;
  idNumber: string | null;
  gender: string | null;
}

export type PartyPlan =
  | { action: "match"; partyId: string; diff: Record<string, [unknown, unknown]> }
  | { action: "create"; data: PartyCreateData }
  | { action: "skip"; reason: string };

export interface ImportActor {
  orgId: string;
  userId: string;
  role: string;
}

export async function planParty(
  tx: Prisma.TransactionClient,
  orgId: string,
  row: RawTenantRow,
): Promise<PartyPlan> {
  if (!row.tenantNameRaw) return { action: "skip", reason: "no tenant name" };
  const phone = normalizeMyPhone(row.phoneRaw);
  const existing = await findPartyByNaturalKey(tx, orgId, phone, row.idNumber);
  if (existing) {
    const diff: Record<string, [unknown, unknown]> = {};
    if (phone && existing.primaryPhone && existing.primaryPhone !== phone) {
      diff.primaryPhone = [existing.primaryPhone, phone];
    }
    if (row.idNumber && existing.idNumber && existing.idNumber !== row.idNumber) {
      diff.idNumber = [existing.idNumber, row.idNumber];
    }
    return { action: "match", partyId: existing.id, diff };
  }
  return {
    action: "create",
    data: {
      organizationId: orgId,
      partyType: "tenant",
      displayName: row.tenantNameRaw,
      status: "active",
      primaryPhone: phone,
      primaryEmail: row.email,
      idType: row.idNumber ? parseIdType(row.idNumber) : null,
      idNumber: row.idNumber,
      gender: row.gender,
    },
  };
}

export async function executePartyPlan(
  tx: Prisma.TransactionClient,
  actor: ImportActor,
  plan: PartyPlan,
): Promise<string | null> {
  if (plan.action === "skip") return null;
  if (plan.action === "match") return plan.partyId;
  const created = await tx.party.create({ data: plan.data, select: { id: true } });
  await recordAudit(tx, {
    organizationId: actor.orgId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "data-import.party.create",
    entityType: "Party",
    entityId: created.id,
    meta: { source: "data-import" },
  });
  return created.id;
}
