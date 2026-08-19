/**
 * Bills-grid attachment SCOPE — which documents a grid attachment can reach.
 *
 * Pins the contract behind a 2026-08-19 report: "after it's billed and I upload a new
 * attachment, it never shows on the tenant's proforma — but changing a billing value
 * does". Both halves are correct, and they come from the grid's TWO different upload
 * surfaces, which look alike on screen and behave nothing alike:
 *
 *   PER-LINE   (POST /bills-grid/expenses/:id/attachments, expenseId SET)
 *     -> resolved via charge.sourceGridExpenseId, so it lands on whichever party is
 *        billed for that line. Reaches a TENANT proforma, and invalidates its cached
 *        pdfKey so the next download re-renders with the bill appended.
 *
 *   UNIT-LEVEL (POST /bills-grid/apartments/:id/attachments, expenseId NULL)
 *     -> the unit's own supplier paperwork. pdf.service source B and
 *        attachment-pdf-invalidation BOTH gate it on counterpartyType === "owner",
 *        so it reaches owner documents ONLY — never a tenant's, not even after a
 *        re-Bill mints a brand-new proforma.
 *
 * The unit-level exclusion is DELIBERATE (a unit-level bill covers the whole unit, i.e.
 * other tenants' consumption) — this suite exists so nobody "fixes" it into a leak by
 * mistake, and so the per-line path can't silently regress into the same silence.
 * The matching UI disclosure is pinned in
 * apps/web/src/pages/bills-grid/__tests__/attachments-panel.test.tsx.
 *
 * Run:
 *   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/kaenproperties_test?schema=public"
 *   RUN_INTEGRATION=1 npx vitest run --root apps/api attachment-scope
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Local Supabase storage is unconfigured, so the real putObject would throw on the
// happy path. Same stub convention as line-attachment.integration.test.ts.
vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
  createSignedDownloadUrl: vi.fn(async (k: string) => `https://stub.test/${k}`),
  objectExists: vi.fn(async () => false),
  deleteObject: vi.fn(async () => undefined),
  getObject: vi.fn(async () => null),
}));

import { getDb } from "@kason/db";
import { issueGroupedGridInvoiceTx } from "../issue-grouped";
import { uploadAttachmentService, uploadLineAttachmentService } from "../service";
import { buildBillingDocumentPdfModel } from "../../billing-documents/pdf.service";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// DEDICATED fixture org in an isolated id namespace — never `findFirstOrThrow()`, so
// teardown stays total AND org-scoped and can't destroy real dev-database grid data.
const ORG = "9f7a0000-0000-4000-8000-000000000001";
const USER = "9f7a0000-0000-4000-8000-000000000002";
const PROP = "9f7a0000-0000-4000-8000-000000000003";
const APT = "9f7a0000-0000-4000-8000-000000000004";
const ROOM = "9f7a0000-0000-4000-8000-000000000005";
const TENANT = "9f7a0000-0000-4000-8000-000000000006";
const OWNER = "9f7a0000-0000-4000-8000-000000000007";
const TEN = "9f7a0000-0000-4000-8000-000000000008";
const ENTRY = "9f7a0000-0000-4000-8000-000000000009";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");
const SESSION = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.gridAttachment.deleteMany({ where: { organizationId: ORG } });
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

async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "AS", slug: "as-attach-scope", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "as7a@example.test", fullName: "AS Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-AS7A", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-AS7A", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT, tenancyCode: "T-AS7A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.unitBillsGridEntry.create({ data: { id: ENTRY, organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER } });

  await ensureChargeCategorySeeds(ORG);
  const cats = await db.chargeCategory.findMany({
    where: { organizationId: ORG, code: { in: ["electricity_tenant", "maintenance_tenant", "wifi_tenant", "electricity_owner"] } },
    select: { id: true, code: true },
  });
  return Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<string, string>;
}

/** A tenant-borne GridExpense + the "expense" Charge mintExpenseChargesTx mints from it. */
async function makeExpenseWithCharge(categoryId: string, amount: string) {
  const db = getDb();
  const exp = await db.gridExpense.create({
    data: {
      organizationId: ORG, entryId: ENTRY, apartmentId: APT, periodMonth: PERIOD,
      bearer: "tenant", description: "Aircon service", amount, withSST: false,
      partyId: TENANT, chargeCategoryId: categoryId, tenancyId: TEN, status: "active", createdBy: USER,
    },
    select: { id: true },
  });
  const charge = await db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `AS7A-EXP-${exp.id.slice(0, 8)}`, tenancyId: TEN, unitId: ROOM,
      partyId: TENANT, categoryId, chargeType: "expense", status: "posted", postedAt: new Date(),
      description: "Aircon service", dueDate: PERIOD, amount, currency: "MYR", outstandingAmount: amount,
      billingMonth: PERIOD, attachmentKeys: [], sourceGridEntryId: ENTRY, sourceGridExpenseId: exp.id,
    },
    select: { id: true },
  });
  return { expenseId: exp.id, chargeId: charge.id };
}

