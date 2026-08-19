/**
 * Integration tests for PART 3 (Workstream D) — owner notification on payment.
 *
 * When a tenant payment is applied and a Charge reaches "paid", the unit's OWNER
 * (resolved via Listing.ownerPartyId → User.partyId) gets an in-app Notification
 * that the tenant's payment landed. Before this, the only notification on a tenant
 * payment was the org-wide ADMIN inbox alert at submit time.
 *
 * Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`. Run:
 *   RUN_INTEGRATION=1 DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev" \
 *     npx vitest run src/modules/payments/__tests__/payments.owner-notify.integration.test.ts
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { postPaymentTx } from "../payments.repository";
import { notifyOwnersOfChargesPaid } from "../payments.owner-notify";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint, valid-hex (prefix 0d).
const ORG = "0d000000-0000-4000-8000-000000000001";
const ADMIN_USER = "0d000000-0000-4000-8000-000000000002";
const TENANT_PARTY = "0d000000-0000-4000-8000-000000000003";
const OWNER_PARTY = "0d000000-0000-4000-8000-000000000004";
const OWNER_USER = "0d000000-0000-4000-8000-000000000005";
const PROPERTY = "0d000000-0000-4000-8000-000000000006";
const APARTMENT = "0d000000-0000-4000-8000-000000000007";
const UNIT = "0d000000-0000-4000-8000-000000000008";
const PAYMENT = "0d000000-0000-4000-8000-000000000010";
const CHARGE_1 = "0d000000-0000-4000-8000-000000000011";
const CHARGE_2 = "0d000000-0000-4000-8000-000000000012";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.notification.deleteMany({ where: org });
  await db.paymentAllocation.deleteMany({ where: org });
  await db.payment.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** Seed an org with an owner (Party + portal User), a tenant, and an owned unit. */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "OwnerNotify Org", slug: "owner-notify-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  // The acting (admin) user — AuditLog.actorUserId FK requires it.
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "ON Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "ON Owner", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: ADMIN_USER, organizationId: ORG, email: "on-admin@example.test", fullName: "ON Admin", status: "active", role: "manager", userType: "operator" } });
  // The owner's portal user (User.partyId @unique → one user per party).
  await db.user.create({ data: { id: OWNER_USER, organizationId: ORG, email: "on-owner@example.test", fullName: "ON Owner", status: "active", role: "owner", userType: "owner", partyId: OWNER_PARTY } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "ON Property", propertyCode: "ON-P1", propertyType: "apartment", addressLine1: "1 ON St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "ON-A-1", listingMode: "PARTITIONED" } });
  // The owned unit — owner is per-unit via Listing.ownerPartyId.
  await db.listing.create({ data: { id: UNIT, organizationId: ORG, apartmentId: APARTMENT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
}

/** Seed a pending_approval payment + a posted Charge on UNIT (owned by OWNER_PARTY). */
async function seedPendingPayment(amount: string) {
  const db = getDb();
  await db.payment.create({
    data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PAY-ON-001", partyId: TENANT_PARTY, paymentType: "payment", paymentMethod: "bank_transfer", status: "pending_approval", amount, currency: "MYR", receivedAt: new Date("2026-06-01T00:00:00.000Z") },
  });
}
async function seedCharge(id: string, amount: string, outstanding: string, unitId: string | null = UNIT) {
  const db = getDb();
  await db.charge.create({
    data: { id, organizationId: ORG, chargeNumber: `CHG-${id.slice(-4)}`, partyId: TENANT_PARTY, unitId, tenancyId: null, chargeType: "rent", status: "posted", dueDate: new Date("2026-06-30T00:00:00.000Z"), amount, currency: "MYR", outstandingAmount: outstanding },
  });
}
async function seedAllocation(chargeId: string, amount: string) {
  const db = getDb();
  await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId, allocatedAmount: amount, allocatedAt: new Date() } });
}

dn("PART 3 — owner notification on tenant payment", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("(a) posting a payment that FULLY pays a charge notifies the unit's owner", async () => {
    const db = getDb();
    await seedPendingPayment("600.00");
    await seedCharge(CHARGE_1, "600.00", "600.00");
    await seedAllocation(CHARGE_1, "600.00");

    const r = await postPaymentTx({ organizationId: ORG, paymentId: PAYMENT, actorUserId: ADMIN_USER, actorRole: "manager" });
    expect(r).toMatchObject({ ok: true });
    // The tx reports the charge that reached paid.
    expect((r as { paidChargeIds: string[] }).paidChargeIds).toEqual([CHARGE_1]);

    // Drive the post-commit notifier (the service does this; we call it directly here).
    await notifyOwnersOfChargesPaid(ORG, (r as { paidChargeIds: string[] }).paidChargeIds);

    // The charge is paid.
    expect((await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } })).status).toBe("paid");
    // EXACTLY one owner-targeted notification, addressed to the owner's User.
    const notes = await db.notification.findMany({ where: { organizationId: ORG, userId: OWNER_USER } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.domain).toBe("finance");
    expect(notes[0]!.title).toBe("Tenant payment received");
    expect(notes[0]!.body).toContain("ON-A-1"); // the unit code
    expect(notes[0]!.body).toContain("600.00");
    expect(notes[0]!.actionUrl).toBe("/owner/financials");
  });

  it("(b) a PARTIAL payment (charge not fully paid) notifies no owner", async () => {
    const db = getDb();
    await seedPendingPayment("100.00");
    await seedCharge(CHARGE_1, "600.00", "600.00");
    await seedAllocation(CHARGE_1, "100.00");

    const r = await postPaymentTx({ organizationId: ORG, paymentId: PAYMENT, actorUserId: ADMIN_USER, actorRole: "manager" });
    expect(r).toMatchObject({ ok: true });
    expect((r as { paidChargeIds: string[] }).paidChargeIds).toEqual([]); // nothing reached paid

    await notifyOwnersOfChargesPaid(ORG, (r as { paidChargeIds: string[] }).paidChargeIds);

    expect((await db.charge.findUniqueOrThrow({ where: { id: CHARGE_1 } })).status).toBe("partially_paid");
    expect(await db.notification.count({ where: { organizationId: ORG, userId: OWNER_USER } })).toBe(0);
  });

  it("(c) a paid charge on an UNOWNED unit (ownerPartyId null) notifies no one", async () => {
    const db = getDb();
    // Clear the unit's owner so resolution finds no owner Party.
    await db.listing.update({ where: { id: UNIT }, data: { ownerPartyId: null } });
    await seedPendingPayment("600.00");
    await seedCharge(CHARGE_1, "600.00", "600.00");
    await seedAllocation(CHARGE_1, "600.00");

    const r = await postPaymentTx({ organizationId: ORG, paymentId: PAYMENT, actorUserId: ADMIN_USER, actorRole: "manager" });
    expect((r as { paidChargeIds: string[] }).paidChargeIds).toEqual([CHARGE_1]);
    await notifyOwnersOfChargesPaid(ORG, (r as { paidChargeIds: string[] }).paidChargeIds);

    // Charge paid, but no owner → zero notifications (no org-wide spam either).
    expect(await db.notification.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("(d) a paid charge with NO unit (unitId null) notifies no one", async () => {
    const db = getDb();
    await seedPendingPayment("600.00");
    await seedCharge(CHARGE_1, "600.00", "600.00", null); // unitId null
    await seedAllocation(CHARGE_1, "600.00");

    const r = await postPaymentTx({ organizationId: ORG, paymentId: PAYMENT, actorUserId: ADMIN_USER, actorRole: "manager" });
    expect((r as { paidChargeIds: string[] }).paidChargeIds).toEqual([CHARGE_1]);
    await notifyOwnersOfChargesPaid(ORG, (r as { paidChargeIds: string[] }).paidChargeIds);

    expect(await db.notification.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("(e) notifyOwnersOfChargesPaid is idempotent-safe per call: one call → one note (no double-send within a call)", async () => {
    const db = getDb();
    await seedPendingPayment("600.00");
    await seedCharge(CHARGE_1, "600.00", "600.00");
    await seedCharge(CHARGE_2, "0.01", "0.01"); // unrelated, not in the paid set
    await seedAllocation(CHARGE_1, "600.00");

    const r = await postPaymentTx({ organizationId: ORG, paymentId: PAYMENT, actorUserId: ADMIN_USER, actorRole: "manager" });
    // Only CHARGE_1 was allocated/paid; CHARGE_2 is untouched.
    expect((r as { paidChargeIds: string[] }).paidChargeIds).toEqual([CHARGE_1]);
    await notifyOwnersOfChargesPaid(ORG, (r as { paidChargeIds: string[] }).paidChargeIds);

    expect(await db.notification.count({ where: { organizationId: ORG, userId: OWNER_USER } })).toBe(1);
  });
});
