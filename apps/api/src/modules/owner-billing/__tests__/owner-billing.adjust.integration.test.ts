/**
 * Adjustment-on-approved integration test (Task 8).
 *
 * Once a statement is `approved` it is LOCKED for ordinary line edits
 * (addStatementLineService → 409 NOT_DRAFT). But admins must be able to append an
 * ad-hoc charge (e.g. fire insurance paid on behalf) to an ALREADY-approved
 * statement WITHOUT un-approving it — un-approving would hide the statement from
 * the owner portal (the owner sees it at status `approved`). `addAdjustmentLineService`
 * is that explicit, audited path: it appends a Charge, recomputes the Invoice
 * totals, re-syncs the owner ledger for the new charge, regenerates the PDF, and
 * KEEPS the status.
 *
 * Proven here against a real LOCAL Postgres (opt-in RUN_INTEGRATION=1), through the
 * REAL generate → approve → addAdjustmentLineService chain (no service mocks), that:
 *   1. Adjusting an `approved` statement keeps status `approved` (still
 *      portal-visible), raises totalAmount by the line, refreshes pdfKey
 *      (PDF regenerated), and books a new OwnerLedgerEntry for the charge
 *      (includeInPayout:true → the net payout deducts it).
 *   2. Adjusting a `paid` statement → 409 STATEMENT_NOT_ADJUSTABLE.
 *   3. Adjusting a `void` statement → 409 STATEMENT_NOT_ADJUSTABLE.
 *
 * Storage + Chromium are mocked (putObject, htmlToPdf, …) so no real bucket or
 * browser is needed; the owner-ledger sync hook is kept REAL (flag on) so the
 * adjustment's ledger booking is exercised exactly like production.
 *
 * Run:
 *   cd apps/api
 *   DATABASE_URL="postgresql://…/kason_hub_dev?schema=public" \
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_OWNER_BILLING=1 \
 *     ../../node_modules/.bin/vitest run \
 *       src/modules/owner-billing/__tests__/owner-billing.adjust.integration.test.ts \
 *     --no-coverage
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { getDb } from "@kason/db";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

// ── External I/O mocks (storage + Chromium) ───────────────────────────────────
// Let regenerateStatementPdf succeed without a real Supabase bucket or browser.
// The pdfKey is still written to DB by the real setStatementPdfKey call in-tx.
// putObject is spied (via vi.hoisted so it exists before the hoisted vi.mock
// factory runs) so the test can assert the adjustment re-uploaded the PDF.
const { putObjectMock } = vi.hoisted(() => ({ putObjectMock: vi.fn(async () => undefined) }));
vi.mock("../../../lib/storage", () => ({
  putObject: putObjectMock,
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  fetchStorageBuffer: vi.fn(async () => Buffer.from("%PDF-attachment")),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

vi.mock("../../../lib/document-templates/pdf", () => ({
  htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub")),
}));

vi.mock("../../../lib/document-templates/render", () => ({
  renderToHtml: vi.fn(() => "<html>stub</html>"),
}));

vi.mock("../../../lib/document-templates/service", () => ({
  getTemplateForOrgDocType: vi.fn(async () => ({ docType: "owner_statement", title: "Owner Statement" })),
}));

vi.mock("../../../lib/document-templates/merge-pdfs", () => ({
  mergePdfs: vi.fn(async (base: Buffer) => base),
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import {
  addAdjustmentLineService,
  approveStatementService,
  generateStatementService,
  createFeeConfigService,
} from "../owner-billing.service";
import { buildOwnerLedgerReceiptModel } from "../../owner-ledger/owner-ledger-receipt.service";
import { assembleYannieStatement } from "../owner-statement-sections";

// ── Safety guard ──────────────────────────────────────────────────────────────
const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  // The post-commit owner-ledger sync hook is flag-gated; keep it on so the
  // adjustment materialises its owner-side expense like production.
  if (!(process.env.ENABLE_PHASE2_OWNER_BILLING === "1" || process.env.ENABLE_PHASE2_OWNER_BILLING === "true")) {
    process.env.ENABLE_PHASE2_OWNER_BILLING = "1";
  }
}

// ── Fixed disjoint UUIDs (prefix aj01; unused by any other suite) ──────────────
const ORG    = "a3010000-0000-4000-8000-000000000001";
const USER   = "a3010000-0000-4000-8000-000000000002";
const PARTY  = "a3010000-0000-4000-8000-000000000003";
const OWNER  = "a3010000-0000-4000-8000-000000000004";
const TENANT = "a3010000-0000-4000-8000-000000000005";
const PROP   = "a3010000-0000-4000-8000-000000000006";
const APT    = "a3010000-0000-4000-8000-000000000007";
const UNIT   = "a3010000-0000-4000-8000-000000000008";
const TEN    = "a3010000-0000-4000-8000-000000000009";

const BILLING_MONTH = "2026-05";

const ctx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

// ── Cleanup ───────────────────────────────────────────────────────────────────
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

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG,
      name: "AJ01 Adjust Org",
      slug: "aj01-adjust-org",
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: PARTY, organizationId: ORG, displayName: "AJ01 Operator", partyType: "individual", status: "active" },
  });
  await db.user.create({
    data: {
      id: USER,
      organizationId: ORG,
      email: "aj01-operator@example.com",
      fullName: "AJ01 Operator",
      status: "active",
      role: "admin",
      userType: "operator",
      partyId: PARTY,
    },
  });
  await db.party.create({
    data: { id: OWNER, organizationId: ORG, displayName: "AJ01 Owner", partyType: "individual", status: "active" },
  });
  // PartyRole of roleType "owner" is required by findOwnerInOrg.
  await db.partyRole.create({
    data: { organizationId: ORG, partyId: OWNER, roleType: "owner", status: "active" },
  });
  await db.property.create({
    data: {
      id: PROP,
      organizationId: ORG,
      name: "AJ01 Property",
      propertyCode: "AJ01-P1",
      propertyType: "apartment",
      addressLine1: "1 AJ St",
      city: "KL",
      country: "MY",
      status: "active",
      publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "AJ-1", listingMode: "WHOLE" },
  });
  await db.listing.create({
    data: {
      id: UNIT,
      organizationId: ORG,
      apartmentId: APT,
      listingType: "Whole Unit",
      occupancyStatus: "occupied",
      listingStatus: "active",
      currency: "MYR",
      ownerPartyId: OWNER,
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "AJ01 Tenant", partyType: "individual", status: "active" },
  });
  await db.tenancy.create({
    data: {
      id: TEN,
      organizationId: ORG,
      propertyId: PROP,
      unitId: UNIT,
      tenantPartyId: TENANT,
      tenancyCode: "AJ01-T1",
      status: "active",
      billingStatus: "current",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRentAmount: "2000",
    },
  });
  await db.landlordTenancy.create({
    data: {
      organizationId: ORG,
      propertyId: PROP,
      landlordId: OWNER,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      monthlyRent: "2000",
      status: "active",
    },
  });
  // Active 10%/8%-SST management fee config with cleaning auto-bill so the
  // statement has content (mgmt fee + cleaning lines).
  await createFeeConfigService(ctx, {
    ownerPartyId: OWNER,
    feeType: "percent",
    feeValue: "10",
    sstPercent: "8",
    isActive: true,
  });
}

/** Seed + generate a draft statement with at least one charge. Returns the id. */
async function seedDraftStatement(): Promise<string> {
  const res = await generateStatementService(ctx, { ownerPartyId: OWNER, billingMonth: BILLING_MONTH });
  if (!res.ok) throw new Error(`generateStatementService failed: ${JSON.stringify(res)}`);
  expect(res.data.lines.length).toBeGreaterThanOrEqual(1);
  return res.data.id;
}

