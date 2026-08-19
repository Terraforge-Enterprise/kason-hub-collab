/**
 * Owner-side "charge-adjustment credit" gap — seam #1 (payout netting).
 *
 * charge-adjustment.service.ts is TENANT-ONLY today (it 403s
 * OWNER_ADJUSTMENT_NOT_SUPPORTED for any charge whose linked invoice has
 * counterpartyType "owner" — see charge-adjustment.integration.test.ts's own
 * "B5" case). There is therefore no REAL endpoint yet that applies a partial
 * credit/debit note to an owner-side (IVOWN) charge. This suite does NOT call
 * that service. It hand-mints the EXACT DB effect createChargeAdjustmentService
 * would produce (charge-adjustment.service.ts:210-308) if it were widened to
 * accept an owner charge:
 *   1. a charge-backed credit_note/debit_note BillingDocument
 *      (originalDocumentId = the IVOWN invoice doc, one line carrying
 *      chargeId + the note amount)
 *   2. charge.outstandingAmount adjusted the same way the real service does
 *      (CN decrements, DN increments)
 *   3. charge.amount and charge.status left UNTOUCHED (exactly like the real
 *      tenant-side branches — charge-adjustment.service.ts:210-213,283-286)
 * then fires the SAME post-commit hook the real service calls
 * (syncOwnerLedgerForCharges, charge-adjustment.service.ts:360) and reads the
 * owner's payable the same way recordRemittanceService/recordOffsetService do
 * (computeAvailableOwnerPayableC, owner-remittance.repository.ts:57 — the
 * function every money-mutating remittance/offset guard gates on).
 *
 * Proves the seam #1 fix: expectedStatementLedgerRows / netAdjustmentsByChargeId
 * (owner-ledger.sync.ts, net-adjustments-by-charge.ts) net ACTIVE charge-backed
 * CN/DN into the owner payout (Formula-B), excluding voided/draft notes via
 * ACTIVE_ADJUSTMENT_NOTE_STATUSES.
 *
 * Run (real local Postgres):
 *   cd apps/api; set -a; . ../../.env; set +a
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=1 \
 *     ENABLE_PHASE2_OWNER_REMITTANCE=1 npx vitest run owner-adjustment-gap
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { computeAvailableOwnerPayableC } from "../owner-remittance.repository";
import { resolveOwnerBalance } from "../../owner-ledger/owner-ledger.repository";
import { syncMonthService } from "../../owner-ledger/owner-ledger.sync";
import { syncOwnerLedgerForCharges } from "../../owner-ledger/owner-ledger.sync-hook";
import type { OwnerLedgerActorCtx } from "../../owner-ledger/owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  if (!(process.env.ENABLE_PHASE2_OWNER_BILLING === "1" || process.env.ENABLE_PHASE2_OWNER_BILLING === "true")) {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  }
}

// Fixed disjoint UUIDs (prefix b7a0; unused by any other suite).
const ORG          = "b7a00000-0000-4000-8000-000000000001";
const USER         = "b7a00000-0000-4000-8000-000000000002";
const OP_PARTY     = "b7a00000-0000-4000-8000-000000000003";
const OWNER        = "b7a00000-0000-4000-8000-000000000004";
const PROPERTY     = "b7a00000-0000-4000-8000-000000000005";
const APARTMENT    = "b7a00000-0000-4000-8000-000000000006";
const LISTING      = "b7a00000-0000-4000-8000-000000000007";
const SERIES_IVOWN = "b7a00000-0000-4000-8000-000000000008";
const SERIES_CN    = "b7a00000-0000-4000-8000-000000000009";
const STMT_INVOICE = "b7a00000-0000-4000-8000-00000000000a";
const CHARGE       = "b7a00000-0000-4000-8000-00000000000b";
const IVOWN_DOC    = "b7a00000-0000-4000-8000-00000000000c";
const CN_DOC       = "b7a00000-0000-4000-8000-00000000000d";
const SERIES_DN    = "b7a00000-0000-4000-8000-00000000000e";
const DN_DOC        = "b7a00000-0000-4000-8000-00000000000f";
const CN_DOC_VOIDED = "b7a00000-0000-4000-8000-000000000010";
const CN_DOC_DRAFT  = "b7a00000-0000-4000-8000-000000000011";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));

const actor: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.partyRole.deleteMany({ where: org });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * Seed an OWNER scenario in an OPEN month (no OwnerStatementPeriod row exists
 * for (OWNER, MONTH), so findPeriod resolves null → "open" per
 * assert-period-open.ts:55 / owner-ledger.sync.ts:308's own frozen check):
 *   - an owner Party + a Listing they own on one Apartment/Property
 *   - an owner_statement Invoice (legacy M6 record the sync's Source-2 reads
 *     directly — see owner-ledger.sync.ts:404-433) with ONE management_fee
 *     Charge, amount=outstanding="100.00", status "posted"
 *   - an IVOWN BillingDocument (docType "invoice", counterpartyType "owner",
 *     statementInvoiceId = the Invoice) mirroring one line to that Charge —
 *     the Phase-2 billing-documents artifact charge-adjustment.service.ts
 *     would look up via originalDocumentId
 *
 * management_fee is NOT in STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES
 * (owner-ledger.sync.ts:108-113), so it books a normal Source-2
 * includeInPayout:true expense row (owner-ledger.sync.ts:249-268).
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "B7A0 Owner Adjustment Gap Org", slug: "b7a0-owner-adjustment-gap",
      status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: OP_PARTY, organizationId: ORG, displayName: "B7A0 Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b7a0-operator@example.com", fullName: "B7A0 Operator",
      status: "active", role: "admin", userType: "operator", partyId: OP_PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "B7A0 Owner", partyType: "individual", status: "active" },
  });
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROPERTY, organizationId: ORG, name: "B7A0 Property", propertyCode: "B7A0-P1",
      propertyType: "apartment", addressLine1: "1 B7A0 St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APARTMENT, organizationId: ORG, propertyId: PROPERTY, unitCode: "B7A0-1", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: LISTING, organizationId: ORG, apartmentId: APARTMENT, listingType: "Whole Unit",
      occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER,
    },
  });
  await db.documentSeries.create({
    data: { id: SERIES_IVOWN, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_DN, organizationId: ORG, code: "DN", prefix: "DN", padding: 4, includeYear: false, active: true },
  });

  // Legacy owner_statement Invoice — the record owner-ledger.sync.ts's
  // Source-2 reads DIRECTLY (db.invoice.findMany, NOT BillingDocument).
  await db.invoice.create({
    data: {
      id: STMT_INVOICE, organizationId: ORG, invoiceNumber: "B7A0-STMT-1", partyId: OWNER,
      ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft",
      invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "100.00", sstAmount: "0.00",
      currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}`,
    },
  });
  await db.charge.create({
    data: {
      id: CHARGE, organizationId: ORG, chargeNumber: "B7A0-CHG-1", unitId: LISTING, partyId: OWNER,
      chargeType: "management_fee", status: "posted", dueDate: MONTH_START, amount: "100.00",
      currency: "MYR", outstandingAmount: "100.00", invoiceId: STMT_INVOICE, billingMonth: MONTH_START,
    },
  });

  // IVOWN BillingDocument — the Phase-2 billing-documents artifact a
  // (hypothetical) owner-side charge-adjustment would mint its CN against.
  await db.billingDocument.create({
    data: {
      id: IVOWN_DOC, organizationId: ORG, docType: "invoice", documentNumber: "IVOWN-0001",
      seriesId: SERIES_IVOWN, status: "issued", issuedById: USER, counterpartyType: "owner",
      partyId: OWNER, propertyId: PROPERTY, apartmentId: APARTMENT, listingId: LISTING,
      billingMonth: MONTH_START, statementInvoiceId: STMT_INVOICE,
      subtotal: "100.00", sstAmount: "0", total: "100.00",
      lines: {
        create: [{ chargeId: CHARGE, description: "Management fee", amount: "100.00", sstRate: 0, sstAmount: 0 }],
      },
    },
  });
}

/** Read the owner's available payable in cents — the SAME read
 *  recordRemittanceService/recordOffsetService gate every write on
 *  (owner-remittance.service.ts:123/664). Wrapped in its own tx since the
 *  function requires a Prisma.TransactionClient (GC3 contract) but this call
 *  site is read-only, outside any money-mutating transaction. */
