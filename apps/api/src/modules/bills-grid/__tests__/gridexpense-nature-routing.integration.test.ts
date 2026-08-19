/**
 * gridexpense-nature — per-row Expense/Profit choice on FREEFORM GridExpense rows.
 *
 * A freeform GridExpense row (bills-grid cols O/P/Q/R) historically ALWAYS routes as an
 * EXPENSE: tenant → Expense Bill (EB-), owner → owner-ledger payout deduction. This
 * feature lets an admin mark a specific row as PROFIT so it lands on the tenant IVTEN /
 * owner IVOWN (KAEN revenue) instead. Default (NULL / "expense") stays EXPENSE
 * (backward-compatible); ONLY an explicit "profit" diverts. Gated by
 * ENABLE_CHARGE_NATURE_ROUTING.
 *
 * TWO money paths must both respect nature (the crux):
 *  1. issue-grouped.ts — a Profit GridExpense charge must NOT be expense-routed (no EB
 *     reroute for tenant, no IVOWN-exclude for owner), so it groups onto IVTEN/IVOWN.
 *  2. owner-ledger.sync.ts Source-6 — must EXCLUDE nature:"profit" so a Profit owner
 *     expense is an IVOWN receivable ONLY, never ALSO a deduction (no double-representation).
 * Plus the MINT (mintExpenseChargesTx) stamps Charge.nature from GridExpense.nature.
 *
 * Isolated seams (hand-made Charge fixtures + direct calls), mirroring
 * expense-bill-routing.integration.test.ts (tenant EB), owner-borne-deduct-grouping.
 * integration.test.ts (owner IVOWN), and owner-ledger.sync.owner-borne-deduct.
 * integration.test.ts (Source-6). Charge.nature already exists (prior task); this suite
 * sets it directly on the fixtures to test issue-grouped/Source-6 in isolation, and mints
 * real GridExpense rows to prove the mint stamp.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; \
 *   unset ENABLE_CHARGE_NATURE_ROUTING ENABLE_EXPENSE_BILL ENABLE_BILL_EXPENSES_AS_CHARGES; \
 *   RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/gridexpense-nature-routing.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { issueGroupedGridInvoiceTx } from "../issue-grouped";
import { mintExpenseChargesTx } from "../service";
import { syncMonthService } from "../../owner-ledger/owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../../owner-ledger/owner-ledger.types";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "c1d00000-0000-4000-8000-000000000001";
const USER = "c1d00000-0000-4000-8000-000000000002";
const PROP = "c1d00000-0000-4000-8000-000000000003";
const APT = "c1d00000-0000-4000-8000-000000000004";
const ROOM = "c1d00000-0000-4000-8000-000000000005";
const PARTY_T = "c1d00000-0000-4000-8000-000000000006"; // tenant
const OWNER = "c1d00000-0000-4000-8000-000000000007"; // owner
const TENANCY = "c1d00000-0000-4000-8000-000000000008";
const OPERATOR_PARTY = "c1d00000-0000-4000-8000-000000000009";
const GRID_ENTRY = "c1d00000-0000-4000-8000-00000000000a";

const MONTH = "2026-06";
const YM = "202606";
const PERIOD = new Date("2026-06-01T00:00:00.000Z");

const session = { orgId: ORG, userId: USER, role: "manager" };
const ctx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest" };

// The nature-routing flag family. Each test opts IN — none are read from the ambient
// shell env (the worktree .env sets some ON globally; the run command unsets them).
const NATURE_FLAGS = ["ENABLE_CHARGE_NATURE_ROUTING", "ENABLE_EXPENSE_BILL", "ENABLE_BILL_EXPENSES_AS_CHARGES"] as const;
function flagsOn() { for (const f of NATURE_FLAGS) process.env[f] = "true"; }
function flagsOff() { for (const f of NATURE_FLAGS) delete process.env[f]; }

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.gridExpense.deleteMany({ where: org });
  await db.unitBillsGridEntry.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** One owner-assigned, OCCUPIED room + its tenancy — supports both tenant-bearer and
 * owner-bearer GridExpense rows off ONE apartment. Returns the {code → id} category map. */