/** Seed + generate + approve → returns an APPROVED statement id (with a pdfKey). */
async function seedApprovedStatement(): Promise<string> {
  const id = await seedDraftStatement();
  const res = await approveStatementService(ctx, id);
  if (!res.ok) throw new Error(`approveStatementService failed: ${JSON.stringify(res)}`);
  return id;
}

/** Force a statement to a terminal status directly (test-only DB write). */
async function forceStatus(id: string, status: "paid" | "void"): Promise<void> {
  await getDb().invoice.update({ where: { id }, data: { status } });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

dn("addAdjustmentLineService (integration)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanup();
    await seedBase();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("appends an audited adjustment to an approved statement and keeps it visible", async () => {
    const id = await seedApprovedStatement();
    const db = getDb();

    const before = await db.invoice.findUniqueOrThrow({
      where: { id },
      select: { totalAmount: true, pdfKey: true },
    });
    // Approve already regenerated the PDF (Task 1), so a pdfKey is present here.
    expect(before.pdfKey).not.toBeNull();
    // Only the adjustment's PDF re-upload should be observed below.
    putObjectMock.mockClear();

    const res = await addAdjustmentLineService(ctx, id, {
      chargeType: "insurance",
      description: "Fire insurance (paid on behalf)",
      amount: "300.00",
    });
    expect(res.ok).toBe(true);

    const after = await db.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalAmount: true, pdfKey: true },
    });
    expect(after.status).toBe("approved"); // still visible to the owner
    expect(Number(after.totalAmount)).toBeCloseTo(Number(before.totalAmount) + 300, 2);
    // PDF refreshed: the soft-copy object key is DETERMINISTIC
    // (owner-statements/<owner>/<YYYYMM>-combined.pdf), so regeneration OVERWRITES
    // the same key with new bytes rather than minting a new key — assert the
    // re-upload happened (putObject called) and the key is still present.
    expect(after.pdfKey).not.toBeNull();
    expect(putObjectMock).toHaveBeenCalled();

    // The new charge exists on the statement with chargeType "insurance".
    const charge = await db.charge.findFirstOrThrow({
      where: { invoiceId: id, chargeType: "insurance", organizationId: ORG },
      select: { id: true, amount: true, status: true },
    });
    expect(Number(charge.amount)).toBeCloseTo(300, 2);

    // The owner ledger booked the adjustment as a payout-deducting expense
    // (sourceType "statement", sourceChargeId = the new charge). includeInPayout
    // true ⇒ the net payout to the owner is reduced by this RM300.
    const entry = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: charge.id },
      select: { direction: true, amount: true, includeInPayout: true, ownerPartyId: true },
    });
    expect(entry.direction).toBe("expense");
    expect(entry.includeInPayout).toBe(true);
    expect(entry.ownerPartyId).toBe(OWNER);
    expect(Number(entry.amount)).toBeCloseTo(300, 2);
  });

  it("threads paid-on-behalf metadata onto the Charge + synced ledger + render WITHOUT changing the payout math (Task 9)", async () => {
    const id = await seedApprovedStatement();
    const db = getDb();

    // Expense total BEFORE the adjustment — the seed creates a cleaning charge (RM100),
    // so the receipt already has one expense line item.
    // After adding the RM300 insurance, the total must rise by exactly RM300.
    const beforeModel = await buildOwnerLedgerReceiptModel(ctx, OWNER, BILLING_MONTH, null);
    if (!beforeModel) throw new Error("expected a receipt model before adjustment (cleaning charge exists)");
    const beforeTotal = Number(beforeModel.totals.total);

    // Add a paid-on-behalf adjustment: KAEN paid Allianz RM300 fire insurance,
    // ref INV-1, on 2026-06-15.
    const res = await addAdjustmentLineService(ctx, id, {
      chargeType: "insurance",
      description: "Fire insurance (paid on behalf)",
      amount: "300.00",
      payeeName: "Allianz",
      paidOnBehalfRef: "INV-1",
      paidOnBehalfDate: "2026-06-15",
    });
    expect(res.ok).toBe(true);

    // 1) The metadata persisted on the created Charge.
    const charge = await db.charge.findFirstOrThrow({
      where: { invoiceId: id, chargeType: "insurance", organizationId: ORG },
      select: { id: true, payeeName: true, paidOnBehalfRef: true, paidOnBehalfDate: true },
    });
    expect(charge.payeeName).toBe("Allianz");
    expect(charge.paidOnBehalfRef).toBe("INV-1");
    expect(charge.paidOnBehalfDate?.toISOString().slice(0, 10)).toBe("2026-06-15");

    // 2) The metadata flowed through the sync onto the OwnerLedgerEntry.
    const entry = await db.ownerLedgerEntry.findFirstOrThrow({
      where: { organizationId: ORG, sourceType: "statement", sourceChargeId: charge.id },
      select: {
        direction: true,
        amount: true,
        includeInPayout: true,
        payeeName: true,
        paidOnBehalfRef: true,
        paidOnBehalfDate: true,
      },
    });
    expect(entry.direction).toBe("expense");
    expect(entry.includeInPayout).toBe(true); // still deducts from the payout
    expect(Number(entry.amount)).toBeCloseTo(300, 2);
    expect(entry.payeeName).toBe("Allianz");
    expect(entry.paidOnBehalfRef).toBe("INV-1");
    expect(entry.paidOnBehalfDate?.toISOString().slice(0, 10)).toBe("2026-06-15");

    // 3) The receipt model includes the insurance line item (expense row, not mgmt_fee).
    //    NOTE: The redesigned receipt (2026-06-30) exposes lineItems (not rows); payee
    //    metadata is display-only and lives in the statement sections (checked in step 4).
    const afterModel = await buildOwnerLedgerReceiptModel(ctx, OWNER, BILLING_MONTH, null);
    if (!afterModel) throw new Error("expected a receipt model after adjustment");
    const receiptItem = afterModel.lineItems.find((li) => li.description.toLowerCase().includes("insurance"));
    expect(receiptItem).toBeDefined();
    expect(receiptItem?.amount).toBe("300.00");

    // 4) The statement §5 expense breakdown exposes the payee too.
    const sections = await assembleYannieStatement(ctx, id);
    if (!sections) throw new Error("expected statement sections");
    const expenseRow = sections.expenseBreakdown.rows.find((r) => r.payeeName === "Allianz");
    expect(expenseRow).toBeDefined();
    expect(expenseRow?.paidOnBehalfRef).toBe("INV-1");
    expect(expenseRow?.paidOnBehalfDate).toBe("2026-06-15");

    // 5) MONEY-FOOT: the receipt expense total rose by EXACTLY the RM300 insurance line.
    //    (The receipt is now expenses-only; total = Σ expense amounts + sst.)
    const afterTotal = Number(afterModel.totals.total);
    expect(afterTotal).toBeCloseTo(beforeTotal + 300, 2);
  });

  it("rejects an adjustment on a paid statement (409)", async () => {
    const id = await seedApprovedStatement();
    await forceStatus(id, "paid");

    const res = await addAdjustmentLineService(ctx, id, {
      chargeType: "insurance",
      description: "Fire insurance",
      amount: "150.00",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);

    // No insurance charge was appended to the paid statement.
    const count = await getDb().charge.count({
      where: { invoiceId: id, chargeType: "insurance", organizationId: ORG },
    });
    expect(count).toBe(0);
  });

  it("rejects an adjustment on a void statement (409)", async () => {
    const id = await seedApprovedStatement();
    await forceStatus(id, "void");

    const res = await addAdjustmentLineService(ctx, id, {
      chargeType: "insurance",
      description: "Fire insurance",
      amount: "150.00",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});
