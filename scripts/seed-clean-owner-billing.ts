// Clean dev seed for the Owner-Billing loop.
// ---------------------------------------------------------------------------
// Replaces the messy local `kason_hub_dev` data with a small, known-good,
// BILLING-READY dataset so the owner-billing loop can be exercised cleanly,
// starting from "post the utility bill" → tenant charges → tenant pays →
// owner statement → owner payout. Spec:
//   docs/superpowers/specs/2026-06-27-clean-dev-seed-design.md
//
// Seeds ONLY the login + structural rows the owner-billing path reads; it
// posts NO billing transactions (zero UnitUtilityBill / Charge / Payment /
// Deposit / OwnerLedgerEntry / owner-statement Invoice). Every screen starts
// at zero — the user posts the first bill and drives the loop.
//
// "Billing-ready" = exactly the config the post-bill → charge → statement
// path reads is present:
//   • Apartment.listingMode + Apartment.partitionBillingMode      (meter/service.buildComputeInputs)
//   • Listing.ownerPartyId on every room                          (owner resolution)
//   • An ACTIVE Tenancy per room with numberOfPax > 0             (charge gate: ACTIVE_TENANCY_NO_PAX)
//   • Tenancy → UnitReservation.agreedMonthlyRent                 (post-monthly-rent rent source §12)
//   • AircondMeter per room (the aircond submeter)               (aircond charge path)
//   • ManagementFeeConfig for the owner (10% + 8% SST)           (owner statement / owner-ledger sync)
//   • UtilityBillingConfig (org subsidyPerPax singleton)         (SUBSIDY-mode pool)
//
// IDEMPOTENT + re-run safe: every row is upserted on a stable key (natural
// unique where one exists, else a deterministic UUIDv5 id). Re-running never
// duplicates.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost / 127.0.0.1
// (mirrors scripts/seed-e2e-owner-billing.ts). NOTE: this guard rejects
// remote hosts only — it deliberately does NOT distinguish kason_hub_dev from
// a scratch DB. Pass the DATABASE_URL of the DB you intend to seed.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import crypto from "node:crypto";

// ── Airtight localhost guard ────────────────────────────────────────────────
const rawUrl = process.env.DATABASE_URL ?? "";
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/** scrypt password hash — identical format to packages/db/prisma/seed.ts. */
async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

