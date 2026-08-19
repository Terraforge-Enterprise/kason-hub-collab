// apps/api/src/modules/billing/__tests__/post-charge-guard.integration.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { postChargeService } from "../billing.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c3300000-0000-4000-8000-000000000001";
const USER = "c3300000-0000-4000-8000-000000000002";
const PROP = "c3300000-0000-4000-8000-000000000003";
const APT = "c3300000-0000-4000-8000-000000000004";
const ROOM = "c3300000-0000-4000-8000-000000000005";
const OWNER = "c3300000-0000-4000-8000-000000000006";
const sess = { orgId: ORG, userId: USER, role: "manager" } as never;

async function cleanup() {
  const db = getDb();
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.managementFeeConfig.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}
async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "PG", slug: "pg", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "pg@example.test", fullName: "PG", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
}
async function draftCharge(over: Record<string, unknown> = {}): Promise<string> {
  const c = await getDb().charge.create({
    data: {
      organizationId: ORG, chargeNumber: `MAN-${Math.random().toString(36).slice(2, 8)}`,
      partyId: OWNER, unitId: ROOM, chargeType: "utility", status: "draft",
      dueDate: new Date(Date.UTC(2026, 5, 30)), billingMonth: new Date(Date.UTC(2026, 5, 1)),
      amount: "50.00", outstandingAmount: "50.00", currency: "MYR", attachmentKeys: [], ...over,
    },
    select: { id: true },
  });
  return c.id;
}

beforeAll(() => { process.env.ENABLE_PHASE2_OWNER_BILLING = "1"; });
afterAll(() => { delete process.env.ENABLE_PHASE2_OWNER_BILLING; });

dn("postChargeService guard (integration)", () => {
  beforeEach(async () => { await cleanup(); await seed(); });

  // B2
  it("blocks the flip with 422 OWNER_BILLING_NOT_CONFIGURED and keeps the charge draft", async () => {
    const id = await draftCharge();
    const r = await postChargeService(sess, { chargeId: id });
    expect(r).toMatchObject({ ok: false, status: 422, error: "OWNER_BILLING_NOT_CONFIGURED" });
    expect((await getDb().charge.findFirstOrThrow({ where: { id } })).status).toBe("draft");
    expect(await getDb().chargeEvent.count({ where: { chargeId: id, eventType: "charge_posted" } })).toBe(0);
  });

  // B3
  it("blocks with 422 OWNER_NOT_ASSIGNED when the listing has no owner", async () => {
    await getDb().listing.update({ where: { id: ROOM }, data: { ownerPartyId: null } });
    const id = await draftCharge();
    const r = await postChargeService(sess, { chargeId: id });
    expect(r).toMatchObject({ ok: false, status: 422, error: "OWNER_NOT_ASSIGNED" });
    expect((await getDb().charge.findFirstOrThrow({ where: { id } })).status).toBe("draft");
  });

  // B6
  it("re-posting succeeds after fixing the config post-rejection (idempotent retry)", async () => {
    const id = await draftCharge();
    const r1 = await postChargeService(sess, { chargeId: id });
    expect(r1).toMatchObject({ ok: false, status: 422, error: "OWNER_BILLING_NOT_CONFIGURED" });
    await getDb().managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: null, feeType: "percent", feeValue: "10", sstPercent: "8", isActive: true } });
    const r2 = await postChargeService(sess, { chargeId: id });
    expect(r2.ok).toBe(true);
    expect((await getDb().charge.findFirstOrThrow({ where: { id } })).status).toBe("posted");
  });

  // B1
  it("posts once the owner has an active config", async () => {
    await getDb().managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: null, feeType: "percent", feeValue: "10", sstPercent: "8", isActive: true } });
    const id = await draftCharge();
    const r = await postChargeService(sess, { chargeId: id });
    expect(r.ok).toBe(true);
    expect((await getDb().charge.findFirstOrThrow({ where: { id } })).status).toBe("posted");
  });

  // B4
  it("posts a non-unit charge (unitId null) — guard is a no-op", async () => {
    const id = await draftCharge({ unitId: null });
    const r = await postChargeService(sess, { chargeId: id });
    expect(r.ok).toBe(true);
    expect((await getDb().charge.findFirstOrThrow({ where: { id } })).status).toBe("posted");
  });

  // B5
  it("flag off: posts even when owner/config would fail the guard", async () => {
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const id = await draftCharge(); // owner assigned, but NO config — would 422 if the flag were on
      const r = await postChargeService(sess, { chargeId: id });
      expect(r.ok).toBe(true);
      expect((await getDb().charge.findFirstOrThrow({ where: { id } })).status).toBe("posted");
    } finally {
      process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
    }
  });
});
