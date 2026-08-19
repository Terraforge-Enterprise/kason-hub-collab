/**
 * Integration tests for the M6 Owner-Billing module (Task C2). Hits a real LOCAL
 * Postgres. Skipped by default in `npx vitest run`. Run explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="<local>" \
 *     npx vitest run src/modules/owner-billing/__tests__/owner-billing.integration.test.ts
 *
 * Mirrors the tasks-tickets integration harness: fixed-UUID seed + org-scoped
 * deleteMany cleanup (services own their own transactions). Asserts createFeeConfig
 * lands a row, and that the read paths are org-scoped (org B sees nothing).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { computeManagementFee } from "@kason/shared";
import {
  addStatementLineService,
  createFeeConfigService,
  generateStatementService,
  getFeeConfigService,
  getStatementService,
  listFeeConfigsService,
  listStatementsService,
  restoreFeeConfigService,
  retireFeeConfigService,
  updateFeeConfigService,
  updateStatementLineService,
  voidStatementLineService,
} from "../owner-billing.service";
import { getFeeConfig, findDepositsCollectedInMonth } from "../owner-billing.repository";
import { assembleYannieStatement } from "../owner-statement-sections";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// A timestamp that can never match a live row's updatedAt → forces the stale path.
const STALE_UPDATED_AT = "2000-01-01T00:00:00.000Z";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Fixed UUIDs — disjoint from every other integration test's constants.
const ORG_A = "0b000000-0000-4000-8000-0000000000a1";
const ORG_B = "0b000000-0000-4000-8000-0000000000b1";
const USER_A = "0b000000-0000-4000-8000-0000000000a2";
const PARTY_A = "0b000000-0000-4000-8000-0000000000a3";
const OWNER_A = "0b000000-0000-4000-8000-0000000000a4";
// Base property + the LandlordTenancy that makes OWNER_A "in ORG_A" — required
// by findOwnerInOrg, which createFeeConfigService / generateStatementService both
// gate on. (Previously absent, which 404'd every C2 fee-config integration test.)
const PROPERTY_BASE = "0b000000-0000-4000-8000-0000000000aa";

const CTX_A: OwnerBillingActorCtx = { orgId: ORG_A, actorUserId: USER_A, actorRole: "admin" };
const CTX_B: OwnerBillingActorCtx = { orgId: ORG_B, actorUserId: USER_A, actorRole: "admin" };

async function seedBase() {
  const db = getDb();
  for (const [id, slug] of [
    [ORG_A, "ob-int-org-a"],
    [ORG_B, "ob-int-org-b"],
  ] as const) {
    await db.organization.create({
      data: {
        id,
        name: `OB Int ${slug}`,
        slug,
        status: "active",
        defaultCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        locale: "en-MY",
        subscriptionPlan: "free",
      },
    });
  }
  // Operator invariant: every operator User carries a paired individual Party.
  await db.party.create({
    data: {
      id: PARTY_A,
      organizationId: ORG_A,
      displayName: "OB Operator",
      partyType: "individual",
      status: "active",
    },
  });
  // Real User row required: AuditLog.actorUserId is FK → User (onDelete: Restrict).
  await db.user.create({
    data: {
      id: USER_A,
      organizationId: ORG_A,
      email: "ob-int-operator@example.com",
      fullName: "OB Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY_A,
    },
  });
  // The owner Party the fee config points at (ManagementFeeConfig.ownerPartyId FK).
  await db.party.create({
    data: {
      id: OWNER_A,
      organizationId: ORG_A,
      displayName: "OB Owner",
      partyType: "individual",
      status: "active",
    },
  });
  // Owner re-point: findOwnerInOrg now resolves "owner in org" via a PartyRole of
  // roleType "owner" (decoupled from owning units). Without this, every
  // create/generate service 404s before doing any work.
  await db.partyRole.create({
    data: { organizationId: ORG_A, partyId: OWNER_A, roleType: "owner", status: "active" },
  });
  // A base Property + a LandlordTenancy (the entity stays; owner→units no longer
  // derives from it, but it remains valid data).
  await db.property.create({
    data: {
      id: PROPERTY_BASE,
      organizationId: ORG_A,
      name: "OB Int Base Property",
      propertyCode: "OB-INT-BASE",
      propertyType: "apartment",
      addressLine1: "1 Base St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.landlordTenancy.create({
    data: {
      organizationId: ORG_A,
      propertyId: PROPERTY_BASE,
      landlordId: OWNER_A,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRent: "2000",
      status: "active",
    },
  });
}

/** Delete everything in FK-safe order (AuditLog before User — Restrict FK). */
async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG_A, ORG_B] };
  // generateStatementService now re-syncs the owner-ledger (BUG1) → OwnerLedgerEntry
  // rows. They FK-cascade only from Organization, but delete them explicitly first
  // so each test starts from a clean ledger and any ledger assertion stays isolated.
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: orgs } });
  // Charges reference Invoice (SetNull) + Tenancy (SetNull) + Listing (SetNull);
  // delete them before the rows they point at. Tenancy/Listing carry Restrict FKs
  // from Charge, so Charge must go first.
  await db.charge.deleteMany({ where: { organizationId: orgs } });
  await db.invoice.deleteMany({ where: { organizationId: orgs } });
  await db.tenancy.deleteMany({ where: { organizationId: orgs } });
  await db.landlordTenancy.deleteMany({ where: { organizationId: orgs } });
  await db.managementFeeConfig.deleteMany({ where: { organizationId: orgs } });
  // UnitUtilityBill FK-restricts to Apartment → delete bills (+ their allocations,
  // which cascade from the bill) before the apartments they reference (PART 4).
  await db.utilityAllocation.deleteMany({ where: { organizationId: orgs } });
  await db.unitUtilityBill.deleteMany({ where: { organizationId: orgs } });
  await db.listing.deleteMany({ where: { organizationId: orgs } });
  await db.apartment.deleteMany({ where: { organizationId: orgs } });
  await db.property.deleteMany({ where: { organizationId: orgs } });
  await db.auditLog.deleteMany({ where: { organizationId: orgs } });
  await db.user.deleteMany({ where: { organizationId: orgs } });
  await db.partyRole.deleteMany({ where: { organizationId: orgs } });
  await db.party.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