async function readPayableC(): Promise<number> {
  return getDb().$transaction((tx) => computeAvailableOwnerPayableC(tx, ORG, OWNER));
}

/**
 * Mint a charge-backed credit_note/debit_note against CHARGE, mirroring the DB
 * effect createChargeAdjustmentService produces for a note line (see the file
 * header) — `documentStatus` defaults to the schema default ISSUED (active);
 * pass DRAFT/CANCELLED to exercise the ACTIVE_ADJUSTMENT_NOTE_STATUSES exclusion.
 */
async function mintNote(o: {
  id: string;
  docType: "credit_note" | "debit_note";
  seriesId: string;
  documentNumber: string;
  amount: string; // e.g. "30.00"
  documentStatus?: string; // omit for the default ISSUED
}): Promise<void> {
  await getDb().billingDocument.create({
    data: {
      id: o.id, organizationId: ORG, docType: o.docType, documentNumber: o.documentNumber,
      seriesId: o.seriesId, status: "issued", issuedById: USER, counterpartyType: "owner",
      partyId: OWNER, originalDocumentId: IVOWN_DOC, billingMonth: MONTH_START,
      ...(o.documentStatus ? { documentStatus: o.documentStatus } : {}),
      ...(o.docType === "credit_note" ? { creditAmount: "0.00" } : {}),
      subtotal: o.amount, sstAmount: "0", total: o.amount,
      lines: {
        create: [{ chargeId: CHARGE, description: `Correction: Management fee (${o.docType})`, amount: o.amount, sstRate: 0, sstAmount: 0 }],
      },
    },
  });
}

