// E2E fixture seed for the Tenant Tracker (M1) Puppeteer suite.
// Run:  npx tsx scripts/seed-e2e-tenant-tracker.ts   (from the repo root)
//
// Creates a deterministic, recognizable fixture in the SAME org the e2e
// logins use (resolved via admin@kaenproperties.com — see SEED-LOGINS.md):
//
//   Property  "E2E-TT Tower" (code E2ETT)
//   ├─ 27 apartments E2E-TT-01 … E2E-TT-27 (1 Master room-listing each)
//   │    → 27 > the page size of 25, so the UI shows "Load more" when
//   │      filtered to this property (pagination scenario).
//   ├─ E2E-TT-01: active tenancy E2E-TT-0001 → party "E2E-TT Tenant Alpha"
//   │    phone 60181239481 (unique last-4 "9481" for the ⌘K phone search),
//   │    IC 990101145566 (masked export must show "••••5566").
//   ├─ E2E-TT-02: active tenancy E2E-TT-0002 → party "E2E-TT Tenant Beta".
//   └─ Party "E2E-TT PIC Agent" (partyType=agent) for the PIC typeahead.
//
// IDEMPOTENT + ADDITIVE: every write is an upsert on a real unique key
// (Property/Apartment/Listing/Tenancy) or a find-or-create by displayName
// (Party has no natural unique). Re-runs never duplicate and NEVER delete
// or modify anything this script did not create. The only "reset" performed
// is clearing the PIC on the fixture's OWN E2E-TT-01 listing so the PIC
// assign→clear e2e scenario starts from a known state.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const rawUrl = process.env.DATABASE_URL ?? "";
// Airtight localhost guard: parse the URL and check the actual hostname — a
// substring regex can be fooled (e.g. a password or path containing
// "@localhost").
let dbHost = "";
try {
  dbHost = new URL(rawUrl).hostname;
} catch {
  // unparseable URL → empty hostname fails the check below
}
if (dbHost !== "localhost" && dbHost !== "127.0.0.1") {
  console.error(
    "REFUSING TO RUN: DATABASE_URL host is not local postgres:",
    rawUrl.replace(/:[^:@/]*@/, ":****@"),
  );
  process.exit(1);
}

const adapter = new PrismaPg({
  connectionString: rawUrl.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, ""),
  ssl: false,
});
const prisma = new PrismaClient({ adapter });

const APT_COUNT = 27; // > page size 25 → "Load more" appears under the property filter

