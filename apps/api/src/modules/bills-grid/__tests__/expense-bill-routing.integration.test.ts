/**
 * P4 (accounting-document redesign) — issue-grouped.ts's tenant-borne grid-expense
 * ROUTING. When ENABLE_EXPENSE_BILL is ON, a bills-grid tenant-borne expense Charge
 * (chargeType:"expense", sourceGridExpenseId set, tenant-family category) must issue
 * on its OWN "Expense Bill" (EB-) document — NEVER co-grouped onto the tenant's IVTEN
 * — because recovering a tenant-borne expense is not KAEN service revenue. Mirrors
 * P5's owner-borne EXCLUSION test (owner-borne-deduct-grouping.integration.test.ts)
 * but ROUTES instead of excluding: the tenant still receives the charge, just on a
 * separate document.
 *
 * mintExpenseChargesTx (service.ts) is UNCHANGED by P4 — the Charge is always minted
 * (same category, same chargeNumber format) regardless of the flag; only
 * issue-grouped.ts's downstream GROUPING/ISSUANCE decision changes.
 *
 * MONEY-CRITICAL — this suite also proves the grouping-key fix: an EB-routed charge
 * and an IVTEN service charge sharing the IDENTICAL (counterpartyType, partyId,
 * unitId, billingMonth, docType) tuple must NEVER land in the same group/document
 * (both are docType "invoice", tenant family — the ONLY thing that can separate them
 * is the routed-series discriminator threaded into the grouping key).
 *
 * Real local Postgres only (mirrors grouped-issue.test.ts / owner-borne-deduct-
 * grouping.integration.test.ts's own RUN_INTEGRATION + host-guard convention).
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/expense-bill-routing.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueGroupedGridInvoiceTx } from "../issue-grouped";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "b7c00000-0000-4000-8000-000000000001";
const USER = "b7c00000-0000-4000-8000-000000000002";
const PROP = "b7c00000-0000-4000-8000-000000000003";
const APT = "b7c00000-0000-4000-8000-000000000004";
const ROOM_A = "b7c00000-0000-4000-8000-000000000005";
const PARTY_A = "b7c00000-0000-4000-8000-000000000006";
const OWNER_PARTY = "b7c00000-0000-4000-8000-000000000007";
const TEN_A = "b7c00000-0000-4000-8000-000000000008";
const GRID_ENTRY = "b7c00000-0000-4000-8000-000000000009";
const GRID_EXPENSE = "b7c00000-0000-4000-8000-00000000000a";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** One occupied, owner-assigned room — tenant-side grouping. */
async function seedOrgAndApartment() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG-P4", slug: "bg-p4", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bgp4@example.test", fullName: "BG P4 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-BGP4", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-BGP4", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  await ensureChargeCategorySeeds(ORG);
  const cats = await db.chargeCategory.findMany({
    where: { organizationId: ORG, code: { in: ["electricity_tenant", "other_expense_tenant"] } },
    select: { id: true, code: true },
  });
  return Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<string, string>;
}

/** The minimal FK chain Charge.sourceGridExpenseId needs — mirrors
 * owner-borne-deduct-grouping.integration.test.ts's identical helper. */
async function seedGridExpenseProvenance() {
  const db = getDb();
  await db.unitBillsGridEntry.create({
    data: { id: GRID_ENTRY, organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER },
  });
  await db.gridExpense.create({
    data: {
      id: GRID_EXPENSE, organizationId: ORG, entryId: GRID_ENTRY, apartmentId: APT, periodMonth: PERIOD,
      bearer: "tenant", tenancyId: TEN_A, partyId: PARTY_A, description: "Aircon repair", amount: "250.00", createdBy: USER,
    },
  });
}

let chargeSeq = 0;
/** Mirrors mintExpenseChargesTx's tenant-branch field shape (chargeType "expense",
 * status "posted", sourceGridExpenseId set) when `sourceGridExpenseId` is passed;
 * otherwise mirrors an ordinary mintItemizedCharges tenant utility component. */
async function makeCharge(opts: {
  partyId: string; unitId: string | null; tenancyId?: string | null; categoryId: string; amount: string; description: string;
  chargeType?: string; sourceGridExpenseId?: string | null;
}) {
  const db = getDb();
  chargeSeq += 1;
  return db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `P4TEST-${chargeSeq}`, unitId: opts.unitId, tenancyId: opts.tenancyId ?? null,
      partyId: opts.partyId, categoryId: opts.categoryId, chargeType: opts.chargeType ?? "utility",
      status: "posted", postedAt: new Date(), description: opts.description, dueDate: PERIOD,
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.amount, billingMonth: PERIOD,
      sourceGridExpenseId: opts.sourceGridExpenseId ?? null, attachmentKeys: [],
    },
    select: { id: true },
  });
}

