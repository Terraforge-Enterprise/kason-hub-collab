import { getDb } from "@kason/db";
import type { DealAuditResponse } from "@kason/shared";

// Match the inline session pattern used by sibling services (e.g.
// level-thresholds.service.ts). Kept local so this service has no coupling
// to the Hono route session-variable type.
type Session = {
  orgId: string;
  userId: string;
  role: "admin" | "manager" | "editor";
  userType?: string;
};

type ServiceResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

type ListInput = { page: number; pageSize: number };

type RawClaimSlice = {
  claim_id: string;
  claim_number: string;
  agent_party_id: string;
  agent_name: string;
  claim_type: "tenant_portion" | "listing_portion";
  agent_tier_percentage: string | number;
  commission_percentage: string | number;
  effective_percentage: string | number;
  monthly_rental: string | number;
  nett_payout: string | number;
  status: string;
  shortfall_applied: string | number | null;
  outstanding_balance: string | number | null;
};

type RawRow = {
  property_id: string;
  condo_name: string;
  unit_code: string;
  room_type: string;
  move_in_date: string;
  tenant_name: string;
  sales_date: string;
  tenant_side_total: string;
  listing_side_total: string;
  combined_total: string;
  total_shortfall: string;
  claims: unknown;
};

export async function listDealAuditService(
  session: Session,
  input: ListInput,
): Promise<ServiceResult<DealAuditResponse>> {
  const db = getDb();
  const page = Math.max(1, input.page);
  const pageSize = Math.min(100, Math.max(1, input.pageSize));
  const offset = (page - 1) * pageSize;

  // orgId is always $1 — never from request body/query. Enforced by the
  // positional-parameter contract of $queryRawUnsafe.
  const sql = `
    SELECT
      i."propertyId"::text   AS property_id,
      i."condoName"          AS condo_name,
      i."unitCode"           AS unit_code,
      i."roomType"           AS room_type,
      i."moveInDate"::text   AS move_in_date,
      i."tenantName"         AS tenant_name,
      MAX(i."salesDate")::text AS sales_date,
      COALESCE(SUM(CASE WHEN c."claimType" = 'tenant_portion'  AND c.status IN ('submitted','approved','paid')
                        THEN i."agentTierPercentage" * i."commissionPercentage" / 100 ELSE 0 END), 0)::text AS tenant_side_total,
      COALESCE(SUM(CASE WHEN c."claimType" = 'listing_portion' AND c.status IN ('submitted','approved','paid')
                        THEN i."agentTierPercentage" * i."commissionPercentage" / 100 ELSE 0 END), 0)::text AS listing_side_total,
      COALESCE(SUM(CASE WHEN c.status IN ('submitted','approved','paid')
                        THEN i."agentTierPercentage" * i."commissionPercentage" / 100 ELSE 0 END), 0)::text AS combined_total,
      COALESCE(SUM(COALESCE(i."shortfallApplied", 0)), 0)::text AS total_shortfall,
      json_agg(json_build_object(
        'claim_id',              c.id::text,
        'claim_number',          c."claimNumber",
        'agent_party_id',        c."agentPartyId"::text,
        'agent_name',            p."displayName",
        'claim_type',            c."claimType",
        'agent_tier_percentage', i."agentTierPercentage",
        'commission_percentage', i."commissionPercentage",
        'effective_percentage',  (i."agentTierPercentage" * i."commissionPercentage" / 100),
        'monthly_rental',        i."monthlyRental",
        'nett_payout',           i."nettPayout",
        'status',                c.status,
        'shortfall_applied',     i."shortfallApplied",
        'outstanding_balance',   i."outstandingBalance"
      ) ORDER BY p."displayName") AS claims
    FROM "CommissionClaimItem" i
    JOIN "CommissionClaim" c ON c.id = i."claimId"
    JOIN "Party" p ON p.id = c."agentPartyId"
    WHERE i."organizationId" = $1
    GROUP BY i."propertyId", i."condoName", i."unitCode", i."roomType", i."moveInDate", i."tenantName"
    ORDER BY MAX(c."createdAt") DESC
    LIMIT $2 OFFSET $3;
  `;

  const [rows, totalCount] = await Promise.all([
    db.$queryRawUnsafe<RawRow[]>(sql, session.orgId, pageSize, offset),
    db.commissionClaimItem.count({ where: { organizationId: session.orgId } }),
  ]);

  const data = rows.map((r) => {
    const combined = Number(r.combined_total);
    const companyResidual = Math.max(0, 100 - combined).toFixed(2);
    return {
      propertyId: r.property_id,
      condoName: r.condo_name,
      unitCode: r.unit_code,
      roomType: r.room_type,
      moveInDate: r.move_in_date,
      tenantName: r.tenant_name,
      salesDate: r.sales_date,
      tenantSideTotal: Number(r.tenant_side_total).toFixed(2),
      listingSideTotal: Number(r.listing_side_total).toFixed(2),
      combinedTotal: combined.toFixed(2),
      companyResidual,
      totalShortfall: Number(r.total_shortfall).toFixed(2),
      claims: (r.claims as RawClaimSlice[]).map((cl) => ({
        claimId: cl.claim_id,
        claimNumber: cl.claim_number,
        agentPartyId: cl.agent_party_id,
        agentName: cl.agent_name,
        claimType: cl.claim_type,
        agentTierPercentage: String(cl.agent_tier_percentage),
        commissionPercentage: String(cl.commission_percentage),
        effectivePercentage: Number(cl.effective_percentage).toFixed(2),
        monthlyRental: String(cl.monthly_rental),
        nettPayout: String(cl.nett_payout),
        status: cl.status,
        shortfallApplied: cl.shortfall_applied != null ? String(cl.shortfall_applied) : null,
        outstandingBalance: cl.outstanding_balance != null ? String(cl.outstanding_balance) : null,
      })),
    };
  });

  return {
    ok: true,
    status: 200,
    data: {
      data,
      pageInfo: { page, pageSize, totalCount },
    },
  };
}