dn("owner-billing fee configs (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
    const db = getDb();
    const orgs = { in: [ORG_A, ORG_B] };
    expect(await db.managementFeeConfig.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.auditLog.count({ where: { organizationId: orgs } })).toBe(0);
    expect(await db.organization.count({ where: { id: orgs } })).toBe(0);
  });

  it("createFeeConfig persists an org-scoped row + exactly one audit row", async () => {
    const res = await createFeeConfigService(CTX_A, {
      ownerPartyId: OWNER_A,
      feeType: "percent",
      feeValue: "10",
      sstPercent: "8",
      isActive: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.feeType).toBe("percent");
    expect(res.data.feeValue).toBe("10");

    const db = getDb();
    const row = await db.managementFeeConfig.findUnique({ where: { id: res.data.id } });
    expect(row).not.toBeNull();
    expect(row!.organizationId).toBe(ORG_A);
    expect(row!.ownerPartyId).toBe(OWNER_A);

    const audits = await db.auditLog.findMany({
      where: { organizationId: ORG_A, action: "owner-billing.feeConfig.create" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe("ManagementFeeConfig");
    expect(audits[0]!.entityId).toBe(res.data.id);
  });

  it("cross-org isolation: org B cannot read org A's fee config", async () => {
    const created = await createFeeConfigService(CTX_A, {
      ownerPartyId: OWNER_A,
      feeType: "fixed",
      feeValue: "250",
      sstPercent: "8",
      isActive: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Org A reads its own row.
    const own = await getFeeConfigService(CTX_A, created.data.id);
    expect(own.ok).toBe(true);

    // Org B: service 404s + repository null (org id is in EVERY where).
    const cross = await getFeeConfigService(CTX_B, created.data.id);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.status).toBe(404);
    expect(await getFeeConfig(ORG_B, created.data.id)).toBeNull();

    // List is org-scoped too: org B sees an empty list.
    const bList = await listFeeConfigsService(CTX_B, {}, { limit: 50, offset: 0 });
    expect(bList.ok).toBe(true);
    if (bList.ok) expect(bList.data.items).toHaveLength(0);
  });

  it("guarded update: a fresh expectedUpdatedAt updates the row + writes one audit", async () => {
    const created = await createFeeConfigService(CTX_A, {
      ownerPartyId: OWNER_A,
      feeType: "percent",
      feeValue: "10",
      sstPercent: "8",
      isActive: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await updateFeeConfigService(CTX_A, created.data.id, {
      feeValue: "12.5",
      expectedUpdatedAt: created.data.updatedAt,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.feeValue).toBe("12.5");
    // updatedAt is bumped past the value we passed.
    expect(updated.data.updatedAt).not.toBe(created.data.updatedAt);

    const db = getDb();
    const row = await db.managementFeeConfig.findUnique({ where: { id: created.data.id } });
    expect(row!.feeValue.toString()).toBe("12.5");
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.feeConfig.update" },
      }),
    ).toBe(1);
  });

  it("guarded update: a stale expectedUpdatedAt → 409 and NO row change / NO audit", async () => {
    const created = await createFeeConfigService(CTX_A, {
      ownerPartyId: OWNER_A,
      feeType: "percent",
      feeValue: "10",
      sstPercent: "8",
      isActive: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const stale = await updateFeeConfigService(CTX_A, created.data.id, {
      feeValue: "99",
      expectedUpdatedAt: STALE_UPDATED_AT,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.status).toBe(409);
    expect(stale.error).toBe("Record changed — reloaded");

    const db = getDb();
    const row = await db.managementFeeConfig.findUnique({ where: { id: created.data.id } });
    // Row untouched (the whole tx — guarded write + audit — unwound).
    expect(row!.feeValue.toString()).toBe("10");
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.feeConfig.update" },
      }),
    ).toBe(0);
  });

  it("guarded update is org-scoped: org B's stale-token PATCH on org A's row → 409, row untouched", async () => {
    const created = await createFeeConfigService(CTX_A, {
      ownerPartyId: OWNER_A,
      feeType: "percent",
      feeValue: "10",
      sstPercent: "8",
      isActive: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Org B pre-reads org A's id → 404 (never reaches the guarded write).
    const cross = await updateFeeConfigService(CTX_B, created.data.id, {
      feeValue: "1",
      expectedUpdatedAt: created.data.updatedAt,
    });
    expect(cross.ok).toBe(false);
    if (cross.ok) return;
    expect(cross.status).toBe(404);

    const db = getDb();
    const row = await db.managementFeeConfig.findUnique({ where: { id: created.data.id } });
    expect(row!.feeValue.toString()).toBe("10");
    expect(row!.organizationId).toBe(ORG_A);
  });

  it("retire then restore flips isActive and writes one audit each", async () => {
    const created = await createFeeConfigService(CTX_A, {
      ownerPartyId: OWNER_A,
      feeType: "fixed",
      feeValue: "250",
      sstPercent: "8",
      isActive: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const retired = await retireFeeConfigService(CTX_A, created.data.id);
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(retired.data.isActive).toBe(false);

    const restored = await restoreFeeConfigService(CTX_A, created.data.id);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.data.isActive).toBe(true);

    const db = getDb();
    const row = await db.managementFeeConfig.findUnique({ where: { id: created.data.id } });
    expect(row!.isActive).toBe(true);
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.feeConfig.retire" },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.feeConfig.restore" },
      }),
    ).toBe(1);

    // Org B cannot retire org A's row (pre-read 404, row stays active).
    const crossRetire = await retireFeeConfigService(CTX_B, created.data.id);
    expect(crossRetire.ok).toBe(false);
    if (!crossRetire.ok) expect(crossRetire.status).toBe(404);
    const after = await db.managementFeeConfig.findUnique({ where: { id: created.data.id } });
    expect(after!.isActive).toBe(true);
  });
});

// ─── Owner statement generate (C4) — real idempotency + org-scoping ─────────

const PROPERTY_A = "0b000000-0000-4000-8000-0000000000a5";
const APARTMENT_A = "0b000000-0000-4000-8000-0000000000a6";
const UNIT_A = "0b000000-0000-4000-8000-0000000000a7"; // occupied listing
const TENANT_A = "0b000000-0000-4000-8000-0000000000a8";
const TENANCY_A = "0b000000-0000-4000-8000-0000000000a9";
const BILLING_MONTH = "2026-06";

/**
 * Seed an owner with one OCCUPIED unit in ORG_A: Property → Apartment → Listing
 * → active Tenancy (rent 2000) + a LandlordTenancy linking OWNER_A as landlord +
 * an active percent/10% fee config with a RM100 cleaning auto-bill.
 */
async function seedOccupiedOwnerUnit() {
  const db = getDb();
  await db.property.create({
    data: {
      id: PROPERTY_A,
      organizationId: ORG_A,
      name: "OB Int Property",
      propertyCode: "OB-INT-P1",
      propertyType: "apartment",
      addressLine1: "1 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: {
      id: APARTMENT_A,
      organizationId: ORG_A,
      propertyId: PROPERTY_A,
      unitCode: "A-1",
      listingMode: "PARTITIONED",
    },
  });
  await db.listing.create({
    data: {
      id: UNIT_A,
      organizationId: ORG_A,
      apartmentId: APARTMENT_A,
      listingType: "room",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      // Owner re-point: resolveOwnerUnitsForMonth resolves the owner's units via
      // Listing.ownerPartyId (the rent base for the statement comes from here).
      ownerPartyId: OWNER_A,
    },
  });
  // The tenant party + the active tenancy supplying the rent base (2000).
  await db.party.create({
    data: {
      id: TENANT_A,
      organizationId: ORG_A,
      displayName: "OB Tenant",
      partyType: "individual",
      status: "active",
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY_A,
      organizationId: ORG_A,
      propertyId: PROPERTY_A,
      unitId: UNIT_A,
      tenantPartyId: TENANT_A,
      tenancyCode: "OB-INT-T1",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "2000",
    },
  });
  // OWNER_A is the landlord of PROPERTY_A (the financials resolution predicate).
  await db.landlordTenancy.create({
    data: {
      organizationId: ORG_A,
      propertyId: PROPERTY_A,
      landlordId: OWNER_A,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRent: "2000",
      status: "active",
    },
  });
  // Active management-fee config: 10% + RM100 cleaning auto-bill.
  await createFeeConfigService(CTX_A, {
    ownerPartyId: OWNER_A,
    feeType: "percent",
    feeValue: "10",
    sstPercent: "8",
    isActive: true,
  });
}

dn("owner-billing statement generate (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    await seedOccupiedOwnerUnit();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("generates a draft owner_statement with mgmt-fee (computeManagementFee) + cleaning lines", async () => {
    const res = await generateStatementService(CTX_A, {
      ownerPartyId: OWNER_A,
      billingMonth: BILLING_MONTH,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe(201);
    expect(res.data.invoiceType).toBe("owner_statement");
    expect(res.data.status).toBe("draft");
    expect(res.data.ownerPartyId).toBe(OWNER_A);
    expect(res.data.partyId).toBe(OWNER_A); // bill-to = owner

    const expectedFee = computeManagementFee(
      { feeType: "percent", feeValue: "10", capAmount: null, sstPercent: "8" },
      "2000",
    );
    expect(expectedFee.base).toBe("200.00");
    expect(expectedFee.sst).toBe("16.00");

    const mgmt = res.data.lines.find((l) => l.chargeType === "management_fee");
    const cleaning = res.data.lines.find((l) => l.chargeType === "cleaning");
    expect(mgmt!.amount).toBe("200.00");
    expect(cleaning!.amount).toBe("100.00");
    expect(res.data.sstAmount).toBe("16.00");
    expect(res.data.totalAmount).toBe("316.00"); // 200 + 100 + 16

    const db = getDb();
    // Idempotency key persisted; both line Charges attached to the invoice.
    const inv = await db.invoice.findUnique({ where: { id: res.data.id } });
    expect(inv!.idempotencyKey).toBe(`owner:${OWNER_A}:${BILLING_MONTH}`);
    expect(inv!.organizationId).toBe(ORG_A);
    const charges = await db.charge.findMany({ where: { invoiceId: res.data.id } });
    expect(charges).toHaveLength(2);
    expect(charges.every((c) => c.organizationId === ORG_A)).toBe(true);
    expect(charges.every((c) => c.billingMonth !== null)).toBe(true);

    // Exactly one generate audit row.
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.statement.generate" },
      }),
    ).toBe(1);
  });

  it("is IDEMPOTENT: a re-run returns the SAME invoice id and creates NO duplicate charges", async () => {
    const first = await generateStatementService(CTX_A, {
      ownerPartyId: OWNER_A,
      billingMonth: BILLING_MONTH,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await generateStatementService(CTX_A, {
      ownerPartyId: OWNER_A,
      billingMonth: BILLING_MONTH,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Same invoice; the re-run is a 200 (existing) not a 201 (created).
    expect(second.data.id).toBe(first.data.id);
    expect(second.status).toBe(200);

    const db = getDb();
    // No duplicate invoice + no duplicate charges.
    expect(
      await db.invoice.count({
        where: { organizationId: ORG_A, idempotencyKey: `owner:${OWNER_A}:${BILLING_MONTH}` },
      }),
    ).toBe(1);
    expect(await db.charge.count({ where: { invoiceId: first.data.id } })).toBe(2);
    // Still exactly one generate audit row (the second run did not write one).
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.statement.generate" },
      }),
    ).toBe(1);
  });

  it("cross-org: ORG_B cannot generate for ORG_A's owner (404), and ORG_B's list is empty", async () => {
    const cross = await generateStatementService(CTX_B, {
      ownerPartyId: OWNER_A,
      billingMonth: BILLING_MONTH,
    });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.status).toBe(404);

    // ORG_A generates; ORG_B's org-scoped list sees nothing.
    await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    const bList = await listStatementsService(CTX_B, {}, { limit: 50, offset: 0 });
    expect(bList.ok).toBe(true);
    if (bList.ok) expect(bList.data.items).toHaveLength(0);

    const aList = await listStatementsService(
      CTX_A,
      { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH, status: "draft" },
      { limit: 50, offset: 0 },
    );
    expect(aList.ok).toBe(true);
    if (aList.ok) expect(aList.data.items).toHaveLength(1);
  });
});

