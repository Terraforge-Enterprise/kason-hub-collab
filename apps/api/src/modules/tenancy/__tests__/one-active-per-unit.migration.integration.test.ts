/**
 * Integration tests for the T6 migration
 * (20260707130000_tenancy_one_active_per_unit): a pre-sweep that closes any
 * pre-existing duplicate-active Tenancy rows per unit (auditing the closure
 * to a real admin User), followed by a permanent partial unique index
 * `tenancy_one_active_per_unit` that enforces "at most one active Tenancy
 * per (organizationId, unitId)" going forward.
 *
 * Hits a real local Postgres. Skipped by default. Run explicitly:
 *   cd apps/api && RUN_INTEGRATION=1 \
 *     DATABASE_URL="postgresql://yonghongtan@localhost:5432/kason_hub_dev?schema=public" \
 *     npx vitest run one-active-per-unit.migration
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb, Prisma } from "@kason/db";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  // This suite drops/recreates a real unique index and writes real Tenancy
  // rows. Refuse to run against anything but the local dev DB, even by
  // accident (money-critical write path + DDL).
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`one-active-per-unit.migration.integration.test.ts: refusing non-local DB host "${host}"`);
  }
}

const MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  "../../../../../../packages/db/prisma/migrations/20260707130000_tenancy_one_active_per_unit/migration.sql",
);
const INDEX_BOUNDARY = 'CREATE UNIQUE INDEX "tenancy_one_active_per_unit"';

// Read the pre-sweep statement DIRECTLY out of the real migration file (the
// text before the CREATE UNIQUE INDEX) so this test can never drift from
// what actually ships -- there is no second, hand-copied source of truth.
function readPresweepSql(): string {
  const full = fs.readFileSync(MIGRATION_SQL_PATH, "utf8");
  const idx = full.indexOf(INDEX_BOUNDARY);
  if (idx === -1) {
    throw new Error("readPresweepSql: could not find CREATE UNIQUE INDEX boundary in migration.sql");
  }
  return full.slice(0, idx).trim();
}

// Runs `fn` inside an interactive transaction that is ALWAYS rolled back --
// used to exercise the pre-sweep SQL (which needs the unique index gone, to
// seed duplicate actives) without ever leaving the shared dev DB without its
// permanent index, or leaving fixture data behind.
const ROLLBACK = Symbol("intentional-rollback");
async function runInRollbackTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  let captured!: T;
  try {
    await getDb().$transaction(async (tx) => {
      captured = await fn(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return captured;
}

const ORG = "99990006-0006-4006-8006-000000000001";
const ADMIN_USER = "99990006-0006-4006-8006-000000000002";
const PROPERTY = "99990006-0006-4006-8006-000000000003";
const APARTMENT = "99990006-0006-4006-8006-000000000004";
const UNIT = "99990006-0006-4006-8006-000000000005";
const TENANT_PARTY_OLD = "99990006-0006-4006-8006-000000000006";
const TENANT_PARTY_NEW = "99990006-0006-4006-8006-000000000007";
const TENANT_PARTY_SECOND = "99990006-0006-4006-8006-000000000008";
const TENANCY_OLD = "99990006-0006-4006-8006-000000000101";
const TENANCY_NEW = "99990006-0006-4006-8006-000000000102";
const TENANCY_FIRST = "99990006-0006-4006-8006-000000000103";
const TENANCY_SECOND = "99990006-0006-4006-8006-000000000104";

async function cleanup() {
  const db = getDb();
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "T6 One-Active-Per-Unit Org",
      slug: "t6-one-active-per-unit-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // The pre-sweep's LATERAL join resolves the org's earliest-created admin
  // User as the AuditLog actor -- must exist or the swept row's audit insert
  // (and, via the FK, the whole statement) fails.
  await db.user.create({
    data: {
      id: ADMIN_USER,
      organizationId: ORG,
      email: "admin@t6-one-active.test",
      fullName: "T6 Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
      userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_OLD, organizationId: ORG, displayName: "Old Tenant", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_NEW, organizationId: ORG, displayName: "New Tenant", partyType: "individual", status: "active" },
  });
  await db.party.create({
    data: { id: TENANT_PARTY_SECOND, organizationId: ORG, displayName: "Second Tenant", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY,
      organizationId: ORG,
      name: "T6 Property",
      propertyCode: "T6-1",
      propertyType: "residential",
      addressLine1: "1 T6 St",
      city: "Kuala Lumpur",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "T6-101", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APARTMENT,
      listingType: "apartment",
      occupancyStatus: "vacant",
      listingStatus: "active",
      readyNow: true,
      currency: "MYR",
    },
  });
}

dn("one-active-per-unit migration (T6: pre-sweep + partial unique index)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("presweep closes duplicates keeping survivor + writes AuditLog", async () => {
    const SAME_START = new Date("2026-01-01T00:00:00Z");
    const OLDER_CREATED_AT = new Date("2026-01-01T00:00:00Z");
    const NEWER_CREATED_AT = new Date("2026-01-02T00:00:00Z");

    const result = await runInRollbackTx(async (tx) => {
      // The index must be gone to seed two ACTIVE tenancies on the same
      // unit -- this all happens inside a transaction that is rolled back
      // at the end, so the real index is untouched once this test returns.
      await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "tenancy_one_active_per_unit"`);

      // Equal startDate (a genuine tie) -- the survivor must be decided by
      // the createdAt tie-break, not startDate.
      await tx.tenancy.create({
        data: {
          id: TENANCY_OLD,
          organizationId: ORG,
          propertyId: PROPERTY,
          unitId: UNIT,
          tenantPartyId: TENANT_PARTY_OLD,
          tenancyCode: "TEN-T6-OLD",
          status: "active",
          billingStatus: "active",
          startDate: SAME_START,
          monthlyRentAmount: "1500.00",
          createdAt: OLDER_CREATED_AT,
        },
      });
      await tx.tenancy.create({
        data: {
          id: TENANCY_NEW,
          organizationId: ORG,
          propertyId: PROPERTY,
          unitId: UNIT,
          tenantPartyId: TENANT_PARTY_NEW,
          tenancyCode: "TEN-T6-NEW",
          status: "active",
          billingStatus: "active",
          startDate: SAME_START,
          monthlyRentAmount: "1600.00",
          createdAt: NEWER_CREATED_AT,
        },
      });

      await tx.$executeRawUnsafe(readPresweepSql());

      const survivor = await tx.tenancy.findUniqueOrThrow({ where: { id: TENANCY_NEW } });
      const loser = await tx.tenancy.findUniqueOrThrow({ where: { id: TENANCY_OLD } });
      const auditForLoser = await tx.auditLog.findFirst({
        where: {
          organizationId: ORG,
          entityId: TENANCY_OLD,
          action: "tenancy.presweep_duplicate_active_closed",
        },
      });
      const auditForSurvivorCount = await tx.auditLog.count({
        where: {
          organizationId: ORG,
          entityId: TENANCY_NEW,
          action: "tenancy.presweep_duplicate_active_closed",
        },
      });

      return { survivor, loser, auditForLoser, auditForSurvivorCount };
    });

    // Survivor: later createdAt wins the startDate tie, stays active/untouched.
    expect(result.survivor.status).toBe("active");
    expect(result.survivor.endDate).toBeNull();

    // Loser: closed out, endDate pinned to the survivor's startDate.
    expect(result.loser.status).toBe("ended");
    expect(result.loser.endDate?.toISOString()).toBe(SAME_START.toISOString());

    // Exactly one audit row for the swept (loser) tenancy, none for the survivor.
    expect(result.auditForLoser).not.toBeNull();
    expect(result.auditForLoser?.actorUserId).toBe(ADMIN_USER);
    expect(result.auditForLoser?.actorRole).toBe("admin");
    expect(result.auditForSurvivorCount).toBe(0);

    // Confirm the transaction really rolled back: neither seeded tenancy
    // (nor the index drop) persisted outside it.
    const db = getDb();
    expect(await db.tenancy.count({ where: { id: { in: [TENANCY_OLD, TENANCY_NEW] } } })).toBe(0);
    const indexRow = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Tenancy' AND indexname = 'tenancy_one_active_per_unit'`,
    );
    expect(indexRow.length).toBe(1);
  });

  it("index rejects duplicate active", async () => {
    const db = getDb();

    await db.tenancy.create({
      data: {
        id: TENANCY_FIRST,
        organizationId: ORG,
        propertyId: PROPERTY,
        unitId: UNIT,
        tenantPartyId: TENANT_PARTY_OLD,
        tenancyCode: "TEN-T6-FIRST",
        status: "active",
        billingStatus: "active",
        startDate: new Date("2026-02-01T00:00:00Z"),
        monthlyRentAmount: "1500.00",
      },
    });

    let caught: unknown;
    try {
      await db.tenancy.create({
        data: {
          id: TENANCY_SECOND,
          organizationId: ORG,
          propertyId: PROPERTY,
          unitId: UNIT,
          tenantPartyId: TENANT_PARTY_SECOND,
          tenancyCode: "TEN-T6-SECOND",
          status: "active",
          billingStatus: "active",
          startDate: new Date("2026-03-01T00:00:00Z"),
          monthlyRentAmount: "1600.00",
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");

    const activeCount = await db.tenancy.count({ where: { organizationId: ORG, unitId: UNIT, status: "active" } });
    expect(activeCount).toBe(1);
    const secondExists = await db.tenancy.findUnique({ where: { id: TENANCY_SECOND } });
    expect(secondExists).toBeNull();
  });
});
