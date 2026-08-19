/**
 * Integration tests for M5 Auto-Draft Invoices — the runAutoDraftInvoices monthly
 * run. Hits a real LOCAL Postgres. Skipped by default in `npx vitest run`. Run
 * explicitly:
 *   RUN_INTEGRATION=1 DATABASE_URL="<local>" \
 *     npx vitest run src/modules/billing/__tests__/auto-draft.integration.test.ts
 *
 * Mirrors the owner-billing integration harness: fixed-UUID seed + org-scoped
 * deleteMany cleanup (the service owns its own per-tenancy transactions). Asserts
 * the no-auto-approve invariant, real idempotency (the
 * @@unique([organizationId, idempotencyKey]) index), that tenant utility/aircond
 * charges are NOT folded onto the rent draft (they are standalone POSTED charges
 * under the one-action flow), and that an InvoiceDraftRun ledger row is recorded.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import {
  approveInvoiceService,
  runAutoDraftInvoices,
  voidInvoiceService,
} from "../auto-draft.service";
import { firstOfMonthUtc } from "../auto-draft.repository";

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
const ORG_A = "0c000000-0000-4000-8000-0000000000a1";
const USER_A = "0c000000-0000-4000-8000-0000000000a2";
const PARTY_A = "0c000000-0000-4000-8000-0000000000a3"; // operator's paired party
const TENANT_A = "0c000000-0000-4000-8000-0000000000a4";
const PROPERTY_A = "0c000000-0000-4000-8000-0000000000a5";
const APARTMENT_A = "0c000000-0000-4000-8000-0000000000a6";
const UNIT_A = "0c000000-0000-4000-8000-0000000000a7";
const TENANCY_A = "0c000000-0000-4000-8000-0000000000a8";
// Owner-statement UUIDs (Task 5) — disjoint from tenant UUIDs above.
const OWNER_PARTY_A = "0c000000-0000-4000-8000-0000000000b1";
const LANDLORD_TENANCY_A = "0c000000-0000-4000-8000-0000000000b2";

const PERIOD = "2026-06";

const CTX_A = { orgId: ORG_A, actorUserId: USER_A, actorRole: "admin" as const, triggeredBy: "system:auto-draft" };

async function seedTenantOnly(opts: { includeRent?: boolean; includeElectricity?: boolean } = {}) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG_A,
      name: "AD Int Org A",
      slug: "ad-int-org-a",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  // Operator invariant: every operator User carries a paired individual Party.
  await db.party.create({
    data: {
      id: PARTY_A,
      organizationId: ORG_A,
      displayName: "AD Operator",
      partyType: "individual",
      status: "active",
    },
  });
  // Real admin User: AuditLog.actorUserId is FK → User (onDelete: Restrict).
  await db.user.create({
    data: {
      id: USER_A,
      organizationId: ORG_A,
      email: "ad-int-operator@example.com",
      fullName: "AD Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY_A,
    },
  });
  await db.party.create({
    data: {
      id: TENANT_A,
      organizationId: ORG_A,
      displayName: "AD Tenant",
      partyType: "individual",
      status: "active",
    },
  });
  await db.property.create({
    data: {
      id: PROPERTY_A,
      organizationId: ORG_A,
      name: "AD Int Property",
      propertyCode: "AD-INT-P1",
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
    },
  });
  await db.tenancy.create({
    data: {
      id: TENANCY_A,
      organizationId: ORG_A,
      propertyId: PROPERTY_A,
      unitId: UNIT_A,
      tenantPartyId: TENANT_A,
      tenancyCode: "AD-INT-T1",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "1500.00",
    },
  });
  await db.draftConfig.create({
    data: {
      organizationId: ORG_A,
      runDayOfMonth: 1,
      includeRent: opts.includeRent ?? true,
      includeElectricity: opts.includeElectricity ?? true,
      includeMgmtFee: false,
      includeCleaning: false,
      isActive: true,
    },
  });
  return { orgId: ORG_A, adminId: USER_A, tenancyId: TENANCY_A, unitId: UNIT_A, partyId: TENANT_A };
}

/** A standalone DRAFT tenant charge. The auto-draft run must NOT fold it into the rent invoice. */
async function createDraftCharge(
  orgId: string,
  input: { tenancyId: string; unitId: string; partyId: string; chargeType: string; amount: string; billingMonth: Date },
) {
  const db = getDb();
  return db.charge.create({
    data: {
      organizationId: orgId,
      chargeNumber: `AC-${input.chargeType}-${Date.now()}`,
      tenancyId: input.tenancyId,
      unitId: input.unitId,
      partyId: input.partyId,
      chargeType: input.chargeType,
      status: "draft",
      description: `${input.chargeType} charge`,
      dueDate: input.billingMonth,
      amount: input.amount,
      currency: "MYR",
      outstandingAmount: input.amount,
      billingMonth: input.billingMonth,
      attachmentKeys: [],
    },
  });
}

