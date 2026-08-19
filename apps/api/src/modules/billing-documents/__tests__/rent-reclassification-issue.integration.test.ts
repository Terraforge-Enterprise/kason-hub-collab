/**
 * Spec 1 Phase 1 — flag-gated classification routing at issuance.
 * Real local Postgres.
 * Run: RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 ENABLE_PHASE2_RENT_RECLASSIFICATION=1 \
 *   npx vitest run src/modules/billing-documents/__tests__/rent-reclassification-issue.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@kason/db";
import { ChargeNeedsClassificationError, issueDocumentsForChargesTx } from "../issue.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

const ORG = "18181818-1818-4181-8181-181818181818";
let actorId = "";
let ownerPartyId = "";
let tenantPartyId = "";
let listingId = "";

async function cleanOrg() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.unitReservation.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Reclass Org", slug: `org-${ORG}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  const actor = await db.user.create({ data: { organizationId: ORG, email: `rc-${ORG}@test.local`, passwordHash: "x", fullName: "Actor", role: "admin", status: "active" } });
  actorId = actor.id;
  const owner = await db.party.create({ data: { organizationId: ORG, partyType: "owner", displayName: "Owner O", status: "active" } });
  ownerPartyId = owner.id;
  const tenant = await db.party.create({ data: { organizationId: ORG, partyType: "tenant", displayName: "Tenant T", status: "active" } });
  tenantPartyId = tenant.id;
  const prop = await db.property.create({ data: { organizationId: ORG, name: "Prop", propertyCode: "PRC", propertyType: "condominium", addressLine1: "1", city: "KL", state: "WP", postalCode: "50000", country: "Malaysia", status: "active", publishStatus: "published", managerId: actorId } });
  const apt = await db.apartment.create({ data: { organizationId: ORG, propertyId: prop.id, unitCode: "A-1", listingMode: "WHOLE", partitionBillingMode: "NO_SUBSIDY", bedrooms: 2, bathrooms: 1, floorArea: 800, floor: 1 } });
  const listing = await db.listing.create({ data: { organizationId: ORG, apartmentId: apt.id, listingType: "apartment", occupancyStatus: "occupied", listingStatus: "unlisted", currency: "MYR", rentalRate: 1200, baseRentAmount: 1200, ownerPartyId: owner.id, photoKeys: [], videoKeys: [] } });
  listingId = listing.id;
  // Legacy rental category (docType debit_note / DEP) — used for the flag-off legacy path AND the LINE category.
  const dep = await db.documentSeries.create({ data: { organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true } });
  await db.chargeCategory.create({ data: { organizationId: ORG, code: "rental", name: "rental", family: "pay_back_landlord", docType: "debit_note", seriesId: dep.id, defaultSstRate: "0", eInvoiceEligible: false, ledgerCategory: "rental_income", isSystem: true, active: true, sortOrder: 1 } });
}

function mkRent(extra: Record<string, unknown>) {
  return getDb().charge.create({
    data: {
      organizationId: ORG, chargeNumber: `RENT-${Math.floor(Math.random() * 1e9)}`, partyId: tenantPartyId,
      chargeType: "rent", status: "posted", postedAt: new Date(), dueDate: new Date("2026-07-31T00:00:00.000Z"),
      amount: "1200.00", currency: "MYR", outstandingAmount: "1200.00", attachmentKeys: [], unitId: listingId,
      billingMonth: new Date("2026-07-01T00:00:00.000Z"), ...extra,
    },
    select: { id: true },
  });
}
async function mintInTx(ids: string[]) { await getDb().$transaction((tx) => issueDocumentsForChargesTx(tx, ids, actorId)); }

dn("issueDocumentsForChargesTx — rent reclassification (Phase 1)", () => {
  beforeEach(async () => { process.env.ENABLE_PHASE2_BILLING_DOCS = "1"; await cleanOrg(); await seed(); });
  afterEach(() => { delete process.env.ENABLE_PHASE2_BILLING_DOCS; delete process.env.ENABLE_PHASE2_RENT_RECLASSIFICATION; });

  it("flag ON: a RENT charge issues an RB RENTAL_INVOICE (invoice / PAYABLE_TO_OWNER / owner set)", async () => {
    process.env.ENABLE_PHASE2_RENT_RECLASSIFICATION = "1";
    const rent = await mkRent({ commercialPurpose: "RENT", fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner" });
    await mintInTx([rent.id]);
    const doc = await getDb().billingDocument.findFirstOrThrow({ where: { organizationId: ORG }, select: { docType: true, documentNumber: true, commercialDocumentType: true, ledgerTreatment: true, principalOwnerId: true, collectedOnBehalfOfOwnerId: true, counterpartyType: true } });
    expect(doc).toMatchObject({ docType: "invoice", commercialDocumentType: "RENTAL_INVOICE", ledgerTreatment: "PAYABLE_TO_OWNER", counterpartyType: "tenant", principalOwnerId: ownerPartyId, collectedOnBehalfOfOwnerId: ownerPartyId });
    expect(doc.documentNumber.startsWith("RB")).toBe(true);
  });

  it("flag OFF: the SAME rent charge issues the legacy DEP debit_note (byte-identical)", async () => {
    const rent = await mkRent({ commercialPurpose: "RENT", fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner" });
    await mintInTx([rent.id]);
    const doc = await getDb().billingDocument.findFirstOrThrow({ where: { organizationId: ORG }, select: { docType: true, documentNumber: true, commercialDocumentType: true } });
    expect(doc.docType).toBe("debit_note");
    expect(doc.documentNumber.startsWith("DEP")).toBe(true);
    expect(doc.commercialDocumentType).toBeNull();
  });

  it("flag ON + missing commercialPurpose: fails closed (throws, aborts posting — no document)", async () => {
    // Fail-closed = the throw aborts the whole posting tx (mint-on-post §4.6); no document is
    // written. The persistent NEEDS_ECONOMIC_CLASSIFICATION marker is deliberately NOT written
    // from inside the posting tx (it would deadlock on the caller-locked charge row); marker
    // population is a safe post-tx follow-up.
    process.env.ENABLE_PHASE2_RENT_RECLASSIFICATION = "1";
    const rent = await mkRent({ fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner" });
    await expect(mintInTx([rent.id])).rejects.toBeInstanceOf(ChargeNeedsClassificationError);
    expect(await getDb().billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it("REGRESSION: fail-closed does NOT deadlock when the charge row is already locked in the tx", async () => {
    // Reproduces the PRODUCTION posting context the earlier test missed: postCharge/auto-draft
    // write-lock the charge row (status:"posted") INSIDE the same tx before minting. The old
    // separate-connection stamp would block on that lock and hang forever; the fix (throw only,
    // no in-tx cross-connection write) throws cleanly. A hang would trip vitest's 5s timeout.
    process.env.ENABLE_PHASE2_RENT_RECLASSIFICATION = "1";
    const rent = await mkRent({ fundedBy: "tenant_funded", revenueRecognition: "third_party_collection", settlementRecipient: "owner" }); // no commercialPurpose → fail closed
    const db = getDb();
    await expect(
      db.$transaction(async (tx) => {
        await tx.charge.update({ where: { id: rent.id }, data: { status: "posted" } }); // row lock, like the posting flows
        await issueDocumentsForChargesTx(tx, [rent.id], actorId);
      }),
    ).rejects.toBeInstanceOf(ChargeNeedsClassificationError);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
