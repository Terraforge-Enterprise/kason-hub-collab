import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "b2000000-0000-4000-8000-0000000000a1";
const PROP = "b2000000-0000-4000-8000-0000000000a2";
const APT = "b2000000-0000-4000-8000-0000000000a3";

dn("M2 unit-utility-billing schema (integration)", () => {
  beforeEach(async () => {
    const db = getDb();
    await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG } });
    await db.apartment.deleteMany({ where: { organizationId: ORG } });
    await db.property.deleteMany({ where: { organizationId: ORG } });
    await db.organization.deleteMany({ where: { id: ORG } });
    await db.organization.create({ data: { id: ORG, name: "M2 Smoke", slug: "m2-smoke", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
    await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
    await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  });

  it("creates a UnitUtilityBill and enforces the per-apt-per-period unique", async () => {
    const db = getDb();
    await db.unitUtilityBill.create({ data: { organizationId: ORG, apartmentId: APT, periodMonth: new Date("2026-06-01"), billingMode: "no_subsidy", tnbTotal: "134.40", cleaning: "100.00", airSelangor: "6.50", status: "draft", createdBy: ORG } });
    await expect(
      db.unitUtilityBill.create({ data: { organizationId: ORG, apartmentId: APT, periodMonth: new Date("2026-06-01"), billingMode: "no_subsidy", tnbTotal: "1.00", status: "draft", createdBy: ORG } }),
    ).rejects.toThrow();
  });
});