// ─── BUG1: generate re-syncs the owner-ledger (cleaning reaches §5) ─────────
//
// generateStatementService creates the statement's cleaning/mgmt-fee Charges but
// historically NEVER re-synced the owner-ledger — so the Source-2 cleaning charge
// never materialised as an OwnerLedgerEntry, and assembleYannieStatement (which
// reads ledger rows) OMITTED Cleaning from the §5 Expense Breakdown. The fix
// mirrors postPaymentService: AFTER the write tx commits, syncOwnerLedgerForCharges
// runs for the created charges. The sync hook is ENABLE_PHASE2_OWNER_BILLING-gated.

dn("owner-billing generate re-syncs owner-ledger (integration, BUG1)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    await seedOccupiedOwnerUnit();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("after generate, the cleaning charge reaches the owner-ledger AND the §5 Expense Breakdown", async () => {
    const res = await generateStatementService(CTX_A, {
      ownerPartyId: OWNER_A,
      billingMonth: BILLING_MONTH,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const db = getDb();
    // 1) The Source-2 cleaning charge now materialises as an OwnerLedgerEntry
    //    (sourceType "statement", category "cleaning", direction "expense") — proof
    //    the generate path re-synced the ledger. PRE-FIX: ZERO ledger rows (the
    //    sync never ran) → this assertion fails.
    const cleaningLedger = await db.ownerLedgerEntry.findMany({
      where: {
        organizationId: ORG_A,
        ownerPartyId: OWNER_A,
        sourceType: "statement",
        category: "cleaning",
      },
    });
    expect(cleaningLedger).toHaveLength(1);
    expect(cleaningLedger[0]!.direction).toBe("expense");
    expect(Number(cleaningLedger[0]!.amount)).toBe(100);

    // 2) assembleYannieStatement reads ledger rows → the §5 Expense Breakdown now
    //    lists Cleaning (RM100), which was missing before the re-sync fix.
    const sections = await assembleYannieStatement(CTX_A, res.data.id);
    expect(sections).not.toBeNull();
    const cleaningExpense = sections!.expenseBreakdown.rows.find(
      (r) => r.category === "Cleaning",
    );
    expect(cleaningExpense, "Cleaning row in §5 Expense Breakdown").toBeDefined();
    expect(cleaningExpense!.amount).toBe("100.00");
  });
});