/** Deterministic UUIDv5 from a stable name → re-runs reuse the same id. */
const NAMESPACE = "6f1a2c00-0000-4000-8000-0000000000aa";
function sid(name: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const h = crypto.createHash("sha1").update(ns).update(name).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function d(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

// ── Stable ids ──────────────────────────────────────────────────────────────
const ID = {
  org: sid("org:kaen-clean"),
  adminUser: sid("user:admin"),
  owner: sid("party:owner:razak"),
  ownerUser: sid("user:owner:razak"),
  mfc: sid("mgmtfee:razak"),
  ubc: sid("utilitybillingconfig"),
  prop: sid("property:kaen"),
  apt1902: sid("apt:A-19-02"),
  apt1004: sid("apt:A-10-04"),
};

// Partition rooms of A-19-02 (PARTITIONED / NO_SUBSIDY) + the whole unit A-10-04.
// Each maps to one tenant. listingType is the room/whole-unit discriminator and
// is the @@unique(apartmentId, listingType) key — it never affects the billing math.
type UnitDef = {
  key: string;
  apartmentId: string;
  unitCode: string;
  listingType: string;
  roomLabel: string;
  rent: number;
  pax: number;
  tenantIdx: number;
  listingId: string;
};
const UNITS: UnitDef[] = [
  { key: "a1902-master", apartmentId: ID.apt1902, unitCode: "A-19-02", listingType: "Master", roomLabel: "Room A", rent: 1500, pax: 2, tenantIdx: 1, listingId: sid("listing:A-19-02:Master") },
  { key: "a1902-medium", apartmentId: ID.apt1902, unitCode: "A-19-02", listingType: "Medium", roomLabel: "Room B", rent: 1100, pax: 1, tenantIdx: 2, listingId: sid("listing:A-19-02:Medium") },
  { key: "a1902-small", apartmentId: ID.apt1902, unitCode: "A-19-02", listingType: "Small", roomLabel: "Room C", rent: 800, pax: 1, tenantIdx: 3, listingId: sid("listing:A-19-02:Small") },
  { key: "a1004-whole", apartmentId: ID.apt1004, unitCode: "A-10-04", listingType: "apartment", roomLabel: "Whole unit", rent: 2200, pax: 3, tenantIdx: 4, listingId: sid("listing:A-10-04:apartment") },
];

const TENANTS = [
  { idx: 1, name: "Ahmad Faizal bin Ismail", phone: "60130000001", ic: "880312-10-1001" },
  { idx: 2, name: "Siti Aminah binti Yusof", phone: "60130000002", ic: "910725-14-1002" },
  { idx: 3, name: "Rajesh a/l Kumar", phone: "60130000003", ic: "850918-08-1003" },
  { idx: 4, name: "Tan Wei Ming", phone: "60130000004", ic: "930405-10-1004" },
];
const tenantPartyId = (idx: number) => sid(`party:tenant:${idx}`);
const tenantUserId = (idx: number) => sid(`user:tenant:${idx}`);
const tenantEmail = (idx: number) => `tenant${idx}@kaen.test`;

// ── Main seed ─────────────────────────────────────────────────────────────
async function main() {
  const adminHash = await hashPassword("admin123");
  const ownerHash = await hashPassword("owner123");
  const tenantHash = await hashPassword("tenant123");

  // 1. Organization (upsert on slug) ----------------------------------------
  console.log("Organization...");
  await prisma.organization.upsert({
    where: { slug: "kaen-clean" },
    update: { name: "KAEN Properties Sdn Bhd", managementFeePercent: 10 },
    create: {
      id: ID.org,
      name: "KAEN Properties Sdn Bhd",
      slug: "kaen-clean",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "starter",
      managementFeePercent: 10,
    },
  });

  // 2. Admin user + role (upsert on org+email) ------------------------------
  console.log("Admin user...");
  await prisma.user.upsert({
    where: { organizationId_email: { organizationId: ID.org, email: "admin@kaenproperties.com" } },
    update: { passwordHash: adminHash, status: "active", role: "admin", userType: "operator" },
    create: {
      id: ID.adminUser,
      organizationId: ID.org,
      email: "admin@kaenproperties.com",
      phone: "60123456789",
      fullName: "KAEN Admin",
      passwordHash: adminHash,
      status: "active",
      role: "admin",
      userType: "operator",
      emailVerified: true,
    },
  });
  await prisma.roleAssignment.upsert({
    where: { id: sid("ra:admin") },
    update: {},
    create: { id: sid("ra:admin"), organizationId: ID.org, userId: ID.adminUser, role: "admin", scopeType: "organization" },
  });

  // 3. Org utility-billing config (subsidyPerPax singleton) -----------------
  console.log("UtilityBillingConfig...");
  await prisma.utilityBillingConfig.upsert({
    where: { organizationId: ID.org },
    update: { subsidyPerPax: 50, isActive: true },
    create: { id: ID.ubc, organizationId: ID.org, subsidyPerPax: 50, isActive: true },
  });

  // 4. Owner: Party + role + portal user ------------------------------------
  console.log("Owner (Dato' Razak)...");
  await prisma.party.upsert({
    where: { id: ID.owner },
    update: { displayName: "Dato' Razak bin Abdullah", primaryEmail: "razak@gmail.com", status: "active" },
    create: {
      id: ID.owner,
      organizationId: ID.org,
      partyType: "owner",
      displayName: "Dato' Razak bin Abdullah",
      legalName: "Razak bin Abdullah",
      primaryEmail: "razak@gmail.com",
      primaryPhone: "60172345678",
      status: "active",
      idType: "NRIC",
      idNumber: "650415-10-5533",
      nationality: "Malaysian",
      bankName: "Maybank",
      bankAccountHolder: "Razak bin Abdullah",
      bankAccountNumber: "1141-2233-4455",
    },
  });
  await prisma.partyRole.upsert({
    where: { id: sid("pr:owner") },
    update: {},
    create: { id: sid("pr:owner"), organizationId: ID.org, partyId: ID.owner, roleType: "owner", status: "active", effectiveFrom: d("2024-01-01") },
  });
  await prisma.user.upsert({
    where: { organizationId_email: { organizationId: ID.org, email: "razak@gmail.com" } },
    update: { passwordHash: ownerHash, userType: "owner", partyId: ID.owner, status: "active" },
    create: {
      id: ID.ownerUser,
      organizationId: ID.org,
      email: "razak@gmail.com",
      phone: "60172345678",
      fullName: "Dato' Razak bin Abdullah",
      passwordHash: ownerHash,
      status: "active",
      role: "viewer",
      userType: "owner",
      partyId: ID.owner,
      emailVerified: true,
    },
  });

  // 5. Owner management-fee config: 10% + 8% SST ----------------------------
  console.log("ManagementFeeConfig (10% + 8% SST)...");
  await prisma.managementFeeConfig.upsert({
    where: { id: ID.mfc },
    update: { feeType: "percent", feeValue: 10, sstPercent: 8, cleaningAutoBill: 100, isActive: true },
    create: {
      id: ID.mfc,
      organizationId: ID.org,
      ownerPartyId: ID.owner,
      propertyId: null, // applies to all of the owner's properties
      feeType: "percent",
      feeValue: 10,
      capAmount: null,
      sstPercent: 8,
      cleaningAutoBill: 100,
      isActive: true,
      effectiveFrom: d("2024-01-01"),
    },
  });

  // 6. Property (hosts both apartments) -------------------------------------
  console.log("Property...");
  await prisma.property.upsert({
    where: { organizationId_propertyCode: { organizationId: ID.org, propertyCode: "KAEN" } },
    update: { name: "KAEN Residence", status: "active", publishStatus: "published" },
    create: {
      id: ID.prop,
      organizationId: ID.org,
      name: "KAEN Residence",
      propertyCode: "KAEN",
      propertyType: "condominium",
      addressLine1: "Jalan KAEN 1",
      addressLine2: "Setapak",
      city: "Kuala Lumpur",
      state: "W.P. Kuala Lumpur",
      postalCode: "53300",
      country: "Malaysia",
      status: "active",
      publishStatus: "published",
      managerId: ID.adminUser,
    },
  });

  // 7. Apartment A-19-02 (PARTITIONED / NO_SUBSIDY) -------------------------
  console.log("Apartment A-19-02 (PARTITIONED)...");
  await prisma.apartment.upsert({
    where: { organizationId_propertyId_unitCode: { organizationId: ID.org, propertyId: ID.prop, unitCode: "A-19-02" } },
    update: { listingMode: "PARTITIONED", partitionBillingMode: "NO_SUBSIDY" },
    create: {
      id: ID.apt1902,
      organizationId: ID.org,
      propertyId: ID.prop,
      unitCode: "A-19-02",
      listingMode: "PARTITIONED",
      partitionBillingMode: "NO_SUBSIDY",
      bedrooms: 3,
      bathrooms: 2,
      floorArea: 1000,
      floor: 19,
    },
  });

  // 8. Apartment A-10-04 (WHOLE) --------------------------------------------
  console.log("Apartment A-10-04 (WHOLE)...");
  await prisma.apartment.upsert({
    where: { organizationId_propertyId_unitCode: { organizationId: ID.org, propertyId: ID.prop, unitCode: "A-10-04" } },
    update: { listingMode: "WHOLE", partitionBillingMode: "NO_SUBSIDY" },
    create: {
      id: ID.apt1004,
      organizationId: ID.org,
      propertyId: ID.prop,
      unitCode: "A-10-04",
      listingMode: "WHOLE",
      partitionBillingMode: "NO_SUBSIDY", // inert for WHOLE; single tenant bears all
      bedrooms: 2,
      bathrooms: 1,
      floorArea: 850,
      floor: 10,
    },
  });

  // 9. Listings + aircond submeters (one per room/whole-unit) ---------------
  console.log("Listings (rooms) + aircond submeters...");
  for (const u of UNITS) {
    await prisma.listing.upsert({
      where: { apartmentId_listingType: { apartmentId: u.apartmentId, listingType: u.listingType } },
      update: { ownerPartyId: ID.owner, occupancyStatus: "occupied", rentalRate: u.rent },
      create: {
        id: u.listingId,
        organizationId: ID.org,
        apartmentId: u.apartmentId,
        listingType: u.listingType,
        occupancyStatus: "occupied",
        listingStatus: "unlisted",
        currency: "MYR",
        rentalRate: u.rent,
        baseRentAmount: u.rent,
        ownerPartyId: ID.owner,
        photoKeys: [],
        videoKeys: [],
      },
    });
    // Aircond submeter for the room (the "aircond submeter" config the spec wants).
    await prisma.aircondMeter.upsert({
      where: { organizationId_unitId: { organizationId: ID.org, unitId: u.listingId } },
      update: { isActive: true, ratePerKwh: "0.6000" },
      create: {
        id: sid(`meter:${u.listingId}`),
        organizationId: ID.org,
        unitId: u.listingId,
        meterNumber: `MTR-${u.unitCode}-${u.listingType}`,
        ratePerKwh: "0.6000",
        isActive: true,
      },
    });
  }

  // 10. Tenants: Party + role + portal user ---------------------------------
  console.log("Tenants (4)...");
  for (const t of TENANTS) {
    await prisma.party.upsert({
      where: { id: tenantPartyId(t.idx) },
      update: { displayName: t.name, status: "active" },
      create: {
        id: tenantPartyId(t.idx),
        organizationId: ID.org,
        partyType: "tenant",
        displayName: t.name,
        legalName: t.name,
        primaryEmail: tenantEmail(t.idx),
        primaryPhone: t.phone,
        status: "active",
        idType: "NRIC",
        idNumber: t.ic,
        nationality: "Malaysian",
      },
    });
    await prisma.partyRole.upsert({
      where: { id: sid(`pr:tenant:${t.idx}`) },
      update: {},
      create: { id: sid(`pr:tenant:${t.idx}`), organizationId: ID.org, partyId: tenantPartyId(t.idx), roleType: "tenant", status: "active", effectiveFrom: d("2026-01-01") },
    });
    await prisma.user.upsert({
      where: { organizationId_email: { organizationId: ID.org, email: tenantEmail(t.idx) } },
      update: { passwordHash: tenantHash, userType: "tenant", partyId: tenantPartyId(t.idx), status: "active" },
      create: {
        id: tenantUserId(t.idx),
        organizationId: ID.org,
        email: tenantEmail(t.idx),
        phone: t.phone,
        fullName: t.name,
        passwordHash: tenantHash,
        status: "active",
        role: "viewer",
        userType: "tenant",
        partyId: tenantPartyId(t.idx),
        emailVerified: true,
      },
    });
  }

  // 11. Reservations (rent source) + active tenancies (numberOfPax) ---------
  // Reservation first (Tenancy.reservationId FK is unique). agreedMonthlyRent is
  // the canonical rent source the post-bill path reads (post-monthly-rent §12).
  console.log("Reservations + tenancies...");
  for (const u of UNITS) {
    const resId = sid(`reservation:${u.key}`);
    const ref = `RSV-CLEAN-${String(u.tenantIdx).padStart(3, "0")}`;
    await prisma.unitReservation.upsert({
      where: { organizationId_referenceCode: { organizationId: ID.org, referenceCode: ref } },
      update: { agreedMonthlyRent: u.rent, unitId: u.listingId },
      create: {
        id: resId,
        organizationId: ID.org,
        referenceCode: ref,
        status: "completed",
        issuedByPartyId: ID.owner, // any valid Party satisfies the issuer FK
        expiresAt: d("2026-12-31"),
        publicToken: sid(`token:${u.key}`),
        propertyId: ID.prop,
        unitId: u.listingId,
        proposedMoveIn: d("2026-01-01"),
        reservationDeposit: 500,
        documentationFee: 200,
        rentalDeposit: u.rent,
        utilityDeposit: Math.round(u.rent * 0.5),
        accessCardDeposit: 100,
        agreedMonthlyRent: u.rent, // ← canonical rent source for the bill post
      },
    });

    const tenancyCode = `TEN-CLEAN-${String(u.tenantIdx).padStart(3, "0")}`;
    await prisma.tenancy.upsert({
      where: { organizationId_tenancyCode: { organizationId: ID.org, tenancyCode } },
      update: {
        status: "active",
        billingStatus: "current",
        numberOfPax: u.pax, // ← charge gate: paxless active rooms are blocked (ACTIVE_TENANCY_NO_PAX)
        monthlyRentAmount: u.rent,
        reservationId: resId,
      },
      create: {
        id: sid(`tenancy:${u.key}`),
        organizationId: ID.org,
        propertyId: ID.prop,
        unitId: u.listingId,
        tenantPartyId: tenantPartyId(u.tenantIdx),
        tenancyCode,
        status: "active",
        billingStatus: "current",
        startDate: d("2026-01-01"),
        endDate: d("2026-12-31"),
        monthlyRentAmount: u.rent,
        depositAmount: u.rent * 2,
        termMonths: 12,
        numberOfPax: u.pax, // ← REQUIRED for the bill to charge (per-pax pool denominator)
        noticePeriodDays: 30,
        reservationId: resId,
      },
    });
  }

  // ── Summary + login map ────────────────────────────────────────────────
  console.log("\nClean owner-billing seed complete.\n");
  console.log("Logins");
  console.log("  Admin   admin@kaenproperties.com / admin123");
  console.log("  Owner   razak@gmail.com          / owner123   (Dato' Razak — owns both apartments)");
  for (const t of TENANTS) {
    console.log(`  Tenant  ${tenantEmail(t.idx).padEnd(24)} / tenant123  (${t.name})`);
  }
  console.log("\nApartment → room → tenant map");
  console.log("  A-19-02  PARTITIONED / NO_SUBSIDY  (aircond submeter per room; owner = Dato' Razak)");
  for (const u of UNITS.filter((x) => x.unitCode === "A-19-02")) {
    const t = TENANTS[u.tenantIdx - 1];
    console.log(`    ${u.roomLabel} (${u.listingType.padEnd(7)})  rent RM${String(u.rent).padEnd(5)} pax ${u.pax}  → ${t.name} <${tenantEmail(u.tenantIdx)}>`);
  }
  console.log("  A-10-04  WHOLE                      (single tenant bears all; owner = Dato' Razak)");
  for (const u of UNITS.filter((x) => x.unitCode === "A-10-04")) {
    const t = TENANTS[u.tenantIdx - 1];
    console.log(`    ${u.roomLabel} (${u.listingType.padEnd(7)})  rent RM${String(u.rent).padEnd(5)} pax ${u.pax}  → ${t.name} <${tenantEmail(u.tenantIdx)}>`);
  }
  console.log("\nNo billing transactions seeded (0 UnitUtilityBill / Charge / Payment / Deposit / OwnerLedgerEntry / owner-statement Invoice).");
  console.log("Post the first UnitUtilityBill for A-19-02 to start the loop.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
