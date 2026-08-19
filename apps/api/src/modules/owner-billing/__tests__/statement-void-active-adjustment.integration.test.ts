/**
 * Statement-CN vs. active charge-adjustment note — mutual exclusion (Task 2,
 * seam #3, Option B, integration).
 *
 * `issueStatementCreditNoteTx` is called ONLY from the two statement-void
 * paths, and in both the target charge(s) are simultaneously set
 * `status → "void"` — so a statement CN is ALWAYS a full-line reversal. If an
 * active charge-adjustment note (CN or DN) already exists on that charge, a
 * statement CN on top would over-credit the document (e.g. 30 + 100 = 130
 * against a 100 charge). This suite proves BOTH void paths reject with
 * `409 STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT` while an active note exists, that
 * the reverse ordering is independently capped by the existing
 * `CHARGE_NOT_ADJUSTABLE` precondition (charge goes void first), and that
 * total active credit documents against the charge never exceed its original
 * adjustable amount at any step.
 *
 * The owner charge-adjustment CREATE endpoint is still 403-blocked
 * (`OWNER_ADJUSTMENT_NOT_SUPPORTED` — Task 4 not landed), so the "active
 * note" fixtures here are inserted directly via the same DB primitives
 * `createChargeAdjustmentService` uses internally (credit_note/debit_note
 * BillingDocument + line, `documentStatus: "ISSUED"`, `originalDocumentId`
 * pointing at the statement's IVOWN document) rather than through the
 * endpoint.
 *
 * Run:
 *   cd apps/api && set -a && . ../../.env && set +a && \
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_INVOICE_ADJUSTMENTS=true \
 *   ENABLE_PHASE2_OWNER_STATEMENT_LIVE_LEDGER=true ENABLE_PHASE2_OWNER_BILLING=true \
 *   ENABLE_PHASE2_BILLING_DOCS=true \
 *     npx vitest run ../../apps/api/src/modules/owner-billing/__tests__/statement-void-active-adjustment.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../owner-billing.types";
import {
  voidStatementService,
  voidStatementLineService,
  STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT,
} from "../owner-billing.service";
import { createChargeAdjustmentService } from "../../billing-documents/charge-adjustment.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (fixture prefix c3ea — "rj" isn't valid hex, so the
// plan's c3rj label is transliterated to the nearest hex-safe form; unused by
// any other suite).
const ORG = "c3ea0000-0000-4000-8000-000000000001";
const USER = "c3ea0000-0000-4000-8000-000000000002";
const OWNER = "c3ea0000-0000-4000-8000-000000000003";
const CAT = "c3ea0000-0000-4000-8000-000000000004";
const SERIES_IVOWN = "c3ea0000-0000-4000-8000-000000000005";
const SERIES_CN = "c3ea0000-0000-4000-8000-000000000006";
const SERIES_DN = "c3ea0000-0000-4000-8000-000000000007";
const INV = "c3ea0000-0000-4000-8000-000000000008";
const C_FEE = "c3ea0000-0000-4000-8000-000000000009";
const D_IVOWN = "c3ea0000-0000-4000-8000-00000000000a";
const NOTE = "c3ea0000-0000-4000-8000-00000000000b";
const MONTH = new Date(Date.UTC(2026, 5, 1));

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };
const session = { orgId: ORG, userId: USER, role: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * Base fixture: one owner-statement Invoice (status "approved", so both void
 * paths' pre-tx status checks pass) with ONE charge (chargeType "cleaning" —
 * deliberately not "management_fee", so voidStatementLineService's SST
 * recompute needs no ManagementFeeConfig, mirroring the idiom already used in
 * statement-void-cn.integration.test.ts) and a matching IVOWN BillingDocument
 * carrying that charge's line, amount 100.00.
 */
async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "C3RJ Statement-vs-Adjustment Org",
      slug: "c3rj-statement-vs-adjustment-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "c3rj-admin@test.local",
      fullName: "C3RJ Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "C3RJ Owner", partyType: "individual", status: "active" },
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
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "cleaning", name: "Cleaning",
      family: "owner_income", docType: "invoice", seriesId: SERIES_IVOWN,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "cleaning",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
  await db.invoice.create({
    data: {
      id: INV, organizationId: ORG, invoiceNumber: "OS-202606-c3ea0000",
      partyId: OWNER, ownerPartyId: OWNER, invoiceType: "owner_statement",
      status: "approved", invoiceDate: new Date(), periodMonth: MONTH,
      totalAmount: "100.00", sstAmount: "0.00", currency: "MYR",
      idempotencyKey: `owner:${OWNER}:2026-06:c3rj`,
    },
  });
  await db.charge.create({
    data: {
      id: C_FEE, organizationId: ORG, chargeNumber: "OSC-202606-C3RJ", partyId: OWNER,
      invoiceId: INV, chargeType: "cleaning", status: "posted", postedAt: new Date(),
      dueDate: new Date(Date.UTC(2026, 5, 30)), amount: "100.00", currency: "MYR",
      outstandingAmount: "100.00", billingMonth: MONTH,
    },
  });
  await db.billingDocument.create({
    data: {
      id: D_IVOWN, organizationId: ORG, docType: "invoice", documentNumber: "IVOWN-C3RJ-1",
      seriesId: SERIES_IVOWN, status: "issued", issuedById: USER,
      counterpartyType: "owner", partyId: OWNER, statementInvoiceId: INV,
      billingMonth: MONTH, subtotal: "100.00", sstAmount: "0.00", total: "100.00",
      lines: {
        create: [
          { chargeId: C_FEE, categoryId: CAT, description: "Cleaning 202606", amount: "100.00", sstRate: 0, sstAmount: 0 },
        ],
      },
    },
  });
}

