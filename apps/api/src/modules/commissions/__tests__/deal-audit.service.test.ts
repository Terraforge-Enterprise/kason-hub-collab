import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  $queryRawUnsafe: vi.fn(),
  commissionClaimItem: { count: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import { listDealAuditService } from "../deal-audit.service";

const session = {
  orgId: "org-1",
  userId: "user-1",
  role: "manager" as const,
  userType: "operator" as const,
};

describe("listDealAuditService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("groups claims by (propertyId, unitCode, roomType, moveInDate, tenantName, salesDate)", async () => {
    dbMock.$queryRawUnsafe.mockResolvedValue([
      {
        property_id: "prop-1",
        condo_name: "Berkeley",
        unit_code: "A-08-02",
        room_type: "Master",
        move_in_date: "2026-04-20",
        tenant_name: "Ali",
        sales_date: "2026-04-15",
        tenant_side_total: "50.0000",
        listing_side_total: "30.0000",
        combined_total: "80.0000",
        total_shortfall: "0.00",
        claims: [
          {
            claim_id: "c-1",
            claim_number: "CLM-0001",
            agent_party_id: "a-1",
            agent_name: "Rizal",
            claim_type: "tenant_portion",
            agent_tier_percentage: "40.00",
            commission_percentage: "100.00",
            effective_percentage: "40.00",
            monthly_rental: "1000.00",
            nett_payout: "484.00",
            status: "submitted",
            shortfall_applied: null,
            outstanding_balance: null,
          },
        ],
      },
    ]);
    dbMock.commissionClaimItem.count.mockResolvedValue(1);

    const res = await listDealAuditService(session, { page: 1, pageSize: 20 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.data).toHaveLength(1);
      const row = res.data.data[0];
      expect(row.unitCode).toBe("A-08-02");
      expect(row.tenantSideTotal).toBe("50.00");
      expect(row.companyResidual).toBe("20.00");
      expect(row.claims).toHaveLength(1);
    }
  });

  it("always includes organizationId filter in the raw query with orgId from session", async () => {
    dbMock.$queryRawUnsafe.mockResolvedValue([]);
    dbMock.commissionClaimItem.count.mockResolvedValue(0);

    await listDealAuditService(session, { page: 1, pageSize: 20 });
    const callArgs = dbMock.$queryRawUnsafe.mock.calls[0];
    const sql = callArgs[0] as string;
    const firstParam = callArgs[1];
    expect(sql).toContain(`"organizationId" = $1`);
    expect(firstParam).toBe(session.orgId);
  });
});