async function seed(): Promise<Record<string, string>> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "GN Org", slug: "gn-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.party.create({ data: { id: OPERATOR_PARTY, organizationId: ORG, displayName: "GN Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "gn@example.test", fullName: "GN Operator", status: "active", role: "admin", userType: "operator", partyId: OPERATOR_PARTY } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-GN", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-GN", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_T, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: PARTY_T, tenancyCode: "T-GN", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.unitBillsGridEntry.create({ data: { id: GRID_ENTRY, organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER } });

  await ensureChargeCategorySeeds(ORG);
  const cats = await db.chargeCategory.findMany({
    where: { organizationId: ORG, code: { in: ["electricity_tenant", "other_expense_tenant", "electricity_owner", "other_expense_owner"] } },
    select: { id: true, code: true },
  });
  return Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<string, string>;
}

/** A freeform GridExpense row (no Charge) — for the MINT test. */
async function makeGridExpense(opts: { bearer: "tenant" | "owner"; nature: string | null; amount: string; description: string }) {
  const ge = await getDb().gridExpense.create({
    data: {
      organizationId: ORG, entryId: GRID_ENTRY, apartmentId: APT, periodMonth: PERIOD,
      bearer: opts.bearer, nature: opts.nature, description: opts.description, amount: opts.amount,
      ...(opts.bearer === "tenant" ? { tenancyId: TENANCY, partyId: PARTY_T } : {}), createdBy: USER,
    },
    select: { id: true },
  });
  return ge.id;
}

let chargeSeq = 0;
/** A GridExpense row + its GRIDEXP- Charge, mirroring mintExpenseChargesTx's shape
 * (chargeType:"expense", sourceGridExpenseId set, nature stamped). Used to test
 * issue-grouped / Source-6 in isolation (both read Charge.nature). */
async function makeExpenseCharge(opts: { bearer: "tenant" | "owner"; nature: string | null; categoryId: string; amount: string; description: string }) {
  const db = getDb();
  const geId = await makeGridExpense({ bearer: opts.bearer, nature: opts.nature, amount: opts.amount, description: opts.description });
  chargeSeq += 1;
  const c = await db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `GNTEST-${chargeSeq}`, unitId: ROOM,
      tenancyId: opts.bearer === "tenant" ? TENANCY : null, partyId: opts.bearer === "tenant" ? PARTY_T : OWNER,
      categoryId: opts.categoryId, chargeType: "expense", status: "posted", postedAt: new Date(),
      description: opts.description, dueDate: PERIOD, amount: opts.amount, currency: "MYR",
      outstandingAmount: opts.amount, billingMonth: PERIOD, sourceGridEntryId: GRID_ENTRY,
      sourceGridExpenseId: geId, nature: opts.nature, attachmentKeys: [],
    },
    select: { id: true },
  });
  return { chargeId: c.id, gridExpenseId: geId };
}

/** An ordinary (non-expense) utility Charge — a plain IVTEN/IVOWN service line. */
async function makeServiceCharge(opts: { bearer: "tenant" | "owner"; categoryId: string; amount: string; description: string }) {
  chargeSeq += 1;
  const c = await getDb().charge.create({
    data: {
      organizationId: ORG, chargeNumber: `GNTEST-${chargeSeq}`, unitId: ROOM,
      tenancyId: opts.bearer === "tenant" ? TENANCY : null, partyId: opts.bearer === "tenant" ? PARTY_T : OWNER,
      categoryId: opts.categoryId, chargeType: "utility", status: "posted", postedAt: new Date(),
      description: opts.description, dueDate: PERIOD, amount: opts.amount, currency: "MYR",
      outstandingAmount: opts.amount, billingMonth: PERIOD, attachmentKeys: [],
    },
    select: { id: true },
  });
  return c.id;
}