// ─── Cleaning is per-APARTMENT, not per-room (integration) ──────────────────
//
// Cleaning is ONE charge per physical APARTMENT — whether WHOLE or PARTITIONED.
// A PARTITIONED apartment with 3 rooms (3 Listing rows sharing ONE Apartment) must
// yield exactly ONE cleaning line, NOT three. Management fee stays PER ROOM.
//
// Seed: owner OWNER_A, two apartments under one property:
//   • Apartment P — PARTITIONED, 3 occupied rooms (each an active tenancy)
//   • Apartment W — WHOLE, 1 occupied room
// → generate ⇒ 2 cleaning (one per apartment) + 4 management_fee (one per room).

const PROPERTY_TWO = "0b000000-0000-4000-8000-0000000000c0";
const APT_P = "0b000000-0000-4000-8000-0000000000c1"; // partitioned
const APT_W = "0b000000-0000-4000-8000-0000000000c2"; // whole
// P_ROOM_1 has the lexicographically smallest unitId of P's rooms → the
// representative the single cleaning line attaches to (deterministic across re-runs).
const P_ROOM_1 = "0b000000-0000-4000-8000-0000000000c3";
const P_ROOM_2 = "0b000000-0000-4000-8000-0000000000c4";
const P_ROOM_3 = "0b000000-0000-4000-8000-0000000000c5";
const W_UNIT = "0b000000-0000-4000-8000-0000000000c6";
const T_P1 = "0b000000-0000-4000-8000-0000000000d1";
const T_P2 = "0b000000-0000-4000-8000-0000000000d2";
const T_P3 = "0b000000-0000-4000-8000-0000000000d3";
const T_W = "0b000000-0000-4000-8000-0000000000d4";
const TY_P1 = "0b000000-0000-4000-8000-0000000000e1";
const TY_P2 = "0b000000-0000-4000-8000-0000000000e2";
const TY_P3 = "0b000000-0000-4000-8000-0000000000e3";
const TY_W = "0b000000-0000-4000-8000-0000000000e4";

