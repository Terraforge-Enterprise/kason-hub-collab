/**
 * An owner-borne bills-grid expense is ALWAYS billed to the owner as an IVOWN line.
 *
 * This is the surviving half of what used to be a flag-switched pair. Behind
 * ENABLE_OWNER_BORNE_DEDUCT the same charge was pulled OFF the IVOWN, given its own
 * non-receivable OEA advice, and deducted from the payout by owner-ledger.sync.ts's
 * Source 6 instead. That model was removed (2026-08-16): KAEN wants the expense to SHOW
 * on an invoice the owner can see, and to be netted out of the payout when the rent is
 * collected — which auto-offset-on-rent.hook.ts does, unconditionally.
 *
 * So there is now exactly ONE outcome, and it is not guarded by anything. That is
 * precisely why it needs pinning: a regression here does not throw and does not fail a
 * type check — it silently stops billing the owner for money KAEN already spent.
 *
 * Isolated to the grouping seam, mirroring grouped-issue.test.ts's convention:
 * issueGroupedGridInvoiceTx called directly against hand-created Charge fixtures (real
 * ChargeCategory rows via ensureChargeCategorySeeds), no grid allocation math involved.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/owner-borne-expense-billing.integration.test.ts
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

const ORG = "b7b00000-0000-4000-8000-000000000001";
const USER = "b7b00000-0000-4000-8000-000000000002";
const PROP = "b7b00000-0000-4000-8000-000000000003";
const APT = "b7b00000-0000-4000-8000-000000000004";
const ROOM_A = "b7b00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "b7b00000-0000-4000-8000-000000000006";
const GRID_ENTRY = "b7b00000-0000-4000-8000-000000000007";
const GRID_EXPENSE = "b7b00000-0000-4000-8000-000000000008";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
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

/** One owner-assigned, vacant room — owner-side grouping only, no tenant needed. */
async function seedOrgAndApartment() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG-P5", slug: "bg-p5", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bgp5@example.test", fullName: "BG P5 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-BGP5", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-BGP5", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });

  await ensureChargeCategorySeeds(ORG);
  const cats = await db.chargeCategory.findMany({
    where: { organizationId: ORG, code: { in: ["electricity_owner", "other_expense_owner"] } },
    select: { id: true, code: true },
  });
  return Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<string, string>;
}

/** The minimal FK chain Charge.sourceGridExpenseId needs — a real UnitBillsGridEntry +
 * GridExpense row (Charge.sourceGridExpense is a real FK, SetNull on delete). Neither
 * row is read by issueGroupedGridInvoiceTx; they exist only so the Charge fixture below
 * can carry a valid provenance ref, exactly like a real mintExpenseChargesTx charge. */
async function seedGridExpenseProvenance() {
  const db = getDb();
  await db.unitBillsGridEntry.create({
    data: { id: GRID_ENTRY, organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER },
  });
  await db.gridExpense.create({
    data: {
      id: GRID_EXPENSE, organizationId: ORG, entryId: GRID_ENTRY, apartmentId: APT, periodMonth: PERIOD,
      bearer: "owner", description: "Roof repair", amount: "80.00", createdBy: USER,
    },
  });
}

let chargeSeq = 0;
/** Mirrors mintExpenseChargesTx's owner-branch field shape (chargeType "expense",
 * status "posted", sourceGridExpenseId set) when `sourceGridExpenseId` is passed;
 * otherwise mirrors an ordinary mintItemizedCharges owner utility component. */
async function makeCharge(opts: {
  partyId: string; unitId: string | null; categoryId: string; amount: string; description: string;
  chargeType?: string; sourceGridExpenseId?: string | null; nature?: string | null;
}) {
  const db = getDb();
  chargeSeq += 1;
  return db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `P5TEST-${chargeSeq}`, unitId: opts.unitId, tenancyId: null,
      partyId: opts.partyId, categoryId: opts.categoryId, chargeType: opts.chargeType ?? "utility",
      status: "posted", postedAt: new Date(), description: opts.description, dueDate: PERIOD,
      amount: opts.amount, currency: "MYR", outstandingAmount: opts.amount, billingMonth: PERIOD,
      sourceGridExpenseId: opts.sourceGridExpenseId ?? null, nature: opts.nature ?? null,
      attachmentKeys: [],
    },
    select: { id: true },
  });
}