dn("gridexpense-nature — per-row Expense/Profit on freeform GridExpense rows", () => {
  let cats: Record<string, string>;
  beforeEach(async () => {
    await cleanup();
    cats = await seed();
  });
  afterEach(async () => {
    flagsOff();
    await cleanup();
  });

  // ─── MINT: mintExpenseChargesTx stamps Charge.nature from GridExpense.nature ───────
  describe("mintExpenseChargesTx stamps GridExpense.nature onto the Charge", () => {
    it("flags ON: Profit row → Charge.nature 'profit'; Expense row → 'expense'; NULL row → null", async () => {
      flagsOn();
      const db = getDb();
      const geTenantProfit = await makeGridExpense({ bearer: "tenant", nature: "profit", amount: "120.00", description: "Tenant profit svc" });
      const geOwnerExpense = await makeGridExpense({ bearer: "owner", nature: "expense", amount: "80.00", description: "Owner expense" });
      const geTenantNull = await makeGridExpense({ bearer: "tenant", nature: null, amount: "60.00", description: "Tenant legacy" });

      await db.$transaction((tx) => mintExpenseChargesTx(tx, session, { id: GRID_ENTRY, apartmentId: APT }, YM, 0));

      const charges = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "expense" }, select: { nature: true, sourceGridExpenseId: true } });
      const byGe = new Map(charges.map((c) => [c.sourceGridExpenseId, c.nature]));
      expect(byGe.get(geTenantProfit)).toBe("profit");
      expect(byGe.get(geOwnerExpense)).toBe("expense");
      expect(byGe.get(geTenantNull)).toBeNull();
    });

    it("ENABLE_CHARGE_NATURE_ROUTING OFF (bill-expenses ON): every minted Charge.nature is null (byte-identical)", async () => {
      process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true"; // mint runs; nature routing stays OFF
      const db = getDb();
      await makeGridExpense({ bearer: "tenant", nature: "profit", amount: "120.00", description: "Tenant profit" });
      await makeGridExpense({ bearer: "owner", nature: "expense", amount: "80.00", description: "Owner expense" });

      await db.$transaction((tx) => mintExpenseChargesTx(tx, session, { id: GRID_ENTRY, apartmentId: APT }, YM, 0));

      const charges = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "expense" }, select: { nature: true } });
      expect(charges.length).toBeGreaterThan(0);
      for (const c of charges) expect(c.nature).toBeNull();
    });
  });

  // ─── issue-grouped: Profit → IVTEN/IVOWN; Expense/NULL → EB/exclude ────────────────
  describe("issueGroupedGridInvoiceTx routing", () => {
    it("(1) tenant Profit GridExpense charge co-groups onto IVTEN (KAEN revenue), NEVER an EB", async () => {
      flagsOn();
      const db = getDb();
      const svc = await makeServiceCharge({ bearer: "tenant", categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant)" });
      const profit = await makeExpenseCharge({ bearer: "tenant", nature: "profit", categoryId: cats.other_expense_tenant, amount: "250.00", description: "Aircon service (profit)" });

      const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [svc, profit.chargeId], USER));

      expect(result.tenantInvoiceIds).toHaveLength(1); // ONE IVTEN — no separate EB
      const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: result.tenantInvoiceIds[0] } });
      expect(doc.documentNumber.startsWith("IVTEN-")).toBe(true);
      const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id } });
      expect(lines).toHaveLength(2);
      expect(new Set(lines.map((l) => l.chargeId))).toEqual(new Set([svc, profit.chargeId]));
      expect(await db.billingDocument.count({ where: { organizationId: ORG, documentNumber: { startsWith: "EB-" } } })).toBe(0);
    });

    it("(3) tenant Expense/NULL GridExpense charges route onto the Expense Bill (EB-), IVTEN keeps only the service line (backward-compatible)", async () => {
      flagsOn();
      const db = getDb();
      const svc = await makeServiceCharge({ bearer: "tenant", categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant)" });
      const expense = await makeExpenseCharge({ bearer: "tenant", nature: "expense", categoryId: cats.other_expense_tenant, amount: "250.00", description: "Aircon repair (expense)" });
      const legacy = await makeExpenseCharge({ bearer: "tenant", nature: null, categoryId: cats.other_expense_tenant, amount: "70.00", description: "Legacy expense (null)" });

      const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [svc, expense.chargeId, legacy.chargeId], USER));

      const docs = await db.billingDocument.findMany({ where: { id: { in: result.tenantInvoiceIds } } });
      const ivten = docs.find((d) => d.documentNumber.startsWith("IVTEN-"));
      const eb = docs.find((d) => d.documentNumber.startsWith("EB-"));
      expect(ivten).toBeTruthy();
      expect(eb).toBeTruthy();
      const ivtenLines = await db.billingDocumentLine.findMany({ where: { documentId: ivten!.id } });
      expect(ivtenLines.map((l) => l.chargeId)).toEqual([svc]); // service only
      const ebLines = await db.billingDocumentLine.findMany({ where: { documentId: eb!.id } });
      expect(new Set(ebLines.map((l) => l.chargeId))).toEqual(new Set([expense.chargeId, legacy.chargeId])); // both expenses on EB
    });

    it("(2a) owner Profit GridExpense charge is a LINE on IVOWN (not excluded)", async () => {
      flagsOn();
      const db = getDb();
      const svc = await makeServiceCharge({ bearer: "owner", categoryId: cats.electricity_owner, amount: "300.00", description: "Electricity (owner)" });
      const profit = await makeExpenseCharge({ bearer: "owner", nature: "profit", categoryId: cats.other_expense_owner, amount: "80.00", description: "Owner profit expense" });

      const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [svc, profit.chargeId], USER));

      expect(result.ownerInvoiceIds).toHaveLength(1);
      const lines = await db.billingDocumentLine.findMany({ where: { documentId: result.ownerInvoiceIds![0] } });
      expect(new Set(lines.map((l) => l.chargeId))).toEqual(new Set([svc, profit.chargeId])); // profit IS an IVOWN line
    });

    it("(4a) owner Expense/NULL GridExpense charges are LINES on IVOWN — nature never diverts an owner charge", async () => {
      // OUTCOME CHANGED 2026-08-16: these used to be pulled off the IVOWN onto an OEA
      // advice (ENABLE_OWNER_BORNE_DEDUCT). The owner must SEE the expense on an invoice;
      // the netting happens at collection instead (auto-offset-on-rent.hook.ts).
      flagsOn();
      const db = getDb();
      const svc = await makeServiceCharge({ bearer: "owner", categoryId: cats.electricity_owner, amount: "300.00", description: "Electricity (owner)" });
      const expense = await makeExpenseCharge({ bearer: "owner", nature: "expense", categoryId: cats.other_expense_owner, amount: "80.00", description: "Owner expense" });
      const legacy = await makeExpenseCharge({ bearer: "owner", nature: null, categoryId: cats.other_expense_owner, amount: "45.00", description: "Owner legacy expense (null)" });

      const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [svc, expense.chargeId, legacy.chargeId], USER));

      // ONE owner document, carrying all three lines.
      expect(result.ownerInvoiceIds).toHaveLength(1);
      const ivown = await db.billingDocument.findUniqueOrThrow({ where: { id: result.ownerInvoiceIds![0] } });
      expect(ivown.docType).toBe("invoice");
      expect(Number(ivown.subtotal.toString())).toBe(425); // 300 + 80 + 45

      const ivownLines = await db.billingDocumentLine.findMany({ where: { documentId: ivown.id } });
      expect(new Set(ivownLines.map((l) => l.chargeId))).toEqual(new Set([svc, expense.chargeId, legacy.chargeId]));

      // MONEY: each expense MUST sit on a live receivable — without one the owner is
      // never billed and the auto-offset hook has nothing to net against the payout.
      for (const id of [expense.chargeId, legacy.chargeId]) {
        expect(await db.billingDocumentLine.findFirst({
          where: { chargeId: id, document: { docType: { in: ["invoice", "debit_note"] }, documentStatus: "ISSUED" } },
        })).not.toBeNull();
      }
      // And no OEA may exist any more.
      expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "owner_expense_advice" } })).toBe(0);
    });

    it("(5) nature routing OFF (EB ON): a Profit GridExpense is treated as an Expense — tenant→EB, owner→still an IVOWN line", async () => {
      process.env.ENABLE_EXPENSE_BILL = "true"; // ENABLE_CHARGE_NATURE_ROUTING intentionally unset
      const db = getDb();
      const tSvc = await makeServiceCharge({ bearer: "tenant", categoryId: cats.electricity_tenant, amount: "100.00", description: "Electricity (tenant)" });
      const tProfit = await makeExpenseCharge({ bearer: "tenant", nature: "profit", categoryId: cats.other_expense_tenant, amount: "250.00", description: "Tenant profit (flag off)" });
      const oSvc = await makeServiceCharge({ bearer: "owner", categoryId: cats.electricity_owner, amount: "300.00", description: "Electricity (owner)" });
      const oProfit = await makeExpenseCharge({ bearer: "owner", nature: "profit", categoryId: cats.other_expense_owner, amount: "80.00", description: "Owner profit (flag off)" });

      const result = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [tSvc, tProfit.chargeId, oSvc, oProfit.chargeId], USER));

      // tenant Profit → EB (nature ignored while the routing flag is off)
      const docs = await db.billingDocument.findMany({ where: { id: { in: result.tenantInvoiceIds } } });
      const eb = docs.find((d) => d.documentNumber.startsWith("EB-"));
      expect(eb).toBeTruthy();
      const ebLines = await db.billingDocumentLine.findMany({ where: { documentId: eb!.id } });
      expect(ebLines.map((l) => l.chargeId)).toEqual([tProfit.chargeId]);

      // owner side: ONE IVOWN carrying both the service line and the expense. The owner
      // arm of resolveRoutedSeries consults no flag at all now, so nature is irrelevant.
      expect(result.ownerInvoiceIds).toHaveLength(1);
      const oIvown = await db.billingDocument.findUniqueOrThrow({ where: { id: result.ownerInvoiceIds![0] } });
      expect(oIvown.docType).toBe("invoice");
      const ownerLines = await db.billingDocumentLine.findMany({ where: { documentId: oIvown.id } });
      expect(new Set(ownerLines.map((l) => l.chargeId))).toEqual(new Set([oSvc, oProfit.chargeId]));
    });
  });

  // ─── owner-ledger: an owner GridExpense is NEVER a payout deduction row ────────────
  describe("owner-ledger.sync books no owner-borne expense deduction", () => {
    // Source 6 was DELETED with ENABLE_OWNER_BORNE_DEDUCT (2026-08-16). It booked an
    // owner GridExpense as an includeInPayout deduction INSTEAD of billing it, and — a
    // defect never fixed in its lifetime — it read `charge.amount` bare, so an active
    // CN/DN on the expense was silently ignored in the payout.
    //
    // The replacement is not "no deduction": the expense is billed on IVOWN and netted
    // out of the payout at collection, on the payable-consuming offset rail, which DOES
    // honour the adjusted charge. What must never come back is a SECOND representation
    // of the same cost sitting in the ledger.
    it("books no owner_borne_expense row for ANY owner GridExpense — expense, profit or legacy-null", async () => {
      flagsOn();
      const db = getDb();
      await makeExpenseCharge({ bearer: "owner", nature: "expense", categoryId: cats.other_expense_owner, amount: "80.00", description: "Owner expense" });
      await makeExpenseCharge({ bearer: "owner", nature: "profit", categoryId: cats.other_expense_owner, amount: "80.00", description: "Owner profit expense" });
      await makeExpenseCharge({ bearer: "owner", nature: null, categoryId: cats.other_expense_owner, amount: "45.00", description: "Owner legacy expense (null)" });

      const res = await syncMonthService(ctx, { ownerPartyId: OWNER, month: MONTH });
      expect(res.ok).toBe(true);

      expect(await db.ownerLedgerEntry.count({
        where: { organizationId: ORG, sourceType: "owner_borne_expense" },
      })).toBe(0);
    });
  });
});
