/**
 * Bill-attachment → owner supporting-proof mirror (integration, RUN_INTEGRATION=1).
 *
 * Task 5: posting a utility bill mirrors its draft-attached files into the
 * owner's OwnerExpenseProof store (category "supporting"), REFERENCING the
 * same storageKey (no byte copy) so detach/void cleanup stays single-source.
 * Idempotent per storageKey — calling the mirror twice never duplicates.
 * Voiding the bill un-mirrors those proofs without touching the
 * UnitUtilityBillAttachment row or its storage object (no orphan either way).
 *
 * Run:
 *   cd apps/api && RUN_INTEGRATION=1 npx vitest run src/modules/meter/__tests__/attachment.mirror.integration.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}?token=t`),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

import {
  attachBillAttachmentsService,
  chargeUtilityBillService,
  createUtilityBillService,
  mirrorBillAttachmentsToOwner,
  voidUtilityBillService,
} from "../service";
import type { SessionPayload } from "../../../lib/auth";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed disjoint UUIDs (prefix ba99 — unused by any sibling file)
const ORG = "ba990000-0000-4000-8000-000000000001";
const USER = "ba990000-0000-4000-8000-000000000002";
const PROP = "ba990000-0000-4000-8000-000000000003";
const APT = "ba990000-0000-4000-8000-000000000004";
const ROOM = "ba990000-0000-4000-8000-000000000005";
const OWNER_PARTY = "ba990000-0000-4000-8000-000000000006";
const TENANT_PARTY = "ba990000-0000-4000-8000-000000000007";
const TEN = "ba990000-0000-4000-8000-000000000008";
// No-owner apartment (its room's ownerPartyId stays null) — Task 5's no-throw/no-mirror case.
const APT_NO_OWNER = "ba990000-0000-4000-8000-000000000009";
const ROOM_NO_OWNER = "ba990000-0000-4000-8000-00000000000a";
const TENANT_PARTY2 = "ba990000-0000-4000-8000-00000000000b";
const TEN2 = "ba990000-0000-4000-8000-00000000000c";
// Reassignment target for the owner-reassigned-between-charge-and-void test.
const OWNER_PARTY_2 = "ba990000-0000-4000-8000-00000000000d";

const sess: SessionPayload = { orgId: ORG, userId: USER, role: "manager", userType: "operator" };
const PERIOD = "2026-06-01";
const PERIOD_DATE = new Date(PERIOD);

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerExpenseProof.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.utilityAllocation.deleteMany({ where: org });
  await db.unitUtilityBillAttachment.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.meterReading.deleteMany({ where: org });
  await db.aircondMeter.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  // UnitReservation.unit → Listing is onDelete: Restrict — drop before listings.
  await db.unitReservation.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Mirror Org", slug: "mirror-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "mirror@example.test", fullName: "Mirror Manager", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY_2, organizationId: ORG, displayName: "Owner2 (reassignment target)", partyType: "individual", status: "active" } });

  // ENABLE_PHASE2_OWNER_BILLING gates assertOwnerBillingReady, which refuses to post
  // charges for a unit whose owner has no ACTIVE management-fee config
  // (OwnerBillingNotReadyError -> 422 OWNER_BILLING_NOT_CONFIGURED). The flag is on in
  // this repo's api .env, so without a config every charge-posting test in this file
  // failed on a precondition rather than on the behaviour it was written to check.
  // Seed the minimal config; effectiveFrom/To null = always in window.
  for (const owner of [OWNER_PARTY, OWNER_PARTY_2]) {
    await db.managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: owner, feeType: "percent", feeValue: "10.00", isActive: true } });
  }
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });

  // Owned apartment: ROOM.ownerPartyId = OWNER_PARTY (distinct from the tenant).
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  // No-owner apartment: same shape, but the room's ownerPartyId stays unset.
  await db.party.create({ data: { id: TENANT_PARTY2, organizationId: ORG, displayName: "Tenant2", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT_NO_OWNER, organizationId: ORG, propertyId: PROP, unitCode: "A-2", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM_NO_OWNER, organizationId: ORG, apartmentId: APT_NO_OWNER, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR" } });
  await db.tenancy.create({ data: { id: TEN2, organizationId: ORG, propertyId: PROP, unitId: ROOM_NO_OWNER, tenantPartyId: TENANT_PARTY2, tenancyCode: "T-2", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

function pdf(filename = "TNB.pdf"): { filename: string; mimeType: string; content: Buffer } {
  return { filename, mimeType: "application/pdf", content: Buffer.from([1, 2, 3]) };
}

async function billFor(apartmentId: string) {
  const bill = await createUtilityBillService(sess, { apartmentId, periodMonth: PERIOD, tnbTotal: "10.00", cleaning: "100.00" });
  expect(bill.ok).toBe(true);
  return (bill as { data: { id: string } }).data.id;
}

dn("bill-attachment → owner supporting-proof mirror (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it("mirrors draft attachments to owner supporting proofs on post, idempotently", async () => {
    const db = getDb();
    const billId = await billFor(APT);
    const attached = await attachBillAttachmentsService(sess, billId, [pdf("TNB.pdf")]);
    expect(attached.ok).toBe(true);

    const charged = await chargeUtilityBillService(sess, billId, {});
    expect(charged.ok).toBe(true);

    const proofs = await db.ownerExpenseProof.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_PARTY, apartmentId: APT, statementMonth: PERIOD_DATE, category: "supporting" },
    });
    expect(proofs).toHaveLength(1);
    expect(proofs[0].filename).toBe("TNB.pdf");
    const attachmentRow = await db.unitUtilityBillAttachment.findFirstOrThrow({ where: { organizationId: ORG, billId } });
    expect(proofs[0].storageKey).toBe(attachmentRow.storageKey); // references the SAME key — no byte copy

    // Idempotency: invoking the helper directly a second time must not duplicate
    // (re-charging is rejected — the bill is already charged — so we call it directly).
    await mirrorBillAttachmentsToOwner(ORG, USER, "manager", billId, APT, PERIOD_DATE);
    const again = await db.ownerExpenseProof.findMany({
      where: { organizationId: ORG, ownerPartyId: OWNER_PARTY, apartmentId: APT, statementMonth: PERIOD_DATE, category: "supporting" },
    });
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(proofs[0].id); // same row, not a replacement
  });

  it("un-mirrors the supporting proof on void, without touching the attachment row or its storage object", async () => {
    const db = getDb();
    const billId = await billFor(APT);
    await attachBillAttachmentsService(sess, billId, [pdf("TNB.pdf")]);
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

    expect(await db.ownerExpenseProof.count({ where: { organizationId: ORG, category: "supporting" } })).toBe(1);
    const attachmentsBefore = await db.unitUtilityBillAttachment.findMany({ where: { organizationId: ORG, billId } });
    expect(attachmentsBefore).toHaveLength(1);
    const storageKey = attachmentsBefore[0].storageKey;

    const voided = await voidUtilityBillService(sess, billId);
    expect(voided.ok).toBe(true);

    expect(await db.ownerExpenseProof.count({ where: { organizationId: ORG, category: "supporting" } })).toBe(0);
    // No orphan the other direction either: the attachment row + its storageKey survive the void.
    const attachmentsAfter = await db.unitUtilityBillAttachment.findMany({ where: { organizationId: ORG, billId } });
    expect(attachmentsAfter).toHaveLength(1);
    expect(attachmentsAfter[0].storageKey).toBe(storageKey);
  });

  it("un-mirrors correctly even if the apartment's owner was reassigned between charge and void (storageKey match, not a fresh owner re-lookup)", async () => {
    const db = getDb();
    const billId = await billFor(APT);
    await attachBillAttachmentsService(sess, billId, [pdf("TNB.pdf")]);
    expect((await chargeUtilityBillService(sess, billId, {})).ok).toBe(true);

    const before = await db.ownerExpenseProof.findMany({ where: { organizationId: ORG, category: "supporting" } });
    expect(before).toHaveLength(1);
    expect(before[0].ownerPartyId).toBe(OWNER_PARTY); // mirrored under the owner AT CHARGE TIME

    // Reassign the room's owner AFTER charge, BEFORE void — a fresh apartment→owner
    // lookup at void time would now resolve OWNER_PARTY_2, not OWNER_PARTY.
    await db.listing.update({ where: { id: ROOM }, data: { ownerPartyId: OWNER_PARTY_2 } });

    const voided = await voidUtilityBillService(sess, billId);
    expect(voided.ok).toBe(true);

    // The OLD owner's mirrored proof must be gone — matched by storageKey, not by a
    // (now-stale) owner re-lookup, so it is never orphaned under OWNER_PARTY.
    expect(await db.ownerExpenseProof.count({ where: { organizationId: ORG, category: "supporting" } })).toBe(0);
  });

  // The subject here is the MIRROR (no owner ⇒ nothing to mirror ⇒ no throw), not owner
  // billing. ENABLE_PHASE2_OWNER_BILLING is a separate, later guard that refuses to post
  // charges for an unowned unit at all (OWNER_NOT_ASSIGNED), so with the flag ambient-on —
  // as it is in this repo's api .env — this test failed on that precondition and never
  // reached the assertion it exists for. Pin the flag OFF for the duration rather than
  // depending on the developer's environment, and assert the flag-ON behaviour separately
  // below so BOTH contracts stay covered.
  it("no-owner apartment (owner-billing OFF): charging still succeeds and mirrors nothing", async () => {
    const db = getDb();
    const prev = process.env.ENABLE_PHASE2_OWNER_BILLING;
    delete process.env.ENABLE_PHASE2_OWNER_BILLING;
    try {
      const billId = await billFor(APT_NO_OWNER);
      await attachBillAttachmentsService(sess, billId, [pdf("TNB.pdf")]);

      const charged = await chargeUtilityBillService(sess, billId, {});
      expect(charged.ok).toBe(true);

      expect(await db.ownerExpenseProof.count({ where: { organizationId: ORG } })).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
      else process.env.ENABLE_PHASE2_OWNER_BILLING = prev;
    }
  });

  it("no-owner apartment (owner-billing ON): charging is refused OWNER_NOT_ASSIGNED and still mirrors nothing", async () => {
    const db = getDb();
    const prev = process.env.ENABLE_PHASE2_OWNER_BILLING;
    process.env.ENABLE_PHASE2_OWNER_BILLING = "true";
    try {
      const billId = await billFor(APT_NO_OWNER);
      await attachBillAttachmentsService(sess, billId, [pdf("TNB.pdf")]);

      const charged = await chargeUtilityBillService(sess, billId, {});
      expect(charged.ok).toBe(false);
      if (!charged.ok) expect(charged.error).toBe("OWNER_NOT_ASSIGNED");

      expect(await db.ownerExpenseProof.count({ where: { organizationId: ORG } })).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_PHASE2_OWNER_BILLING;
      else process.env.ENABLE_PHASE2_OWNER_BILLING = prev;
    }
  });
});