dn("issueGroupedGridInvoiceTx — P4 tenant-borne grid-expense routing (ENABLE_EXPENSE_BILL)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  // (b) flag OFF — byte-identical baseline.
  it("flag OFF: a tenant-borne grid-expense charge co-groups onto the SAME IVTEN document as the tenant's other charge (byte-identical baseline)", async () => {
    delete process.env.ENABLE_EXPENSE_BILL;
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const utility = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant) 202606" });
    const expense = await makeCharge({
      partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.other_expense_tenant, amount: "250.00",
      description: "Aircon repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [utility.id, expense.id], USER));

    expect(result.tenantInvoiceIds).toHaveLength(1);
    expect(result.ownerInvoiceIds).toEqual([]);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    expect(doc.documentNumber.startsWith("IVTEN-")).toBe(true);
    expect(Number(doc.subtotal.toString())).toBe(350); // 100 + 250 — BOTH lines present, no EB
    const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id } });
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.chargeId))).toEqual(new Set([utility.id, expense.id]));
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });

  // (a) flag ON — routes to EB-, IVTEN purity.
  it("flag ON: the tenant-borne grid-expense charge routes onto its OWN Expense Bill (EB-) document — the tenant's IVTEN carries ZERO expense lines", async () => {
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const utility = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant) 202606" });
    const expense = await makeCharge({
      partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.other_expense_tenant, amount: "250.00",
      description: "Aircon repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [utility.id, expense.id], USER));

    // TWO tenant documents now — IVTEN (service) + EB (expense recovery) — never one merged doc.
    expect(result.tenantInvoiceIds).toHaveLength(2);
    expect(result.ownerInvoiceIds).toEqual([]);
    const docs = await db.billingDocument.findMany({ where: { id: { in: result.tenantInvoiceIds } } });
    expect(docs).toHaveLength(2);

    const ivten = docs.find((d) => d.documentNumber.startsWith("IVTEN-"));
    const eb = docs.find((d) => d.documentNumber.startsWith("EB-"));
    expect(ivten).toBeTruthy();
    expect(eb).toBeTruthy();
    expect(ivten!.id).not.toBe(eb!.id);
    expect(ivten!.counterpartyType).toBe("tenant");
    expect(eb!.counterpartyType).toBe("tenant");
    expect(ivten!.partyId).toBe(PARTY_A);
    expect(eb!.partyId).toBe(PARTY_A);
    expect(ivten!.docType).toBe("invoice");
    expect(eb!.docType).toBe("invoice");

    // IVTEN purity: ZERO expense (GRIDEXP-sourced) lines — only the service charge.
    const ivtenLines = await db.billingDocumentLine.findMany({ where: { documentId: ivten!.id } });
    expect(ivtenLines).toHaveLength(1);
    expect(ivtenLines[0].chargeId).toBe(utility.id);
    expect(Number(ivten!.subtotal.toString())).toBe(100);

    // EB carries exactly the expense line.
    const ebLines = await db.billingDocumentLine.findMany({ where: { documentId: eb!.id } });
    expect(ebLines).toHaveLength(1);
    expect(ebLines[0].chargeId).toBe(expense.id);
    expect(Number(eb!.subtotal.toString())).toBe(250);
  });

  // (c) never co-mingle, even for the identical (counterpartyType, partyId, unitId,
  // billingMonth, docType) tuple — the grouping-key fix. Both electricity_tenant and
  // other_expense_tenant are docType:"invoice" family:"tenant_income" (seed-categories.ts),
  // so before the routed-series segment, this charge pair's OLD key
  // (tenant:partyId:unitId:month:invoice) was IDENTICAL for both charges — this proves
  // they now resolve to DIFFERENT groups/documents despite that.
  it("flag ON: EB- expense charges NEVER co-mingle with IVTEN service charges for the SAME tenant/unit/month/docType", async () => {
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const utility = await makeCharge({ partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant) 202606" });
    const expense = await makeCharge({
      partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.other_expense_tenant, amount: "250.00",
      description: "Aircon repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [utility.id, expense.id], USER));

    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(2);
    const allLines = await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG } } });
    // No single document carries BOTH charges.
    const docIdsByCharge = new Map(allLines.map((l) => [l.chargeId, l.documentId]));
    expect(docIdsByCharge.get(utility.id)).not.toBe(docIdsByCharge.get(expense.id));
    // Never the same id anywhere in the result either.
    expect(new Set(result.tenantInvoiceIds).size).toBe(2);
  });

  it("flag ON: a tenant-borne grid-expense charge as the SOLE tenant charge yields ONLY an EB- document (no empty IVTEN)", async () => {
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const expense = await makeCharge({
      partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.other_expense_tenant, amount: "250.00",
      description: "Aircon repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [expense.id], USER));

    expect(result.tenantInvoiceIds).toHaveLength(1);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
    expect(doc.documentNumber.startsWith("EB-")).toBe(true);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it("flag ON: re-running on the SAME EB-routed chargeId returns the SAME document, never a duplicate", async () => {
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const expense = await makeCharge({
      partyId: PARTY_A, unitId: ROOM_A, tenancyId: TEN_A, categoryId: cats.other_expense_tenant, amount: "250.00",
      description: "Aircon repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const first = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [expense.id], USER));
    const second = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [expense.id], USER));

    expect(second.tenantInvoiceIds).toEqual(first.tenantInvoiceIds);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(1);
  });
});
