// SYNC: keep aligned with the sibling seed file except for the SSL/adapter block.
// - prisma/seed.ts: uses local postgres driver (no SSL setup)
// - packages/db/prisma/seed.ts: uses PrismaPg adapter + Supabase CA cert
// Any other drift is a bug. Diff periodically:
//   diff prisma/seed.ts packages/db/prisma/seed.ts
import "dotenv/config";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function resolveSsl(url: string): { ca: Buffer; rejectUnauthorized: true } | { rejectUnauthorized: false } | false {
  // Local postgres doesn't negotiate TLS — disable SSL entirely.
  if (/localhost|127\.0\.0\.1/.test(url)) return false;
  const caPath =
    process.env.SUPABASE_CA_CERT_PATH ?? path.join(process.cwd(), "certs/supabase-ca.crt");
  try {
    const ca = fs.readFileSync(caPath);
    return { ca, rejectUnauthorized: true as const };
  } catch {
    return { rejectUnauthorized: false as const };
  }
}

function stripSslmode(url: string): string {
  return url.replace(/([?&])sslmode=[^&]*&?/g, "$1").replace(/[?&]$/, "");
}

const rawUrl = process.env.DATABASE_URL!;
const adapter = new PrismaPg({
  connectionString: stripSslmode(rawUrl),
  ssl: resolveSsl(rawUrl),
});
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