let seq = 0;
async function makeCharge(partyId: string, categoryId: string, amount: string, tenancyId: string | null) {
  seq += 1;
  return getDb().charge.create({
    data: {
      organizationId: ORG, chargeNumber: `AS7A-U-${seq}`, tenancyId, unitId: ROOM, partyId, categoryId,
      chargeType: "utility", status: "posted", postedAt: new Date(), description: `Line ${seq}`,
      dueDate: PERIOD, amount, currency: "MYR", outstandingAmount: amount, billingMonth: PERIOD, attachmentKeys: [],
    },
    select: { id: true },
  });
}

const filenames = (m: { attachments: { filename: string }[] } | null) =>
  (m?.attachments ?? []).map((a) => a.filename);

/** The whole month Billed once: a tenant proforma + an owner invoice, both PDF-rendered. */
async function billAndCachePdfs(cats: Record<string, string>) {
  const db = getDb();
  const { expenseId, chargeId } = await makeExpenseWithCharge(cats.maintenance_tenant, "250.00");
  const tenantUtil = await makeCharge(TENANT, cats.electricity_tenant, "100.00", TEN);
  const ownerUtil = await makeCharge(OWNER, cats.electricity_owner, "40.00", null);

  const r = await db.$transaction((tx) =>
    issueGroupedGridInvoiceTx(tx, [chargeId, tenantUtil.id, ownerUtil.id], USER));

  const tenantDocId = r.tenantInvoiceIds[0];
  const ownerDocId = r.ownerInvoiceIds[0];
  // Stand in for the first PDF download, which renders and caches pdfKey.
  for (const id of [tenantDocId, ownerDocId]) {
    await db.billingDocument.update({ where: { id }, data: { pdfKey: `billing-documents/${ORG}/${id}.pdf` } });
  }
  return { expenseId, tenantDocId, ownerDocId };
}

