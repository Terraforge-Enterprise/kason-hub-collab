// apps/api/src/modules/meter/__tests__/owner-resolvers.integration.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { findApartmentOwner, findListingOwner } from "../repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c1100000-0000-4000-8000-000000000001";
const PROP = "c1100000-0000-4000-8000-000000000003";
const APT = "c1100000-0000-4000-8000-000000000004";
const ROOM = "c1100000-0000-4000-8000-000000000005";
const OWNER = "c1100000-0000-4000-8000-000000000006";

async function cleanup() {
  const db = getDb();
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}
async function seed(ownerPartyId: string | null) {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "T1", slug: "t1", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-1", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-1", listingMode: "PARTITIONED" } });
  if (ownerPartyId) await db.party.create({ data: { id: ownerPartyId, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "room", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId } });
}

dn("owner resolvers (integration)", () => {
  beforeEach(cleanup);

  it("findListingOwner returns the listing's owner + its apartment's propertyId", async () => {
    await seed(OWNER);
    expect(await findListingOwner(getDb(), ORG, ROOM)).toEqual({ ownerPartyId: OWNER, propertyId: PROP });
  });

  it("findApartmentOwner returns owner:null but the propertyId when no listing has an owner", async () => {
    await seed(null);
    expect(await findApartmentOwner(getDb(), ORG, APT)).toEqual({ ownerPartyId: null, propertyId: PROP });
  });

  it("findListingOwner returns null for an unknown / cross-org listing id", async () => {
    await seed(OWNER);
    expect(await findListingOwner(getDb(), ORG, "c1100000-0000-4000-8000-0000000000ff")).toBeNull();
  });
});
