/**
 * Owner-statement void / line void → CN against the IVOWN document (integration).
 *
 * Proves (flag ON): voiding a statement issues ONE CN (seriesCode CN,
 * counterparty owner) referencing its IVOWN invoice document via
 * statementInvoiceId, marks the IVOWN doc `offset`; voiding a single INCOME
 * line issues a PARTIAL CN (single line) and leaves the IVOWN doc issued;
 * statements with NO IVOWN doc (pre-cutover) void plainly.
 *
 * Run:
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/owner-billing/__tests__/statement-void-cn.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// Statement void triggers a post-void PDF/regenerate concern in other paths but
// NOT here (void does not regenerate); audit is real. No mocks needed except
// keeping Chromium/storage untouched — void renders nothing.
import { voidStatementService, voidStatementLineService } from "../owner-billing.service";
import { releaseVoidedStatementSlotsInTx } from "../owner-billing.repository";
import { issueStatementIvownDocumentTx } from "../../billing-documents/issue.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

// Fixed disjoint UUIDs (prefix 9c32)
const ORG = "9c320000-0000-4000-8000-000000000001";
const USER = "9c320000-0000-4000-8000-000000000002";
const OWNER = "9c320000-0000-4000-8000-000000000003";
const CAT_FEE = "9c320000-0000-4000-8000-000000000004";
const SERIES_IVOWN = "9c320000-0000-4000-8000-000000000005";
const SERIES_CN = "9c320000-0000-4000-8000-000000000006";
const INV = "9c320000-0000-4000-8000-000000000007";
const C_FEE = "9c320000-0000-4000-8000-000000000008";
const C_CLEAN = "9c320000-0000-4000-8000-000000000009";
const D_IVOWN = "9c320000-0000-4000-8000-00000000000a";
const MONTH = new Date(Date.UTC(2026, 5, 1));

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

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

async function seed(withIvownDoc: boolean) {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "P3 Stmt Void Org",
      slug: "p3-stmt-void-org",
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
      email: "p3stmt@test.local",
      fullName: "P3 Admin",
      passwordHash: "x",
      status: "active",
      role: "admin",
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "Statement Owner", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES_IVOWN, organizationId: ORG, code: "IVOWN", prefix: "IVOWN", padding: 4, includeYear: false, active: true },
  });
  await db.documentSeries.create({
    data: { id: SERIES_CN, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT_FEE, organizationId: ORG, code: "management_fee", name: "Management fee",
      family: "owner_income", docType: "invoice", seriesId: SERIES_IVOWN,
      defaultSstRate: 8, eInvoiceEligible: false, ledgerCategory: "management_fee",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
  await db.invoice.create({
    data: {
      id: INV, organizationId: ORG, invoiceNumber: "OS-202606-9c320000",
      partyId: OWNER, ownerPartyId: OWNER, invoiceType: "owner_statement",
      status: "approved", invoiceDate: new Date(), periodMonth: MONTH,
      totalAmount: "308.00", sstAmount: "8.00", currency: "MYR",
      idempotencyKey: `owner:${OWNER}:2026-06`,
    },
  });
  await db.charge.create({
    data: {
      id: C_FEE, organizationId: ORG, chargeNumber: "OSC-202606-FEE", partyId: OWNER,
      invoiceId: INV, chargeType: "management_fee", status: "posted", postedAt: new Date(),
      dueDate: new Date(Date.UTC(2026, 5, 30)), amount: "100.00", currency: "MYR",
      outstandingAmount: "100.00", billingMonth: MONTH,
    },
  });
  await db.charge.create({
    data: {
      id: C_CLEAN, organizationId: ORG, chargeNumber: "OSC-202606-CLEAN", partyId: OWNER,
      invoiceId: INV, chargeType: "cleaning", status: "posted", postedAt: new Date(),
      dueDate: new Date(Date.UTC(2026, 5, 30)), amount: "200.00", currency: "MYR",
      outstandingAmount: "200.00", billingMonth: MONTH,
    },
  });
  if (withIvownDoc) {
    await db.billingDocument.create({
      data: {
        id: D_IVOWN, organizationId: ORG, docType: "invoice", documentNumber: "IVOWN-7001",
        seriesId: SERIES_IVOWN, status: "issued", issuedById: USER,
        counterpartyType: "owner", partyId: OWNER, statementInvoiceId: INV,
        billingMonth: MONTH, subtotal: "300.00", sstAmount: "8.00", total: "308.00",
        lines: {
          create: [
            { chargeId: C_FEE, categoryId: CAT_FEE, description: "Management fee 202606", amount: "100.00", sstRate: 8, sstAmount: "8.00" },
            { chargeId: C_CLEAN, categoryId: CAT_FEE, description: "Cleaning 202606", amount: "200.00", sstRate: 0, sstAmount: 0 },
          ],
        },
      },
    });
  }
}

dn("statement void / line void → CN (integration)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("statement void → CN referencing the IVOWN doc, IVOWN offset", async () => {
    await seed(true);
    const r = await voidStatementService(ctx, INV, { reason: "figures were wrong" });
    expect(r.ok).toBe(true);

    const db = getDb();
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: INV } });
    expect(inv.status).toBe("void");

    const cn = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "credit_note" },
      include: { lines: true },
    });
    expect(cn.originalDocumentId).toBe(D_IVOWN);
    expect(cn.statementInvoiceId).toBe(INV);
    expect(cn.counterpartyType).toBe("owner");
    expect(cn.reason).toBe("figures were wrong");
    expect(cn.lines).toHaveLength(2); // full reversal: fee + cleaning
    expect(Number(cn.total.toString())).toBe(308);

    const ivown = await db.billingDocument.findUniqueOrThrow({ where: { id: D_IVOWN } });
    expect(ivown.status).toBe("offset");
    // Deferred item close-out: the offset doc's idempotency slot MUST be
    // released, else a void→regenerate cycle replays "ivown:<same key>" into
    // issueDocumentTx's dedupe lookup and hands the regenerated statement a
    // reference to THIS offset document instead of minting a fresh one.
    expect(ivown.idempotencyKey).toBeNull();
  });

  it("statement void with NO IVOWN doc (pre-cutover) → plain void, no CN", async () => {
    await seed(false);
    const r = await voidStatementService(ctx, INV, { reason: "legacy statement" });
    expect(r.ok).toBe(true);
    const db = getDb();
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "credit_note" } })).toBe(0);
  });

  it("income line void → PARTIAL CN (single line), IVOWN stays issued", async () => {
    await seed(true);
    const r = await voidStatementLineService(ctx, INV, C_FEE, { reason: "fee waived this month" });
    expect(r.ok).toBe(true);

    const db = getDb();
    const line = await db.charge.findUniqueOrThrow({ where: { id: C_FEE } });
    expect(line.status).toBe("void"); // existing line-void semantics preserved

    const cn = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "credit_note" },
      include: { lines: true },
    });
    expect(cn.originalDocumentId).toBe(D_IVOWN);
    expect(cn.lines).toHaveLength(1);
    expect(cn.lines[0]!.chargeId).toBe(C_FEE);
    expect(Number(cn.total.toString())).toBe(108); // 100 base + 8 SST

    const ivown = await db.billingDocument.findUniqueOrThrow({ where: { id: D_IVOWN } });
    expect(ivown.status).toBe("issued"); // partial reversal — original NOT offset
  });

  it("statement void → regenerate mints a FRESH IVOWN doc (idempotency slot released, not reused)", async () => {
    // Reproduces the exact statement void→regenerate cycle the deferred item
    // covers: void the statement (offsets D_IVOWN + releases its idempotency
    // key), release the STATEMENT's own idempotencyKey slot the same way
    // generateStatementService's regenerate path does, then mint a second
    // IVOWN document under the SAME "ivown:"+statement-idempotencyKey. Before
    // the fix this would have matched D_IVOWN (now offset) via
    // issueDocumentTx's status-blind idempotencyKey lookup; after the fix it
    // must mint a brand-new document.
    await seed(true);
    const r = await voidStatementService(ctx, INV, { reason: "figures were wrong" });
    expect(r.ok).toBe(true);

    const db = getDb();
    const ivownAfterVoid = await db.billingDocument.findUniqueOrThrow({ where: { id: D_IVOWN } });
    expect(ivownAfterVoid.status).toBe("offset");
    expect(ivownAfterVoid.idempotencyKey).toBeNull();

    const INV2 = "9c320000-0000-4000-8000-00000000000b";
    const C_FEE2 = "9c320000-0000-4000-8000-00000000000c";
    await db.$transaction(async (tx) => {
      // Mirrors generateStatementService's regenerate path: release the
      // VOIDED statement's own idempotencyKey/invoiceNumber slots so the
      // fresh statement can claim them.
      await releaseVoidedStatementSlotsInTx(tx, ORG, `owner:${OWNER}:2026-06`, "OS-202606-9c320000");
      await tx.invoice.create({
        data: {
          id: INV2, organizationId: ORG, invoiceNumber: "OS-202606-9c320000",
          partyId: OWNER, ownerPartyId: OWNER, invoiceType: "owner_statement",
          status: "draft", invoiceDate: new Date(), periodMonth: MONTH,
          totalAmount: "100.00", sstAmount: "0.00", currency: "MYR",
          idempotencyKey: `owner:${OWNER}:2026-06`,
        },
      });
      // "cleaning" (not "management_fee") deliberately — it needs no per-unit
      // ManagementFeeConfig/SST-rate resolution, keeping this fixture focused
      // on the idempotency-slot mechanism rather than the fee-config pipeline.
      await tx.charge.create({
        data: {
          id: C_FEE2, organizationId: ORG, chargeNumber: "OSC-202606-CLEAN2", partyId: OWNER,
          invoiceId: INV2, chargeType: "cleaning", status: "posted", postedAt: new Date(),
          dueDate: new Date(Date.UTC(2026, 5, 30)), amount: "100.00", currency: "MYR",
          outstandingAmount: "100.00", billingMonth: MONTH,
        },
      });
      await issueStatementIvownDocumentTx(tx, ORG, USER, INV2);
    });

    const freshIvown = await db.billingDocument.findFirstOrThrow({
      where: { organizationId: ORG, docType: "invoice", statementInvoiceId: INV2 },
    });
    expect(freshIvown.id).not.toBe(D_IVOWN); // a NEW document, not the offset one
    expect(freshIvown.status).toBe("issued");
    expect(freshIvown.idempotencyKey).toBe(`ivown:owner:${OWNER}:2026-06`);

    // The offset original is untouched by the regenerate.
    const ivownStillOffset = await db.billingDocument.findUniqueOrThrow({ where: { id: D_IVOWN } });
    expect(ivownStillOffset.status).toBe("offset");
    expect(ivownStillOffset.idempotencyKey).toBeNull();
  });
});