/** Delete everything in FK-safe order (AuditLog before User — Restrict FK). */
async function cleanup() {
  const db = getDb();
  const orgs = { in: [ORG_A] };
  await db.chargeEvent.deleteMany({ where: { organizationId: orgs } });
  await db.charge.deleteMany({ where: { organizationId: orgs } });
  await db.invoice.deleteMany({ where: { organizationId: orgs } });
  await db.invoiceDraftRun.deleteMany({ where: { organizationId: orgs } });
  await db.draftConfig.deleteMany({ where: { organizationId: orgs } });
  await db.tenancy.deleteMany({ where: { organizationId: orgs } });
  await db.managementFeeConfig.deleteMany({ where: { organizationId: orgs } });
  await db.landlordTenancy.deleteMany({ where: { organizationId: orgs } });
  await db.listing.deleteMany({ where: { organizationId: orgs } });
  await db.apartment.deleteMany({ where: { organizationId: orgs } });
  await db.property.deleteMany({ where: { organizationId: orgs } });
  await db.auditLog.deleteMany({ where: { organizationId: orgs } });
  await db.user.deleteMany({ where: { organizationId: orgs } });
  await db.partyRole.deleteMany({ where: { organizationId: orgs } });
  await db.party.deleteMany({ where: { organizationId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
}

/** Seed an owner (Party + LandlordTenancy + ManagementFeeConfig) alongside the tenant org. */
async function seedOwnerWithFeeConfig(
  orgId: string,
  opts: { includeMgmtFee?: boolean; includeCleaning?: boolean } = {},
) {
  const db = getDb();
  await db.party.create({
    data: {
      id: OWNER_PARTY_A,
      organizationId: orgId,
      displayName: "AD Owner",
      partyType: "individual",
      status: "active",
    },
  });
  // Owner re-point: findOwnerInOrg now resolves "owner in org" via a PartyRole;
  // listDistinctActiveOwners + resolveOwnerUnitsForMonth resolve units via
  // Listing.ownerPartyId. Stamp the role + point UNIT_A at this owner.
  await db.partyRole.create({
    data: { organizationId: orgId, partyId: OWNER_PARTY_A, roleType: "owner", status: "active" },
  });
  await db.listing.update({
    where: { id: UNIT_A },
    data: { ownerPartyId: OWNER_PARTY_A },
  });
  await db.landlordTenancy.create({
    data: {
      id: LANDLORD_TENANCY_A,
      organizationId: orgId,
      propertyId: PROPERTY_A,
      landlordId: OWNER_PARTY_A,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRent: "2000.00",
      status: "active",
    },
  });
  await db.managementFeeConfig.create({
    data: {
      organizationId: orgId,
      ownerPartyId: OWNER_PARTY_A,
      feeType: "percent",
      feeValue: "10",
      sstPercent: "8",
      isActive: true,
    },
  });
  // Update DraftConfig toggles for this test.
  await db.draftConfig.update({
    where: { organizationId: orgId },
    data: {
      includeMgmtFee: opts.includeMgmtFee ?? true,
      includeCleaning: opts.includeCleaning ?? true,
    },
  });
}

dn("runAutoDraftInvoices — owner statements (integration)", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("drafts an owner_statement invoice via M6 generateStatementService, status=draft, idempotent", async () => {
    // seedTenantOnly builds the org/user/property/apartment/listing/tenancy/draftConfig
    const { orgId } = await seedTenantOnly({ includeRent: false, includeElectricity: false });
    await seedOwnerWithFeeConfig(orgId);

    const r1 = await runAutoDraftInvoices(CTX_A, PERIOD);
    expect(r1.status).toBe("completed");
    expect(r1.draftsCreated).toBeGreaterThanOrEqual(1);

    const db = getDb();
    const os = await db.invoice.findFirst({
      where: { organizationId: orgId, invoiceType: "owner_statement" },
    });
    expect(os).not.toBeNull();
    expect(os?.status).toBe("draft");
    expect(os?.approvedBy).toBeNull();

    // Second run — M6 idempotency returns 200 → counted as skipped.
    const r2 = await runAutoDraftInvoices(CTX_A, PERIOD);
    expect(r2.draftsSkipped).toBeGreaterThanOrEqual(1);
    // Still exactly one owner_statement invoice — no double-draft.
    expect(
      await db.invoice.count({ where: { organizationId: orgId, invoiceType: "owner_statement" } }),
    ).toBe(1);
  });

  it("skips owner statements entirely when both includeMgmtFee:false + includeCleaning:false", async () => {
    const { orgId } = await seedTenantOnly({ includeRent: false, includeElectricity: false });
    await seedOwnerWithFeeConfig(orgId, { includeMgmtFee: false, includeCleaning: false });

    await runAutoDraftInvoices(CTX_A, PERIOD);

    const db = getDb();
    expect(
      await db.invoice.count({ where: { organizationId: orgId, invoiceType: "owner_statement" } }),
    ).toBe(0);
  });
});

dn("runAutoDraftInvoices — tenant drafts (integration)", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates ONE draft invoice per active tenancy with a rent charge, status=draft, approvedBy null", async () => {
    const { orgId, tenancyId } = await seedTenantOnly();
    const r = await runAutoDraftInvoices(CTX_A, PERIOD);
    expect(r.status).toBe("completed");
    expect(r.draftsCreated).toBe(1);

    const db = getDb();
    const inv = await db.invoice.findFirstOrThrow({
      where: { organizationId: orgId, idempotencyKey: `draft:${tenancyId}:${PERIOD}` },
      include: { charges: true },
    });
    expect(inv.status).toBe("draft");
    expect(inv.approvedBy).toBeNull();
    expect(inv.invoiceType).toBe("tenant_rental");
    expect(inv.charges.some((c) => c.chargeType === "rent" && Number(c.amount) === 1500)).toBe(true);
    expect(Number(inv.totalAmount)).toBe(1500);
  });

  it("NEVER auto-approves or sends: every created invoice is draft with no approvedBy/approvedAt", async () => {
    const { orgId } = await seedTenantOnly();
    await runAutoDraftInvoices(CTX_A, PERIOD);
    const db = getDb();
    const invs = await db.invoice.findMany({ where: { organizationId: orgId } });
    expect(invs.length).toBeGreaterThan(0);
    expect(invs.every((i) => i.status === "draft" && i.approvedBy === null && i.approvedAt === null)).toBe(true);
  });

  it("is idempotent: a second run for the same period creates 0 and skips 1 (unique idempotencyKey index)", async () => {
    await seedTenantOnly();
    await runAutoDraftInvoices(CTX_A, PERIOD);
    const r2 = await runAutoDraftInvoices(CTX_A, PERIOD);
    expect(r2.draftsCreated).toBe(0);
    expect(r2.draftsSkipped).toBe(1);

    const db = getDb();
    // Exactly ONE invoice for the tenancy+period — no duplicate.
    expect(
      await db.invoice.count({
        where: { organizationId: ORG_A, idempotencyKey: `draft:${TENANCY_A}:${PERIOD}` },
      }),
    ).toBe(1);
  });

  it("does NOT fold tenant utility/aircond charges into the rent draft (standalone POSTED charges)", async () => {
    const { orgId, tenancyId, unitId, partyId } = await seedTenantOnly();
    // A tenant aircond charge present BEFORE the run must NOT be folded in.
    const elec = await createDraftCharge(orgId, {
      tenancyId,
      unitId,
      partyId,
      chargeType: "aircond",
      amount: "50.00",
      billingMonth: firstOfMonthUtc(PERIOD),
    });
    await runAutoDraftInvoices(CTX_A, PERIOD);

    const db = getDb();
    const inv = await db.invoice.findFirstOrThrow({
      where: { organizationId: orgId, idempotencyKey: `draft:${tenancyId}:${PERIOD}` },
      include: { charges: true },
    });
    // Rent only — the aircond charge is NOT attached, and the total excludes it.
    expect(inv.charges.some((c) => c.chargeType === "aircond")).toBe(false);
    expect(inv.charges.every((c) => c.chargeType === "rent")).toBe(true);
    expect(Number(inv.totalAmount)).toBe(1500); // 1500 rent, NO electricity folded

    // The standalone aircond charge is left untouched: still unlinked + draft.
    const elecAfter = await db.charge.findUniqueOrThrow({ where: { id: elec.id } });
    expect(elecAfter.invoiceId).toBeNull();
    expect(elecAfter.status).toBe("draft");
  });

  it("records the run in InvoiceDraftRun with the right triggeredBy", async () => {
    const { orgId } = await seedTenantOnly();
    await runAutoDraftInvoices(CTX_A, PERIOD);
    const db = getDb();
    const run = await db.invoiceDraftRun.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(run.status).toBe("completed");
    expect(run.draftsCreated).toBe(1);
    expect(run.triggeredBy).toBe("system:auto-draft");
  });
});

