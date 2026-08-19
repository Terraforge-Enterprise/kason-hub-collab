/**
 * Race-condition integration test for createAndSubmitClaimService.
 *
 * Requires a real local Postgres with the commission_split_constraint
 * migration applied and at least two agent parties + one property seeded.
 *
 * Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="..." \
 *     npx vitest run apps/api/src/modules/portal/commissions/__tests__/claim-serialization.integration.test.ts
 *
 * The scenario: two agents (Rizal + Priya) submit claims for the SAME
 * property+unit+room+moveInDate simultaneously, each claiming 60%. Total
 * would be 120%. Under Serializable isolation, exactly one must succeed
 * with status=submitted; the other must see a rule_c_sum_exceeded 409.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getDb } from "@kason/db";
import { createAndSubmitClaimService } from "../portal.commissions.service";

type Db = ReturnType<typeof getDb>;

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

type TestSession = { orgId: string; partyId: string; userId: string; userType: string };

dn("createAndSubmitClaimService — race condition (integration)", () => {
  let db: Db;
  let session1: TestSession;
  let session2: TestSession;
  let propertyId: string;
  const RACE_UNIT = "RACE-TEST-UNIT-9C8F1E2A";
  const RACE_MOVEIN = "2099-01-15";

  beforeAll(async () => {
    db = getDb();

    const agents = await db.party.findMany({
      where: { primaryEmail: { in: ["rizal.zainal@gmail.com", "priya.subra@gmail.com"] } },
      select: { id: true, organizationId: true, primaryEmail: true },
    });
    const rizal = agents.find((a) => a.primaryEmail === "rizal.zainal@gmail.com");
    const priya = agents.find((a) => a.primaryEmail === "priya.subra@gmail.com");
    if (!rizal || !priya) {
      throw new Error("Integration test requires seeded agents rizal + priya");
    }
    if (rizal.organizationId !== priya.organizationId) {
      throw new Error("Integration test requires rizal + priya in the same organization");
    }

    session1 = { orgId: rizal.organizationId, partyId: rizal.id, userId: rizal.id, userType: "agent" };
    session2 = { orgId: priya.organizationId, partyId: priya.id, userId: priya.id, userType: "agent" };

    const prop = await db.property.findFirst({ where: { organizationId: rizal.organizationId }, select: { id: true } });
    if (!prop) throw new Error("Integration test requires at least one seeded property");
    propertyId = prop.id;
  });

  afterEach(async () => {
    // Cleanup: remove any RACE_UNIT claim items + their parent claims.
    await db.commissionClaimItem.deleteMany({ where: { unitCode: RACE_UNIT } });
    await db.commissionClaim.deleteMany({
      where: { items: { every: { unitCode: RACE_UNIT } } },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  // tenancyChargesByKaen MUST equal the TaTier companyMinimum for this rental, else
  // the submit path's assertTaTierMatch throws 422 ta_tier_mismatch BEFORE the
  // Serializable race is ever reached. monthlyRental=1000 falls in seeded TaTier tier 1
  // (rentalMin 0 – rentalMax 2000 → companyMinimum 216), so the TA charge is 216.00.
  // With chargesByAgent=0 this yields shortfall=216 and nettPayout is clamped to
  // max(0, …) ≥ 0 (compute-nett-payout.ts) — no negative payout. The test is about
  // race serialization — the exact fee is only here to clear the tier gate.
  const buildInput = (pct: string) => ({
    claimType: "tenant_portion" as const,
    items: [{
      propertyId,
      condoName: "Race Test Property",
      unitCode: RACE_UNIT,
      roomType: "Master",
      tenantName: "Race Test Tenant",
      salesDate: "2099-01-10",
      moveInDate: RACE_MOVEIN,
      moveOutDate: "2099-12-31",
      monthlyRental: "1000.00",
      commissionPercentage: pct,
      tenancyChargesByAgent: "0",
      tenancyChargesByKaen: "216.00",
    }],
  });

  it("two concurrent submits summing >100% → exactly one succeeds, other gets rule_c_sum_exceeded", async () => {
    const [r1, r2] = await Promise.all([
      createAndSubmitClaimService(session1, buildInput("60.00")),
      createAndSubmitClaimService(session2, buildInput("60.00")),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const fail = failures[0] as Extract<typeof r1, { ok: false }>;
    expect(fail.status).toBe(409);
    expect(fail.error.code).toBe("rule_c_sum_exceeded");

    // DB state: exactly one active claim for this key.
    const activeCount = await db.commissionClaim.count({
      where: {
        status: { in: ["submitted", "approved", "paid"] },
        items: { some: { unitCode: RACE_UNIT } },
      },
    });
    expect(activeCount).toBe(1);
  }, 30000);

  it("two concurrent submits summing exactly 100% (e.g. 60+40) → BOTH succeed", async () => {
    const [r1, r2] = await Promise.all([
      createAndSubmitClaimService(session1, buildInput("60.00")),
      createAndSubmitClaimService(session2, buildInput("40.00")),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const activeCount = await db.commissionClaim.count({
      where: {
        status: { in: ["submitted", "approved", "paid"] },
        items: { some: { unitCode: RACE_UNIT } },
      },
    });
    expect(activeCount).toBe(2);
  }, 30000);
});