/**
 * Seed two apartments under ONE owner: P (PARTITIONED, 3 occupied rooms) + W
 * (WHOLE, 1 occupied room). Every room is a Listing owned by OWNER_A with an active
 * Tenancy (rent 2000) → all 4 rooms occupied. Plus a 10% / RM100-cleaning
 * owner-scoped (all-properties) fee config.
 */
async function seedTwoApartmentsOneOwner() {
  const db = getDb();
  await db.property.create({
    data: {
      id: PROPERTY_TWO,
      organizationId: ORG_A,
      name: "OB Int Property Two",
      propertyCode: "OB-INT-P2",
      propertyType: "apartment",
      addressLine1: "2 Test St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT_P, organizationId: ORG_A, propertyId: PROPERTY_TWO, unitCode: "P-1", listingMode: "PARTITIONED" },
  });
  await db.apartment.create({
    data: { id: APT_W, organizationId: ORG_A, propertyId: PROPERTY_TWO, unitCode: "W-1", listingMode: "WHOLE" },
  });
  // 3 rooms in apartment P + 1 unit in apartment W, ALL owned by OWNER_A. Each
  // room in an apartment needs a DISTINCT listingType (@@unique[apartmentId,
  // listingType]); the representative rule keys on unitId, NOT listingType.
  const rooms: Array<readonly [string, string, string]> = [
    [P_ROOM_1, APT_P, "Master"],
    [P_ROOM_2, APT_P, "Medium"],
    [P_ROOM_3, APT_P, "Small"],
    [W_UNIT, APT_W, "Whole Unit"],
  ];
  for (const [id, apartmentId, listingType] of rooms) {
    await db.listing.create({
      data: {
        id,
        organizationId: ORG_A,
        apartmentId,
        listingType,
        occupancyStatus: "occupied",
        listingStatus: "active",
        currency: "MYR",
        ownerPartyId: OWNER_A,
      },
    });
  }
  // A tenant party + an active tenancy (rent 2000) per room → each room occupied.
  const tenancies: Array<readonly [string, string, string, string]> = [
    [T_P1, TY_P1, P_ROOM_1, "OB-INT-TP1"],
    [T_P2, TY_P2, P_ROOM_2, "OB-INT-TP2"],
    [T_P3, TY_P3, P_ROOM_3, "OB-INT-TP3"],
    [T_W, TY_W, W_UNIT, "OB-INT-TW"],
  ];
  for (const [tenantId, tenancyId, unitId, code] of tenancies) {
    await db.party.create({
      data: { id: tenantId, organizationId: ORG_A, displayName: `OB Tenant ${code}`, partyType: "individual", status: "active" },
    });
    await db.tenancy.create({
      data: {
        id: tenancyId,
        organizationId: ORG_A,
        propertyId: PROPERTY_TWO,
        unitId,
        tenantPartyId: tenantId,
        tenancyCode: code,
        status: "active",
        billingStatus: "current",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        monthlyRentAmount: "2000",
      },
    });
  }
  // Owner-scoped (all-properties) fee config: 10% mgmt + RM100 cleaning auto-bill.
  await createFeeConfigService(CTX_A, {
    ownerPartyId: OWNER_A,
    feeType: "percent",
    feeValue: "10",
    sstPercent: "8",
    isActive: true,
  });
}

dn("owner-billing cleaning is per-APARTMENT not per-room (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    await seedTwoApartmentsOneOwner();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("a 3-room PARTITIONED apartment + a WHOLE apartment → exactly 2 cleaning (one per apartment) + 4 mgmt-fee (per room)", async () => {
    const res = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const cleaning = res.data.lines.filter((l) => l.chargeType === "cleaning");
    const mgmt = res.data.lines.filter((l) => l.chargeType === "management_fee");
    // ONE cleaning per physical apartment (P + W) — NOT one per room (which is 4 here).
    expect(cleaning).toHaveLength(2);
    expect(cleaning.every((l) => l.amount === "100.00")).toBe(true);
    // Management fee stays PER ROOM (4 occupied rooms).
    expect(mgmt).toHaveLength(4);

    // Each cleaning line attaches to its apartment's REPRESENTATIVE room = the
    // lexicographically smallest unitId (P_ROOM_1 in P; the sole W_UNIT in W).
    const cleaningUnitIds = cleaning.map((l) => l.unitId).sort();
    expect(cleaningUnitIds).toEqual([P_ROOM_1, W_UNIT].sort());

    const db = getDb();
    // 6 charges total: 4 mgmt + 2 cleaning (no utility bills seeded).
    expect(await db.charge.count({ where: { invoiceId: res.data.id } })).toBe(6);
    expect(await db.charge.count({ where: { invoiceId: res.data.id, chargeType: "cleaning" } })).toBe(2);
    expect(await db.charge.count({ where: { invoiceId: res.data.id, chargeType: "management_fee" } })).toBe(4);
  });

  it("is IDEMPOTENT per apartment: a re-run still yields exactly 2 cleaning (no per-room duplicates)", async () => {
    const first = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Same invoice; re-run is a 200 (existing), not a 201.
    expect(second.data.id).toBe(first.data.id);
    expect(second.status).toBe(200);

    const db = getDb();
    // Still exactly 6 charges; cleaning never duplicated on the stable representative.
    expect(await db.charge.count({ where: { invoiceId: first.data.id } })).toBe(6);
    expect(await db.charge.count({ where: { invoiceId: first.data.id, chargeType: "cleaning" } })).toBe(2);
    expect(await db.charge.count({ where: { invoiceId: first.data.id, chargeType: "management_fee" } })).toBe(4);
  });
});

