/**
 * Integration tests for reservation-backed documents in the tenant portal.
 *
 * A tenant signs their reservation; the API renders and stores the signed PDF at
 * `reservations/<id>/signed.pdf` and records the key on
 * `UnitReservation.signedPdfKey`. The reservation is linked to the tenant's Party
 * via `tenantPartyId` (the same link that draws the admin list's "Has reservation"
 * tag). Their identification scans live on `UnitReservationDocument`.
 *
 * None of it reached the portal. GET /portal-api/documents read ONLY
 * `DocumentLink where linkedEntityType = "tenancy"` — a store nothing in the
 * application writes (its sole writer is packages/db/prisma/seed.ts) — so the
 * Documents tab was structurally empty for every real tenant.
 *
 * THE INVARIANT THESE TESTS EXIST TO HOLD: listed ⟺ downloadable. The list and
 * the /files ownership check must resolve through the SAME predicate; a row that
 * lists but 404s is a dead end, and a key that downloads without listing is a leak.
 *
 * Hits a real LOCAL Postgres (RUN_INTEGRATION=1). Run:
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/portal/documents/__tests__/portal.reservation-documents.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import { getDb } from "@kason/db";
import { listDocuments, verifyFileOwnership } from "../portal.documents.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

type Seeded = {
  orgId: string;
  tenantPartyId: string;
  reservationId: string;
  listingId: string;
  propertyId: string;
};

/** Disjoint org per test — no shared fixtures, no cross-file teardown races. */
async function seedOrgWithTenant(): Promise<Seeded> {
  const db = getDb();
  const orgId = crypto.randomUUID();
  const tenantPartyId = crypto.randomUUID();
  const agentPartyId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const apartmentId = crypto.randomUUID();
  const listingId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();

  await db.organization.create({
    data: {
      id: orgId, name: "RES Org", slug: `res-org-${orgId}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: tenantPartyId, organizationId: orgId, displayName: "TEST Tenant", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: agentPartyId, organizationId: orgId, displayName: "Issuing Agent", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: propertyId, organizationId: orgId, name: "4 Aug", propertyCode: `RES-${propertyId.slice(0, 6)}`,
      propertyType: "apartment", addressLine1: "1 Res St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: apartmentId, organizationId: orgId, propertyId, unitCode: "A-11-22", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: listingId, organizationId: orgId, apartmentId, listingType: "whole",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR",
    },
  });
  await db.unitReservation.create({
    data: {
      id: reservationId, organizationId: orgId, referenceCode: "RESERVATION-2026-001",
      status: "signed", issuedByPartyId: agentPartyId, expiresAt: new Date("2026-08-12"),
      publicToken: crypto.randomUUID().replace(/-/g, "").slice(0, 22),
      propertyId, unitId: listingId, proposedMoveIn: new Date("2026-08-05"),
      reservationDeposit: "500.00", documentationFee: "200.00", rentalDeposit: "1000.00",
      utilityDeposit: "500.00", accessCardDeposit: "100.00",
      applicantFullName: "TEST", applicantEmail: "test@gmail.com",
      tenantPartyId, signedAt: new Date("2026-08-05"),
      signedPdfKey: `reservations/${reservationId}/signed.pdf`,
    },
  });

  return { orgId, tenantPartyId, reservationId, listingId, propertyId };
}

async function addTenancy(s: Seeded) {
  await getDb().tenancy.create({
    data: {
      id: crypto.randomUUID(), organizationId: s.orgId, propertyId: s.propertyId,
      unitId: s.listingId, tenantPartyId: s.tenantPartyId, startDate: new Date("2026-08-05"),
      monthlyRentAmount: "1500.00", status: "active", billingStatus: "active",
      tenancyCode: `RES-TC-${crypto.randomUUID().slice(0, 8)}`,
    },
  });
}

async function addIdDoc(s: Seeded, kind: string) {
  await getDb().unitReservationDocument.create({
    data: {
      id: crypto.randomUUID(), organizationId: s.orgId, reservationId: s.reservationId,
      kind, fileKey: `reservations/${s.orgId}/${s.reservationId}/id-docs/${kind}`,
      filename: `${kind}.jpg`,
    },
  });
}

dn("tenant portal Documents — reservation-backed files", () => {
  it("lists the SIGNED reservation PDF for the tenant it belongs to", async () => {
    const s = await seedOrgWithTenant();
    await addTenancy(s);

    const docs = await listDocuments({ partyId: s.tenantPartyId, orgId: s.orgId });

    const signed = docs.find((d) => d.storageKey === `reservations/${s.reservationId}/signed.pdf`);
    expect(signed).toBeDefined();
    // Must classify under the page's "Agreements" chip (classifyDoc matches "agreement"),
    // and must NOT claim to be a tenancy agreement — it is the reservation agreement.
    expect(signed!.label?.toLowerCase()).toContain("agreement");
    expect(signed!.label?.toLowerCase()).not.toContain("tenancy agreement");
    expect(signed!.label).toContain("RESERVATION-2026-001");
  });

  it("lists the tenant's OWN identification scans", async () => {
    const s = await seedOrgWithTenant();
    await addTenancy(s);
    await addIdDoc(s, "ic_front");
    await addIdDoc(s, "ic_back");

    const docs = await listDocuments({ partyId: s.tenantPartyId, orgId: s.orgId });

    const idKeys = docs.map((d) => d.storageKey).filter((k) => k.includes("/id-docs/"));
    expect(idKeys).toHaveLength(2);
    expect(idKeys.some((k) => k.endsWith("ic_front"))).toBe(true);
    expect(idKeys.some((k) => k.endsWith("ic_back"))).toBe(true);
  });

  it("shows the reservation even when the tenant has NO tenancy row yet", async () => {
    const s = await seedOrgWithTenant(); // deliberately no addTenancy

    const docs = await listDocuments({ partyId: s.tenantPartyId, orgId: s.orgId });

    expect(docs.some((d) => d.storageKey === `reservations/${s.reservationId}/signed.pdf`)).toBe(true);
  });

  it("an UNSIGNED reservation contributes no PDF row (nothing to show yet)", async () => {
    const s = await seedOrgWithTenant();
    await addTenancy(s);
    await getDb().unitReservation.update({
      where: { id: s.reservationId },
      data: { status: "pending_customer", signedAt: null, signedPdfKey: null },
    });

    const docs = await listDocuments({ partyId: s.tenantPartyId, orgId: s.orgId });

    expect(docs.some((d) => d.storageKey.endsWith("/signed.pdf"))).toBe(false);
  });

  it("INVARIANT — every listed row is downloadable through the /files ownership check", async () => {
    const s = await seedOrgWithTenant();
    await addTenancy(s);
    await addIdDoc(s, "passport_front");

    const docs = await listDocuments({ partyId: s.tenantPartyId, orgId: s.orgId });
    expect(docs.length).toBeGreaterThan(0);

    for (const d of docs) {
      const owned = await verifyFileOwnership({ partyId: s.tenantPartyId, orgId: s.orgId }, d.storageKey);
      expect(owned, `listed but not downloadable: ${d.storageKey}`).not.toBeNull();
    }
  });

  it("AUTHZ — another tenant can neither see nor download these files", async () => {
    const s = await seedOrgWithTenant();
    await addTenancy(s);
    await addIdDoc(s, "ic_front");

    const stranger = crypto.randomUUID();
    await getDb().party.create({
      data: { id: stranger, organizationId: s.orgId, displayName: "Stranger", partyType: "individual", status: "active" },
    });

    const docs = await listDocuments({ partyId: stranger, orgId: s.orgId });
    expect(docs).toEqual([]);

    for (const key of [
      `reservations/${s.reservationId}/signed.pdf`,
      `reservations/${s.orgId}/${s.reservationId}/id-docs/ic_front`,
    ]) {
      const owned = await verifyFileOwnership({ partyId: stranger, orgId: s.orgId }, key);
      expect(owned, `leaked to a stranger: ${key}`).toBeNull();
    }
  });

  it("AUTHZ — the right partyId in the WRONG org gets nothing (org scoping holds)", async () => {
    const s = await seedOrgWithTenant();
    await addTenancy(s);
    const otherOrg = crypto.randomUUID();
    await getDb().organization.create({
      data: {
        id: otherOrg, name: "Other Org", slug: `other-org-${otherOrg}`, status: "active",
        defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
      },
    });

    const docs = await listDocuments({ partyId: s.tenantPartyId, orgId: otherOrg });
    expect(docs).toEqual([]);

    const owned = await verifyFileOwnership(
      { partyId: s.tenantPartyId, orgId: otherOrg },
      `reservations/${s.reservationId}/signed.pdf`,
    );
    expect(owned).toBeNull();
  });
});
