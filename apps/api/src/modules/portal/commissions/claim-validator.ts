import { Decimal } from "@prisma/client/runtime/client";
import { ClaimError } from "./claim-errors";

// Minimal input shapes used by the validator. Parent service layer converts
// from route-layer Zod type to this shape.
export type ValidatorItem = {
  propertyId: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  salesDate: string;              // ISO date (YYYY-MM-DD) at validator boundary
  moveInDate: string;             // ISO date (YYYY-MM-DD) at validator boundary
  commissionPercentage: string;   // decimal string
};

export type ValidatorPayload = {
  claimType: string;
  items: ValidatorItem[];
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: ClaimError };

function keyOf(it: Pick<ValidatorItem, "propertyId" | "unitCode" | "roomType" | "moveInDate">): string {
  return `${it.propertyId}|${it.unitCode.trim().toLowerCase()}|${it.roomType.trim().toLowerCase()}|${it.moveInDate}`;
}

export function validateRuleA(payload: ValidatorPayload): ValidationResult {
  const seen = new Map<string, number>();
  for (let i = 0; i < payload.items.length; i++) {
    const k = keyOf(payload.items[i]);
    if (seen.has(k)) {
      return {
        ok: false,
        error: new ClaimError("rule_a_duplicate", {
          message:
            "Duplicate items detected: two rows share the same property, unit, room type, and move-in date.",
          keyIndex: i,
        }),
      };
    }
    seen.set(k, i);
  }
  return { ok: true };
}

// Exported for reuse by Rule C (grouping) and precheck (key construction).
export function keyOfItem(it: Pick<ValidatorItem, "propertyId" | "unitCode" | "roomType" | "moveInDate">): string {
  return keyOf(it);
}

// Prisma transactional client type — loose so unit tests can pass simple mocks.
// Route/service layer passes the real `Prisma.TransactionClient`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PrismaTx = any;

export type ValidatorSession = { orgId: string; partyId: string };

export async function validateRuleB(
  tx: PrismaTx,
  payload: ValidatorPayload,
  session: ValidatorSession,
  excludeClaimId?: string,
): Promise<ValidationResult> {
  for (const item of payload.items) {
    const prior = await tx.commissionClaim.findFirst({
      where: {
        organizationId: session.orgId,
        agentPartyId: session.partyId,
        claimType: payload.claimType,
        status: { in: ["submitted", "approved", "paid"] },
        ...(excludeClaimId ? { id: { not: excludeClaimId } } : {}),
        items: {
          some: {
            propertyId: item.propertyId,
            unitCode: { equals: item.unitCode, mode: "insensitive" },
            roomType: { equals: item.roomType, mode: "insensitive" },
            tenantName: { equals: item.tenantName, mode: "insensitive" },
            salesDate: new Date(item.salesDate),
            moveInDate: new Date(item.moveInDate),
          },
        },
      },
      select: { id: true, claimNumber: true },
    });
    if (prior) {
      return {
        ok: false,
        error: new ClaimError("rule_b_same_agent_active", {
          message: `You already have an active claim with the exact same details (claim ${prior.claimNumber}). You cannot submit a duplicate until this one is resolved.`,
          priorClaimNumber: prior.claimNumber,
        }),
      };
    }
  }
  return { ok: true };
}

type RuleCRow = {
  propertyId: string;
  unit_l: string;
  room_l: string;
  moveInDate: Date;
  total: string;
};