// ─── PART 4 (Workstream D): statement auto-feeds owner-borne utility lines ───
//
// generateStatementService previously auto-created ONLY management_fee + cleaning
// lines; the owner-borne utilities from the unit's UnitUtilityBill (TNB-leftover /
// indah water / wifi / vacant-aircond / subsidy-covered) had to be added by hand.
// Now the owner-borne breakdown is auto-fed as statement lines for that
// owner+period, idempotently (a regenerate never double-adds).

const MONTH_START_A = new Date(Date.UTC(2026, 5, 1));

/** Seed a CHARGED UnitUtilityBill on APARTMENT_A with an owner-borne breakdown:
 *  • indah water 30 (owner-borne)         → a "sewerage"/indah_water line
 *  • wifi 20 (owner-borne)                → a "wifi" line
 *  • electricity owner-borne 25 = vacant-aircond 10 + subsidy 12 + residual 3 → a "tnb" line
 *  (air selangor is always tenant-pooled; cleaning is left to the config path.)
 */
async function seedOwnerBorneUtilityBill() {
  const db = getDb();
  await db.unitUtilityBill.create({
    data: {
      organizationId: ORG_A,
      apartmentId: APARTMENT_A,
      periodMonth: MONTH_START_A,
      billingMode: "subsidy",
      tnbTotal: "100.00",
      airSelangor: "40.00",
      indahWater: "30.00",
      cleaning: "0.00",
      wifi: "20.00",
      indahWaterBearer: "owner",
      cleaningBearer: "owner",
      wifiBearer: "owner",
      ownerAttributableAircond: "10.00",
      subsidyCovered: "12.00",
      roundingResidual: "3.00",
      ownerBorneUtilities: "50.00", // 30 indah + 20 wifi (+ 0 cleaning)
      ownerBorneUtilitiesTotal: "75.00", // 50 + 10 + 12 + 3
      status: "charged",
      createdBy: USER_A,
    },
  });
}

dn("owner-billing statement auto-feeds utilities (integration, PART 4)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    await seedOccupiedOwnerUnit();
    await seedOwnerBorneUtilityBill();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("auto-includes the owner-borne utility components as statement lines (alongside mgmt-fee + cleaning)", async () => {
    const res = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // mgmt-fee + config cleaning still present (unchanged behavior).
    expect(res.data.lines.find((l) => l.chargeType === "management_fee")!.amount).toBe("200.00");
    expect(res.data.lines.find((l) => l.chargeType === "cleaning")!.amount).toBe("100.00");

    // NEW owner-borne utility lines from the bill's breakdown.
    const indah = res.data.lines.find((l) => l.chargeType === "sewerage");
    const wifi = res.data.lines.find((l) => l.chargeType === "wifi");
    const tnb = res.data.lines.find((l) => l.chargeType === "tnb");
    expect(indah, "indah water line").toBeDefined();
    expect(indah!.amount).toBe("30.00");
    expect(wifi, "wifi line").toBeDefined();
    expect(wifi!.amount).toBe("20.00");
    expect(tnb, "electricity owner-borne line").toBeDefined();
    expect(tnb!.amount).toBe("25.00"); // 10 vacant-aircond + 12 subsidy + 3 residual

    // 5 lines total: mgmt + cleaning + indah + wifi + tnb.
    expect(res.data.lines).toHaveLength(5);
    // Total = 200 mgmt + 100 cleaning + 16 sst + 30 + 20 + 25 = 391.00.
    expect(res.data.totalAmount).toBe("391.00");

    const db = getDb();
    expect(await db.charge.count({ where: { invoiceId: res.data.id } })).toBe(5);
  });

  it("is IDEMPOTENT: regenerate adds NO duplicate utility lines", async () => {
    const first = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.lines).toHaveLength(5);

    const second = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Same invoice, still exactly 5 charges (no utility-line duplication).
    expect(second.data.id).toBe(first.data.id);
    const db = getDb();
    expect(await db.charge.count({ where: { invoiceId: first.data.id } })).toBe(5);
    expect(await db.charge.count({ where: { organizationId: ORG_A, chargeType: "sewerage" } })).toBe(1);
    expect(await db.charge.count({ where: { organizationId: ORG_A, chargeType: "wifi" } })).toBe(1);
    expect(await db.charge.count({ where: { organizationId: ORG_A, chargeType: "tnb" } })).toBe(1);
  });

  it("no UnitUtilityBill for the period → no utility lines (only mgmt + cleaning)", async () => {
    const db = getDb();
    await db.unitUtilityBill.deleteMany({ where: { organizationId: ORG_A } });
    const res = await generateStatementService(CTX_A, { ownerPartyId: OWNER_A, billingMonth: BILLING_MONTH });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.lines).toHaveLength(2); // mgmt + cleaning only
    expect(res.data.lines.some((l) => ["tnb", "wifi", "sewerage"].includes(l.chargeType))).toBe(false);
  });
});

// ─── Owner statement detail + line add/edit/void (C5) — real concurrency ────

