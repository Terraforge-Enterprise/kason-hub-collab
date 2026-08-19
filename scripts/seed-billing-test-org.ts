// Clean, isolated BILLING TEST org — a pristine sandbox to re-verify the billing
// loop end-to-end (auto-draft rent → approve → invoices, meter utilities → post →
// itemized invoice, pay-now + slip, owner statement/ledger).
// ---------------------------------------------------------------------------
// Forked from scripts/seed-clean-owner-billing.ts with three deliberate changes:
//   1. A DEDICATED org (slug "kaen-billing-test") + a UNIQUE admin email
//      (admin@billing-test.local). The admin login resolves by EMAIL ONLY and is
//      unordered (auth.repository.findActiveUserByEmail) — reusing an email that
//      exists in another org makes "which org do I land in" a coin flip. A unique
//      email guarantees this login always lands in THIS clean org, whose per-query
//      organizationId hard-filter then shows ONLY this org's zeroed data.
//   2. An active DraftConfig ("draft invoice settings") so the auto-draft run works
//      out of the box, plus the ChargeCategory/DocumentSeries registry so documents
//      mint deterministically from step 1 (no dependency on hitting a UI GET first).
//   3. Round-number rents (1500 / 1200 / 1000 / 2000) for easy mental math.
//
// Seeds ONLY structural + config rows the billing path reads; posts ZERO billing
// transactions (no Charge / BillingDocument / Payment / UnitUtilityBill / ledger).
// Every screen starts at zero — you drive the loop.
//
// IDEMPOTENT: every row upserts on a stable key (natural unique, else a
// deterministic UUIDv5). Re-running never duplicates.
//
// --reset : first tears down ONLY this org's billing TRANSACTIONAL data (the
//   charges/documents/payments/readings you create while testing), scoped to this
//   org's id, then re-seeds the structure — a safe "back to zero" between test runs
//   that touches nothing outside this org. Structural config (org/users/parties/
//   property/units/tenancies/meters/mgmt-fee/draft-config) is preserved.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost / 127.0.0.1.

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { SEED_DOCUMENT_SERIES, SEED_CHARGE_CATEGORIES } from "@kason/shared";
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

const RESET = process.argv.includes("--reset");

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

/** Deterministic UUIDv5 from a stable name → re-runs reuse the same id. A DISTINCT
 * namespace from seed-clean-owner-billing (…aa) so this org's ids never collide. */
const NAMESPACE = "6f1a2c00-0000-4000-8000-0000000000bb";
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

// ── Identity ─────────────────────────────────────────────────────────────────
const SLUG = "kaen-billing-test";
const ADMIN_EMAIL = "admin@billing-test.local";
const OWNER_EMAIL = "owner@billing-test.local";
const tenantEmail = (idx: number) => `tenant${idx}@billing-test.local`;

const ID = {
  org: sid("org"),
  adminUser: sid("user:admin"),
  owner: sid("party:owner"),
  ownerUser: sid("user:owner"),
  mfc: sid("mgmtfee:owner"),
  ubc: sid("utilitybillingconfig"),
  draftConfig: sid("draftconfig"),
  prop: sid("property:kaen"),
  apt1902: sid("apt:A-19-02"),
  apt1004: sid("apt:A-10-04"),
};

// A-19-02 PARTITIONED (3 rooms, per-room utility split) + A-10-04 WHOLE (one tenant).
type UnitDef = {
  key: string; apartmentId: string; unitCode: string; listingType: string;
  roomLabel: string; rent: number; pax: number; tenantIdx: number; listingId: string;
};
const UNITS: UnitDef[] = [
  { key: "a1902-master", apartmentId: ID.apt1902, unitCode: "A-19-02", listingType: "Master", roomLabel: "Room A", rent: 1500, pax: 2, tenantIdx: 1, listingId: sid("listing:A-19-02:Master") },
  { key: "a1902-medium", apartmentId: ID.apt1902, unitCode: "A-19-02", listingType: "Medium", roomLabel: "Room B", rent: 1200, pax: 1, tenantIdx: 2, listingId: sid("listing:A-19-02:Medium") },
  { key: "a1902-small",  apartmentId: ID.apt1902, unitCode: "A-19-02", listingType: "Small",  roomLabel: "Room C", rent: 1000, pax: 1, tenantIdx: 3, listingId: sid("listing:A-19-02:Small") },
  { key: "a1004-whole",  apartmentId: ID.apt1004, unitCode: "A-10-04", listingType: "apartment", roomLabel: "Whole unit", rent: 2000, pax: 3, tenantIdx: 4, listingId: sid("listing:A-10-04:apartment") },
];