// ── Task 7: invoice transitions (integration, opt-in) ─────────────────────────
//
// Exercises approve/void against a REAL draft seeded by runAutoDraftInvoices, then
// proves the money rules at the DB level: approve stamps the actor; void from
// approved succeeds; void DETACHES the electricity charge (row survives,
// invoiceId null) and VOIDS the synthesized rent charge (row survives, status
// "void"). NEITHER charge row is ever deleted.

/** Run the auto-draft job then return the single draft invoice it created. */
async function seedOneDraft() {
  const { orgId, tenancyId } = await seedTenantOnly();
  await runAutoDraftInvoices(CTX_A, PERIOD);
  const db = getDb();
  const inv = await db.invoice.findFirstOrThrow({
    where: { organizationId: orgId, idempotencyKey: `draft:${tenancyId}:${PERIOD}` },
  });
  return { orgId, adminId: USER_A, invoiceId: inv.id, updatedAt: inv.updatedAt.toISOString() };
}

dn("invoice transitions (integration)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("approve flips draft → approved and stamps approvedBy/approvedAt", async () => {
    const { orgId, invoiceId, updatedAt } = await seedOneDraft();
    const ctx = { orgId, actorUserId: USER_A, actorRole: "admin" as const };
    const r = await approveInvoiceService(ctx, invoiceId, updatedAt);
    expect(r.ok && r.status === 200).toBe(true);

    const db = getDb();
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe("approved");
    expect(inv.approvedBy).toBe(USER_A);
    expect(inv.approvedAt).not.toBeNull();

    // A second approve (now non-draft) is rejected 409.
    const again = await approveInvoiceService(ctx, invoiceId, inv.updatedAt.toISOString());
    expect(again.ok).toBe(false);
    expect(again.status).toBe(409);
  });

  it("approve (billing-docs on) POSTS the rent charge and mints its document", async () => {
    const prev = process.env.ENABLE_PHASE2_BILLING_DOCS;
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    try {
      const { orgId, invoiceId, updatedAt } = await seedOneDraft();
      const ctx = { orgId, actorUserId: USER_A, actorRole: "admin" as const };
      const db = getDb();
      const before = await db.charge.findFirstOrThrow({ where: { organizationId: orgId, invoiceId, chargeType: "rent" } });
      expect(before.status).toBe("draft"); // not yet a live receivable

      const r = await approveInvoiceService(ctx, invoiceId, updatedAt);
      expect(r.ok).toBe(true);

      const after = await db.charge.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.status).toBe("posted"); // approval made it live
      expect(after.postedAt).not.toBeNull();
      // Mint-on-post upheld: the now-posted charge has a BillingDocument line.
      const line = await db.billingDocumentLine.findFirst({ where: { chargeId: before.id, document: { organizationId: orgId } } });
      expect(line).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ENABLE_PHASE2_BILLING_DOCS;
      else process.env.ENABLE_PHASE2_BILLING_DOCS = prev;
    }
  });

  it("void of an approved invoice CREDITS the posted rent charge (no orphaned document)", async () => {
    const prev = process.env.ENABLE_PHASE2_BILLING_DOCS;
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    try {
      const { orgId, invoiceId, updatedAt } = await seedOneDraft();
      const ctx = { orgId, actorUserId: USER_A, actorRole: "admin" as const };
      const db = getDb();
      await approveInvoiceService(ctx, invoiceId, updatedAt);
      const rent = await db.charge.findFirstOrThrow({ where: { organizationId: orgId, invoiceId, chargeType: "rent" } });
      expect(rent.status).toBe("posted");

      const approved = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      const v = await voidInvoiceService(ctx, invoiceId, approved.updatedAt.toISOString(), "duplicate");
      expect(v.ok).toBe(true);

      // Posted + documented rent charge is credited (outstanding zeroed) — never left live.
      const afterVoid = await db.charge.findUniqueOrThrow({ where: { id: rent.id } });
      expect(["credited", "void"]).toContain(afterVoid.status);
      expect(Number(afterVoid.outstandingAmount)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_PHASE2_BILLING_DOCS;
      else process.env.ENABLE_PHASE2_BILLING_DOCS = prev;
    }
  });

  it("void from approved succeeds and sets status void", async () => {
    const { orgId, invoiceId, updatedAt } = await seedOneDraft();
    const ctx = { orgId, actorUserId: USER_A, actorRole: "admin" as const };
    await approveInvoiceService(ctx, invoiceId, updatedAt);

    const db = getDb();
    const approved = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const r = await voidInvoiceService(ctx, invoiceId, approved.updatedAt.toISOString(), "duplicate");
    expect(r.ok && r.status === 200).toBe(true);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe("void");
  });

  it("void DETACHES a non-rent charge (row survives, invoiceId null) and VOIDS rent (row survives); neither deleted", async () => {
    const { orgId, tenancyId, unitId, partyId } = await seedTenantOnly();
    // A standalone aircond charge (no longer auto-folded) is manually attached to the draft,
    // mirroring an admin attach, so we can prove that VOID DETACHES it rather than deleting it.
    const elec = await createDraftCharge(orgId, {
      tenancyId, unitId, partyId, chargeType: "aircond", amount: "50.00", billingMonth: firstOfMonthUtc(PERIOD),
    });
    await runAutoDraftInvoices(CTX_A, PERIOD);

    const db = getDb();
    const inv = await db.invoice.findFirstOrThrow({
      where: { organizationId: orgId, idempotencyKey: `draft:${tenancyId}:${PERIOD}` },
    });
    await db.charge.update({ where: { id: elec.id }, data: { invoiceId: inv.id } });

    const ctx = { orgId, actorUserId: USER_A, actorRole: "admin" as const };
    const r = await voidInvoiceService(ctx, inv.id, inv.updatedAt.toISOString());
    expect(r.ok).toBe(true);

    const rent = await db.charge.findFirstOrThrow({ where: { organizationId: orgId, chargeType: "rent" } });
    const elecAfter = await db.charge.findUniqueOrThrow({ where: { id: elec.id } });
    expect(rent.status).toBe("void"); // synthesized rent line voided, still exists
    expect(elecAfter.invoiceId).toBeNull(); // non-rent charge detached, still exists
    expect(elecAfter.status).not.toBe("void"); // detach must NOT void the external charge
  });
});
