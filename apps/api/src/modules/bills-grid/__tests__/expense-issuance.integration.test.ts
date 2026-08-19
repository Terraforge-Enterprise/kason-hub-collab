/**
 * Task 10: end-to-end integration proof for "Bill Expenses as Invoice Line Items"
 * (spec R1-R9), against real local Postgres — the final task of the flag-dark
 * bill-expenses feature. Proves the MONEY PATH through the real `billService`
 * issuance flow: seed a Bill with tenant/owner utilities AND an expense (created
 * via the real `createExpensesService`), issue it, and assert the minted
 * `BillingDocument`/`Charge` rows — not `mintExpenseChargesTx` in isolation
 * (mint-expense-charges.test.ts already covers that at the unit level).
 *
 * Same integration harness convention as bill-issuance.integration.test.ts /
 * bill-rebill.integration.test.ts / itemized-mint.test.ts: a dedicated, fully-
 * seeded org (never the shared dev seed), RUN_INTEGRATION=1 + non-local-host
 * guard, ENABLE_PHASE2_BILLING_DOCS + ENABLE_BILL_EXPENSES_AS_CHARGES toggled
 * per-test via process.env (isPhase2FlagEnabled reads process.env directly —
 * mint-expense-charges.test.ts's own convention), ordered FK-safe cleanup.
 *
 * Real local Postgres only.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/expense-issuance.integration.test.ts
 *
 * Coverage (behavior-inventory, spec Testing Strategy + task-10-brief acceptance table):
 *  1. tenant expense co-groups onto one IVTEN — tenant utilities (RM523) + a tenant
 *     expense (RM250) on the SAME room co-group into ONE IVTEN, 3 lines, total RM773.00.
 *  2. owner expense on IVOWN — an owner-bearer expense appears as a payable line on
 *     the owner's IVOWN.
 *  3. re-Bill reverses expense charge — a re-Bill of a month carrying an expense line
 *     must supersede the expense charge alongside the utility charges (no leftover
 *     outstanding). Task 5 could not verify this at the unit level (mintExpenseChargesTx
 *     is a pure mint, indifferent to what a real re-Bill's credit-step covers).
 *  4. flag off parity — with ENABLE_BILL_EXPENSES_AS_CHARGES OFF, issuing the same
 *     Bill mints NO expense charge and the IVTEN total excludes the expense (matches
 *     pre-feature behavior).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, createExpensesService, currentBillingMonthUTC, getGridService } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture ids — distinct namespace so cleanup is org-scoped + total.
const ORG = "b7a00000-0000-4000-8000-000000000001";
const USER = "b7a00000-0000-4000-8000-000000000002";
const PROP = "b7a00000-0000-4000-8000-000000000003";
const APT = "b7a00000-0000-4000-8000-000000000004";
const ROOM_A = "b7a00000-0000-4000-8000-000000000005";
const PARTY_A = "b7a00000-0000-4000-8000-000000000006";
const OWNER_PARTY = "b7a00000-0000-4000-8000-000000000007";
const TEN_A = "b7a00000-0000-4000-8000-000000000008";
// FIX 2 fixture: a SEPARATE vacant apartment (no occupied room, no tenancy) with its
// own owner-assigned listing — reuses ORG/PROP/OWNER_PARTY.
const APT_V = "b7a00000-0000-4000-8000-000000000009";
const ROOM_V = "b7a00000-0000-4000-8000-00000000000a";

// The CURRENT org-local billing month, so the re-Bill scenario's previous-period
// guard (rule 1, service.ts rebillSupersedeTx step 1) never blocks it — mirrors
// bill-rebill.integration.test.ts's own PERIOD derivation.
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
  await db.gridExpense.deleteMany({ where: { organizationId: ORG } });
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG } });
  await db.unitBillsBearerConfig.deleteMany({ where: { organizationId: ORG } });
  await db.tenancy.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/** A PARTITIONED apartment, ONE occupied room (its own tenancy/party, pax 1),
 * owner-assigned. Every scenario shares this identical org/room skeleton. */
async function seedOrgAndRoom(): Promise<void> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BEX", slug: "bex", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bex@example.test", fullName: "BEX Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-BEX", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-BEX", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
}

/** FIX 2 fixture: a PARTITIONED apartment with ONE vacant, owner-assigned room and
 * NO tenancy at all — nothing for buildGridRooms/buildBillRooms to allocate. */