/** Date helper — returns ISO string for a given YYYY-MM-DD */
function d(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function dt(dateStr: string): Date {
  return new Date(dateStr);
}

// ---------------------------------------------------------------------------
// Stable UUIDs (so we can reference them across tables)
// ---------------------------------------------------------------------------

const IDS = {
  org: uuid(),
  // Users
  adminUser: uuid(),
  managerUser: uuid(),
  // Parties — Landlords
  landlord1: uuid(), // Dato' Razak
  landlord2: uuid(), // Puan Mei Ling
  // Parties — Tenants
  tenant1: uuid(),  // Ahmad Faizal
  tenant2: uuid(),  // Siti Nurhaliza (common name)
  tenant3: uuid(),  // Rajesh Kumar
  tenant4: uuid(),  // Tan Wei Ming
  tenant5: uuid(),  // Nurul Izzah
  tenant6: uuid(),  // James Wilson (expat)
  tenant7: uuid(),  // Lim Chee Keong
  tenant8: uuid(),  // Aisha binti Hassan
  tenant9: uuid(),  // Yuki Tanaka (expat)
  tenant10: uuid(), // Muhammad Hafiz
  // Properties
  prop1: uuid(), // Seri Kembangan Heights
  prop2: uuid(), // Taman Desa Shophouses
  prop3: uuid(), // Bangsar South Residences
  propPV9: uuid(), // PV9 Residence
  // Buildings
  bldgA: uuid(), // Tower A (prop1)
  bldgB: uuid(), // Tower B (prop1)
  bldgSR: uuid(), // Block A (prop3)
  bldgPV9A: uuid(), // PV9 Tower A
  // Units — Seri Kembangan Heights
  unitSK1: uuid(), unitSK2: uuid(), unitSK3: uuid(),
  unitSK4: uuid(), unitSK5: uuid(), unitSK6: uuid(),
  // Units — Taman Desa Shophouses
  unitTD1: uuid(), unitTD2: uuid(), unitTD3: uuid(), unitTD4: uuid(),
  // Units — Bangsar South Residences
  unitBS1: uuid(), unitBS2: uuid(), unitBS3: uuid(),
  unitBS4: uuid(), unitBS5: uuid(),
  // Units — PV9 Residence
  unitPV9_1: uuid(), unitPV9_2: uuid(), unitPV9_3: uuid(), unitPV9_4: uuid(),
  // PV9 — same unitCode (A-11-43) split into three rentable rooms.
  // Demonstrates the (unitCode, unitType) composite-uniqueness model: one
  // physical unit can host Master/Medium/Small as separate rentable rows.
  unitPV9_A1143_master: uuid(),
  unitPV9_A1143_medium: uuid(),
  unitPV9_A1143_small: uuid(),
  // Tenancies
  ten1: uuid(), ten2: uuid(), ten3: uuid(), ten4: uuid(), ten5: uuid(),
  ten6: uuid(), ten7: uuid(), ten8: uuid(), ten9: uuid(), ten10: uuid(),
  // Tenant portal user accounts
  tenantUser1: uuid(), tenantUser2: uuid(), tenantUser3: uuid(),
  tenantUser4: uuid(), tenantUser5: uuid(), tenantUser6: uuid(),
  tenantUser7: uuid(), tenantUser8: uuid(), tenantUser9: uuid(),
  tenantUser10: uuid(),
  // Landlord tenancies
  lt1: uuid(), lt2: uuid(), lt3: uuid(),
  // Maintenance requests
  mr1: uuid(), mr2: uuid(), mr3: uuid(), mr4: uuid(), mr5: uuid(),
  // Announcements
  ann1: uuid(), ann2: uuid(), ann3: uuid(),
  // Documents
  doc1: uuid(), doc2: uuid(), doc3: uuid(), doc4: uuid(),
  // Charge templates
  ctRent: uuid(), ctUtility: uuid(), ctMaint: uuid(),
  // Late fee rule
  lfr1: uuid(),
  // Email templates
  etWelcome: uuid(), etReminder: uuid(), etOverdue: uuid(),
  // Agents (agent3 is the team manager — leader level — with agent1 & agent2 as downlines)
  agent1: uuid(), agent2: uuid(), agent3: uuid(),
  agentUser1: uuid(), agentUser2: uuid(), agentUser3: uuid(),
  // Owner portal users
  ownerUser1: uuid(), ownerUser2: uuid(),
  // Agent tier mappings
  tierMapping1: uuid(), tierMapping2: uuid(), tierMapping3: uuid(),
  tierMapping4: uuid(), tierMapping5: uuid(), tierMapping6: uuid(),
  // Commission claims
  clm1: uuid(), clm2: uuid(), clm3: uuid(), clm4: uuid(),
  // Commission bills & movements
  clmBill1: uuid(), clmBill2: uuid(), clmCM1: uuid(),
  // Sales Entry & Renovation Claim (Wave 1)
  // Renovation packages (3) and their default splits (3 per package = 9 total)
  pkgStandard: uuid(),     pkgPremium: uuid(),    pkgPremiumPlus: uuid(),
  pkgStdSales: uuid(),     pkgStdLeader: uuid(),  pkgStdHouseKeep: uuid(),
  pkgPremSales: uuid(),    pkgPremLeader: uuid(), pkgPremHouseKeep: uuid(),
  pkgPlusSales: uuid(),    pkgPlusLeader: uuid(), pkgPlusHouseKeep: uuid(),
  // Settings labels (5 + 3 + 3 + 3 = 14)
  lblClaimSubmitted: uuid(),  lblClaimPending: uuid(),  lblClaimApproved: uuid(),
  lblClaimRejected: uuid(),   lblClaimAmend: uuid(),
  lblRenoNotStarted: uuid(),  lblRenoOnGoing: uuid(),   lblRenoCompleted: uuid(),
  lblDocQuotation: uuid(),    lblDocInvoice: uuid(),    lblDocAgreement: uuid(),
  lblPayFull: uuid(),         lblPayPartial: uuid(),    lblPayOffset: uuid(),
  // Demo projects (2)
  projAurora: uuid(),         projSkyline: uuid(),
};

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PROD_SEED !== "1") {
    console.error("FATAL: Refusing to run seed script in production.");
    console.error("This script runs TRUNCATE CASCADE on all tables.");
    console.error("To intentionally reseed production, re-run with ALLOW_PROD_SEED=1.");
    process.exit(1);
  }
  if (process.env.ALLOW_PROD_SEED === "1") {
    const maskedUrl = (process.env.DATABASE_URL ?? "<unset>").replace(/:[^@]+@/, ":***@");
    console.warn(`WARNING: ALLOW_PROD_SEED=1 — wiping data in 5 seconds.`);
    console.warn(`         NODE_ENV=${process.env.NODE_ENV}`);
    console.warn(`         DATABASE_URL=${maskedUrl}`);
    console.warn(`         Ctrl-C to abort.`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log("Clearing existing data...");
  // Use TRUNCATE CASCADE to handle FK constraints from tables outside the Prisma schema
  // (e.g. Contract, Document, MaintenanceRequest, etc. that still exist in the DB).
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ActivityLog", "AuditLog", "NotificationQueue", "Notification",
      "EmailTemplate", "CashMovement", "Bill", "PaymentAllocation",
      "Payment", "ChargeEvent", "Charge", "RecurringCharge",
      "LateFeeRule", "ChargeTemplate", "Deposit",
      "MaintenanceRequest", "DocumentLink", "Document", "Announcement",
      "CommissionClaimItem", "CommissionClaim", "AgentTierMapping", "AgentLevelThreshold", "RoomType",
      "RenovationClaimOffset", "RenovationClaimDocument", "RenovationClaimTransition",
      "RenovationClaimSplit", "RenovationClaim",
      "RenovationPackageSplit", "RenovationPackage",
      "RenovationTransition", "RenovationProgress",
      "SalesClaimTransition", "SalesClaimSplit", "SalesClaim",
      "SalesUnit", "Project", "SettingsLabel",
      "Tenancy", "LandlordTenancy", "UnitAttribute",
      "ListingVisibilityGrant", "UnitSubmission", "Unit", "Apartment",
      "PropertySubmission", "Building",
      "Property", "PartyRole", "RoleAssignment", "User", "Party",
      "Organization"
    CASCADE
  `);

  // =========================================================================
  // 1. Organization
  // =========================================================================
  console.log("Creating organization...");
  const org = await prisma.organization.create({
    data: {
      id: IDS.org,
      name: "KAEN PROPERTIES MANAGEMENT SDN BHD",
      slug: "kaen-demo",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "starter",
      billingCycleMode: "calendar",
      billLeadDays: 30,
      tenancyExpiryReminderDays: 30,
      currencyDisplay: "symbol",
      managementFeePercent: 10,
    },
  });

  // =========================================================================
  // 2. Users
  // =========================================================================
  console.log("Creating users...");
  const adminHash = await hashPassword("admin123");
  const managerHash = await hashPassword("manager123");

  const adminUser = await prisma.user.create({
    data: {
      id: IDS.adminUser,
      organizationId: org.id,
      email: "admin@kaenproperties.com",
      phone: "60123456789",
      fullName: "Kaen Admin",
      passwordHash: adminHash,
      status: "active",
      role: "admin",
      userType: "operator",
      emailVerified: true,
    },
  });

  await prisma.user.create({
    data: {
      id: IDS.managerUser,
      organizationId: org.id,
      email: "sarah@kaenproperties.com",
      phone: "60198765432",
      fullName: "Sarah Ahmad",
      passwordHash: managerHash,
      status: "active",
      role: "manager",
      userType: "operator",
      emailVerified: true,
    },
  });

  // =========================================================================
  // 3. Role Assignments
  // =========================================================================
  console.log("Creating role assignments...");
  await prisma.roleAssignment.createMany({
    data: [
      { id: uuid(), organizationId: org.id, userId: IDS.adminUser, role: "admin", scopeType: "organization" },
      { id: uuid(), organizationId: org.id, userId: IDS.managerUser, role: "manager", scopeType: "organization" },
    ],
  });

  // =========================================================================
  // 4. Parties — Landlords
  // =========================================================================
  console.log("Creating parties (landlords)...");
  await prisma.party.createMany({
    data: [
      {
        id: IDS.landlord1,
        organizationId: org.id,
        partyType: "owner",
        displayName: "Dato' Razak bin Abdullah",
        legalName: "Razak bin Abdullah",
        primaryEmail: "razak@gmail.com",
        primaryPhone: "60172345678",
        status: "active",
        idType: "NRIC",
        idNumber: "650415-10-5533",
        nationality: "Malaysian",
        race: "Malay",
        gender: "male",
        dateOfBirth: d("1965-04-15"),
        bankName: "Maybank",
        bankAccountHolder: "Razak bin Abdullah",
        bankAccountNumber: "1141-2233-4455",
      },
      {
        id: IDS.landlord2,
        organizationId: org.id,
        partyType: "owner",
        displayName: "Puan Tan Mei Ling",
        legalName: "Tan Mei Ling",
        primaryEmail: "meiling.tan@hotmail.com",
        primaryPhone: "60162345678",
        status: "active",
        idType: "NRIC",
        idNumber: "720823-14-5678",
        nationality: "Malaysian",
        race: "Chinese",
        gender: "female",
        dateOfBirth: d("1972-08-23"),
        bankName: "CIMB Bank",
        bankAccountHolder: "Tan Mei Ling",
        bankAccountNumber: "7602-1234-5678",
      },
    ],
  });

  // =========================================================================
  // 5. Parties — Tenants
  // =========================================================================
  console.log("Creating parties (tenants)...");
  await prisma.party.createMany({
    data: [
      {
        id: IDS.tenant1,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Ahmad Faizal bin Ismail",
        legalName: "Ahmad Faizal bin Ismail",
        primaryEmail: "faizal.ismail@gmail.com",
        primaryPhone: "60133456789",
        status: "active",
        idType: "NRIC",
        idNumber: "880312-10-1234",
        nationality: "Malaysian",
        race: "Malay",
        gender: "male",
        dateOfBirth: d("1988-03-12"),
        occupation: "Software Engineer",
        employerName: "Petronas Digital",
        monthlyIncome: 8500,
        emergencyContactName: "Fatimah binti Ismail",
        emergencyContactPhone: "60134567890",
        emergencyContactRelation: "Mother",
        bankName: "Maybank",
        bankAccountHolder: "Ahmad Faizal bin Ismail",
        bankAccountNumber: "1122-3344-5566",
      },
      {
        id: IDS.tenant2,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Siti Aminah binti Yusof",
        legalName: "Siti Aminah binti Yusof",
        primaryEmail: "siti.aminah@yahoo.com",
        primaryPhone: "60143456789",
        status: "active",
        idType: "NRIC",
        idNumber: "910725-14-5678",
        nationality: "Malaysian",
        race: "Malay",
        gender: "female",
        dateOfBirth: d("1991-07-25"),
        occupation: "Accountant",
        employerName: "Deloitte Malaysia",
        monthlyIncome: 7200,
        emergencyContactName: "Yusof bin Ahmad",
        emergencyContactPhone: "60145678901",
        emergencyContactRelation: "Father",
        bankName: "CIMB Bank",
        bankAccountHolder: "Siti Aminah binti Yusof",
        bankAccountNumber: "7601-2233-4455",
      },
      {
        id: IDS.tenant3,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Rajesh a/l Kumar",
        legalName: "Rajesh a/l Kumar",
        primaryEmail: "rajesh.kumar@outlook.com",
        primaryPhone: "60153456789",
        status: "active",
        idType: "NRIC",
        idNumber: "850918-08-7890",
        nationality: "Malaysian",
        race: "Indian",
        gender: "male",
        dateOfBirth: d("1985-09-18"),
        occupation: "Civil Engineer",
        employerName: "Gamuda Berhad",
        monthlyIncome: 9500,
        emergencyContactName: "Priya a/p Raman",
        emergencyContactPhone: "60156789012",
        emergencyContactRelation: "Wife",
        bankName: "Public Bank",
        bankAccountHolder: "Rajesh a/l Kumar",
        bankAccountNumber: "3188-1234-5678",
      },
      {
        id: IDS.tenant4,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Tan Wei Ming",
        legalName: "Tan Wei Ming",
        primaryEmail: "weiming.tan@gmail.com",
        primaryPhone: "60163456789",
        status: "active",
        idType: "NRIC",
        idNumber: "930405-10-2345",
        nationality: "Malaysian",
        race: "Chinese",
        gender: "male",
        dateOfBirth: d("1993-04-05"),
        occupation: "Graphic Designer",
        employerName: "Freelance",
        monthlyIncome: 6000,
        emergencyContactName: "Tan Ah Kow",
        emergencyContactPhone: "60167890123",
        emergencyContactRelation: "Father",
        bankName: "Hong Leong Bank",
        bankAccountHolder: "Tan Wei Ming",
        bankAccountNumber: "2081-5566-7788",
      },
      {
        id: IDS.tenant5,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Nurul Izzah binti Mahmud",
        legalName: "Nurul Izzah binti Mahmud",
        primaryEmail: "nurul.izzah@gmail.com",
        primaryPhone: "60173456789",
        status: "active",
        idType: "NRIC",
        idNumber: "960112-01-6789",
        nationality: "Malaysian",
        race: "Malay",
        gender: "female",
        dateOfBirth: d("1996-01-12"),
        occupation: "Marketing Executive",
        employerName: "AirAsia",
        monthlyIncome: 5500,
        emergencyContactName: "Mahmud bin Ali",
        emergencyContactPhone: "60178901234",
        emergencyContactRelation: "Father",
        bankName: "Bank Islam",
        bankAccountHolder: "Nurul Izzah binti Mahmud",
        bankAccountNumber: "1602-3344-5566",
      },
      {
        id: IDS.tenant6,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "James Wilson",
        legalName: "James Andrew Wilson",
        primaryEmail: "james.wilson@proton.me",
        primaryPhone: "60183456789",
        status: "active",
        idType: "Passport",
        idNumber: "GB987654321",
        nationality: "British",
        gender: "male",
        dateOfBirth: d("1982-11-30"),
        occupation: "Regional Sales Director",
        employerName: "Shell Malaysia",
        monthlyIncome: 18000,
        emergencyContactName: "Emma Wilson",
        emergencyContactPhone: "+447911234567",
        emergencyContactRelation: "Wife",
        bankName: "HSBC Malaysia",
        bankAccountHolder: "James Andrew Wilson",
        bankAccountNumber: "3011-2233-4455",
      },
      {
        id: IDS.tenant7,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Lim Chee Keong",
        legalName: "Lim Chee Keong",
        primaryEmail: "ckl88@gmail.com",
        primaryPhone: "60193456789",
        status: "active",
        idType: "NRIC",
        idNumber: "880620-10-4567",
        nationality: "Malaysian",
        race: "Chinese",
        gender: "male",
        dateOfBirth: d("1988-06-20"),
        occupation: "Restaurant Owner",
        employerName: "CK Food Industries Sdn Bhd",
        monthlyIncome: 12000,
        emergencyContactName: "Lim Ah Moi",
        emergencyContactPhone: "60189012345",
        emergencyContactRelation: "Mother",
        bankName: "Public Bank",
        bankAccountHolder: "Lim Chee Keong",
        bankAccountNumber: "3188-9876-5432",
      },
      {
        id: IDS.tenant8,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Aisha binti Hassan",
        legalName: "Aisha binti Hassan",
        primaryEmail: "aisha.hassan@outlook.com",
        primaryPhone: "60113456789",
        status: "active",
        idType: "NRIC",
        idNumber: "940308-14-8901",
        nationality: "Malaysian",
        race: "Malay",
        gender: "female",
        dateOfBirth: d("1994-03-08"),
        occupation: "Lawyer",
        employerName: "Zaid Ibrahim & Co",
        monthlyIncome: 11000,
        emergencyContactName: "Hassan bin Omar",
        emergencyContactPhone: "60112345678",
        emergencyContactRelation: "Father",
        bankName: "RHB Bank",
        bankAccountHolder: "Aisha binti Hassan",
        bankAccountNumber: "2142-3344-5566",
      },
      {
        id: IDS.tenant9,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Yuki Tanaka",
        legalName: "Tanaka Yuki",
        primaryEmail: "yuki.tanaka@icloud.com",
        primaryPhone: "60123456780",
        status: "active",
        idType: "Passport",
        idNumber: "TK12345678",
        nationality: "Japanese",
        gender: "female",
        dateOfBirth: d("1990-05-14"),
        occupation: "Japanese Language Instructor",
        employerName: "JFKL (Japan Foundation KL)",
        monthlyIncome: 7000,
        emergencyContactName: "Tanaka Kenji",
        emergencyContactPhone: "+81901234567",
        emergencyContactRelation: "Brother",
        bankName: "Maybank",
        bankAccountHolder: "Tanaka Yuki",
        bankAccountNumber: "1141-8877-6655",
      },
      {
        id: IDS.tenant10,
        organizationId: org.id,
        partyType: "tenant",
        displayName: "Muhammad Hafiz bin Osman",
        legalName: "Muhammad Hafiz bin Osman",
        primaryEmail: "hafiz.osman@gmail.com",
        primaryPhone: "60133456780",
        status: "active",
        idType: "NRIC",
        idNumber: "970715-10-3456",
        nationality: "Malaysian",
        race: "Malay",
        gender: "male",
        dateOfBirth: d("1997-07-15"),
        occupation: "Junior Doctor",
        employerName: "Hospital Kuala Lumpur",
        monthlyIncome: 6500,
        emergencyContactName: "Osman bin Daud",
        emergencyContactPhone: "60134567891",
        emergencyContactRelation: "Father",
        bankName: "Bank Islam",
        bankAccountHolder: "Muhammad Hafiz bin Osman",
        bankAccountNumber: "1602-7788-9900",
      },
    ],
  });

  // =========================================================================
  // 5b. Parties — Agents
  //
  // Hierarchy (rooted at the org):
  //   KAEN Properties
  //     └─ Farah binti Hassan     (leader  / Manager)
  //          ├─ Priya a/p Subramaniam   (pre_leader)
  //          └─ Ahmad Rizal bin Zainal  (new_agent)
  //
  // NOTE: the "leader" enum value is shown as "Manager" in the UI
  // (see web/src/pages/parties/agent-tree-view.tsx → LEVEL_LABELS).
  // The DB enum stays `leader` so existing tier mappings keep working.
  //
  // Inserted in two calls so the self-referencing uplineId FK resolves:
  // the manager must exist before their downlines reference her.
  // =========================================================================
  console.log("Creating parties (agents) — manager first, then downlines...");
  await prisma.party.create({
    data: {
      id: IDS.agent3,
      organizationId: org.id,
      partyType: "agent",
      displayName: "Farah binti Hassan",
      legalName: "Farah binti Hassan",
      primaryEmail: "farah.hassan@gmail.com",
      primaryPhone: "60132345678",
      status: "active",
      idType: "NRIC",
      idNumber: "820215-08-3344",
      nationality: "Malaysian",
      race: "Malay",
      gender: "female",
      dateOfBirth: d("1982-02-15"),
      bankName: "Maybank",
      bankAccountHolder: "Farah binti Hassan",
      bankAccountNumber: "1141-2233-4455",
      agentLevel: "leader", // shown as "Manager" in the UI
      uplineId: null,       // reports directly to the organization
    },
  });

  await prisma.party.createMany({
    data: [
      {
        id: IDS.agent1,
        organizationId: org.id,
        partyType: "agent",
        displayName: "Ahmad Rizal bin Zainal",
        legalName: "Ahmad Rizal bin Zainal",
        primaryEmail: "rizal.zainal@gmail.com",
        primaryPhone: "60142345678",
        status: "active",
        idType: "NRIC",
        idNumber: "850610-10-5577",
        nationality: "Malaysian",
        race: "Malay",
        gender: "male",
        dateOfBirth: d("1985-06-10"),
        bankName: "Maybank",
        bankAccountHolder: "Ahmad Rizal bin Zainal",
        bankAccountNumber: "1141-5566-7788",
        agentLevel: "new_agent",
        uplineId: IDS.agent3, // reports to Farah (Manager)
      },
      {
        id: IDS.agent2,
        organizationId: org.id,
        partyType: "agent",
        displayName: "Priya a/p Subramaniam",
        legalName: "Priya a/p Subramaniam",
        primaryEmail: "priya.subra@gmail.com",
        primaryPhone: "60152345678",
        status: "active",
        idType: "NRIC",
        idNumber: "900322-14-6688",
        nationality: "Malaysian",
        race: "Indian",
        gender: "female",
        dateOfBirth: d("1990-03-22"),
        bankName: "CIMB Bank",
        bankAccountHolder: "Priya a/p Subramaniam",
        bankAccountNumber: "7602-9988-7766",
        agentLevel: "pre_leader",
        uplineId: IDS.agent3, // reports to Farah (Manager)
      },
    ],
  });

  // =========================================================================
  // 6. Party Roles
  // =========================================================================
  console.log("Creating party roles...");
  const landlordIds = [IDS.landlord1, IDS.landlord2];
  const tenantIds = [
    IDS.tenant1, IDS.tenant2, IDS.tenant3, IDS.tenant4, IDS.tenant5,
    IDS.tenant6, IDS.tenant7, IDS.tenant8, IDS.tenant9, IDS.tenant10,
  ];

  await prisma.partyRole.createMany({
    data: [
      ...landlordIds.map((pid) => ({
        id: uuid(), organizationId: org.id, partyId: pid,
        roleType: "owner", status: "active", effectiveFrom: d("2024-01-01"),
      })),
      ...tenantIds.map((pid) => ({
        id: uuid(), organizationId: org.id, partyId: pid,
        roleType: "tenant", status: "active", effectiveFrom: d("2025-10-01"),
      })),
      ...([IDS.agent1, IDS.agent2, IDS.agent3]).map((pid) => ({
        id: uuid(), organizationId: org.id, partyId: pid,
        roleType: "agent", status: "active", effectiveFrom: d("2025-06-01"),
      })),
    ],
  });

  // =========================================================================
  // 6b. Tenant Portal Users (so tenants can log into the portal)
  // =========================================================================
  console.log("Creating tenant portal users...");
  const tenantPassword = await hashPassword("tenant123");

  const tenantUserData = [
    { id: IDS.tenantUser1,  partyId: IDS.tenant1,  email: "faizal.ismail@gmail.com",   fullName: "Ahmad Faizal bin Ismail",   phone: "60133456789" },
    { id: IDS.tenantUser2,  partyId: IDS.tenant2,  email: "siti.aminah@yahoo.com",     fullName: "Siti Aminah binti Yusof",   phone: "60143456789" },
    { id: IDS.tenantUser3,  partyId: IDS.tenant3,  email: "rajesh.kumar@outlook.com",  fullName: "Rajesh a/l Kumar",          phone: "60153456789" },
    { id: IDS.tenantUser4,  partyId: IDS.tenant4,  email: "weiming.tan@gmail.com",     fullName: "Tan Wei Ming",              phone: "60163456789" },
    { id: IDS.tenantUser5,  partyId: IDS.tenant5,  email: "nurul.izzah@gmail.com",     fullName: "Nurul Izzah binti Mahmud",  phone: "60173456789" },
    { id: IDS.tenantUser6,  partyId: IDS.tenant6,  email: "james.wilson@proton.me",    fullName: "James Wilson",              phone: "60183456789" },
    { id: IDS.tenantUser7,  partyId: IDS.tenant7,  email: "ckl88@gmail.com",           fullName: "Lim Chee Keong",            phone: "60193456789" },
    { id: IDS.tenantUser8,  partyId: IDS.tenant8,  email: "aisha.hassan@outlook.com",  fullName: "Aisha binti Hassan",        phone: "60113456789" },
    { id: IDS.tenantUser9,  partyId: IDS.tenant9,  email: "yuki.tanaka@icloud.com",    fullName: "Yuki Tanaka",               phone: "60123456780" },
    { id: IDS.tenantUser10, partyId: IDS.tenant10, email: "hafiz.osman@gmail.com",     fullName: "Muhammad Hafiz bin Osman",  phone: "60133456780" },
  ];

  await prisma.user.createMany({
    data: tenantUserData.map((t) => ({
      id: t.id,
      organizationId: org.id,
      email: t.email,
      phone: t.phone,
      fullName: t.fullName,
      passwordHash: tenantPassword,
      status: "active",
      role: "viewer",
      userType: "tenant",
      partyId: t.partyId,
      emailVerified: true,
    })),
  });

  // =========================================================================
  // 6c. Agent Portal Users
  // =========================================================================
  console.log("Creating agent portal users...");
  const agentPassword = await hashPassword("agent123");
  await prisma.user.createMany({
    data: [
      {
        id: IDS.agentUser1, organizationId: org.id,
        email: "rizal.zainal@gmail.com", phone: "60142345678",
        fullName: "Ahmad Rizal bin Zainal",
        passwordHash: agentPassword, status: "active",
        role: "viewer", userType: "agent", partyId: IDS.agent1,
        emailVerified: true,
      },
      {
        id: IDS.agentUser2, organizationId: org.id,
        email: "priya.subra@gmail.com", phone: "60152345678",
        fullName: "Priya a/p Subramaniam",
        passwordHash: agentPassword, status: "active",
        role: "viewer", userType: "agent", partyId: IDS.agent2,
        emailVerified: true,
      },
      {
        id: IDS.agentUser3, organizationId: org.id,
        email: "farah.hassan@gmail.com", phone: "60132345678",
        fullName: "Farah binti Hassan",
        passwordHash: agentPassword, status: "active",
        role: "viewer", userType: "agent", partyId: IDS.agent3,
        emailVerified: true,
      },
    ],
  });

  // =========================================================================
  // 6d. Owner Portal Users (landlords who can log into the portal)
  // =========================================================================
  console.log("Creating owner portal users...");
  const ownerPassword = await hashPassword("owner123");
  await prisma.user.createMany({
    data: [
      {
        id: IDS.ownerUser1, organizationId: org.id,
        email: "razak@gmail.com", phone: "60172345678",
        fullName: "Dato' Razak bin Abdullah",
        passwordHash: ownerPassword, status: "active",
        role: "viewer", userType: "owner", partyId: IDS.landlord1,
        emailVerified: true,
      },
      {
        id: IDS.ownerUser2, organizationId: org.id,
        email: "meiling.tan@hotmail.com", phone: "60162345678",
        fullName: "Puan Tan Mei Ling",
        passwordHash: ownerPassword, status: "active",
        role: "viewer", userType: "owner", partyId: IDS.landlord2,
        emailVerified: true,
      },
    ],
  });

  // =========================================================================
  // 7. Properties
  // =========================================================================
  console.log("Creating properties...");
  await prisma.property.createMany({
    data: [
      {
        id: IDS.prop1,
        organizationId: org.id,
        name: "Seri Kembangan Heights",
        propertyCode: "SKH",
        propertyType: "condominium",
        addressLine1: "Persiaran Seri Kembangan",
        addressLine2: "Seri Kembangan",
        city: "Serdang",
        state: "Selangor",
        postalCode: "43300",
        country: "Malaysia",
        status: "active",
        publishStatus: "published",
        managerId: IDS.managerUser,
        insuranceProvider: "Allianz Malaysia",
        insurancePolicyNo: "ALZ-2025-001234",
        insuranceExpiryDate: d("2027-06-30"),
        insuranceCoverage: 5000000,
        hasPaxDeduction: true,
        paxDeductionAmount: 50,
      },
      {
        id: IDS.prop2,
        organizationId: org.id,
        name: "Taman Desa Shophouses",
        propertyCode: "TDS",
        propertyType: "shophouse",
        addressLine1: "Jalan Desa Utama",
        addressLine2: "Taman Desa",
        city: "Kuala Lumpur",
        state: "W.P. Kuala Lumpur",
        postalCode: "58100",
        country: "Malaysia",
        status: "active",
        publishStatus: "published",
        managerId: IDS.adminUser,
      },
      {
        id: IDS.prop3,
        organizationId: org.id,
        name: "Bangsar South Residences",
        propertyCode: "BSR",
        propertyType: "serviced_apartment",
        addressLine1: "Jalan Kerinchi",
        addressLine2: "Bangsar South",
        city: "Kuala Lumpur",
        state: "W.P. Kuala Lumpur",
        postalCode: "59200",
        country: "Malaysia",
        status: "active",
        publishStatus: "published",
        managerId: IDS.managerUser,
        insuranceProvider: "Tokio Marine",
        insurancePolicyNo: "TM-2025-005678",
        insuranceExpiryDate: d("2027-03-31"),
        insuranceCoverage: 8000000,
      },
      {
        id: IDS.propPV9,
        organizationId: org.id,
        name: "PV9 Residence",
        propertyCode: "PV9",
        propertyType: "condominium",
        addressLine1: "Jalan PV9",
        addressLine2: "Taman PV9, Setapak",
        city: "Kuala Lumpur",
        state: "W.P. Kuala Lumpur",
        postalCode: "53300",
        country: "Malaysia",
        status: "active",
        publishStatus: "published",
        hasPaxDeduction: true,
        paxDeductionAmount: 50,
      },
    ],
  });

  // =========================================================================
  // 8. Buildings
  // =========================================================================
  console.log("Creating buildings...");
  await prisma.building.createMany({
    data: [
      { id: IDS.bldgA, organizationId: org.id, propertyId: IDS.prop1, name: "Tower A", code: "A", status: "active" },
      { id: IDS.bldgB, organizationId: org.id, propertyId: IDS.prop1, name: "Tower B", code: "B", status: "active" },
      { id: IDS.bldgSR, organizationId: org.id, propertyId: IDS.prop3, name: "Block A", code: "A", status: "active" },
      { id: IDS.bldgPV9A, organizationId: org.id, propertyId: IDS.propPV9, name: "Tower A", code: "A", status: "active" },
    ],
  });

  // =========================================================================
  // 9. Apartments + Listings (the post-three-table-refactor shape)
  //
  // Each demo "unit" is split into:
  //   • Apartment — physical/shared attrs (bedrooms, bathrooms, floor,
  //     amenities, photos, etc.). Keyed by (propertyId, unitCode).
  //   • Listing  — commercial offer fields (rentalRate, occupancyStatus,
  //     listingStatus, deposits, etc.). One Listing per listingType per
  //     Apartment. listingType is the OLD `unitType` value.
  //
  // listingMode is derived per Apartment:
  //   • WHOLE       — whole-unit listing types ("apartment", "studio",
  //                   "penthouse", "shophouse"). One listing per apartment.
  //   • PARTITIONED — room types ("Master", "Medium", "Small", "Partition").
  //                   Multiple listings per apartment, one per room type.
  //
  // The IDS.unit* ids are now the Listing ids (since Tenancy.unitId,
  // Deposit.unitId, Charge.unitId all FK into Listing via @@map("Unit")).
  // =========================================================================
  console.log("Creating apartments + listings...");

  type UnitDef = {
    listingId: string;
    apartmentId: string;
    propertyId: string;
    unitCode: string;
    listingType: string;
    listingMode: "WHOLE" | "PARTITIONED";
    bedrooms: number;
    bathrooms: number;
    floorArea: number;
    floor: number;
    facing?: string;
    furnishingLevel?: string;
    amenities: string[];
    publishedTitle?: string;
    publishedDescription?: string;
    rentalRate: number;
    baseRentAmount?: number;
    occupancyStatus: "occupied" | "vacant";
    listingStatus: "listed" | "unlisted";
    readyNow?: boolean;
    vacantSince?: Date;
  };

  // Stable apartment IDs (one per physical apartment). The three PV9 A-11-43
  // listings share a single apartment record.
  const aptIds = {
    unitSK1: uuid(), unitSK2: uuid(), unitSK3: uuid(),
    unitSK4: uuid(), unitSK5: uuid(), unitSK6: uuid(),
    unitTD1: uuid(), unitTD2: uuid(), unitTD3: uuid(), unitTD4: uuid(),
    unitBS1: uuid(), unitBS2: uuid(), unitBS3: uuid(),
    unitBS4: uuid(), unitBS5: uuid(),
    unitPV9_1: uuid(), unitPV9_2: uuid(), unitPV9_3: uuid(), unitPV9_4: uuid(),
    // One apartment shared by Master/Medium/Small (PARTITIONED mode).
    unitPV9_A1143: uuid(),
  };

  const unitDefs: UnitDef[] = [
    // -- Seri Kembangan Heights (Tower A: 3 listings) --
    {
      listingId: IDS.unitSK1, apartmentId: aptIds.unitSK1, propertyId: IDS.prop1,
      unitCode: "A-12-01", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 3, bathrooms: 2, floorArea: 1100, floor: 12, facing: "East",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool", "security"],
      rentalRate: 2200, baseRentAmount: 2200,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitSK2, apartmentId: aptIds.unitSK2, propertyId: IDS.prop1,
      unitCode: "A-15-03", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 2, bathrooms: 2, floorArea: 900, floor: 15, facing: "West",
      furnishingLevel: "partially_furnished",
      amenities: ["parking", "gym", "pool"],
      rentalRate: 1800, baseRentAmount: 1800,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitSK3, apartmentId: aptIds.unitSK3, propertyId: IDS.prop1,
      unitCode: "A-08-02", listingType: "studio", listingMode: "WHOLE",
      bedrooms: 0, bathrooms: 1, floorArea: 550, floor: 8, facing: "North",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym"],
      rentalRate: 1200, baseRentAmount: 1200,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitSK4, apartmentId: aptIds.unitSK4, propertyId: IDS.prop1,
      unitCode: "B-10-01", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 3, bathrooms: 2, floorArea: 1200, floor: 10, facing: "South",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool", "security", "playground"],
      rentalRate: 2400, baseRentAmount: 2400,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitSK5, apartmentId: aptIds.unitSK5, propertyId: IDS.prop1,
      unitCode: "B-20-02", listingType: "penthouse", listingMode: "WHOLE",
      bedrooms: 4, bathrooms: 3, floorArea: 2000, floor: 20, facing: "East",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool", "security", "concierge"],
      rentalRate: 3500, baseRentAmount: 3500,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitSK6, apartmentId: aptIds.unitSK6, propertyId: IDS.prop1,
      unitCode: "B-05-03", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 2, bathrooms: 1, floorArea: 800, floor: 5, facing: "West",
      furnishingLevel: "unfurnished",
      amenities: ["parking"],
      rentalRate: 1500, baseRentAmount: 1500,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
      vacantSince: d("2026-03-01"),
      publishedTitle: "Cozy 2BR in Seri Kembangan",
      publishedDescription: "Bright and airy 2-bedroom apartment with mountain views. Close to public transport.",
    },
    // -- Taman Desa Shophouses --
    {
      listingId: IDS.unitTD1, apartmentId: aptIds.unitTD1, propertyId: IDS.prop2,
      unitCode: "TD-01", listingType: "shophouse", listingMode: "WHOLE",
      bedrooms: 0, bathrooms: 1, floorArea: 1500, floor: 0,
      furnishingLevel: "unfurnished",
      amenities: ["loading_bay", "parking"],
      rentalRate: 3200, baseRentAmount: 3200,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitTD2, apartmentId: aptIds.unitTD2, propertyId: IDS.prop2,
      unitCode: "TD-02", listingType: "shophouse", listingMode: "WHOLE",
      bedrooms: 0, bathrooms: 1, floorArea: 1500, floor: 0,
      furnishingLevel: "unfurnished",
      amenities: ["loading_bay", "parking"],
      rentalRate: 3000, baseRentAmount: 3000,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitTD3, apartmentId: aptIds.unitTD3, propertyId: IDS.prop2,
      unitCode: "TD-03", listingType: "shophouse", listingMode: "WHOLE",
      bedrooms: 0, bathrooms: 1, floorArea: 1200, floor: 0,
      furnishingLevel: "unfurnished",
      amenities: ["parking"],
      rentalRate: 2800, baseRentAmount: 2800,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitTD4, apartmentId: aptIds.unitTD4, propertyId: IDS.prop2,
      unitCode: "TD-04", listingType: "shophouse", listingMode: "WHOLE",
      bedrooms: 0, bathrooms: 1, floorArea: 1200, floor: 0,
      furnishingLevel: "unfurnished",
      amenities: ["parking"],
      rentalRate: 2600, baseRentAmount: 2600,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
      vacantSince: d("2026-02-15"),
      publishedTitle: "Prime Shophouse in Taman Desa",
      publishedDescription: "Strategic corner lot shophouse. High foot traffic area, suitable for F&B or retail.",
    },
    // -- Bangsar South Residences (Block A) --
    {
      listingId: IDS.unitBS1, apartmentId: aptIds.unitBS1, propertyId: IDS.prop3,
      unitCode: "A-25-01", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 2, bathrooms: 2, floorArea: 950, floor: 25, facing: "KLCC View",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool", "security", "concierge"],
      rentalRate: 2800, baseRentAmount: 2800,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitBS2, apartmentId: aptIds.unitBS2, propertyId: IDS.prop3,
      unitCode: "A-18-02", listingType: "studio", listingMode: "WHOLE",
      bedrooms: 0, bathrooms: 1, floorArea: 500, floor: 18, facing: "South",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool"],
      rentalRate: 1800, baseRentAmount: 1800,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitBS3, apartmentId: aptIds.unitBS3, propertyId: IDS.prop3,
      unitCode: "A-30-03", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 3, bathrooms: 2, floorArea: 1350, floor: 30, facing: "East",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool", "security", "concierge", "sauna"],
      rentalRate: 3500, baseRentAmount: 3500,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    {
      listingId: IDS.unitBS4, apartmentId: aptIds.unitBS4, propertyId: IDS.prop3,
      unitCode: "A-10-04", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 2, bathrooms: 1, floorArea: 850, floor: 10, facing: "West",
      furnishingLevel: "partially_furnished",
      amenities: ["parking", "gym", "pool"],
      rentalRate: 2200, baseRentAmount: 2200,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
      vacantSince: d("2026-03-15"),
      publishedTitle: "Modern 2BR at Bangsar South",
      publishedDescription: "Walking distance to The Sphere, Nexus, and LRT station. Ideal for young professionals.",
    },
    {
      listingId: IDS.unitBS5, apartmentId: aptIds.unitBS5, propertyId: IDS.prop3,
      unitCode: "A-22-05", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 2, bathrooms: 2, floorArea: 1000, floor: 22, facing: "North",
      furnishingLevel: "fully_furnished",
      amenities: ["parking", "gym", "pool", "security"],
      rentalRate: 2600, baseRentAmount: 2600,
      occupancyStatus: "occupied", listingStatus: "unlisted",
    },
    // -- PV9 Residence (Tower A) — 4 vacant whole-unit listings --
    {
      listingId: IDS.unitPV9_1, apartmentId: aptIds.unitPV9_1, propertyId: IDS.propPV9,
      unitCode: "A-22-13A", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 3, bathrooms: 2, floorArea: 1000, floor: 22,
      amenities: ["parking", "gym", "pool"],
      rentalRate: 2000,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
    },
    {
      listingId: IDS.unitPV9_2, apartmentId: aptIds.unitPV9_2, propertyId: IDS.propPV9,
      unitCode: "A-15-07", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 2, bathrooms: 1, floorArea: 850, floor: 15,
      amenities: ["parking", "gym", "pool"],
      rentalRate: 1700,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
    },
    {
      listingId: IDS.unitPV9_3, apartmentId: aptIds.unitPV9_3, propertyId: IDS.propPV9,
      unitCode: "A-08-03", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 1, bathrooms: 1, floorArea: 650, floor: 8,
      amenities: ["parking", "gym"],
      rentalRate: 1300,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
    },
    {
      listingId: IDS.unitPV9_4, apartmentId: aptIds.unitPV9_4, propertyId: IDS.propPV9,
      unitCode: "A-30-01", listingType: "apartment", listingMode: "WHOLE",
      bedrooms: 3, bathrooms: 2, floorArea: 1200, floor: 30,
      amenities: ["parking", "gym", "pool", "security"],
      rentalRate: 2400,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
    },
    // -- PV9 — A-11-43 split into three rentable rooms --
    // Canonical "share unit" pattern: one Apartment (PARTITIONED), three
    // Listings (Master / Medium / Small) each independently rentable.
    {
      listingId: IDS.unitPV9_A1143_master, apartmentId: aptIds.unitPV9_A1143, propertyId: IDS.propPV9,
      unitCode: "A-11-43", listingType: "Master", listingMode: "PARTITIONED",
      bedrooms: 1, bathrooms: 1, floorArea: 220, floor: 11,
      amenities: ["parking", "gym", "pool", "private_bathroom"],
      rentalRate: 1500,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
      publishedTitle: "Master room at PV9 (A-11-43)",
      publishedDescription: "Largest room with attached bathroom. Shared kitchen and living area.",
    },
    {
      listingId: IDS.unitPV9_A1143_medium, apartmentId: aptIds.unitPV9_A1143, propertyId: IDS.propPV9,
      unitCode: "A-11-43", listingType: "Medium", listingMode: "PARTITIONED",
      bedrooms: 1, bathrooms: 0, floorArea: 140, floor: 11,
      amenities: ["parking", "gym", "pool"],
      rentalRate: 1100,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
      publishedTitle: "Medium room at PV9 (A-11-43)",
      publishedDescription: "Mid-sized room with shared bathroom. Shared kitchen and living area.",
    },
    {
      listingId: IDS.unitPV9_A1143_small, apartmentId: aptIds.unitPV9_A1143, propertyId: IDS.propPV9,
      unitCode: "A-11-43", listingType: "Small", listingMode: "PARTITIONED",
      bedrooms: 1, bathrooms: 0, floorArea: 90, floor: 11,
      amenities: ["parking", "gym", "pool"],
      rentalRate: 800,
      occupancyStatus: "vacant", listingStatus: "listed", readyNow: true,
      publishedTitle: "Small room at PV9 (A-11-43)",
      publishedDescription: "Single-occupancy room with shared bathroom. Shared kitchen and living area.",
    },
  ];

  // Build the unique apartment rows first. For PARTITIONED apartments where
  // multiple unitDefs share one apartmentId, we keep the first occurrence and
  // its physical attrs (bedrooms/bathrooms here describe the WHOLE physical
  // unit when rooms are listed individually — using the master-room's stats
  // as a reasonable proxy).
  const seenApartmentIds = new Set<string>();
  const apartmentsData = unitDefs.flatMap((u) => {
    if (seenApartmentIds.has(u.apartmentId)) return [];
    seenApartmentIds.add(u.apartmentId);
    return [{
      id: u.apartmentId,
      organizationId: org.id,
      propertyId: u.propertyId,
      unitCode: u.unitCode,
      listingMode: u.listingMode,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      floorArea: u.floorArea,
      floor: u.floor,
      facing: u.facing ?? null,
      furnishingLevel: u.furnishingLevel ?? null,
      amenities: u.amenities,
      publishedTitle: u.publishedTitle ?? null,
      publishedDescription: u.publishedDescription ?? null,
    }];
  });

  await prisma.apartment.createMany({ data: apartmentsData });

  await prisma.listing.createMany({
    data: unitDefs.map((u) => ({
      id: u.listingId,
      organizationId: org.id,
      apartmentId: u.apartmentId,
      listingType: u.listingType,
      occupancyStatus: u.occupancyStatus,
      listingStatus: u.listingStatus,
      currency: "MYR",
      rentalRate: u.rentalRate,
      baseRentAmount: u.baseRentAmount ?? null,
      readyNow: u.readyNow ?? false,
      vacantSince: u.vacantSince ?? null,
      // Media lives per-Listing per spec 2026-05-24. Seed creates empty
      // arrays; admin uploads after seed run.
      photoKeys: [] as string[],
      videoKeys: [] as string[],
    })),
  });

  // =========================================================================
  // 10. Unit Attributes
  // =========================================================================
  console.log("Creating unit attributes...");
  await prisma.unitAttribute.createMany({
    data: [
      { id: uuid(), organizationId: org.id, unitId: IDS.unitSK1, attributeKey: "parking_lot", attributeValue: "A-B1-012" },
      { id: uuid(), organizationId: org.id, unitId: IDS.unitSK1, attributeKey: "water_heater", attributeValue: "yes" },
      { id: uuid(), organizationId: org.id, unitId: IDS.unitSK5, attributeKey: "parking_lot", attributeValue: "B-B1-201, B-B1-202" },
      { id: uuid(), organizationId: org.id, unitId: IDS.unitBS1, attributeKey: "parking_lot", attributeValue: "P2-025" },
      { id: uuid(), organizationId: org.id, unitId: IDS.unitBS3, attributeKey: "parking_lot", attributeValue: "P2-030, P2-031" },
      { id: uuid(), organizationId: org.id, unitId: IDS.unitTD1, attributeKey: "signage_allowed", attributeValue: "yes" },
      { id: uuid(), organizationId: org.id, unitId: IDS.unitTD1, attributeKey: "electricity_deposit", attributeValue: "RM 1,000" },
    ],
  });

  // =========================================================================
  // 11. Landlord Tenancies
  // =========================================================================
  console.log("Creating landlord tenancies...");
  await prisma.landlordTenancy.createMany({
    data: [
      {
        id: IDS.lt1, organizationId: org.id, propertyId: IDS.prop1, landlordId: IDS.landlord1,
        startDate: d("2024-01-01"), monthlyRent: 15000, depositAmount: 30000,
        status: "active", notes: "Dato' Razak owns all units in Seri Kembangan Heights",
      },
      {
        id: IDS.lt2, organizationId: org.id, propertyId: IDS.prop2, landlordId: IDS.landlord2,
        startDate: d("2024-06-01"), monthlyRent: 12000, depositAmount: 24000,
        status: "active", notes: "Puan Mei Ling owns the Taman Desa shophouse row",
      },
      {
        id: IDS.lt3, organizationId: org.id, propertyId: IDS.prop3, landlordId: IDS.landlord1,
        startDate: d("2025-01-01"), monthlyRent: 20000, depositAmount: 40000,
        status: "active", notes: "Dato' Razak also owns Bangsar South Residences",
      },
    ],
  });

  // =========================================================================
  // 12. Tenancies (10 active tenancies)
  // =========================================================================
  console.log("Creating tenancies...");

  // Mapping: tenant → unit, with staggered start dates and realistic rents
  const tenancyData = [
    { id: IDS.ten1,  code: "TEN-2025-001", tenant: IDS.tenant1,  prop: IDS.prop1, unit: IDS.unitSK1, rent: 2200, deposit: 4400, start: "2025-10-01", term: 12 },
    { id: IDS.ten2,  code: "TEN-2025-002", tenant: IDS.tenant2,  prop: IDS.prop1, unit: IDS.unitSK2, rent: 1800, deposit: 3600, start: "2025-11-01", term: 12 },
    { id: IDS.ten3,  code: "TEN-2025-003", tenant: IDS.tenant3,  prop: IDS.prop1, unit: IDS.unitSK3, rent: 1200, deposit: 2400, start: "2025-12-01", term: 12 },
    { id: IDS.ten4,  code: "TEN-2026-004", tenant: IDS.tenant4,  prop: IDS.prop1, unit: IDS.unitSK4, rent: 2400, deposit: 4800, start: "2026-01-01", term: 24 },
    { id: IDS.ten5,  code: "TEN-2026-005", tenant: IDS.tenant6,  prop: IDS.prop1, unit: IDS.unitSK5, rent: 3500, deposit: 7000, start: "2026-01-01", term: 24 },
    { id: IDS.ten6,  code: "TEN-2026-006", tenant: IDS.tenant7,  prop: IDS.prop2, unit: IDS.unitTD1, rent: 3200, deposit: 6400, start: "2025-10-01", term: 24 },
    { id: IDS.ten7,  code: "TEN-2026-007", tenant: IDS.tenant8,  prop: IDS.prop2, unit: IDS.unitTD2, rent: 3000, deposit: 6000, start: "2026-02-01", term: 12 },
    { id: IDS.ten8,  code: "TEN-2026-008", tenant: IDS.tenant5,  prop: IDS.prop2, unit: IDS.unitTD3, rent: 2800, deposit: 5600, start: "2026-01-15", term: 12 },
    { id: IDS.ten9,  code: "TEN-2026-009", tenant: IDS.tenant9,  prop: IDS.prop3, unit: IDS.unitBS1, rent: 2800, deposit: 5600, start: "2025-11-01", term: 12 },
    { id: IDS.ten10, code: "TEN-2026-010", tenant: IDS.tenant10, prop: IDS.prop3, unit: IDS.unitBS2, rent: 1800, deposit: 3600, start: "2026-02-01", term: 12 },
  ];

  await prisma.tenancy.createMany({
    data: tenancyData.map((t) => {
      const startDate = d(t.start);
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + t.term);
      return {
        id: t.id,
        organizationId: org.id,
        propertyId: t.prop,
        unitId: t.unit,
        tenantPartyId: t.tenant,
        tenancyCode: t.code,
        status: "active",
        billingStatus: "current",
        startDate,
        endDate,
        monthlyRentAmount: t.rent,
        depositAmount: t.deposit,
        termMonths: t.term,
        autoRenew: t.term === 24,
        noticePeriodDays: 30,
      };
    }),
  });

  // =========================================================================
  // 13. Deposits (security deposit + utility deposit per tenancy)
  // =========================================================================
  console.log("Creating deposits...");
  await prisma.deposit.createMany({
    data: tenancyData.flatMap((t) => [
      {
        id: uuid(), organizationId: org.id, tenancyId: t.id,
        partyId: t.tenant, unitId: t.unit,
        type: "security", amount: t.deposit, status: "held",
      },
      {
        id: uuid(), organizationId: org.id, tenancyId: t.id,
        partyId: t.tenant, unitId: t.unit,
        type: "utility", amount: t.rent * 0.5, status: "held",
      },
    ]),
  });

  // =========================================================================
  // 14. Charge Templates
  // =========================================================================
  console.log("Creating charge templates...");
  await prisma.chargeTemplate.createMany({
    data: [
      { id: IDS.ctRent, organizationId: org.id, name: "Monthly Rent", chargeType: "rent", amount: 0, currency: "MYR", frequency: "monthly", description: "Monthly rental charge" },
      { id: IDS.ctUtility, organizationId: org.id, name: "Utility Recharge", chargeType: "utility", amount: 200, currency: "MYR", frequency: "monthly", description: "Water and electricity recharge" },
      { id: IDS.ctMaint, organizationId: org.id, name: "Maintenance Fee", chargeType: "maintenance", amount: 350, currency: "MYR", frequency: "monthly", description: "Building maintenance and sinking fund", propertyType: "condominium" },
    ],
  });

  // =========================================================================
  // 15. Late Fee Rules
  // =========================================================================
  console.log("Creating late fee rules...");
  await prisma.lateFeeRule.create({
    data: {
      id: IDS.lfr1, organizationId: org.id,
      name: "Standard Late Fee",
      daysAfterDue: 7,
      feeType: "flat",
      feeAmount: 50,
      maxAmount: 200,
      isActive: true,
      appliesTo: "all",
    },
  });

  // =========================================================================
  // 16. Recurring Charges (rent auto-generation for each tenancy)
  // =========================================================================
  console.log("Creating recurring charges...");
  await prisma.recurringCharge.createMany({
    data: tenancyData.map((t) => ({
      id: uuid(), organizationId: org.id, tenancyId: t.id,
      chargeType: "rent", amount: t.rent, currency: "MYR",
      frequency: "monthly", dayOfMonth: 1,
      nextChargeDate: d("2026-05-01"),
      lastGeneratedAt: d("2026-04-01"),
      isActive: true,
      description: `Monthly rent for ${t.code}`,
    })),
  });

  // =========================================================================
  // 17. Charges — 3 months of rent (Feb, Mar, Apr 2026)
  // =========================================================================
  console.log("Creating charges...");
  const months = [
    { label: "Feb 2026", due: "2026-02-01", from: "2026-02-01", to: "2026-02-28" },
    { label: "Mar 2026", due: "2026-03-01", from: "2026-03-01", to: "2026-03-31" },
    { label: "Apr 2026", due: "2026-04-01", from: "2026-04-01", to: "2026-04-30" },
  ];

  let chargeSeq = 1;
  const allCharges: Array<{
    id: string; chargeNumber: string; tenancyId: string; unitId: string;
    partyId: string; amount: number; dueDate: Date; monthLabel: string;
    from: Date; to: Date;
  }> = [];

  for (const m of months) {
    for (const t of tenancyData) {
      // Only generate charges if tenancy was active by the due date
      if (d(t.start) <= d(m.due)) {
        const chargeId = uuid();
        const chargeNumber = `CHG-2026-${String(chargeSeq++).padStart(4, "0")}`;
        allCharges.push({
          id: chargeId, chargeNumber, tenancyId: t.id, unitId: t.unit,
          partyId: t.tenant, amount: t.rent, dueDate: d(m.due),
          monthLabel: m.label, from: d(m.from), to: d(m.to),
        });
      }
    }
  }

  // Determine payment status: Feb & Mar fully paid (except tenant10 Mar overdue), Apr all outstanding
  await prisma.charge.createMany({
    data: allCharges.map((c) => {
      const isFeb = c.monthLabel === "Feb 2026";
      const isMar = c.monthLabel === "Mar 2026";
      const isApr = c.monthLabel === "Apr 2026";

      // Tenant10 (Muhammad Hafiz) has overdue March rent
      const isOverdue = isMar && c.partyId === IDS.tenant10;

      let status: string;
      let outstandingAmount: number;

      if (isFeb || (isMar && !isOverdue)) {
        status = "paid";
        outstandingAmount = 0;
      } else if (isOverdue) {
        status = "overdue";
        outstandingAmount = c.amount;
      } else {
        // April — posted but not yet due (due date is April 1)
        status = "posted";
        outstandingAmount = c.amount;
      }

      return {
        id: c.id,
        organizationId: org.id,
        chargeNumber: c.chargeNumber,
        tenancyId: c.tenancyId,
        unitId: c.unitId,
        partyId: c.partyId,
        chargeType: "rent",
        status,
        description: `Rent for ${c.monthLabel}`,
        dueDate: c.dueDate,
        postedAt: new Date(c.dueDate.getTime() - 7 * 24 * 60 * 60 * 1000), // posted 7 days before due
        amount: c.amount,
        currency: "MYR",
        outstandingAmount,
        chargeableFrom: c.from,
        chargeableTo: c.to,
        lateFeeApplied: isOverdue,
        lateFeeAmount: isOverdue ? 50 : undefined,
      };
    }),
  });

  // =========================================================================
  // 18. Charge Events (created + paid events)
  // =========================================================================
  console.log("Creating charge events...");
  const chargeEvents = allCharges.flatMap((c) => {
    const events = [
      {
        id: uuid(), organizationId: org.id, chargeId: c.id,
        eventType: "created", eventAt: new Date(c.dueDate.getTime() - 7 * 24 * 60 * 60 * 1000),
        actorUserId: IDS.adminUser, payloadJson: {},
      },
    ];
    const isFeb = c.monthLabel === "Feb 2026";
    const isMar = c.monthLabel === "Mar 2026";
    const isOverdue = isMar && c.partyId === IDS.tenant10;

    if (isFeb || (isMar && !isOverdue)) {
      events.push({
        id: uuid(), organizationId: org.id, chargeId: c.id,
        eventType: "paid", eventAt: new Date(c.dueDate.getTime() + 3 * 24 * 60 * 60 * 1000),
        actorUserId: IDS.adminUser, payloadJson: { method: "bank_transfer" },
      });
    }
    return events;
  });

  await prisma.chargeEvent.createMany({ data: chargeEvents });

  // =========================================================================
  // 19. Payments (for Feb & Mar paid charges)
  // =========================================================================
  console.log("Creating payments...");
  const paidCharges = allCharges.filter((c) => {
    const isFeb = c.monthLabel === "Feb 2026";
    const isMar = c.monthLabel === "Mar 2026";
    const isOverdue = isMar && c.partyId === IDS.tenant10;
    return isFeb || (isMar && !isOverdue);
  });

  let paymentSeq = 1;
  const payments = paidCharges.map((c) => ({
    id: uuid(),
    chargeId: c.id,
    organizationId: org.id,
    paymentNumber: `PAY-2026-${String(paymentSeq++).padStart(4, "0")}`,
    partyId: c.partyId,
    paymentType: "tenant_payment",
    paymentMethod: "bank_transfer",
    status: "completed",
    amount: c.amount,
    currency: "MYR",
    receivedAt: new Date(c.dueDate.getTime() + 2 * 24 * 60 * 60 * 1000), // paid 2 days after due
    referenceNote: `Rent payment ${c.monthLabel}`,
  }));

  await prisma.payment.createMany({
    data: payments.map(({ chargeId, ...p }) => p),
  });

  // =========================================================================
  // 20. Payment Allocations
  // =========================================================================
  console.log("Creating payment allocations...");
  await prisma.paymentAllocation.createMany({
    data: payments.map((p) => ({
      id: uuid(),
      organizationId: org.id,
      paymentId: p.id,
      chargeId: p.chargeId,
      allocatedAmount: p.amount,
      allocatedAt: p.receivedAt,
    })),
  });

  // =========================================================================
  // 21. Bills (property expenses)
  // =========================================================================
  console.log("Creating bills...");
  await prisma.commissionBill.createMany({
    data: [
      {
        id: uuid(), organizationId: org.id, billNumber: "BILL-2026-0001",
        partyId: IDS.landlord1, propertyId: IDS.prop1,
        category: "maintenance", description: "Lift maintenance service - Q1 2026",
        amount: 4500, currency: "MYR", status: "paid",
        dueDate: d("2026-03-15"), paidAt: dt("2026-03-12T10:00:00Z"),
        notes: "Quarterly lift servicing by Otis Elevator",
      },
      {
        id: uuid(), organizationId: org.id, billNumber: "BILL-2026-0002",
        partyId: IDS.landlord2, propertyId: IDS.prop2,
        category: "insurance", description: "Fire insurance renewal 2026-2027",
        amount: 2800, currency: "MYR", status: "pending",
        dueDate: d("2026-04-30"),
        notes: "Annual fire insurance premium for Taman Desa shophouses",
      },
      {
        id: uuid(), organizationId: org.id, billNumber: "BILL-2026-0003",
        partyId: IDS.landlord1, propertyId: IDS.prop3,
        category: "repair", description: "Water heater replacement - Unit A-25-01",
        amount: 850, currency: "MYR", status: "paid",
        dueDate: d("2026-02-28"), paidAt: dt("2026-02-25T14:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, billNumber: "BILL-2026-0004",
        partyId: IDS.landlord1, propertyId: IDS.prop1,
        category: "utility", description: "Common area electricity - March 2026",
        amount: 1200, currency: "MYR", status: "pending",
        dueDate: d("2026-04-15"),
      },
    ],
  });

  // =========================================================================
  // 22. Cash Movements
  // =========================================================================
  console.log("Creating cash movements...");
  await prisma.cashMovement.createMany({
    data: [
      {
        id: uuid(), organizationId: org.id, movementNumber: "CM-2026-0001",
        type: "inflow", category: "rent_collection",
        description: "February 2026 rent collection batch",
        amount: 23400, currency: "MYR",
        propertyId: IDS.prop1, movementDate: d("2026-02-05"),
        paymentTender: "bank_transfer", allocationStatus: "allocated",
      },
      {
        id: uuid(), organizationId: org.id, movementNumber: "CM-2026-0002",
        type: "outflow", category: "maintenance",
        description: "Lift maintenance payment - Otis Elevator",
        amount: 4500, currency: "MYR",
        propertyId: IDS.prop1, partyId: IDS.landlord1,
        movementDate: d("2026-03-12"), paymentTender: "bank_transfer",
        allocationStatus: "allocated",
      },
      {
        id: uuid(), organizationId: org.id, movementNumber: "CM-2026-0003",
        type: "inflow", category: "rent_collection",
        description: "March 2026 rent collection batch",
        amount: 21600, currency: "MYR",
        propertyId: IDS.prop1, movementDate: d("2026-03-05"),
        paymentTender: "bank_transfer", allocationStatus: "allocated",
      },
      {
        id: uuid(), organizationId: org.id, movementNumber: "CM-2026-0004",
        type: "outflow", category: "repair",
        description: "Water heater replacement - Bangsar South A-25-01",
        amount: 850, currency: "MYR",
        propertyId: IDS.prop3, partyId: IDS.landlord1,
        movementDate: d("2026-02-25"), paymentTender: "bank_transfer",
        allocationStatus: "allocated",
      },
    ],
  });

  // =========================================================================
  // 23. Email Templates
  // =========================================================================
  console.log("Creating email templates...");
  await prisma.emailTemplate.createMany({
    data: [
      {
        id: IDS.etWelcome, organizationId: org.id,
        name: "tenant_welcome",
        subject: "Welcome to {{property_name}} - Your Tenancy Details",
        body: `Dear {{tenant_name}},

Welcome to {{property_name}}! We are pleased to confirm your tenancy for unit {{unit_code}}.

Tenancy Details:
- Monthly Rent: RM {{monthly_rent}}
- Start Date: {{start_date}}
- End Date: {{end_date}}
- Security Deposit: RM {{deposit_amount}}

Please ensure your monthly rent is paid by the 1st of each month via bank transfer.

If you have any questions, please do not hesitate to contact us.

Best regards,
KAEN PROPERTIES MANAGEMENT SDN BHD`,
        description: "Sent to new tenants upon move-in",
        isActive: true,
      },
      {
        id: IDS.etReminder, organizationId: org.id,
        name: "rent_reminder",
        subject: "Rent Reminder - {{month_year}} Payment Due",
        body: `Dear {{tenant_name}},

This is a friendly reminder that your rent of RM {{amount}} for {{month_year}} is due on {{due_date}}.

Please ensure payment is made via bank transfer to:
Bank: Maybank
Account: 5121-6789-0123
Reference: {{tenancy_code}}

Thank you for your prompt payment.

Best regards,
KAEN PROPERTIES MANAGEMENT SDN BHD`,
        description: "Monthly rent reminder sent before due date",
        isActive: true,
      },
      {
        id: IDS.etOverdue, organizationId: org.id,
        name: "overdue_notice",
        subject: "OVERDUE: Rent Payment for {{month_year}}",
        body: `Dear {{tenant_name}},

Our records indicate that your rent payment of RM {{amount}} for {{month_year}} is overdue.

Outstanding Amount: RM {{outstanding}}
Late Fee: RM {{late_fee}}
Total Due: RM {{total_due}}

Please make payment immediately to avoid further action. If you have already made payment, please disregard this notice and contact us with your payment reference.

Best regards,
KAEN PROPERTIES MANAGEMENT SDN BHD`,
        description: "Sent when rent is overdue past grace period",
        isActive: true,
      },
    ],
  });

  // =========================================================================
  // 24. Notifications
  // =========================================================================
  console.log("Creating notifications...");
  await prisma.notification.createMany({
    data: [
      {
        id: uuid(), organizationId: org.id, userId: IDS.adminUser,
        domain: "billing", title: "Overdue rent detected",
        body: "Muhammad Hafiz bin Osman has an overdue rent payment of RM 1,800 for March 2026.",
        read: false, actionUrl: "/billing/charges",
        createdAt: dt("2026-03-08T09:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, userId: IDS.adminUser,
        domain: "tenancy", title: "Tenancy expiring soon",
        body: "Tenancy TEN-2025-001 (Ahmad Faizal - Unit A-12-01) expires on 2026-10-01. Consider sending renewal notice.",
        read: false, actionUrl: "/tenancy/tenancies",
        createdAt: dt("2026-04-01T08:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, userId: IDS.adminUser,
        domain: "property", title: "Insurance expiry reminder",
        body: "Fire insurance for Taman Desa Shophouses needs renewal. Bill BILL-2026-0002 is pending.",
        read: true, actionUrl: "/billing/charges",
        createdAt: dt("2026-03-25T10:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, userId: IDS.managerUser,
        domain: "property", title: "Vacant unit listed",
        body: "Unit B-05-03 at Seri Kembangan Heights has been listed for rent at RM 1,500/month.",
        read: true, actionUrl: "/inventory/properties",
        createdAt: dt("2026-03-01T11:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, userId: IDS.adminUser,
        domain: "billing", title: "April charges generated",
        body: "Monthly rent charges for April 2026 have been generated for all active tenancies.",
        read: false, actionUrl: "/billing/charges",
        createdAt: dt("2026-03-25T06:00:00Z"),
      },
    ],
  });

  // =========================================================================
  // 25. Notification Queue (email history)
  // =========================================================================
  console.log("Creating notification queue...");
  await prisma.notificationQueue.createMany({
    data: [
      {
        id: uuid(), organizationId: org.id,
        type: "rent_reminder", recipientEmail: "hafiz.osman@gmail.com",
        recipientName: "Muhammad Hafiz bin Osman",
        subject: "Rent Reminder - March 2026 Payment Due",
        body: "Dear Muhammad Hafiz, your rent of RM 1,800 for March 2026 is due on 2026-03-01.",
        channel: "email", status: "sent", sentAt: dt("2026-02-25T06:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        type: "overdue_notice", recipientEmail: "hafiz.osman@gmail.com",
        recipientName: "Muhammad Hafiz bin Osman",
        subject: "OVERDUE: Rent Payment for March 2026",
        body: "Dear Muhammad Hafiz, your rent payment of RM 1,800 for March 2026 is overdue.",
        channel: "email", status: "sent", sentAt: dt("2026-03-08T09:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        type: "rent_reminder", recipientEmail: "faizal.ismail@gmail.com",
        recipientName: "Ahmad Faizal bin Ismail",
        subject: "Rent Reminder - April 2026 Payment Due",
        body: "Dear Ahmad Faizal, your rent of RM 2,200 for April 2026 is due on 2026-04-01.",
        channel: "email", status: "sent", sentAt: dt("2026-03-25T06:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        type: "rent_reminder", recipientEmail: "james.wilson@proton.me",
        recipientName: "James Wilson",
        subject: "Rent Reminder - April 2026 Payment Due",
        body: "Dear James, your rent of RM 3,500 for April 2026 is due on 2026-04-01.",
        channel: "email", status: "failed", errorMessage: "SMTP connection timeout",
        createdAt: dt("2026-03-25T06:00:00Z"),
      },
    ],
  });

  // =========================================================================
  // 26. Audit Logs
  // =========================================================================
  console.log("Creating audit logs...");
  await prisma.auditLog.createMany({
    data: [
      {
        id: uuid(), organizationId: org.id, actorUserId: IDS.adminUser, actorRole: "admin",
        action: "create", entityType: "Property", entityId: IDS.prop1,
        diff: { actorName: "Kaen Admin", description: "Created property Seri Kembangan Heights" },
        createdAt: dt("2025-09-15T10:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, actorUserId: IDS.adminUser, actorRole: "admin",
        action: "create", entityType: "Property", entityId: IDS.prop2,
        diff: { actorName: "Kaen Admin", description: "Created property Taman Desa Shophouses" },
        createdAt: dt("2025-09-15T10:30:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, actorUserId: IDS.adminUser, actorRole: "admin",
        action: "create", entityType: "Property", entityId: IDS.prop3,
        diff: { actorName: "Kaen Admin", description: "Created property Bangsar South Residences" },
        createdAt: dt("2025-09-15T11:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, actorUserId: IDS.adminUser, actorRole: "admin",
        action: "create", entityType: "Tenancy", entityId: IDS.ten1,
        diff: { actorName: "Kaen Admin", description: "Created tenancy TEN-2025-001 for Ahmad Faizal bin Ismail" },
        createdAt: dt("2025-09-28T14:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, actorUserId: IDS.managerUser, actorRole: "manager",
        action: "update", entityType: "Unit", entityId: IDS.unitSK6,
        diff: { actorName: "Sarah Ahmad", description: "Listed unit B-05-03 for rent at RM 1,500/month" },
        createdAt: dt("2026-03-01T11:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id, actorUserId: IDS.adminUser, actorRole: "admin",
        action: "generate", entityType: "Charge", entityId: IDS.org,
        diff: { actorName: "Kaen Admin", description: "Generated April 2026 rent charges for 10 active tenancies" },
        createdAt: dt("2026-03-25T06:00:00Z"),
      },
    ],
  });

  // =========================================================================
  // 27. Activity Logs
  // =========================================================================
  console.log("Creating activity logs...");
  await prisma.activityLog.createMany({
    data: [
      {
        id: uuid(), organizationId: org.id,
        entityType: "Tenancy", entityId: IDS.ten1, action: "move_in",
        description: "Ahmad Faizal bin Ismail moved into unit A-12-01",
        performedBy: "Kaen Admin", createdAt: dt("2025-10-01T10:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        entityType: "Payment", entityId: IDS.org, action: "batch_receipt",
        description: "Processed February 2026 rent payments - 9 payments received",
        performedBy: "Kaen Admin", createdAt: dt("2026-02-05T15:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        entityType: "Charge", entityId: IDS.org, action: "overdue_flagged",
        description: "Flagged overdue rent for Muhammad Hafiz bin Osman - March 2026",
        performedBy: "System", createdAt: dt("2026-03-08T09:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        entityType: "Tenancy", entityId: IDS.ten7, action: "move_in",
        description: "Aisha binti Hassan moved into shophouse TD-02",
        performedBy: "Sarah Ahmad", createdAt: dt("2026-02-01T09:00:00Z"),
      },
      {
        id: uuid(), organizationId: org.id,
        entityType: "Property", entityId: IDS.prop1, action: "maintenance",
        description: "Scheduled lift maintenance for Q1 2026 - Otis Elevator",
        performedBy: "Sarah Ahmad", createdAt: dt("2026-01-15T11:00:00Z"),
      },
    ],
  });

  // =========================================================================
  // 28. Maintenance Requests
  // =========================================================================
  console.log("Creating maintenance requests...");
  await prisma.maintenanceRequest.createMany({
    data: [
      {
        id: IDS.mr1, organizationId: org.id, tenancyId: IDS.ten1,
        requestNumber: "MR-2026-001",
        category: "plumbing", title: "Leaking kitchen faucet",
        description: "The kitchen faucet has been dripping continuously for 2 days. Water pressure seems normal but the handle doesn't shut off completely.",
        priority: "medium", status: "resolved",
        adminNotes: "Replaced washer and O-ring. Faucet now functioning normally.",
        createdAt: dt("2026-02-10T08:30:00Z"),
        resolvedAt: dt("2026-02-12T14:00:00Z"),
      },
      {
        id: IDS.mr2, organizationId: org.id, tenancyId: IDS.ten5,
        requestNumber: "MR-2026-002",
        category: "electrical", title: "Living room aircon not cooling",
        description: "The air conditioning unit in the living room blows air but doesn't cool. Tried adjusting temperature to lowest setting with no improvement. Unit model: Daikin 2HP.",
        priority: "high", status: "assigned",
        adminNotes: "Technician scheduled for 2026-04-16. Possible refrigerant leak.",
        createdAt: dt("2026-04-10T09:00:00Z"),
      },
      {
        id: IDS.mr3, organizationId: org.id, tenancyId: IDS.ten6,
        requestNumber: "MR-2026-003",
        category: "door_locks", title: "Main door lock jammed",
        description: "The main entrance door lock is very stiff and sometimes won't turn at all. Need urgent attention as it's a security concern.",
        priority: "urgent", status: "resolved",
        adminNotes: "Lock cylinder replaced with new Gatelock model. Keys handed over to tenant.",
        createdAt: dt("2026-03-05T18:00:00Z"),
        resolvedAt: dt("2026-03-06T11:00:00Z"),
      },
      {
        id: IDS.mr4, organizationId: org.id, tenancyId: IDS.ten9,
        requestNumber: "MR-2026-004",
        category: "pipe_drain", title: "Bathroom drain clogged",
        description: "The bathroom floor drain is draining very slowly. Water pools up during showers. Have tried using drain cleaner but no improvement.",
        priority: "medium", status: "open",
        createdAt: dt("2026-04-12T07:00:00Z"),
      },
      {
        id: IDS.mr5, organizationId: org.id, tenancyId: IDS.ten3,
        requestNumber: "MR-2026-005",
        category: "appliances", title: "Washing machine error code E3",
        description: "The washing machine (Samsung front loader) shows error code E3 during spin cycle. Machine stops mid-wash. Happened 3 times this week.",
        priority: "low", status: "open",
        createdAt: dt("2026-04-13T10:00:00Z"),
      },
    ],
  });

  // =========================================================================
  // 29. Announcements
  // =========================================================================
  console.log("Creating announcements...");
  await prisma.announcement.createMany({
    data: [
      {
        id: IDS.ann1, organizationId: org.id,
        title: "Water Supply Interruption - Tower A & B",
        message: "Scheduled water supply maintenance on 20 April 2026 from 9:00 AM to 5:00 PM. Please store sufficient water beforehand. We apologize for any inconvenience.",
        type: "warning",
        startDate: d("2026-04-14"),
        endDate: d("2026-04-20"),
        active: true,
        createdAt: dt("2026-04-12T10:00:00Z"),
      },
      {
        id: IDS.ann2, organizationId: org.id,
        title: "Hari Raya Aidilfitri Office Hours",
        message: "Our management office will be closed from 31 March to 2 April 2026 for Hari Raya Aidilfitri. For emergencies, please call the security hotline at +6012-999-8888. Selamat Hari Raya!",
        type: "info",
        startDate: d("2026-03-25"),
        endDate: d("2026-04-02"),
        active: false,
        createdAt: dt("2026-03-20T09:00:00Z"),
      },
      {
        id: IDS.ann3, organizationId: org.id,
        title: "Rent Payment Reminder - April 2026",
        message: "Kindly be reminded that rent for April 2026 is due by 1 April. Late payments will incur a RM 50 flat fee after 7 days. Please ensure timely payment. Thank you.",
        type: "info",
        startDate: d("2026-03-25"),
        endDate: d("2026-04-15"),
        active: true,
        createdAt: dt("2026-03-25T06:00:00Z"),
      },
    ],
  });

  // =========================================================================
  // 30. Documents & Links (tenancy agreements, house rules)
  // =========================================================================
  console.log("Creating documents...");
  await prisma.document.createMany({
    data: [
      {
        id: IDS.doc1, organizationId: org.id,
        fileName: "House Rules - Seri Kembangan Heights.pdf",
        fileType: "application/pdf", fileSize: 245000,
        storageKey: "docs/house-rules-skh.pdf",
        uploadedBy: IDS.adminUser,
        createdAt: dt("2025-09-20T10:00:00Z"),
      },
      {
        id: IDS.doc2, organizationId: org.id,
        fileName: "Parking Guidelines 2026.pdf",
        fileType: "application/pdf", fileSize: 128000,
        storageKey: "docs/parking-guidelines-2026.pdf",
        uploadedBy: IDS.adminUser,
        createdAt: dt("2026-01-05T09:00:00Z"),
      },
      {
        id: IDS.doc3, organizationId: org.id,
        fileName: "Emergency Contacts & Procedures.pdf",
        fileType: "application/pdf", fileSize: 95000,
        storageKey: "docs/emergency-contacts.pdf",
        uploadedBy: IDS.managerUser,
        createdAt: dt("2025-10-01T08:00:00Z"),
      },
      {
        id: IDS.doc4, organizationId: org.id,
        fileName: "Move-In Checklist Template.pdf",
        fileType: "application/pdf", fileSize: 67000,
        storageKey: "docs/move-in-checklist.pdf",
        uploadedBy: IDS.adminUser,
        createdAt: dt("2025-09-15T12:00:00Z"),
      },
    ],
  });

  // Link documents to properties and tenancies
  await prisma.documentLink.createMany({
    data: [
      // House rules linked to all properties
      { id: uuid(), organizationId: org.id, documentId: IDS.doc1, linkedEntityType: "Property", linkedEntityId: IDS.prop1, label: "House Rules" },
      { id: uuid(), organizationId: org.id, documentId: IDS.doc1, linkedEntityType: "Property", linkedEntityId: IDS.prop3, label: "House Rules" },
      // Parking guidelines for condo properties
      { id: uuid(), organizationId: org.id, documentId: IDS.doc2, linkedEntityType: "Property", linkedEntityId: IDS.prop1, label: "Parking Guidelines" },
      { id: uuid(), organizationId: org.id, documentId: IDS.doc2, linkedEntityType: "Property", linkedEntityId: IDS.prop3, label: "Parking Guidelines" },
      // Emergency contacts for all properties
      { id: uuid(), organizationId: org.id, documentId: IDS.doc3, linkedEntityType: "Property", linkedEntityId: IDS.prop1, label: "Emergency Procedures" },
      { id: uuid(), organizationId: org.id, documentId: IDS.doc3, linkedEntityType: "Property", linkedEntityId: IDS.prop2, label: "Emergency Procedures" },
      { id: uuid(), organizationId: org.id, documentId: IDS.doc3, linkedEntityType: "Property", linkedEntityId: IDS.prop3, label: "Emergency Procedures" },
      // Move-in checklist linked to a few tenancies
      { id: uuid(), organizationId: org.id, documentId: IDS.doc4, linkedEntityType: "Tenancy", linkedEntityId: IDS.ten1, label: "Move-In Checklist" },
      { id: uuid(), organizationId: org.id, documentId: IDS.doc4, linkedEntityType: "Tenancy", linkedEntityId: IDS.ten7, label: "Move-In Checklist" },
    ],
  });

  // =========================================================================
  // Agent Tier Mappings
  // =========================================================================
  console.log("Creating agent tier mappings...");
  await prisma.agentTierMapping.createMany({
    data: [
      { id: IDS.tierMapping1, organizationId: IDS.org, claimType: "tenant_portion", agentLevel: "new_agent", percentage: 40 },
      { id: IDS.tierMapping2, organizationId: IDS.org, claimType: "tenant_portion", agentLevel: "pre_leader", percentage: 45 },
      { id: IDS.tierMapping3, organizationId: IDS.org, claimType: "tenant_portion", agentLevel: "leader", percentage: 50 },
      { id: IDS.tierMapping4, organizationId: IDS.org, claimType: "listing_portion", agentLevel: "new_agent", percentage: 30 },
      { id: IDS.tierMapping5, organizationId: IDS.org, claimType: "listing_portion", agentLevel: "pre_leader", percentage: 35 },
      { id: IDS.tierMapping6, organizationId: IDS.org, claimType: "listing_portion", agentLevel: "leader", percentage: 40 },
    ],
  });

  await prisma.agentLevelThreshold.createMany({
    data: [
      { organizationId: IDS.org, agentLevel: "new_agent",  minCumulativeCommission: "0"     },
      { organizationId: IDS.org, agentLevel: "pre_leader", minCumulativeCommission: "10000" },
      { organizationId: IDS.org, agentLevel: "leader",     minCumulativeCommission: "20000" },
    ],
    skipDuplicates: true,
  });
  console.log("Seeded 3 AgentLevelThreshold rows");

  // TaTier defaults — 9 bands, KAEN company minimum steps of RM108
  // (216 / 324 / 432 / 540 / 648 / 756 / 864 / 972 / 1080). Each band covers
  // a RM1,000 rental range; the top band (Tier 9) is open-ended (rentalMax NULL)
  // so every rental ≥ RM9,001 lands in it.
  await prisma.taTier.createMany({
    data: [
      { organizationId: IDS.org, tier: 1, rentalMin: 0,    rentalMax: 2000, companyMinimum: 216  },
      { organizationId: IDS.org, tier: 2, rentalMin: 2001, rentalMax: 3000, companyMinimum: 324  },
      { organizationId: IDS.org, tier: 3, rentalMin: 3001, rentalMax: 4000, companyMinimum: 432  },
      { organizationId: IDS.org, tier: 4, rentalMin: 4001, rentalMax: 5000, companyMinimum: 540  },
      { organizationId: IDS.org, tier: 5, rentalMin: 5001, rentalMax: 6000, companyMinimum: 648  },
      { organizationId: IDS.org, tier: 6, rentalMin: 6001, rentalMax: 7000, companyMinimum: 756  },
      { organizationId: IDS.org, tier: 7, rentalMin: 7001, rentalMax: 8000, companyMinimum: 864  },
      { organizationId: IDS.org, tier: 8, rentalMin: 8001, rentalMax: 9000, companyMinimum: 972  },
      { organizationId: IDS.org, tier: 9, rentalMin: 9001, rentalMax: null, companyMinimum: 1080 },
    ],
    skipDuplicates: true,
  });
  console.log("Seeded 9 TaTier rows");

  // =========================================================================
  // Room Types — org-level, global, not per-property
  // =========================================================================
  console.log("Creating room types...");
  await prisma.roomType.createMany({
    data: [
      { organizationId: IDS.org, name: "Whole Unit", kind: "WHOLE",     sortOrder: 1, isActive: true },
      { organizationId: IDS.org, name: "Master",     kind: "PARTITION", sortOrder: 2, isActive: true },
      { organizationId: IDS.org, name: "Medium",     kind: "PARTITION", sortOrder: 3, isActive: true },
      { organizationId: IDS.org, name: "Small",      kind: "PARTITION", sortOrder: 4, isActive: true },
      { organizationId: IDS.org, name: "Partition",  kind: "PARTITION", sortOrder: 5, isActive: true },
    ],
    skipDuplicates: true,
  });

  // =========================================================================
  // Commission Claims
  // =========================================================================
  console.log("Creating commission claims...");

  // CLM-2026-0001: Rizal (new_agent), 3 items, PAID (with Bill + CashMovement)
  await prisma.commissionBill.create({
    data: {
      id: IDS.clmBill1, organizationId: org.id, billNumber: "BILL-2026-0005",
      partyId: IDS.agent1, category: "commission",
      description: "Commission claim CLM-2026-0001 - Ahmad Rizal bin Zainal",
      amount: 734, currency: "MYR", status: "paid",
      dueDate: d("2026-03-15"), paidAt: dt("2026-03-20T10:00:00Z"),
    },
  });

  await prisma.cashMovement.create({
    data: {
      id: IDS.clmCM1, organizationId: org.id, movementNumber: "CM-2026-0005",
      type: "outflow", category: "commission",
      description: "Commission payout CLM-2026-0001 - Ahmad Rizal bin Zainal",
      amount: 734, allocatedAmount: 734, currency: "MYR",
      partyId: IDS.agent1, movementDate: d("2026-03-20"),
      paymentTender: "bank_transfer", allocationStatus: "allocated",
    },
  });

  await prisma.commissionClaim.create({
    data: {
      id: IDS.clm1, organizationId: org.id, claimNumber: "CLM-2026-0001",
      agentPartyId: IDS.agent1, status: "paid", currency: "MYR",
      claimType: "tenant_portion",
      submittedAt: dt("2026-02-10T09:00:00Z"),
      approvedAt: dt("2026-02-15T14:00:00Z"), approvedBy: IDS.adminUser,
      paidAt: dt("2026-03-20T10:00:00Z"), paidBy: IDS.adminUser,
      totalNettPayout: 734,
      billId: IDS.clmBill1, cashMovementId: IDS.clmCM1,
      items: {
        create: [
          {
            organizationId: org.id, propertyId: IDS.prop1,
            condoName: "PV9", unitCode: "A-22-13A", roomType: "Master",
            tenantName: "YANNIE", salesDate: d("2024-05-21"), moveInDate: d("2024-06-01"),
            monthlyRental: 1000, agentTierPercentage: 40, commissionPercentage: 50,
            tenancyChargesByAgent: 300, tenancyChargesByKaen: 216,
            numberOfPax: 3, nettPayout: 254,
          },
          {
            organizationId: org.id, propertyId: IDS.prop1,
            condoName: "PV9", unitCode: "B-10-05", roomType: "Medium",
            tenantName: "DANIEL LEE", salesDate: d("2024-05-25"), moveInDate: d("2024-06-15"),
            monthlyRental: 800, agentTierPercentage: 40, commissionPercentage: 50,
            tenancyChargesByAgent: 200, tenancyChargesByKaen: 180,
            numberOfPax: 2, nettPayout: 220,
          },
          {
            organizationId: org.id, propertyId: IDS.prop1,
            condoName: "PV9", unitCode: "A-15-08", roomType: "Small",
            tenantName: "SARAH TAN", salesDate: d("2024-06-01"), moveInDate: d("2024-06-20"),
            monthlyRental: 650, agentTierPercentage: 40, commissionPercentage: 50,
            tenancyChargesByAgent: 150, tenancyChargesByKaen: 130,
            numberOfPax: 1, nettPayout: 260,
          },
        ],
      },
    },
  });

  // CLM-2026-0002: Rizal (new_agent), 2 items, APPROVED (Bill only, no payment yet)
  await prisma.commissionBill.create({
    data: {
      id: IDS.clmBill2, organizationId: org.id, billNumber: "BILL-2026-0006",
      partyId: IDS.agent1, category: "commission",
      description: "Commission claim CLM-2026-0002 - Ahmad Rizal bin Zainal",
      amount: 510, currency: "MYR", status: "pending",
      dueDate: d("2026-05-01"),
    },
  });

  await prisma.commissionClaim.create({
    data: {
      id: IDS.clm2, organizationId: org.id, claimNumber: "CLM-2026-0002",
      agentPartyId: IDS.agent1, status: "approved", currency: "MYR",
      claimType: "listing_portion",
      submittedAt: dt("2026-03-15T10:00:00Z"),
      approvedAt: dt("2026-04-01T09:00:00Z"), approvedBy: IDS.adminUser,
      totalNettPayout: 510,
      billId: IDS.clmBill2,
      items: {
        create: [
          {
            organizationId: org.id, propertyId: IDS.prop3,
            condoName: "Bangsar South Residences", unitCode: "A-25-01", roomType: "Master",
            tenantName: "JAMES WILSON", salesDate: d("2026-03-01"), moveInDate: d("2026-03-15"),
            monthlyRental: 2800, agentTierPercentage: 30, commissionPercentage: 50,
            tenancyChargesByAgent: 500, tenancyChargesByKaen: 400,
            numberOfPax: 2, nettPayout: 320,
          },
          {
            organizationId: org.id, propertyId: IDS.prop3,
            condoName: "Bangsar South Residences", unitCode: "A-30-03", roomType: "Medium",
            tenantName: "AISHA HASSAN", salesDate: d("2026-03-10"), moveInDate: d("2026-04-01"),
            monthlyRental: 3500, agentTierPercentage: 30, commissionPercentage: 50,
            tenancyChargesByAgent: 600, tenancyChargesByKaen: 500,
            numberOfPax: 1, nettPayout: 190,
          },
        ],
      },
    },
  });

  // CLM-2026-0003: Priya (pre_leader), 2 items, PENDING
  await prisma.commissionClaim.create({
    data: {
      id: IDS.clm3, organizationId: org.id, claimNumber: "CLM-2026-0003",
      agentPartyId: IDS.agent2, status: "submitted", currency: "MYR",
      claimType: "tenant_portion",
      submittedAt: dt("2026-04-05T11:00:00Z"),
      totalNettPayout: 468,
      items: {
        create: [
          {
            organizationId: org.id, propertyId: IDS.prop1,
            condoName: "Seri Kembangan Heights", unitCode: "A-15-03", roomType: "Master",
            tenantName: "RAJESH KUMAR", salesDate: d("2026-03-20"), moveInDate: d("2026-04-01"),
            monthlyRental: 1800, agentTierPercentage: 45, commissionPercentage: 50,
            tenancyChargesByAgent: 250, tenancyChargesByKaen: 200,
            numberOfPax: 2, nettPayout: 255,
          },
          // propertyId chosen to avoid collision with CLM-0001/0002 on the
          // split-constraint key (propertyId, unitCode, roomType, moveInDate).
          // See Task 3/4 in the split-constraint plan.
          {
            organizationId: org.id, propertyId: IDS.prop2,
            condoName: "Taman Desa Shophouses", unitCode: "SA-08-01", roomType: "Small",
            tenantName: "TAN WEI MING", salesDate: d("2026-04-01"), moveInDate: d("2026-04-15"),
            monthlyRental: 1200, agentTierPercentage: 45, commissionPercentage: 50,
            tenancyChargesByAgent: 180, tenancyChargesByKaen: 150,
            numberOfPax: 1, nettPayout: 213,
          },
        ],
      },
    },
  });

  // CLM-2026-0004: Priya (pre_leader), 1 item, DRAFT
  await prisma.commissionClaim.create({
    data: {
      id: IDS.clm4, organizationId: org.id, claimNumber: "CLM-2026-0004",
      agentPartyId: IDS.agent2, status: "draft", currency: "MYR",
      claimType: "tenant_portion",
      totalNettPayout: 350,
      items: {
        create: [
          {
            organizationId: org.id, propertyId: IDS.prop3,
            condoName: "Bangsar South Residences", unitCode: "A-22-05", roomType: "Medium",
            tenantName: "NURUL IZZAH", salesDate: d("2026-04-10"), moveInDate: d("2026-04-25"),
            monthlyRental: 2600, agentTierPercentage: 45, commissionPercentage: 50,
            tenancyChargesByAgent: 400, tenancyChargesByKaen: 350,
            numberOfPax: 1, nettPayout: 350,
          },
        ],
      },
    },
  });

  // =========================================================================
  // Sales Entry & Renovation Claim defaults (Wave 1)
  // -------------------------------------------------------------------------
  // Plan: docs/plans/sales-entry-and-renovation-claim.md §8
  //   • 3 Renovation Packages (Standard / Premium / Premium Plus)
  //   • 3 default splits per package (Sales 60% / Leader 15% / House Keep 25%)
  //   • 14 SettingsLabel rows (claim_status × 5, renovation_status × 3,
  //     document_kind × 3, payment_type × 3)
  //   • 2 demo Projects
  //
  // All upserts use stable IDs from the IDS dictionary so re-running the seed
  // is idempotent (same IDs → same rows, no duplicate-key errors).
  // =========================================================================
  console.log("Creating renovation packages and default splits...");

  await prisma.renovationPackage.createMany({
    data: [
      {
        id: IDS.pkgStandard, organizationId: org.id,
        key: "standard", label: "Standard",
        description: "Baseline renovation — paint, basic flooring, light fixtures.",
        defaultPrice: 25000, sortOrder: 1,
      },
      {
        id: IDS.pkgPremium, organizationId: org.id,
        key: "premium", label: "Premium",
        description: "Mid-tier renovation — quality flooring, kitchen, bathroom upgrade.",
        defaultPrice: 45000, sortOrder: 2,
      },
      {
        id: IDS.pkgPremiumPlus, organizationId: org.id,
        key: "premium_plus", label: "Premium Plus",
        description: "Top-tier renovation — full furnishing, premium fixtures, custom built-ins.",
        defaultPrice: 75000, sortOrder: 3,
      },
    ],
  });

  await prisma.renovationPackageSplit.createMany({
    data: [
      // Standard
      { id: IDS.pkgStdSales,     organizationId: org.id, packageId: IDS.pkgStandard,
        roleLabel: "Sales Commission",        splitType: "percent", splitValue: 60, isHouseKeep: false, sortOrder: 1 },
      { id: IDS.pkgStdLeader,    organizationId: org.id, packageId: IDS.pkgStandard,
        roleLabel: "Project Leader Override", splitType: "percent", splitValue: 15, isHouseKeep: false, sortOrder: 2 },
      { id: IDS.pkgStdHouseKeep, organizationId: org.id, packageId: IDS.pkgStandard,
        roleLabel: "House Keep",              splitType: "percent", splitValue: 25, isHouseKeep: true,  sortOrder: 3 },
      // Premium
      { id: IDS.pkgPremSales,     organizationId: org.id, packageId: IDS.pkgPremium,
        roleLabel: "Sales Commission",        splitType: "percent", splitValue: 60, isHouseKeep: false, sortOrder: 1 },
      { id: IDS.pkgPremLeader,    organizationId: org.id, packageId: IDS.pkgPremium,
        roleLabel: "Project Leader Override", splitType: "percent", splitValue: 15, isHouseKeep: false, sortOrder: 2 },
      { id: IDS.pkgPremHouseKeep, organizationId: org.id, packageId: IDS.pkgPremium,
        roleLabel: "House Keep",              splitType: "percent", splitValue: 25, isHouseKeep: true,  sortOrder: 3 },
      // Premium Plus
      { id: IDS.pkgPlusSales,     organizationId: org.id, packageId: IDS.pkgPremiumPlus,
        roleLabel: "Sales Commission",        splitType: "percent", splitValue: 60, isHouseKeep: false, sortOrder: 1 },
      { id: IDS.pkgPlusLeader,    organizationId: org.id, packageId: IDS.pkgPremiumPlus,
        roleLabel: "Project Leader Override", splitType: "percent", splitValue: 15, isHouseKeep: false, sortOrder: 2 },
      { id: IDS.pkgPlusHouseKeep, organizationId: org.id, packageId: IDS.pkgPremiumPlus,
        roleLabel: "House Keep",              splitType: "percent", splitValue: 25, isHouseKeep: true,  sortOrder: 3 },
    ],
  });

  console.log("Creating settings labels...");
  await prisma.settingsLabel.createMany({
    data: [
      // claim_status — 5 states matching the approval state machine
      { id: IDS.lblClaimSubmitted, organizationId: org.id, category: "claim_status",      key: "submitted",         label: "Submitted",        sortOrder: 1 },
      { id: IDS.lblClaimPending,   organizationId: org.id, category: "claim_status",      key: "pending_approval",  label: "Pending Approval", sortOrder: 2 },
      { id: IDS.lblClaimApproved,  organizationId: org.id, category: "claim_status",      key: "approved",          label: "Approved",         sortOrder: 3 },
      { id: IDS.lblClaimRejected,  organizationId: org.id, category: "claim_status",      key: "rejected",          label: "Rejected",         sortOrder: 4 },
      { id: IDS.lblClaimAmend,     organizationId: org.id, category: "claim_status",      key: "needs_amendment",   label: "Needs Amendment",  sortOrder: 5 },
      // renovation_status — 3 states
      { id: IDS.lblRenoNotStarted, organizationId: org.id, category: "renovation_status", key: "not_started", label: "Not Started", sortOrder: 1 },
      { id: IDS.lblRenoOnGoing,    organizationId: org.id, category: "renovation_status", key: "on_going",    label: "On Going",    sortOrder: 2 },
      { id: IDS.lblRenoCompleted,  organizationId: org.id, category: "renovation_status", key: "completed",   label: "Completed",   sortOrder: 3 },
      // document_kind — 3 types
      { id: IDS.lblDocQuotation, organizationId: org.id, category: "document_kind", key: "quotation", label: "Quotation", sortOrder: 1 },
      { id: IDS.lblDocInvoice,   organizationId: org.id, category: "document_kind", key: "invoice",   label: "Invoice",   sortOrder: 2 },
      { id: IDS.lblDocAgreement, organizationId: org.id, category: "document_kind", key: "agreement", label: "Agreement", sortOrder: 3 },
      // payment_type — 3 modes
      { id: IDS.lblPayFull,    organizationId: org.id, category: "payment_type", key: "full",                label: "Full Payment",      sortOrder: 1 },
      { id: IDS.lblPayPartial, organizationId: org.id, category: "payment_type", key: "partial",             label: "Partial Payment",   sortOrder: 2 },
      { id: IDS.lblPayOffset,  organizationId: org.id, category: "payment_type", key: "offset_from_rental",  label: "Offset from Rental", sortOrder: 3 },
    ],
  });

  console.log("Creating demo projects...");
  await prisma.project.createMany({
    data: [
      {
        id: IDS.projAurora, organizationId: org.id,
        name: "Aurora Residences",
        developer: "Mah Sing Group",
        city: "Petaling Jaya",
        expectedHandover: d("2026-09-30"),
        status: "active",
        notes: "Demo project — used by agents to submit off-plan sales entries.",
      },
      {
        id: IDS.projSkyline, organizationId: org.id,
        name: "The Skyline @ KLCC",
        developer: "EcoWorld Development",
        city: "Kuala Lumpur",
        expectedHandover: d("2027-03-15"),
        status: "active",
        notes: "Demo project — high-rise off-plan unit catalogue.",
      },
    ],
  });

  // =========================================================================
  // Summary
  // =========================================================================
  const counts = {
    organizations: 1,
    users: 16, // 2 admin/manager + 10 tenant portal users + 2 agent portal users + 2 owner portal users
    parties: 14, // 2 landlords + 10 tenants + 2 agents
    agents: 2,
    agentUsers: 2,
    agentTierMappings: 6,
    roomTypes: 5,
    commissionClaims: 4,
    properties: 4,
    buildings: 4,
    apartments: 20, // 19 whole-unit apartments + 1 PARTITIONED apartment (PV9 A-11-43)
    listings: 22,   // 19 whole-unit listings + 3 partition listings (Master/Medium/Small)
    tenancies: 10,
    landlordTenancies: 3,
    deposits: 20,
    charges: allCharges.length,
    payments: payments.length,
    paymentAllocations: payments.length,
    bills: 6, // 4 tenant/landlord bills + 2 commission bills
    cashMovements: 5, // 4 tenant/landlord movements + 1 commission payout
    chargeTemplates: 3,
    recurringCharges: 10,
    lateFeeRules: 1,
    emailTemplates: 3,
    notifications: 5,
    notificationQueue: 4,
    maintenanceRequests: 5,
    announcements: 3,
    documents: 4,
    documentLinks: 9,
    auditLogs: 6,
    activityLogs: 5,
    renovationPackages: 3,
    renovationPackageSplits: 9,
    settingsLabels: 14,
    projects: 2,
  };

  console.log("\nSeed completed successfully!");
  console.log("Record counts:", counts);
  console.log("\nAdmin login:   admin@kaenproperties.com / admin123");
  console.log("Manager login: sarah@kaenproperties.com / manager123");
  console.log("\nTenant portal logins (all use password: tenant123):");
  console.log("  faizal.ismail@gmail.com    (Ahmad Faizal - SKH A-12-01)");
  console.log("  siti.aminah@yahoo.com      (Siti Aminah - SKH A-15-03)");
  console.log("  rajesh.kumar@outlook.com   (Rajesh Kumar - SKH A-08-02)");
  console.log("  weiming.tan@gmail.com      (Tan Wei Ming - SKH B-10-01)");
  console.log("  james.wilson@proton.me     (James Wilson - SKH B-20-02)");
  console.log("  ckl88@gmail.com            (Lim Chee Keong - TDS TD-01)");
  console.log("  aisha.hassan@outlook.com   (Aisha Hassan - TDS TD-02)");
  console.log("  nurul.izzah@gmail.com      (Nurul Izzah - TDS TD-03)");
  console.log("  yuki.tanaka@icloud.com     (Yuki Tanaka - BSR A-25-01)");
  console.log("  hafiz.osman@gmail.com      (M. Hafiz - BSR A-18-02, has overdue rent)");
  console.log("\nOwner portal logins (all use password: owner123):");
  console.log("  razak@gmail.com            (Dato' Razak - owns SKH & BSR)");
  console.log("  meiling.tan@hotmail.com    (Puan Mei Ling - owns TDS)");
  console.log("\nAgent portal logins (all use password: agent123):");
  console.log("  rizal.zainal@gmail.com     (Ahmad Rizal - agent)");
  console.log("  priya.subra@gmail.com      (Priya Subramaniam - agent)");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