dn("owner-side charge-adjustment credit — payable netting (seam #1)", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  it("a charge-backed CN(30) on an owner management_fee charge moves the payable UP by 30 (CN → expense down → payable up)", async () => {
    const db = getDb();

    // Materialise the Source-2 payout row (owner-ledger.sync.ts's normal sync path).
    const firstSync = await syncMonthService(actor, { ownerPartyId: OWNER, month: MONTH });
    expect(firstSync.ok).toBe(true);

    const rowBefore = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: CHARGE },
      select: { amount: true, direction: true, includeInPayout: true },
    });
    expect(rowBefore.direction).toBe("expense");
    expect(rowBefore.includeInPayout).toBe(true);
    expect(Number(rowBefore.amount.toString())).toBe(100);

    const payableBefore = await readPayableC();

    // ── Simulate the charge-adjustment CREDIT (charge-adjustment.service.ts:288-308) ──
    // Mint the charge-backed credit_note doc…
    await mintNote({ id: CN_DOC, docType: "credit_note", seriesId: SERIES_CN, documentNumber: "CN-0001", amount: "30.00" });
    // …and decrement outstandingAmount ONLY (charge.amount / charge.status untouched —
    // charge-adjustment.service.ts:283-286's exact effect).
    await db.charge.update({ where: { id: CHARGE }, data: { outstandingAmount: "70.00" } });

    // Fire the SAME post-commit hook the real service calls (charge-adjustment.service.ts:360).
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [CHARGE]);

    const payableAfter = await readPayableC();
    const rowAfter = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: CHARGE },
      select: { amount: true, status: true },
    });

    // THE FIX, directly observed: the re-sync's ledger row amount now nets the
    // active CN — expectedStatementLedgerRows (owner-ledger.sync.ts) adjusts
    // `charge.amount` by netAdjustmentsByChargeId's Σ active DN − Σ active CN
    // (net-adjustments-by-charge.ts), so the RM30 credit reaches the ledger.
    expect(rowAfter.status).toBe("active");
    expect(Number(rowAfter.amount.toString())).toBe(70); // 100 − 30 (Formula-B, CN netted)

    // management_fee is a Source-2 row with direction:"expense" and
    // includeInPayout:true (STATEMENT_UTILITY_DISPLAY_ONLY_CATEGORIES doesn't
    // cover it), and computeOwnerRunningBalance (owner-net-payout.ts:134-138)
    // SUBTRACTS an included expense from the owner's balance. Crediting RM30 off
    // a fee the owner is charged means RM30 LESS is deducted from their payout:
    // payable RISES by 30.00 (3000 cents) — exactly what recordRemittanceService/
    // recordOffsetService's shared payable read (computeAvailableOwnerPayableC)
    // must now reflect.
    expect(payableAfter).toBe(payableBefore + 3000);

    // Cross-check with the OTHER canonical payable reader (resolveOwnerBalance —
    // used by owner-ledger-receipt.service.ts / owner-statement-period.service.ts /
    // the portal routes) to show the fix isn't an artifact of ONE read path: both
    // derive from the exact same OwnerLedgerEntry rows via
    // computeOwnerRunningBalance, so they agree.
    const balance = await resolveOwnerBalance(ORG, OWNER);
    const carriedForwardC = Math.round(Number(balance.carriedForward) * 100);
    expect(carriedForwardC).toBe(payableAfter);
  });

  it("debit note decreases payable — an active DN(20) on the same charge moves the payable DOWN by 20", async () => {
    const db = getDb();
    const firstSync = await syncMonthService(actor, { ownerPartyId: OWNER, month: MONTH });
    expect(firstSync.ok).toBe(true);
    const payableBefore = await readPayableC();

    // Simulate the charge-adjustment DEBIT (charge-adjustment.service.ts:169-213):
    // mint the charge-backed debit_note doc and increment outstandingAmount.
    await mintNote({ id: DN_DOC, docType: "debit_note", seriesId: SERIES_DN, documentNumber: "DN-0001", amount: "20.00" });
    await db.charge.update({ where: { id: CHARGE }, data: { outstandingAmount: "120.00" } });

    await syncOwnerLedgerForCharges(ORG, USER, "admin", [CHARGE]);

    const payableAfter = await readPayableC();
    const rowAfter = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: CHARGE },
      select: { amount: true },
    });
    expect(Number(rowAfter.amount.toString())).toBe(120); // 100 + 20 (Formula-B, DN netted)
    // DN raises the expense → payout DEDUCTS more → payable FALLS by 20.00 (2000 cents).
    expect(payableAfter).toBe(payableBefore - 2000);
  });

  it("voided note reverts — a CN(30) later VOIDED (documentStatus CANCELLED) returns the payable to baseline", async () => {
    const db = getDb();
    const firstSync = await syncMonthService(actor, { ownerPartyId: OWNER, month: MONTH });
    expect(firstSync.ok).toBe(true);
    const payableBefore = await readPayableC();

    await mintNote({ id: CN_DOC_VOIDED, docType: "credit_note", seriesId: SERIES_CN, documentNumber: "CN-0002", amount: "30.00" });
    await db.charge.update({ where: { id: CHARGE }, data: { outstandingAmount: "70.00" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [CHARGE]);
    expect(await readPayableC()).toBe(payableBefore + 3000); // active CN netted in, as proven above

    // Void the note (the void service's own effect — charge-adjustment-void.service.ts
    // is out of scope here; we only need the documentStatus flip that
    // ACTIVE_ADJUSTMENT_NOTE_STATUSES excludes on) and re-sync.
    await db.billingDocument.update({ where: { id: CN_DOC_VOIDED }, data: { documentStatus: "CANCELLED" } });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [CHARGE]);

    const payableAfter = await readPayableC();
    const rowAfter = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: CHARGE },
      select: { amount: true },
    });
    expect(Number(rowAfter.amount.toString())).toBe(100); // voided CN excluded → back to charge.amount
    expect(payableAfter).toBe(payableBefore); // payable reverts to baseline
  });

  it("draft note ignored — a DRAFT (documentStatus not ISSUED) note on the charge leaves the payable unchanged", async () => {
    const db = getDb();
    const firstSync = await syncMonthService(actor, { ownerPartyId: OWNER, month: MONTH });
    expect(firstSync.ok).toBe(true);
    const payableBefore = await readPayableC();

    // A DRAFT note is never issued in the real flow (createChargeAdjustmentService
    // always mints ISSUED — see issue.service.ts) but ACTIVE_ADJUSTMENT_NOTE_STATUSES
    // must exclude any non-ISSUED status defensively; DRAFT proves the filter fires.
    await mintNote({ id: CN_DOC_DRAFT, docType: "credit_note", seriesId: SERIES_CN, documentNumber: "CN-0003", amount: "30.00", documentStatus: "DRAFT" });
    await syncOwnerLedgerForCharges(ORG, USER, "admin", [CHARGE]);

    const payableAfter = await readPayableC();
    const rowAfter = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: CHARGE },
      select: { amount: true },
    });
    expect(Number(rowAfter.amount.toString())).toBe(100); // draft excluded → unchanged
    expect(payableAfter).toBe(payableBefore); // unchanged
  });
});
