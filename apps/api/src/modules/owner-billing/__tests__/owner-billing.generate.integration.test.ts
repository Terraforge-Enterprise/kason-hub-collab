/**
 * Statement generation — combined "All Units" + per-unit (integration).
 *
 * TWO statement types (2026-07-01): absent apartmentId ⇒ the combined "All Units"
 * statement — exactly ONE Invoice(apartmentId=null) per owner/month covering ALL
 * the owner's units (no partial subset); a valid apartmentId ⇒ a per-unit statement
 * scoped to that ONE apartment (an admin/accountant accounting view, kept OFF the
 * owner portal). Both are stored Invoices with DISTINCT idempotency keys + numbers,
 * so a per-unit statement and the combined one (and per-unit statements for other
 * apartments) coexist for the same owner+month without colliding or duplicating.
 *
 * This proves, against a real LOCAL Postgres (opt-in RUN_INTEGRATION=1) through
 * the REAL generateStatementService (no service mock), that:
 *   1. Generating twice for {owner, month} returns the SAME Invoice (idempotent)
 *      with apartmentId === null — even when the owner owns TWO apartments.
 *   2. The single combined statement covers BOTH apartments' charges (one mgmt-fee
 *      line per occupied room across all apartments + one cleaning line per
 *      apartment), so retiring per-unit generation loses no billed line.
 *
 * Storage + Chromium are NOT touched (generate yields a draft; no PDF render).
 *
 * Run:
 *   cd apps/api
 *   DATABASE_URL="postgresql://…/kason_hub_dev?schema=public" \
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ../../node_modules/.bin/vitest run \
 *       src/modules/owner-billing/__tests__/owner-billing.generate.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../owner-billing.types";
import { voidStatementService } from "../owner-billing.service";

// generate fires the owner-ledger sync hook AFTER its tx commits; that path is
// flag-gated + opens its own tx. Keep it real (flag on) so nothing about the
// combined invoice shape is faked — but recordAudit is stubbed (no audit assertions).
vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import { generateStatementService, createFeeConfigService } from "../owner-billing.service";

// ── Safety guard ──────────────────────────────────────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  // The post-commit owner-ledger sync hook is flag-gated; keep it on so the
  // combined statement materialises its owner-side charges like production.
  if (!(process.env.ENABLE_PHASE2_OWNER_BILLING === "1" || process.env.ENABLE_PHASE2_OWNER_BILLING === "true")) {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  }
}

// ── Fixed disjoint UUIDs (prefix 9c01; unused by any other suite) ──────────────
const ORG    = "9c010000-0000-4000-8000-000000000001";
const USER   = "9c010000-0000-4000-8000-000000000002";
const PARTY  = "9c010000-0000-4000-8000-000000000003";
const OWNER  = "9c010000-0000-4000-8000-000000000004";
const PROP   = "9c010000-0000-4000-8000-000000000005";
const APT_1  = "9c010000-0000-4000-8000-000000000006"; // A-10-04 whole
const UNIT_1 = "9c010000-0000-4000-8000-000000000007";
const TEN_1  = "9c010000-0000-4000-8000-000000000008";
const TENANT_1 = "9c010000-0000-4000-8000-000000000009";
const APT_2  = "9c010002-0000-4000-8000-00000000000a"; // A-19-02 whole (first-8 distinct from APT_1 → distinct per-unit statement number)
const UNIT_2 = "9c010000-0000-4000-8000-00000000000b";
const TEN_2  = "9c010000-0000-4000-8000-00000000000c";
const TENANT_2 = "9c010000-0000-4000-8000-00000000000d";

const BILLING_MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.landlordTenancy.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedApartmentWithRoom(
  apartmentId: string,
  unitCode: string,
  listingId: string,
  tenancyId: string,
  tenantId: string,
  rent: string,
): Promise<void> {
  const db = getDb();
  await db.apartment.create({
    data: { id: apartmentId, organizationId: ORG, propertyId: PROP, unitCode, listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: listingId,
      organizationId: ORG,
      apartmentId,
      listingType: "Whole Unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER,
    },
  });
  await db.party.create({
    data: { id: tenantId, organizationId: ORG, displayName: `Tenant ${unitCode}`, partyType: "individual", status: "active" },
  });
  await db.tenancy.create({
    data: {
      id: tenancyId,
      organizationId: ORG,
      propertyId: PROP,
      unitId: listingId,
      tenantPartyId: tenantId,
      tenancyCode: `T-${unitCode}`,
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: rent,
    },
  });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "9C01 Combined Org",
      slug: "9c01-combined-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "9C01 Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "9c01-operator@example.com",
      fullName: "9C01 Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "9C01 Owner", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROP,
      organizationId: ORG,
      name: "9C01 Property",
      propertyCode: "9C01-P1",
      propertyType: "apartment",
      addressLine1: "1 Combined St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  // TWO distinct apartments under one owner — the case per-unit generation used to
  // split into two statements; combined-only must fold them into ONE.
  await seedApartmentWithRoom(APT_1, "A-10-04", UNIT_1, TEN_1, TENANT_1, "2000");
  await seedApartmentWithRoom(APT_2, "A-19-02", UNIT_2, TEN_2, TENANT_2, "1500");

  // 10%/8%-SST config + cleaning auto-bill so each apartment yields mgmt + cleaning lines.
  await createFeeConfigService(ctx, {
    ownerPartyId: OWNER,
    feeType: "percent",
    feeValue: "10",
    sstPercent: "8",
    isActive: true,
  });
}

dn("generateStatementService — combined-only (integration)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("generates one combined statement per owner/month (idempotent, apartmentId === null)", async () => {
    const a = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    const b = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return; // narrow for TS
    // Idempotent: the second call returns the SAME invoice, never a duplicate.
    expect(a.data.id).toBe(b.data.id);

    const db = getDb();
    const inv = await db.invoice.findUniqueOrThrow({
      where: { id: a.data.id },
      select: { apartmentId: true, invoiceNumber: true, invoiceType: true },
    });
    // Combined-only: the persisted statement is owner-scoped (apartmentId null).
    expect(inv.apartmentId).toBeNull();
    expect(inv.invoiceType).toBe("owner_statement");
    // Invoice number is the owner-combined form OS-<mm>-<owner8> (no apartment suffix).
    expect(inv.invoiceNumber).toBe(`OS-202606-${OWNER.slice(0, 8)}`);

    // Exactly ONE owner_statement Invoice exists for this {owner, month}.
    const count = await db.invoice.count({
      where: { organizationId: ORG, ownerPartyId: OWNER, invoiceType: "owner_statement", periodMonth: MONTH_START },
    });
    expect(count).toBe(1);
  });

  // The management-fee Charge was created with `description` omitted entirely —
  // unlike its utility and letting-commission-SST siblings, which both pass one.
  // The column landed NULL and every downstream reader fell back to a constant
  // literal, so the charge could not describe itself anywhere it was read.
  it("writes a real description on the management-fee charge (never NULL)", async () => {
    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return; // narrow for TS

    const db = getDb();
    const mgmt = await db.charge.findMany({
      where: { organizationId: ORG, invoiceId: r.data.id, chargeType: "management_fee" },
      select: { description: true, amount: true },
    });
    expect(mgmt.length).toBeGreaterThan(0);
    for (const c of mgmt) {
      expect(c.description).not.toBeNull();
      expect(c.description).toBe("Management fee");
    }
  });

  it("the single combined statement covers BOTH apartments (no billed line is lost)", async () => {
    const r = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const db = getDb();
    // Both apartments' rooms are occupied → one mgmt-fee line each (2 total).
    const mgmt = await db.charge.findMany({
      where: { organizationId: ORG, invoiceId: r.data.id, chargeType: "management_fee" },
      select: { unitId: true },
    });
    expect(mgmt.map((c) => c.unitId).sort()).toEqual([UNIT_1, UNIT_2].sort());

    // One cleaning line PER apartment (cleaning is per-apartment) → 2 total.
    const cleaning = await db.charge.count({
      where: { organizationId: ORG, invoiceId: r.data.id, chargeType: "cleaning" },
    });
    expect(cleaning).toBe(2);
  });

  // ── Bug-fix: voiding a statement releases the owner+month slot so a new one can be generated ──

  it("regenerate after void: produces a NEW statement with the canonical number; voided row is slot-released", async () => {
    const db = getDb();

    // (a) Generate → S1 (status draft)
    const gen1 = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(gen1.ok).toBe(true);
    if (!gen1.ok) return;
    const s1Id = gen1.data.id;
    const s1Number = gen1.data.invoiceNumber;

    // (b) Void S1 via voidStatementService
    const voidResult = await voidStatementService(ctx, s1Id);
    expect(voidResult.ok).toBe(true);
    if (!voidResult.ok) return;

    // (c) Generate AGAIN → should produce a fresh statement S2
    const gen2 = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(gen2.ok).toBe(true);
    if (!gen2.ok) return;
    const s2Id = gen2.data.id;

    // S2 must be a DIFFERENT invoice from S1
    expect(s2Id).not.toBe(s1Id);

    // S2 must not be voided
    expect(gen2.data.status).not.toBe("void");

    // S2 must carry the CLEAN canonical invoice number (no suffix)
    const expectedNumber = `OS-202606-${OWNER.slice(0, 8)}`;
    expect(gen2.data.invoiceNumber).toBe(expectedNumber);

    // The VOIDED row (S1) must be slot-released: its idempotencyKey set null
    // and its invoiceNumber mangled to <orig>-V-<id8>
    const s1Row = await db.invoice.findUniqueOrThrow({
      where: { id: s1Id },
      select: { idempotencyKey: true, invoiceNumber: true, status: true },
    });
    expect(s1Row.status).toBe("void"); // void state stays terminal
    expect(s1Row.idempotencyKey).toBeNull();
    expect(s1Row.invoiceNumber).toBe(`${s1Number}-V-${s1Id.slice(0, 8)}`);

    // Exactly ONE non-void owner_statement exists for this {owner, month}
    const nonVoidCount = await db.invoice.count({
      where: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        invoiceType: "owner_statement",
        periodMonth: MONTH_START,
        status: { not: "void" },
      },
    });
    expect(nonVoidCount).toBe(1);
  });

  it("normal idempotency is preserved: two consecutive generates (no void) return the same draft id", async () => {
    const a = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    const b = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Idempotent — SAME invoice returned from the second call
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.status).toBe(a.data.status);
  });
});

dn("generateStatementService — per-unit (integration)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("scopes a per-unit statement to ONE apartment (apartmentId + suffixed number + only that apt's lines)", async () => {
    const r = await generateStatementService(ctx, {
      ownerPartyId: OWNER,
      billingMonth: BILLING_MONTH,
      apartmentId: APT_1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const db = getDb();
    const inv = await db.invoice.findUniqueOrThrow({
      where: { id: r.data.id },
      select: { apartmentId: true, invoiceNumber: true, invoiceType: true },
    });
    // Persisted with the scoped apartmentId + the apartment-suffixed number
    // (would be null / un-suffixed if the service ignored apartmentId).
    expect(inv.apartmentId).toBe(APT_1);
    expect(inv.invoiceType).toBe("owner_statement");
    expect(inv.invoiceNumber).toBe(`OS-202606-${OWNER.slice(0, 8)}-${APT_1.slice(0, 8)}`);

    // Lines cover ONLY APT_1's room — never APT_2's (would be [UNIT_1, UNIT_2] if combined).
    const mgmt = await db.charge.findMany({
      where: { organizationId: ORG, invoiceId: r.data.id, chargeType: "management_fee" },
      select: { unitId: true },
    });
    expect(mgmt.map((c) => c.unitId)).toEqual([UNIT_1]);
    const cleaning = await db.charge.findMany({
      where: { organizationId: ORG, invoiceId: r.data.id, chargeType: "cleaning" },
      select: { unitId: true },
    });
    expect(cleaning.map((c) => c.unitId)).toEqual([UNIT_1]); // representative room of APT_1
  });

  it("is idempotent per apartment (re-run returns the SAME invoice)", async () => {
    const a = await generateStatementService(ctx, {
      ownerPartyId: OWNER,
      billingMonth: BILLING_MONTH,
      apartmentId: APT_1,
    });
    const b = await generateStatementService(ctx, {
      ownerPartyId: OWNER,
      billingMonth: BILLING_MONTH,
      apartmentId: APT_1,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.data.id).toBe(a.data.id);
  });

  it("per-unit statements for different apartments coexist as separate invoices (no collision)", async () => {
    const a1 = await generateStatementService(ctx, {
      ownerPartyId: OWNER,
      billingMonth: BILLING_MONTH,
      apartmentId: APT_1,
    });
    const a2 = await generateStatementService(ctx, {
      ownerPartyId: OWNER,
      billingMonth: BILLING_MONTH,
      apartmentId: APT_2,
    });
    expect(a1.ok && a2.ok).toBe(true);
    if (!a1.ok || !a2.ok) return;
    // Two DISTINCT invoices, each scoped to its own apartment.
    expect(a1.data.id).not.toBe(a2.data.id);

    const db = getDb();
    const invs = await db.invoice.findMany({
      where: {
        organizationId: ORG,
        ownerPartyId: OWNER,
        invoiceType: "owner_statement",
        periodMonth: MONTH_START,
      },
      select: { apartmentId: true },
    });
    expect(invs.map((i) => i.apartmentId).sort()).toEqual([APT_1, APT_2].sort());
  });

  it("404s a per-unit request for an apartment that is not this owner's", async () => {
    const FOREIGN_APT = "9c010000-0000-4000-8000-0000000000ff";
    const r = await generateStatementService(ctx, {
      ownerPartyId: OWNER,
      billingMonth: BILLING_MONTH,
      apartmentId: FOREIGN_APT,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
  });
});