async function seedVacantApartment(): Promise<void> {
  const db = getDb();
  await db.apartment.create({ data: { id: APT_V, organizationId: ORG, propertyId: PROP, unitCode: "A-BEX-V", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: ROOM_V, organizationId: ORG, apartmentId: APT_V, listingType: "master_room", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
}

/** A grid entry with ZERO utility raw amounts (no allocation, no owner-borne utility,
 * no recurring) — isolates the mint gate to whatever expense the test attaches. */
async function seedZeroEntry(apartmentId: string): Promise<{ entryId: string; expectedUpdatedAt: string }> {
  const db = getDb();
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "0.00", airSelangorRaw: "0.00", wifi: "0.00", cleaning: "0.00",
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
    },
  });
  return { entryId: entry.id, expectedUpdatedAt: entry.updatedAt.toISOString() };
}

/**
 * A grid entry with a tenant-borne utility pool: recharged TNB (electricity) +
 * tenant-bearer wifi, both flowing 100% to ROOM_A's single occupied tenancy (pax 1).
 * `tnb + wifi` is the caller-chosen tenant-utility total — mintItemizedCharges
 * mints ONE charge per non-zero component (electricity + wifi = 2 lines here;
 * water/sewerage/cleaning stay RM0 and are omitted). Both patterns "recharged"
 * keeps ownerBorneTnb/ownerBorneAir null (no owner-side utility charge).
 */
async function seedEntry(tnb: string, wifi: string): Promise<{ entryId: string; expectedUpdatedAt: string }> {
  const db = getDb();
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: tnb, airSelangorRaw: "0.00", wifi, cleaning: "0.00",
      tnbPattern: "recharged", airPattern: "recharged",
      cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  return { entryId: entry.id, expectedUpdatedAt: entry.updatedAt.toISOString() };
}