dn("owner-billing statement lines (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
    await seedOccupiedOwnerUnit();
  });

  afterAll(async () => {
    await cleanup();
  });

  /** Generate the draft statement under test (mgmt 200 + cleaning 100 + sst 16). */
  async function generate() {
    const res = await generateStatementService(CTX_A, {
      ownerPartyId: OWNER_A,
      billingMonth: BILLING_MONTH,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("seed generate failed");
    return res.data;
  }

  it("GET detail is org-scoped: ORG_A reads it, ORG_B 404s", async () => {
    const stmt = await generate();
    const own = await getStatementService(CTX_A, stmt.id);
    expect(own.ok).toBe(true);
    if (own.ok) {
      expect(own.data.id).toBe(stmt.id);
      expect(own.data.lines.length).toBeGreaterThanOrEqual(2);
    }
    const cross = await getStatementService(CTX_B, stmt.id);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.status).toBe(404);
  });

  it("add a line to a DRAFT statement persists a Charge + recomputes the total", async () => {
    const stmt = await generate();
    const before = Number(stmt.totalAmount); // 316.00
    const added = await addStatementLineService(CTX_A, stmt.id, {
      chargeType: "tnb",
      description: "TNB June",
      amount: "55.00",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(Number(added.data.totalAmount)).toBeCloseTo(before + 55, 2);

    const db = getDb();
    const charges = await db.charge.findMany({ where: { invoiceId: stmt.id, chargeType: "tnb" } });
    expect(charges).toHaveLength(1);
    expect(charges[0]!.organizationId).toBe(ORG_A);
    expect(charges[0]!.billingMonth).not.toBeNull();
    // Manual line carries status "draft" — same child-Charge lifecycle as the
    // generate path (NOT the Tenancy/User/Org "active" lifecycle).
    expect(charges[0]!.status).toBe("draft");
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.statement.line.add" },
      }),
    ).toBe(1);
  });

  it("PATCH a line amount with a fresh token updates it + recomputes; a stale token → 409", async () => {
    const stmt = await generate();
    const line = stmt.lines.find((l) => l.chargeType === "cleaning")!;
    // Fresh token → succeeds (cleaning 100 → 150 ⇒ total 316 + 50 = 366).
    const ok = await updateStatementLineService(CTX_A, stmt.id, line.id, {
      amount: "150.00",
      expectedUpdatedAt: line.updatedAt,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(Number(ok.data.totalAmount)).toBeCloseTo(366, 2);

    // Stale token (the original updatedAt is now superseded) → 409, exact message.
    const stale = await updateStatementLineService(CTX_A, stmt.id, line.id, {
      amount: "999.00",
      expectedUpdatedAt: STALE_UPDATED_AT,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.status).toBe(409);
      expect(stale.error).toBe("Record changed — reloaded");
    }
    const db = getDb();
    // Row untouched by the stale PATCH (still 150 from the fresh update).
    const row = await db.charge.findUnique({ where: { id: line.id } });
    expect(row!.amount.toString()).toBe("150");
  });

  it("ADD/PATCH on a NON-draft statement → 409; VOID is still allowed post-approve", async () => {
    const stmt = await generate();
    const db = getDb();
    // Flip the statement out of draft directly (no approve endpoint in C5).
    await db.invoice.update({ where: { id: stmt.id }, data: { status: "approved" } });

    const add = await addStatementLineService(CTX_A, stmt.id, {
      chargeType: "tnb",
      description: "late",
      amount: "10.00",
    });
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.status).toBe(409);

    // lines[0] is the management_fee line (generate plans mgmt-fee before cleaning
    // per unit). Voiding it must drop BOTH its base AND its SST from the total.
    const mgmtLine = stmt.lines.find((l) => l.chargeType === "management_fee")!;
    const patch = await updateStatementLineService(CTX_A, stmt.id, mgmtLine.id, {
      amount: "1.00",
      expectedUpdatedAt: mgmtLine.updatedAt,
    });
    expect(patch.ok).toBe(false);
    if (!patch.ok) expect(patch.status).toBe(409);

    // Void IS allowed even on an approved statement. The seed is mgmt base 200 (8%
    // SST = 16) + cleaning 100 + sstAmount 16 = total 316. Voiding the mgmt-fee
    // line removes its 200 base AND its 16 SST → surviving is cleaning 100, sst 0 →
    // total EXACTLY 100.00 (regression for the stranded-SST defect, which a
    // verbatim-preserved sstAmount would have left at 116.00).
    const voided = await voidStatementLineService(CTX_A, stmt.id, mgmtLine.id);
    expect(voided.ok).toBe(true);
    if (voided.ok) {
      expect(voided.data.totalAmount).toBe("100.00");
      expect(voided.data.sstAmount).toBe("0.00");
    }
    const voidedRow = await db.charge.findUnique({ where: { id: mgmtLine.id } });
    expect(voidedRow!.status).toBe("void");
    expect(
      await db.auditLog.count({
        where: { organizationId: ORG_A, action: "owner-billing.statement.line.void" },
      }),
    ).toBe(1);
  });

  it("cross-org: ORG_B cannot add/void a line on ORG_A's statement (404)", async () => {
    const stmt = await generate();
    const crossAdd = await addStatementLineService(CTX_B, stmt.id, {
      chargeType: "tnb",
      description: "x",
      amount: "1.00",
    });
    expect(crossAdd.ok).toBe(false);
    if (!crossAdd.ok) expect(crossAdd.status).toBe(404);

    const crossVoid = await voidStatementLineService(CTX_B, stmt.id, stmt.lines[0]!.id);
    expect(crossVoid.ok).toBe(false);
    if (!crossVoid.ok) expect(crossVoid.status).toBe(404);
  });
});