dn("bills-grid attachment scope (tenant proforma vs owner document)", () => {
  beforeEach(async () => {
    await cleanup();
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    process.env.ENABLE_BILL_EXPENSES_AS_CHARGES = "true";
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "true";
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  it("PER-LINE: filing a receipt on an already-billed line reaches the tenant proforma", async () => {
    const db = getDb();
    const cats = await seed();
    const { expenseId, tenantDocId } = await billAndCachePdfs(cats);

    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: tenantDocId } });
    expect(doc.docType).toBe("proforma");
    expect(doc.counterpartyType).toBe("tenant");

    const up = await uploadLineAttachmentService(SESSION, expenseId, {
      filename: "aircon-receipt.pdf", contentType: "application/pdf", sizeBytes: 10, body: Buffer.from("x"),
    });
    expect(up.ok).toBe(true);

    // pdfKey is a CACHE — nulling it is what makes the next download re-render with
    // the bill appended. Left set, the reader keeps the old render forever.
    const after = await db.billingDocument.findUniqueOrThrow({ where: { id: tenantDocId }, select: { pdfKey: true } });
    expect(after.pdfKey).toBeNull();
    expect(filenames(await buildBillingDocumentPdfModel(ORG, tenantDocId))).toContain("aircon-receipt.pdf");
  });

  it("UNIT-LEVEL: a unit supplier bill never reaches the tenant proforma, and leaves its pdfKey alone", async () => {
    const db = getDb();
    const cats = await seed();
    const { tenantDocId } = await billAndCachePdfs(cats);

    const up = await uploadAttachmentService(SESSION, APT, {
      period: "2026-06", filename: "tnb-june.pdf", contentType: "application/pdf", sizeBytes: 10, body: Buffer.from("x"),
    });
    expect(up.ok).toBe(true);

    // NOT a stale-cache bug: the tenant document would render identically anyway, so
    // invalidating it would force a pointless re-render AND imply the bill belongs on it.
    const after = await db.billingDocument.findUniqueOrThrow({ where: { id: tenantDocId }, select: { pdfKey: true } });
    expect(after.pdfKey).not.toBeNull();
    expect(filenames(await buildBillingDocumentPdfModel(ORG, tenantDocId))).not.toContain("tnb-june.pdf");
  });

  it("UNIT-LEVEL: the same bill DOES reach the owner document, and invalidates its pdfKey", async () => {
    const db = getDb();
    const cats = await seed();
    const { ownerDocId } = await billAndCachePdfs(cats);

    await uploadAttachmentService(SESSION, APT, {
      period: "2026-06", filename: "tnb-june.pdf", contentType: "application/pdf", sizeBytes: 10, body: Buffer.from("x"),
    });

    const after = await db.billingDocument.findUniqueOrThrow({ where: { id: ownerDocId }, select: { pdfKey: true } });
    expect(after.pdfKey).toBeNull();
    expect(filenames(await buildBillingDocumentPdfModel(ORG, ownerDocId))).toContain("tnb-june.pdf");
  });

  it("UNIT-LEVEL: a totally uncached re-render still carries no unit-level bill", async () => {
    // Rules OUT the cache as the explanation. The reported workaround ("if I change
    // those billing values, they reflect") re-Bills the month, so the natural suspicion
    // is a stale pdfKey. Here the month is re-Billed AND pdfKey is force-nulled — the
    // best possible case for the bill to appear — and it still doesn't, because the
    // exclusion is the counterparty gate in pdf.service source B, not a caching artefact.
    const db = getDb();
    const cats = await seed();
    const { tenantDocId } = await billAndCachePdfs(cats);

    await uploadAttachmentService(SESSION, APT, {
      period: "2026-06", filename: "tnb-june.pdf", contentType: "application/pdf", sizeBytes: 10, body: Buffer.from("x"),
    });

    // "Change a billing value" — an extra tenant charge re-Bills the month. issueDocumentTx
    // dedupes on (tenant, unit, month, proforma), so this UPDATES the live PI rather than
    // minting a second one; assert that rather than assuming a new id.
    const extra = await makeCharge(TENANT, cats.wifi_tenant, "80.00", TEN);
    const r2 = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [extra.id], USER));
    expect(r2.tenantInvoiceIds[0]).toBe(tenantDocId);

    await db.billingDocument.update({ where: { id: tenantDocId }, data: { pdfKey: null } });

    const fresh = await db.billingDocument.findUniqueOrThrow({ where: { id: tenantDocId }, select: { pdfKey: true, counterpartyType: true } });
    expect(fresh.pdfKey).toBeNull(); // nothing cached left to blame
    expect(fresh.counterpartyType).toBe("tenant");
    expect(filenames(await buildBillingDocumentPdfModel(ORG, tenantDocId))).not.toContain("tnb-june.pdf");
  });
});