const TENANTS = [
  { idx: 1, name: "Ahmad Faizal bin Ismail", phone: "60130000001", ic: "880312-10-1001" },
  { idx: 2, name: "Siti Aminah binti Yusof", phone: "60130000002", ic: "910725-14-1002" },
  { idx: 3, name: "Rajesh a/l Kumar",        phone: "60130000003", ic: "850918-08-1003" },
  { idx: 4, name: "Tan Wei Ming",            phone: "60130000004", ic: "930405-10-1004" },
];
const tenantPartyId = (idx: number) => sid(`party:tenant:${idx}`);
const tenantUserId = (idx: number) => sid(`user:tenant:${idx}`);

// ── ChargeCategory / DocumentSeries registry (mirrors ensureChargeCategorySeeds) ─
async function seedCategories(orgId: string) {
  const haveSeries = new Set((await prisma.documentSeries.findMany({ where: { organizationId: orgId }, select: { code: true } })).map((s) => s.code));
  for (const s of SEED_DOCUMENT_SERIES) {
    if (haveSeries.has(s.code)) continue;
    await prisma.documentSeries.create({ data: { organizationId: orgId, code: s.code, prefix: s.prefix } });
  }
  const seriesIdByCode = new Map((await prisma.documentSeries.findMany({ where: { organizationId: orgId }, select: { id: true, code: true } })).map((s) => [s.code, s.id]));
  const haveCats = new Set((await prisma.chargeCategory.findMany({ where: { organizationId: orgId }, select: { code: true } })).map((c) => c.code));
  for (const c of SEED_CHARGE_CATEGORIES) {
    if (haveCats.has(c.code)) continue;
    const seriesId = seriesIdByCode.get(c.seriesCode);
    if (!seriesId) continue;
    await prisma.chargeCategory.create({
      data: {
        organizationId: orgId, code: c.code, name: c.name, family: c.family, docType: c.docType,
        seriesId, defaultSstRate: c.defaultSstRate ?? "0", eInvoiceEligible: c.eInvoiceEligible ?? false,
        ledgerCategory: c.ledgerCategory ?? null, isSystem: c.isSystem ?? false, active: c.active ?? true, sortOrder: c.sortOrder,
      },
    });
  }
}

// ── --reset: org-scoped billing-transaction teardown (structure untouched) ───
async function resetBillingData(orgId: string) {
  const where = { organizationId: orgId };
  // Restrict blockers first, then parents (cascades cover lines/allocations/events).
  await prisma.paymentAllocationReversal.deleteMany({ where });
  await prisma.refund.deleteMany({ where });
  await prisma.creditApplication.deleteMany({ where });
  await prisma.billingDocument.deleteMany({ where }); // cascades BillingDocumentLine
  await prisma.paymentAllocation.deleteMany({ where });
  await prisma.payment.deleteMany({ where });
  await prisma.charge.deleteMany({ where }); // cascades ChargeEvent + any PaymentAllocation
  await prisma.invoice.deleteMany({ where });
  await prisma.invoiceDraftRun.deleteMany({ where });
  // Owner-side + meter + bills-grid transactional state (config like meters is kept).
  await prisma.ownerLedgerEntry.deleteMany({ where });
  await prisma.ownerStatementPeriod.deleteMany({ where });
  await prisma.unitBillsGridEntry.deleteMany({ where });
  await prisma.unitUtilityBill.deleteMany({ where });
  await prisma.meterReading.deleteMany({ where });
}