async function findOrCreateParty(
  organizationId: string,
  displayName: string,
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  const existing = await prisma.party.findFirst({
    where: { organizationId, displayName },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.party.create({
    data: { organizationId, displayName, ...data } as never,
    select: { id: true },
  });
}

async function main() {
  const admin = await prisma.user.findFirst({
    where: { email: "admin@kaenproperties.com" },
    select: { organizationId: true },
  });
  if (!admin) {
    console.error("admin@kaenproperties.com not found — run the main seed first (packages/db/prisma/seed.ts).");
    process.exit(1);
  }
  const orgId = admin.organizationId;
  console.log(`Org: ${orgId}`);

  // ── Property ──────────────────────────────────────────────────────────────
  const property = await prisma.property.upsert({
    where: { organizationId_propertyCode: { organizationId: orgId, propertyCode: "E2ETT" } },
    update: {},
    create: {
      organizationId: orgId,
      name: "E2E-TT Tower",
      propertyCode: "E2ETT",
      propertyType: "condominium",
      addressLine1: "1 E2E Test Street",
      city: "Kuala Lumpur",
      state: "W.P. Kuala Lumpur",
      postalCode: "50000",
      country: "Malaysia",
      status: "active",
      publishStatus: "draft",
    },
    select: { id: true },
  });
  console.log(`Property E2E-TT Tower: ${property.id}`);

  // ── Apartments + 1 Master room-listing each ───────────────────────────────
  const listingIds: string[] = [];
  for (let i = 1; i <= APT_COUNT; i++) {
    const unitCode = `E2E-TT-${String(i).padStart(2, "0")}`;
    const apartment = await prisma.apartment.upsert({
      where: {
        organizationId_propertyId_unitCode: {
          organizationId: orgId,
          propertyId: property.id,
          unitCode,
        },
      },
      update: {},
      create: {
        organizationId: orgId,
        propertyId: property.id,
        unitCode,
        listingMode: "WHOLE",
        bedrooms: 1,
        floor: i,
      },
      select: { id: true },
    });
    const listing = await prisma.listing.upsert({
      where: { apartmentId_listingType: { apartmentId: apartment.id, listingType: "Master" } },
      update: {},
      create: {
        organizationId: orgId,
        apartmentId: apartment.id,
        listingType: "Master",
        unitKind: "room",
        occupancyStatus: i <= 2 ? "occupied" : "vacant",
        listingStatus: "listed",
        currency: "MYR",
        rentalRate: 1200,
        baseRentAmount: 1200,
      },
      select: { id: true },
    });
    listingIds.push(listing.id);
  }
  console.log(`Apartments + listings: ${APT_COUNT}`);

  // Reset the PIC on the fixture's own E2E-TT-01 listing only — the PIC e2e
  // scenario (assign → clear) needs a deterministic "Unassigned" start.
  await prisma.listing.update({
    where: { id: listingIds[0] },
    data: { inChargePartyId: null, inChargeName: null },
  });

  // ── Parties ───────────────────────────────────────────────────────────────
  const alpha = await findOrCreateParty(orgId, "E2E-TT Tenant Alpha", {
    partyType: "tenant",
    legalName: "E2E-TT Tenant Alpha",
    primaryEmail: "e2e.tt.alpha@example.com",
    primaryPhone: "60181239481", // last-4 "9481" — unique suffix for ⌘K search
    status: "active",
    idType: "NRIC",
    idNumber: "990101145566", // masked form "••••5566"
    gender: "female",
    nationality: "Malaysian",
  });
  const beta = await findOrCreateParty(orgId, "E2E-TT Tenant Beta", {
    partyType: "tenant",
    legalName: "E2E-TT Tenant Beta",
    primaryEmail: "e2e.tt.beta@example.com",
    primaryPhone: "60181239482",
    status: "active",
    idType: "NRIC",
    idNumber: "880202077788",
    gender: "male",
    nationality: "Malaysian",
  });
  const picAgent = await findOrCreateParty(orgId, "E2E-TT PIC Agent", {
    partyType: "agent",
    legalName: "E2E-TT PIC Agent",
    primaryEmail: "e2e.tt.pic@example.com",
    primaryPhone: "60181239483",
    status: "active",
    agentLevel: "new_agent",
  });
  console.log(`Parties: alpha=${alpha.id} beta=${beta.id} pic=${picAgent.id}`);

  // ── Tenancies (active) ────────────────────────────────────────────────────
  const tenancyDefs = [
    { code: "E2E-TT-0001", unitId: listingIds[0], partyId: alpha.id, rent: 1234 },
    { code: "E2E-TT-0002", unitId: listingIds[1], partyId: beta.id, rent: 999 },
  ];
  for (const t of tenancyDefs) {
    const tenancy = await prisma.tenancy.upsert({
      where: { organizationId_tenancyCode: { organizationId: orgId, tenancyCode: t.code } },
      update: {},
      create: {
        organizationId: orgId,
        propertyId: property.id,
        unitId: t.unitId,
        tenantPartyId: t.partyId,
        tenancyCode: t.code,
        status: "active",
        billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-12-31T00:00:00Z"),
        monthlyRentAmount: t.rent,
        termMonths: 12,
        numberOfPax: 2,
        agentLabel: "E2E-TT",
        accessCardNo: "E2E-AC-01",
        noticePeriodDays: 30,
      },
      select: { id: true },
    });
    console.log(`Tenancy ${t.code}: ${tenancy.id}`);
  }

  console.log("E2E tenant-tracker fixture ready.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