export async function validateRuleC(
  tx: PrismaTx,
  payload: ValidatorPayload,
  session: ValidatorSession,
  excludeClaimId?: string,
): Promise<ValidationResult> {
  // 1. Group payload items by normalized key; accumulate newSum per group.
  type Group = {
    propertyId: string;
    unitCodeLower: string;
    roomTypeLower: string;
    moveInDate: string;
    newSum: Decimal;
  };
  const groups = new Map<string, Group>();
  for (const item of payload.items) {
    const k = keyOfItem(item);
    const g = groups.get(k);
    if (g) {
      g.newSum = g.newSum.plus(new Decimal(item.commissionPercentage));
    } else {
      groups.set(k, {
        propertyId: item.propertyId,
        unitCodeLower: item.unitCode.trim().toLowerCase(),
        roomTypeLower: item.roomType.trim().toLowerCase(),
        moveInDate: item.moveInDate,
        newSum: new Decimal(item.commissionPercentage),
      });
    }
  }

  if (groups.size === 0) return { ok: true };

  // 2. Build ONE grouped query for all distinct keys using jsonb_array_elements.
  const keysJson = JSON.stringify(
    Array.from(groups.values()).map((g) => ({
      propertyId: g.propertyId,
      unitCodeLower: g.unitCodeLower,
      roomTypeLower: g.roomTypeLower,
      moveInDate: g.moveInDate,
    })),
  );

  const rows: RuleCRow[] = await tx.$queryRaw`
    WITH target AS (
      SELECT
        (elem->>'propertyId')::uuid AS "propertyId",
        elem->>'unitCodeLower' AS unit_l,
        elem->>'roomTypeLower' AS room_l,
        (elem->>'moveInDate')::date AS "moveInDate"
      FROM jsonb_array_elements(${keysJson}::jsonb) AS elem
    )
    SELECT
      i."propertyId",
      LOWER(i."unitCode") AS unit_l,
      LOWER(i."roomType") AS room_l,
      i."moveInDate",
      SUM(i."commissionPercentage")::text AS total
    FROM "CommissionClaimItem" i
    JOIN "CommissionClaim" c ON c.id = i."claimId"
    JOIN target t
      ON t."propertyId" = i."propertyId"
     AND t.unit_l = LOWER(i."unitCode")
     AND t.room_l = LOWER(i."roomType")
     AND t."moveInDate" = i."moveInDate"
    WHERE c."organizationId" = ${session.orgId}::uuid
      AND c.status IN ('submitted', 'approved', 'paid', 'amended')
      AND c.id <> COALESCE(${excludeClaimId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
    GROUP BY 1, 2, 3, 4
  `;

  // 3. Build a map of existing sums keyed by normalized key.
  const existingByKey = new Map<string, Decimal>();
  for (const r of rows) {
    const k = `${r.propertyId}|${r.unit_l}|${r.room_l}|${r.moveInDate.toISOString().slice(0, 10)}`;
    existingByKey.set(k, new Decimal(r.total));
  }

  // 4. For each group, check the cap. Return on first violation.
  for (const g of groups.values()) {
    const key = `${g.propertyId}|${g.unitCodeLower}|${g.roomTypeLower}|${g.moveInDate}`;
    const existing = existingByKey.get(key) ?? new Decimal(0);
    const total = existing.plus(g.newSum);
    if (total.greaterThan(100)) {
      const available = Decimal.max(new Decimal(100).minus(existing), 0);
      return {
        ok: false,
        error: new ClaimError("rule_c_sum_exceeded", {
          // SCRUBBED message — no mention of other agents or their totals.
          message: `Commission for this unit, room, and move-in date would exceed 100%. Available max: ${available.toFixed(2)}%.`,
          availableMax: available.toFixed(2),
          existingPct: existing.toFixed(2),
          proposedPct: g.newSum.toFixed(2),
          totalPct: total.toFixed(2),
          key: {
            propertyId: g.propertyId,
            unitCodeLower: g.unitCodeLower,
            roomTypeLower: g.roomTypeLower,
            moveInDate: g.moveInDate,
          },
        }),
      };
    }
  }

  return { ok: true };
}

export async function validateRuleD(args: {
  db: PrismaTx;
  orgId: string;
  claimId: string | null;
  claimType: string;
  items: Array<{
    propertyId: string;
    unitCode: string;
    roomType: string;
    moveInDate: Date;
    taSharePercent: string | number | null;
  }>;
}): Promise<void> {
  if (args.claimType === "listing_portion") return;

  for (const it of args.items) {
    if (it.taSharePercent == null) continue;
    const proposed = new Decimal(it.taSharePercent);
    if (proposed.lessThanOrEqualTo(0)) continue;

    const existingAgg = await args.db.$queryRaw<Array<{ sum: string }>>`
      SELECT COALESCE(SUM(i."taSharePercent"), 0)::text AS sum
      FROM "CommissionClaimItem" i
      JOIN "CommissionClaim" c ON c.id = i."claimId"
      WHERE i."organizationId" = ${args.orgId}::uuid
        AND i."propertyId" = ${it.propertyId}::uuid
        AND LOWER(i."unitCode") = LOWER(${it.unitCode})
        AND LOWER(i."roomType") = LOWER(${it.roomType})
        AND i."moveInDate" = ${it.moveInDate}
        AND c.status IN ('submitted','approved','paid','amended')
        AND c."claimType" IN ('tenant_portion','tenant_listing_portion')
        AND c.id <> COALESCE(${args.claimId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
    `;
    const existing = new Decimal(existingAgg[0]?.sum ?? 0);
    const total = existing.plus(proposed);
    if (total.greaterThan(100)) {
      throw new ClaimError("ta_share_sum_invalid", {
        message: `TA share for this unit, room, and move-in date would exceed 100%. Existing: ${existing.toFixed(2)}%, proposed: ${proposed.toFixed(2)}%, total: ${total.toFixed(2)}%.`,
        existingPct: existing.toFixed(2),
        proposedPct: proposed.toFixed(2),
        totalPct: total.toFixed(2),
        key: {
          propertyId: it.propertyId,
          unitCode: it.unitCode,
          roomType: it.roomType,
          moveInDate: it.moveInDate.toISOString().slice(0, 10),
        },
      });
    }
  }
}

export async function validateAll(
  tx: PrismaTx,
  payload: ValidatorPayload,
  session: ValidatorSession,
  excludeClaimId?: string,
): Promise<ValidationResult> {
  const a = validateRuleA(payload);
  if (!a.ok) return a;

  const b = await validateRuleB(tx, payload, session, excludeClaimId);
  if (!b.ok) return b;

  const c = await validateRuleC(tx, payload, session, excludeClaimId);
  if (!c.ok) return c;

  return { ok: true };
}