// ── Task 2a-3: findDepositsCollectedInMonth repository function ───────────────
//
// Dedicated describe block with its own seed + cleanup (disjoint UUIDs: 0e prefix).
// Seed: one Deposit row for an owner's unit in the test month → assert the function
// returns it. Also verifies: refunded deposits excluded, out-of-month excluded,
// empty unitIds returns empty array.

const DEP_ORG     = "0e000000-0000-4000-8000-0000000000a1";
const DEP_USER    = "0e000000-0000-4000-8000-0000000000a2";
const DEP_PARTY   = "0e000000-0000-4000-8000-0000000000a3";
const DEP_OWNER   = "0e000000-0000-4000-8000-0000000000a4";
const DEP_TENANT  = "0e000000-0000-4000-8000-0000000000a5";
const DEP_PROP    = "0e000000-0000-4000-8000-0000000000a6";
const DEP_APT     = "0e000000-0000-4000-8000-0000000000a7";
const DEP_UNIT    = "0e000000-0000-4000-8000-0000000000a8";
const DEP_TENANCY = "0e000000-0000-4000-8000-0000000000a9";

const DEP_MONTH_START = new Date(Date.UTC(2026, 5, 1));  // 2026-06-01
const DEP_MONTH_END   = new Date(Date.UTC(2026, 5, 30)); // 2026-06-30

async function cleanupDep() {
  const db = getDb();
  const org = { organizationId: DEP_ORG };
  await db.deposit.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: DEP_USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: DEP_ORG } });
}

async function seedDep() {
  const db = getDb();
  await db.organization.create({
    data: { id: DEP_ORG, name: "Dep Int Org", slug: "dep-int-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.create({ data: { id: DEP_PARTY, organizationId: DEP_ORG, displayName: "Dep Op", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: DEP_USER, organizationId: DEP_ORG, email: "dep-int@example.com", fullName: "Dep Op", status: "active", role: "admin", userType: "operator", partyId: DEP_PARTY } });
  await db.party.create({ data: { id: DEP_OWNER, organizationId: DEP_ORG, displayName: "Dep Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: DEP_TENANT, organizationId: DEP_ORG, displayName: "Dep Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: DEP_PROP, organizationId: DEP_ORG, name: "Dep Prop", propertyCode: "DP1", propertyType: "apartment", addressLine1: "1 Dep St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: DEP_APT, organizationId: DEP_ORG, propertyId: DEP_PROP, unitCode: "D-1", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: DEP_UNIT, organizationId: DEP_ORG, apartmentId: DEP_APT, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: DEP_OWNER } });
  await db.tenancy.create({ data: { id: DEP_TENANCY, organizationId: DEP_ORG, propertyId: DEP_PROP, unitId: DEP_UNIT, tenantPartyId: DEP_TENANT, tenancyCode: "DEP-T1", status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000" } });
  await db.landlordTenancy.create({ data: { organizationId: DEP_ORG, propertyId: DEP_PROP, landlordId: DEP_OWNER, startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRent: "1000", status: "active" } });
}

dn("findDepositsCollectedInMonth (2a-3)", () => {
  beforeEach(async () => {
    await cleanupDep();
    await seedDep();
  });

  afterAll(async () => {
    await cleanupDep();
  });

  it("(g1) returns a held deposit collected in the month", async () => {
    const db = getDb();
    await db.deposit.create({
      data: {
        organizationId: DEP_ORG,
        tenancyId: DEP_TENANCY,
        partyId: DEP_TENANT,
        unitId: DEP_UNIT,
        type: "security",
        amount: "2000.00",
        status: "held",
        createdAt: new Date(Date.UTC(2026, 5, 10)), // 2026-06-10 — within month
      },
    });

    const result = await findDepositsCollectedInMonth(DEP_ORG, [DEP_UNIT], DEP_MONTH_START, DEP_MONTH_END);
    expect(result).toHaveLength(1);
    expect(result[0]!.unitId).toBe(DEP_UNIT);
    expect(result[0]!.type).toBe("security");
    expect(result[0]!.amount).toBe("2000.00");
  });

  it("(g2) excludes deposits with status=refunded", async () => {
    const db = getDb();
    await db.deposit.create({
      data: {
        organizationId: DEP_ORG,
        tenancyId: DEP_TENANCY,
        partyId: DEP_TENANT,
        unitId: DEP_UNIT,
        type: "security",
        amount: "2000.00",
        status: "refunded",
        createdAt: new Date(Date.UTC(2026, 5, 10)),
      },
    });

    const result = await findDepositsCollectedInMonth(DEP_ORG, [DEP_UNIT], DEP_MONTH_START, DEP_MONTH_END);
    expect(result).toHaveLength(0);
  });

  it("(g3) excludes deposits created outside the month window", async () => {
    const db = getDb();
    await db.deposit.create({
      data: {
        organizationId: DEP_ORG,
        tenancyId: DEP_TENANCY,
        partyId: DEP_TENANT,
        unitId: DEP_UNIT,
        type: "security",
        amount: "2000.00",
        status: "held",
        createdAt: new Date(Date.UTC(2026, 6, 1)), // 2026-07-01 — after month end
      },
    });

    const result = await findDepositsCollectedInMonth(DEP_ORG, [DEP_UNIT], DEP_MONTH_START, DEP_MONTH_END);
    expect(result).toHaveLength(0);
  });

  it("(g4) returns empty array when unitIds is empty", async () => {
    const result = await findDepositsCollectedInMonth(DEP_ORG, [], DEP_MONTH_START, DEP_MONTH_END);
    expect(result).toHaveLength(0);
  });
});