dn("issueGroupedGridInvoiceTx — an owner-borne grid expense is always an IVOWN line", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  it("co-groups onto the owner's IVOWN alongside an ordinary owner charge", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const normal = await makeCharge({ partyId: OWNER_PARTY, unitId: ROOM_A, categoryId: cats.electricity_owner, amount: "300.00", description: "Electricity (owner) 202606" });
    const expense = await makeCharge({
      partyId: OWNER_PARTY, unitId: ROOM_A, categoryId: cats.other_expense_owner, amount: "80.00",
      description: "Roof repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [normal.id, expense.id], USER));

    expect(result.ownerInvoiceIds).toHaveLength(1);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.ownerInvoiceIds![0] } });
    expect(doc.docType).toBe("invoice");
    expect(Number(doc.subtotal.toString())).toBe(380); // 300 + 80 — BOTH lines present
    const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id } });
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.chargeId))).toEqual(new Set([normal.id, expense.id]));
  });

  it("as the SOLE owner charge it still yields an IVOWN receivable — never an OEA, never nothing", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const expense = await makeCharge({
      partyId: OWNER_PARTY, unitId: ROOM_A, categoryId: cats.other_expense_owner, amount: "80.00",
      description: "Roof repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [expense.id], USER));

    expect(result.ownerInvoiceIds).toHaveLength(1);
    expect(result.tenantInvoiceIds).toEqual([]);
    const allDocs = await db.billingDocument.findMany({
      where: { organizationId: ORG },
      select: { docType: true, counterpartyType: true, documentNumber: true },
    });
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0].docType).toBe("invoice");
    expect(allDocs[0].counterpartyType).toBe("owner");
    expect(allDocs[0].documentNumber).toMatch(/^IVOWN-/);
    // The OEA advice is gone for good — nothing may mint one again.
    expect(allDocs[0].documentNumber).not.toMatch(/^OEA-/);
  });

  it("MONEY: the expense charge always carries a live RECEIVABLE line — it is never left doc-less", async () => {
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const expense = await makeCharge({
      partyId: OWNER_PARTY, unitId: ROOM_A, categoryId: cats.other_expense_owner, amount: "80.00",
      description: "Roof repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE,
    });

    await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [expense.id], USER));

    // A doc-less owner-borne charge is what the removed deduct model produced, and what
    // the re-Bill retire step in service.ts exists to clean up. Nothing may create one
    // now: without a receivable line the owner is simply never billed, and the
    // auto-offset hook has nothing to net against the payout.
    const receivableLine = await db.billingDocumentLine.findFirst({
      where: { chargeId: expense.id, document: { docType: { in: ["invoice", "debit_note"] }, documentStatus: "ISSUED" } },
    });
    expect(receivableLine).not.toBeNull();
    expect(Number(receivableLine!.amount.toString())).toBe(80);
  });

  it("stays an IVOWN line even when nature routing is ON and the charge is nature:'expense'", async () => {
    // The old fail-closed guard THREW here whenever ENABLE_CHARGE_NATURE_ROUTING was on
    // without ENABLE_OWNER_BORNE_DEDUCT — a hard Bill-time failure guarding a model that
    // no longer exists. An owner Expense now simply bills.
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    const db = getDb();
    const cats = await seedOrgAndApartment();
    await seedGridExpenseProvenance();
    const expense = await makeCharge({
      partyId: OWNER_PARTY, unitId: ROOM_A, categoryId: cats.other_expense_owner, amount: "80.00",
      description: "Roof repair", chargeType: "expense", sourceGridExpenseId: GRID_EXPENSE, nature: "expense",
    });

    const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [expense.id], USER));

    expect(result.ownerInvoiceIds).toHaveLength(1);
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.ownerInvoiceIds![0] } });
    expect(doc.docType).toBe("invoice");
    expect(doc.documentNumber).toMatch(/^IVOWN-/);
  });
});