dn("bills-grid expense issuance — end-to-end money path (Task 10)", () => {
  beforeEach(async () => {
    await cleanup();
  });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES;
    await cleanup();
  });

  it("tenant expense co-groups onto one IVTEN", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    // Tenant utilities: electricity 483 + wifi 40 = 523.00 (2 lines).
    const { expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [{ description: "Aircon repair", amount: "250.00", withSST: false }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("invoiced");
    // ONE IVTEN, not two documents — the co-grouping payoff (spec R1).
    expect(res.tenantInvoiceIds).toHaveLength(1);

    const tenantDocs = await db.billingDocument.findMany({ where: { organizationId: ORG, counterpartyType: "tenant" } });
    expect(tenantDocs).toHaveLength(1);
    expect(tenantDocs[0].docType).toBe("invoice");
    expect(tenantDocs[0].tenancyId).toBe(TEN_A);
    expect(tenantDocs[0].total.toFixed(2)).toBe("773.00"); // 483 + 40 + 250, no SST

    const lines = await db.billingDocumentLine.findMany({ where: { documentId: tenantDocs[0].id } });
    expect(lines).toHaveLength(3); // electricity + wifi + the expense line

    // Provenance: the expense line's Charge carries sourceGridExpenseId (spec R4)
    // and co-groups via the SAME partyId/unitId as the utility charges (spec R1).
    const expenseCharge = await db.charge.findFirst({ where: { organizationId: ORG, chargeType: "expense" } });
    expect(expenseCharge).not.toBeNull();
    expect(expenseCharge!.sourceGridExpenseId).toBe(exp.data.ids[0]);
    expect(expenseCharge!.partyId).toBe(PARTY_A);
    expect(expenseCharge!.unitId).toBe(ROOM_A);
    expect(expenseCharge!.amount.toFixed(2)).toBe("250.00");
  });

  /**
   * SST-PAYABLE. Every other case in this file bills `withSST: false`, which is exactly
   * how the defect shipped: issueDocumentTx derived the expense's SST from the line rate
   * and added it to `total`, but nothing wrote that money back to a Charge. Payments
   * settle CHARGES, so the tax was invoiced, declared to LHDN and owed — yet had no row
   * to pay it against. It was missing from the tenant portal's payable list and from
   * balance-due, and deriveDocumentStatus (which reads ONLY charge outstanding) flipped
   * the invoice to "settled" once the base alone was paid, silently pocketing the gap.
   *
   * Both halves matter: the document's own presentation must NOT change (the sibling's
   * line is `isTax`, contributing nothing to subtotal), AND Σ charges must equal total.
   */
  it("SST on an expense is a payable Charge — Σ charges === document total", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    // Tenant utilities: electricity 483 + wifi 40 = 523.00 (2 lines), as above.
    const { expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [{ description: "Aircon repair", amount: "250.00", withSST: true }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const [doc] = await db.billingDocument.findMany({ where: { organizationId: ORG, counterpartyType: "tenant" } });
    // UNCHANGED presentation: 523 utilities + 250 expense in subtotal, 8% of the expense
    // as document SST. The tax line's own amount is excluded from subtotal, so `total` is
    // byte-identical to what this document was before the sibling Charge existed.
    expect(doc.subtotal.toFixed(2)).toBe("773.00");
    expect(doc.sstAmount.toFixed(2)).toBe("20.00");
    expect(doc.total.toFixed(2)).toBe("793.00");

    // THE FIX: every sen the document bills is backed by a Charge a payment can settle.
    // Pre-fix this summed to 773.00 against a 793.00 invoice.
    const lines = await db.billingDocumentLine.findMany({ where: { documentId: doc.id }, select: { chargeId: true } });
    const chargeIds = lines.map((l) => l.chargeId).filter((id): id is string => id !== null);
    const charges = await db.charge.findMany({ where: { id: { in: chargeIds } } });
    const owed = charges.reduce((sum, c) => sum + Number(c.outstandingAmount), 0);
    expect(owed.toFixed(2)).toBe(doc.total.toFixed(2));

    // The tax is its own Charge — 8% of 250, not itself taxed, billed to the SAME payer
    // and unit as its base charge (a different target would group it onto another
    // document and leave the tax just as uncollectable).
    const sstCharge = charges.find((c) => c.chargeNumber.endsWith("-SST"));
    expect(sstCharge).toBeDefined();
    expect(sstCharge!.amount.toFixed(2)).toBe("20.00");
    expect(sstCharge!.outstandingAmount.toFixed(2)).toBe("20.00");
    expect(sstCharge!.sstRate!.toFixed(2)).toBe("0.00");
    expect(sstCharge!.partyId).toBe(PARTY_A);
    expect(sstCharge!.unitId).toBe(ROOM_A);
    expect(sstCharge!.sourceGridExpenseId).toBe(exp.data.ids[0]);
  });

  it("owner expense on IVOWN", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    // A small tenant-borne wifi pool so the mint branch runs at all
    // (billService only mints when alloc.allocations.length > 0 || ownerBorne > 0
    // || hasRecurring) — irrelevant to this scenario's own assertions.
    const { expectedUpdatedAt } = await seedEntry("0.00", "10.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Roof repair", amount: "80.00", withSST: false }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("invoiced");
    expect(res.ownerInvoiceIds).toHaveLength(1);

    const ownerDocs = await db.billingDocument.findMany({ where: { organizationId: ORG, counterpartyType: "owner" } });
    expect(ownerDocs).toHaveLength(1);
    expect(ownerDocs[0].partyId).toBe(OWNER_PARTY);
    expect(ownerDocs[0].id).toBe(res.ownerInvoiceIds![0]);

    const ownerLines = await db.billingDocumentLine.findMany({ where: { documentId: ownerDocs[0].id } });
    expect(ownerLines.some((l) => l.amount.toFixed(2) === "80.00")).toBe(true);

    const expenseCharge = await db.charge.findFirst({ where: { organizationId: ORG, chargeType: "expense", sourceGridExpenseId: exp.data.ids[0] } });
    expect(expenseCharge).not.toBeNull();
    expect(expenseCharge!.partyId).toBe(OWNER_PARTY);
    expect(expenseCharge!.unitId).toBe(ROOM_A); // resolveApartmentOwner's representative listingId
  });

  it("re-Bill reverses expense charge", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    const { entryId, expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [{ description: "Aircon repair", amount: "250.00", withSST: false }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    // First issuance: IVTEN carries the utility lines + the expense line.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    const firstExpenseCharge = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeType: "expense" } });
    expect(firstExpenseCharge.status).not.toBe("credited");
    expect(Number(firstExpenseCharge.outstandingAmount.toString())).toBe(250);

    // Amend the wifi (tenant-borne) pool — a genuine amount change — so the
    // re-Bill is a real reissue, not an `already_billed` no-op. Bumps updatedAt.
    await db.unitBillsGridEntry.update({ where: { id: entryId }, data: { wifi: "140.00" } });
    const freshEntry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });

    const rebill = await billService(session, {
      period: PERIOD_STR,
      rows: [{ apartmentId: APT, expectedUpdatedAt: freshEntry.updatedAt.toISOString(), confirmRebill: true }],
    });
    expect(rebill.ok).toBe(true);
    if (!rebill.ok) return;
    const res = rebill.data.results[0];
    expect(res.outcome).toBe("reinvoiced");

    // The re-Bill reclaim path (spec R5) must reach the expense-sourced charge
    // exactly like the utility charges: the ORIGINAL expense charge is superseded
    // (credited, outstandingAmount 0) — no leftover outstanding — and there is
    // exactly ONE live (non-void/credited) expense charge for this GridExpense.
    const allExpenseCharges = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "expense", sourceGridExpenseId: exp.data.ids[0] } });
    const live = allExpenseCharges.filter((c) => c.status !== "void" && c.status !== "credited");
    expect(live).toHaveLength(1); // exactly one live expense charge post-reBill
    const superseded = allExpenseCharges.find((c) => c.id === firstExpenseCharge.id)!;
    expect(superseded.status).toBe("credited");
    expect(Number(superseded.outstandingAmount.toString())).toBe(0); // no leftover outstanding
  });

  it("flag off parity", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    delete process.env.ENABLE_BILL_EXPENSES_AS_CHARGES; // flag OFF (default)
    const db = getDb();
    await seedOrgAndRoom();
    const { expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [{ description: "Aircon repair", amount: "250.00", withSST: false }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    expect(res.outcome).toBe("invoiced");
    expect(res.tenantInvoiceIds).toHaveLength(1);

    const tenantDocs = await db.billingDocument.findMany({ where: { organizationId: ORG, counterpartyType: "tenant" } });
    expect(tenantDocs).toHaveLength(1);
    expect(tenantDocs[0].total.toFixed(2)).toBe("523.00"); // 483 + 40, NO expense — parity with pre-feature behavior

    const lines = await db.billingDocumentLine.findMany({ where: { documentId: tenantDocs[0].id } });
    expect(lines).toHaveLength(2); // electricity + wifi only, no expense line

    // No charge was ever minted for the GridExpense — the row itself still exists
    // (untouched), just never consumed into a Charge.
    expect(await db.charge.count({ where: { organizationId: ORG, chargeType: "expense" } })).toBe(0);
    const expenseRow = await db.gridExpense.findUniqueOrThrow({ where: { id: exp.data.ids[0] } });
    expect(expenseRow.status).toBe("active");
  });

  // FIX 1 (final review): two DISTINCT active GridExpense rows on the SAME tenancy/bearer
  // with the SAME amount, neither with a picked category, both fall into the SAME fallback
  // category ("other_expense_tenant") → identical (unitId, categoryId, billingMonth, amount)
  // → P2002 on Charge_unit_category_month_amount_active_key unless expense charges are
  // exempted from that index (mirrors the sourceRecurringLineId exemption precedent).
  it("two same-amount expenses both bill", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    const { expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [
        { description: "Aircon repair", amount: "50.00", withSST: false },
        { description: "Plumbing repair", amount: "50.00", withSST: false },
      ],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;
    expect(exp.data.ids).toHaveLength(2);

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    // Before the fix: the whole row rolls back on P2002 → outcome "save_failed".
    expect(res.outcome).toBe("invoiced");

    const tenantDocs = await db.billingDocument.findMany({ where: { organizationId: ORG, counterpartyType: "tenant" } });
    expect(tenantDocs).toHaveLength(1);
    // 483 + 40 + 50 + 50 = 623.00 — BOTH expenses landed as lines, not just one.
    expect(tenantDocs[0].total.toFixed(2)).toBe("623.00");

    const expenseCharges = await db.charge.findMany({ where: { organizationId: ORG, chargeType: "expense" } });
    expect(expenseCharges).toHaveLength(2);
    expect(expenseCharges.every((c) => c.status !== "void" && c.status !== "credited")).toBe(true);
  });

  // FIX 2 (final review): a vacant apartment (no occupied rooms, no utilities, no
  // recurring) with ONLY an owner-borne GridExpense must still mint + invoice — the
  // first-issuance gate (service.ts billService, `if (alloc.allocations.length > 0 ||
  // ownerBorne > 0 || hasRecurring)`) had no expense term, so the mint branch never ran
  // and the expense was silently, permanently un-billable.
  // FIX 4 (final review, covered here rather than a separate scenario): the SAME
  // apartment must appear `billed: true` on the grid read path (billedApartmentIds
  // currently only counts chargeType "utility").
  it("vacant unit owner expense still bills", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    await seedVacantApartment();
    const { expectedUpdatedAt } = await seedZeroEntry(APT_V);

    const exp = await createExpensesService(session, {
      apartmentId: APT_V, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Roof repair", amount: "80.00", withSST: false }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT_V, expectedUpdatedAt }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.data.results[0];
    // Before the fix: the mint branch never runs (gate is false) → falls through to
    // the plain `billed` return, no BillingDocument, expense stays un-consumed forever.
    expect(res.outcome).toBe("invoiced");
    expect(res.ownerInvoiceIds).toHaveLength(1);

    const ownerDocs = await db.billingDocument.findMany({ where: { organizationId: ORG, counterpartyType: "owner" } });
    expect(ownerDocs).toHaveLength(1);
    expect(ownerDocs[0].partyId).toBe(OWNER_PARTY);
    expect(ownerDocs[0].total.toFixed(2)).toBe("80.00");

    const expenseCharge = await db.charge.findFirst({ where: { organizationId: ORG, chargeType: "expense", sourceGridExpenseId: exp.data.ids[0] } });
    expect(expenseCharge).not.toBeNull();
    expect(expenseCharge!.status).not.toBe("void");

    // FIX 4: the grid read path must now tag APT_V as billed.
    const grid = await getGridService({ orgId: ORG }, { period: PERIOD_STR, months: 1 });
    expect(grid.ok).toBe(true);
    if (!grid.ok) return;
    const row = grid.data.rows.find((row) => row.apartmentId === APT_V);
    expect(row).toBeDefined();
    expect(row!.billed).toBe(true);
  });

  // FIX 3 (final review): after FIX 2/4, an entry carrying an expense charge must be
  // recognised as UNCHANGED on a genuine no-op re-Bill call — the component-aware no-op
  // (rebillSupersedeTx step 4, `freshWithRecurring`) had no expense-preview term, so ANY
  // month with an expense charge NEVER matched (the live expense charge had nothing to
  // compare against in the fresh preview) and always fell through to reissue/confirmation
  // churn, even when literally nothing changed.
  it("re-Bill unchanged expense month is a no-op", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    const { entryId, expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [{ description: "Aircon repair", amount: "250.00", withSST: false }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    // First issuance: IVTEN carries the utility lines + the expense line.
    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    // Re-Bill call with NOTHING changed (same period, no entry edit) — a genuine no-op.
    // FRESH token (the first issuance's lock bumped updatedAt) so this exercises the
    // no-op DETECTION itself (step 4), not a stale-token rejection (step 6's relock).
    // Before the fix: this incorrectly falls through past step 4 to reissue (or, without
    // confirmRebill, `rebill_confirmation_required`) because the live expense charge never
    // matches an empty expense preview — mirrors bill-rebill.integration.test.ts's own
    // "unedited-no-op" convention (fresh token + confirmRebill:true).
    const freshEntry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
    const rebill = await billService(session, {
      period: PERIOD_STR,
      rows: [{ apartmentId: APT, expectedUpdatedAt: freshEntry.updatedAt.toISOString(), confirmRebill: true }],
    });
    expect(rebill.ok).toBe(true);
    if (!rebill.ok) return;
    expect(rebill.data.results[0].outcome).toBe("already_billed");
  });

  /**
   * The SST sibling is a component the mint now produces, so `expenseComponents` (the
   * re-Bill no-op preview) has to produce it too. Omit it there and an UNCHANGED
   * SST-bearing month compares short by exactly one component EVERY time, so
   * `already_billed` is never reached and each re-Bill churns a full reissue —
   * crediting and re-minting live charges, which reverses partial payments (R8).
   * The withSST:false twin above cannot catch that: with no SST there is no sibling.
   */
  it("re-Bill unchanged SST-bearing expense month is a no-op", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    const db = getDb();
    await seedOrgAndRoom();
    const { entryId, expectedUpdatedAt } = await seedEntry("483.00", "40.00");

    const exp = await createExpensesService(session, {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "tenant", tenancyId: TEN_A,
      items: [{ description: "Aircon repair", amount: "250.00", withSST: true }],
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;

    const first = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.results[0].outcome).toBe("invoiced");

    const freshEntry = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
    const rebill = await billService(session, {
      period: PERIOD_STR,
      rows: [{ apartmentId: APT, expectedUpdatedAt: freshEntry.updatedAt.toISOString(), confirmRebill: true }],
    });
    expect(rebill.ok).toBe(true);
    if (!rebill.ok) return;
    expect(rebill.data.results[0].outcome).toBe("already_billed");
  });
});