/**
 * Insert an ACTIVE charge-adjustment note directly (bypasses the still-403
 * owner CREATE endpoint) — mirrors the exact shape
 * `createChargeAdjustmentService` mints: docType credit_note|debit_note,
 * `originalDocumentId` = the IVOWN doc, `documentStatus: "ISSUED"`, one line
 * on the target charge.
 */
async function seedActiveNote(docType: "credit_note" | "debit_note", amount: string) {
  const db = getDb();
  const seriesId = docType === "credit_note" ? SERIES_CN : SERIES_DN;
  const prefix = docType === "credit_note" ? "CN" : "DN";
  await db.billingDocument.create({
    data: {
      id: NOTE, organizationId: ORG, docType, documentNumber: `${prefix}-C3RJ-1`,
      seriesId, status: "issued", issuedById: USER, documentStatus: "ISSUED",
      counterpartyType: "owner", partyId: OWNER, originalDocumentId: D_IVOWN,
      billingMonth: MONTH, subtotal: amount, sstAmount: "0.00", total: amount,
      creditAmount: docType === "credit_note" ? amount : undefined,
      lines: {
        create: [{ chargeId: C_FEE, categoryId: CAT, description: "Adjustment", amount, sstRate: 0, sstAmount: 0 }],
      },
    },
  });
}

/** Sum of ACTIVE (documentStatus ISSUED) credit_note line amounts against C_FEE. */
async function activeCreditTotal(): Promise<number> {
  const db = getDb();
  const rows = await db.billingDocumentLine.findMany({
    where: {
      chargeId: C_FEE,
      document: { organizationId: ORG, docType: "credit_note", documentStatus: "ISSUED" },
    },
    select: { amount: true },
  });
  return rows.reduce((s, r) => s + Number(r.amount.toString()), 0);
}

dn("statement void vs. active charge-adjustment note — mutual exclusion (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });

  afterAll(cleanup);

  it("rejects line void while an active charge-adjustment CN exists on the charge (ordering 1)", async () => {
    await seedActiveNote("credit_note", "30.00");

    const before = await getDb().billingDocument.count({ where: { organizationId: ORG, docType: "credit_note" } });
    const r = await voidStatementLineService(ctx, INV, C_FEE, { reason: "attempted line void" });
    expect(r).toEqual({ ok: false, status: 409, error: STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT });

    const db = getDb();
    // No NEW statement CN issued — count of credit_note docs is unchanged.
    const after = await db.billingDocument.count({ where: { organizationId: ORG, docType: "credit_note" } });
    expect(after).toBe(before);
    // Charge stays non-void.
    const charge = await db.charge.findUniqueOrThrow({ where: { id: C_FEE } });
    expect(charge.status).not.toBe("void");
  });

  it("rejects full void while an active charge-adjustment DN exists on a line", async () => {
    await seedActiveNote("debit_note", "20.00");

    const r = await voidStatementService(ctx, INV, { reason: "attempted full void" });
    expect(r).toEqual({ ok: false, status: 409, error: STATEMENT_LINE_HAS_ACTIVE_ADJUSTMENT });

    const inv = await getDb().invoice.findUniqueOrThrow({ where: { id: INV } });
    expect(inv.status).not.toBe("void");
  });

  it("reverse ordering: statement line voided first, THEN a charge-adjustment create is independently capped at 400 CHARGE_NOT_ADJUSTABLE", async () => {
    const r1 = await voidStatementLineService(ctx, INV, C_FEE, { reason: "line voided first" });
    expect(r1.ok).toBe(true);

    const charge = await getDb().charge.findUniqueOrThrow({ where: { id: C_FEE } });
    expect(charge.status).toBe("void");

    const r2 = await createChargeAdjustmentService(session, {
      chargeId: C_FEE,
      kind: "credit",
      amount: "10.00",
      reason: "attempted adjustment on a voided charge",
    });
    expect(r2).toEqual({ ok: false, status: 400, error: "CHARGE_NOT_ADJUSTABLE" });
  });

  it("total active credit documents against the charge never exceed 100 (the adjustable amount) at every step", async () => {
    await seedActiveNote("credit_note", "30.00");
    expect(await activeCreditTotal()).toBeLessThanOrEqual(100);
    expect(await activeCreditTotal()).toBe(30);

    // Void the adjustment note directly (its own void service is out of
    // scope here; documentStatus flip is the same effect that service
    // produces) — the active-note guard must now permit the statement void.
    await getDb().billingDocument.update({ where: { id: NOTE }, data: { documentStatus: "CANCELLED" } });
    expect(await activeCreditTotal()).toBe(0);

    const r = await voidStatementLineService(ctx, INV, C_FEE, { reason: "voided after note cancelled" });
    expect(r.ok).toBe(true);

    // Statement CN (full-line reversal, 100) is now the only active credit —
    // total active credit against the 100 charge is exactly 100, never over.
    expect(await activeCreditTotal()).toBe(100);
  });
});