// ── Main seed ─────────────────────────────────────────────────────────────
async function main() {
  const adminHash = await hashPassword("admin123");
  const ownerHash = await hashPassword("owner123");
  const tenantHash = await hashPassword("tenant123");

  // 1. Organization (upsert on slug) ----------------------------------------
  console.log("Organization...");
  await prisma.organization.upsert({
    where: { slug: SLUG },
    update: { name: "KAEN Billing Test", managementFeePercent: 10 },
    create: {
      id: ID.org, name: "KAEN Billing Test", slug: SLUG, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "starter", managementFeePercent: 10,
    },
  });

  if (RESET) {
    console.log("--reset: clearing this org's billing transactions...");
    await resetBillingData(ID.org);
  }

  // 2. Admin user + role (UNIQUE email) -------------------------------------
  console.log("Admin user...");
  await prisma.user.upsert({
    where: { organizationId_email: { organizationId: ID.org, email: ADMIN_EMAIL } },
    update: { passwordHash: adminHash, status: "active", role: "admin", userType: "operator" },
    create: {
      id: ID.adminUser, organizationId: ID.org, email: ADMIN_EMAIL, phone: "60120000000",
      fullName: "Billing Test Admin", passwordHash: adminHash, status: "active",
      role: "admin", userType: "operator", emailVerified: true,
    },
  });
  await prisma.roleAssignment.upsert({
    where: { id: sid("ra:admin") },
    update: {},
    create: { id: sid("ra:admin"), organizationId: ID.org, userId: ID.adminUser, role: "admin", scopeType: "organization" },
  });

  // 3. Charge category + document series registry (deterministic minting) ----
  console.log("ChargeCategory + DocumentSeries registry...");
  await seedCategories(ID.org);

  // 4. Draft invoice settings (active) --------------------------------------
  console.log("DraftConfig (active; runDay 25, due +7, rent+mgmtfee+cleaning)...");
  await prisma.draftConfig.upsert({
    where: { organizationId: ID.org },
    update: { runDayOfMonth: 25, dueDayOffset: 7, includeRent: true, includeMgmtFee: true, includeCleaning: true, isActive: true },
    create: {
      id: ID.draftConfig, organizationId: ID.org, runDayOfMonth: 25, dueDayOffset: 7,
      includeRent: true, includeMgmtFee: true, includeCleaning: true, isActive: true,
    },
  });

  // 5. Org utility-billing config (subsidyPerPax singleton) -----------------
  console.log("UtilityBillingConfig...");
  await prisma.utilityBillingConfig.upsert({
    where: { organizationId: ID.org },
    update: { subsidyPerPax: 50, isActive: true },
    create: { id: ID.ubc, organizationId: ID.org, subsidyPerPax: 50, isActive: true },
  });

  // 6. Owner: Party + role + portal user ------------------------------------
  console.log("Owner...");
  await prisma.party.upsert({
    where: { id: ID.owner },
    update: { displayName: "Dato' Razak bin Abdullah", primaryEmail: OWNER_EMAIL, status: "active" },
    create: {
      id: ID.owner, organizationId: ID.org, partyType: "owner",
      displayName: "Dato' Razak bin Abdullah", legalName: "Razak bin Abdullah",
      primaryEmail: OWNER_EMAIL, primaryPhone: "60170000000", status: "active",
      idType: "NRIC", idNumber: "650415-10-5533", nationality: "Malaysian",
      bankName: "Maybank", bankAccountHolder: "Razak bin Abdullah", bankAccountNumber: "1141-2233-4455",
    },
  });
  await prisma.partyRole.upsert({
    where: { id: sid("pr:owner") },
    update: {},
    create: { id: sid("pr:owner"), organizationId: ID.org, partyId: ID.owner, roleType: "owner", status: "active", effectiveFrom: d("2024-01-01") },
  });
  await prisma.user.upsert({
    where: { organizationId_email: { organizationId: ID.org, email: OWNER_EMAIL } },
    update: { passwordHash: ownerHash, userType: "owner", partyId: ID.owner, status: "active" },
    create: {
      id: ID.ownerUser, organizationId: ID.org, email: OWNER_EMAIL, phone: "60170000000",
      fullName: "Dato' Razak bin Abdullah", passwordHash: ownerHash, status: "active",
      role: "viewer", userType: "owner", partyId: ID.owner, emailVerified: true,
    },
  });

  // 7. Owner management-fee config: 10% + 8% SST ----------------------------
  console.log("ManagementFeeConfig (10% + 8% SST)...");
  await prisma.managementFeeConfig.upsert({
    where: { id: ID.mfc },
    update: { feeType: "percent", feeValue: 10, sstPercent: 8, cleaningAutoBill: 100, isActive: true },
    create: {
      id: ID.mfc, organizationId: ID.org, ownerPartyId: ID.owner, propertyId: null,
      feeType: "percent", feeValue: 10, capAmount: null, sstPercent: 8, cleaningAutoBill: 100,
      isActive: true, effectiveFrom: d("2024-01-01"),
    },
  });

  // 8. Property -------------------------------------------------------------
  console.log("Property...");
  await prisma.property.upsert({
    where: { organizationId_propertyCode: { organizationId: ID.org, propertyCode: "KAEN" } },
    update: { name: "KAEN Residence", status: "active", publishStatus: "published" },
    create: {
      id: ID.prop, organizationId: ID.org, name: "KAEN Residence", propertyCode: "KAEN",
      propertyType: "condominium", addressLine1: "Jalan KAEN 1", addressLine2: "Setapak",
      city: "Kuala Lumpur", state: "W.P. Kuala Lumpur", postalCode: "53300", country: "Malaysia",
      status: "active", publishStatus: "published", managerId: ID.adminUser,
    },
  });

  // 9. Apartments (A-19-02 PARTITIONED, A-10-04 WHOLE) ----------------------
  console.log("Apartments...");
  await prisma.apartment.upsert({
    where: { organizationId_propertyId_unitCode: { organizationId: ID.org, propertyId: ID.prop, unitCode: "A-19-02" } },
    update: { listingMode: "PARTITIONED", partitionBillingMode: "NO_SUBSIDY" },
    create: {
      id: ID.apt1902, organizationId: ID.org, propertyId: ID.prop, unitCode: "A-19-02",
      listingMode: "PARTITIONED", partitionBillingMode: "NO_SUBSIDY", bedrooms: 3, bathrooms: 2, floorArea: 1000, floor: 19,
    },
  });
  await prisma.apartment.upsert({
    where: { organizationId_propertyId_unitCode: { organizationId: ID.org, propertyId: ID.prop, unitCode: "A-10-04" } },
    update: { listingMode: "WHOLE", partitionBillingMode: "NO_SUBSIDY" },
    create: {
      id: ID.apt1004, organizationId: ID.org, propertyId: ID.prop, unitCode: "A-10-04",
      listingMode: "WHOLE", partitionBillingMode: "NO_SUBSIDY", bedrooms: 2, bathrooms: 1, floorArea: 850, floor: 10,
    },
  });

  // 10. Listings + aircond submeters ----------------------------------------
  console.log("Listings + aircond submeters...");
  for (const u of UNITS) {
    await prisma.listing.upsert({
      where: { apartmentId_listingType: { apartmentId: u.apartmentId, listingType: u.listingType } },
      update: { ownerPartyId: ID.owner, occupancyStatus: "occupied", rentalRate: u.rent },
      create: {
        id: u.listingId, organizationId: ID.org, apartmentId: u.apartmentId, listingType: u.listingType,
        occupancyStatus: "occupied", listingStatus: "unlisted", currency: "MYR",
        rentalRate: u.rent, baseRentAmount: u.rent, ownerPartyId: ID.owner, photoKeys: [], videoKeys: [],
      },
    });
    await prisma.aircondMeter.upsert({
      where: { organizationId_unitId: { organizationId: ID.org, unitId: u.listingId } },
      update: { isActive: true, ratePerKwh: "0.6000" },
      create: {
        id: sid(`meter:${u.listingId}`), organizationId: ID.org, unitId: u.listingId,
        meterNumber: `MTR-${u.unitCode}-${u.listingType}`, ratePerKwh: "0.6000", isActive: true,
      },
    });
  }

  // 11. Tenants -------------------------------------------------------------
  console.log("Tenants (4)...");
  for (const t of TENANTS) {
    await prisma.party.upsert({
      where: { id: tenantPartyId(t.idx) },
      update: { displayName: t.name, status: "active" },
      create: {
        id: tenantPartyId(t.idx), organizationId: ID.org, partyType: "tenant",
        displayName: t.name, legalName: t.name, primaryEmail: tenantEmail(t.idx), primaryPhone: t.phone,
        status: "active", idType: "NRIC", idNumber: t.ic, nationality: "Malaysian",
      },
    });
    await prisma.partyRole.upsert({
      where: { id: sid(`pr:tenant:${t.idx}`) },
      update: {},
      create: { id: sid(`pr:tenant:${t.idx}`), organizationId: ID.org, partyId: tenantPartyId(t.idx), roleType: "tenant", status: "active", effectiveFrom: d("2025-01-01") },
    });
    await prisma.user.upsert({
      where: { organizationId_email: { organizationId: ID.org, email: tenantEmail(t.idx) } },
      update: { passwordHash: tenantHash, userType: "tenant", partyId: tenantPartyId(t.idx), status: "active" },
      create: {
        id: tenantUserId(t.idx), organizationId: ID.org, email: tenantEmail(t.idx), phone: t.phone,
        fullName: t.name, passwordHash: tenantHash, status: "active", role: "viewer",
        userType: "tenant", partyId: tenantPartyId(t.idx), emailVerified: true,
      },
    });
  }

  // 12. Reservations (rent source) + active tenancies (wide date window) -----
  console.log("Reservations + tenancies...");
  for (const u of UNITS) {
    const resId = sid(`reservation:${u.key}`);
    const ref = `RSV-BT-${String(u.tenantIdx).padStart(3, "0")}`;
    await prisma.unitReservation.upsert({
      where: { organizationId_referenceCode: { organizationId: ID.org, referenceCode: ref } },
      update: { agreedMonthlyRent: u.rent, unitId: u.listingId },
      create: {
        id: resId, organizationId: ID.org, referenceCode: ref, status: "completed",
        issuedByPartyId: ID.owner, expiresAt: d("2027-12-31"), publicToken: sid(`token:${u.key}`),
        propertyId: ID.prop, unitId: u.listingId, proposedMoveIn: d("2025-01-01"),
        reservationDeposit: 500, documentationFee: 200, rentalDeposit: u.rent,
        utilityDeposit: Math.round(u.rent * 0.5), accessCardDeposit: 100, agreedMonthlyRent: u.rent,
      },
    });
    const tenancyCode = `TEN-BT-${String(u.tenantIdx).padStart(3, "0")}`;
    await prisma.tenancy.upsert({
      where: { organizationId_tenancyCode: { organizationId: ID.org, tenancyCode } },
      update: { status: "active", billingStatus: "current", numberOfPax: u.pax, monthlyRentAmount: u.rent, reservationId: resId },
      create: {
        id: sid(`tenancy:${u.key}`), organizationId: ID.org, propertyId: ID.prop, unitId: u.listingId,
        tenantPartyId: tenantPartyId(u.tenantIdx), tenancyCode, status: "active", billingStatus: "current",
        startDate: d("2025-01-01"), endDate: d("2027-12-31"), monthlyRentAmount: u.rent,
        depositAmount: u.rent * 2, termMonths: 36, numberOfPax: u.pax, noticePeriodDays: 30, reservationId: resId,
      },
    });
  }

  // ── Summary + login map ────────────────────────────────────────────────
  const rentTotal = UNITS.reduce((s, u) => s + u.rent, 0);
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(" KAEN Billing Test — clean sandbox ready" + (RESET ? " (reset)" : ""));
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`\n  Org: KAEN Billing Test   slug=${SLUG}   id=${ID.org}`);
  console.log("\n  Login → http://localhost:5173/login");
  console.log(`    Admin   ${ADMIN_EMAIL}   / admin123`);
  console.log(`    Owner   ${OWNER_EMAIL}   / owner123   (portal → /portal/login)`);
  for (const t of TENANTS) console.log(`    Tenant  ${tenantEmail(t.idx).padEnd(28)} / tenant123 (${t.name})`);
  console.log("\n  Units → tenant → rent");
  console.log("    A-19-02  PARTITIONED / NO_SUBSIDY (per-room utility split; owner Dato' Razak)");
  for (const u of UNITS.filter((x) => x.unitCode === "A-19-02")) {
    const t = TENANTS[u.tenantIdx - 1];
    console.log(`      ${u.roomLabel} (${u.listingType.padEnd(8)}) RM${String(u.rent).padEnd(5)} pax ${u.pax} → ${t.name}`);
  }
  console.log("    A-10-04  WHOLE (single tenant; owner Dato' Razak)");
  for (const u of UNITS.filter((x) => x.unitCode === "A-10-04")) {
    const t = TENANTS[u.tenantIdx - 1];
    console.log(`      ${u.roomLabel} (${u.listingType.padEnd(8)}) RM${String(u.rent).padEnd(5)} pax ${u.pax} → ${t.name}`);
  }
  console.log(`\n  DraftConfig: active (runDay 25, due +7d, rent+mgmtfee+cleaning). Total monthly rent RM${rentTotal}.`);
  console.log("  Billing transactions: ZERO — you drive the loop. Re-run with --reset to return to zero.\n");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
