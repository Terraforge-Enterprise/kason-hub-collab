/**
 * Proforma routing (spec 2026-08-10 R1/R12): with ENABLE_PROFORMA_INVOICES on, the grid
 * issues the tenant's document as a provisional `proforma` from the PI series instead of
 * an IVTEN invoice. The OWNER side is untouched at any flag value (R10), and flag-off is
 * byte-identical to before the flag existed (R12).
 *
 * Real local Postgres only, same RUN_INTEGRATION + host-guard convention as
 * grouped-issue.test.ts.
 *
 * Run (from apps/api):
 *   RUN_INTEGRATION=1 npx vitest run src/modules/bills-grid/__tests__/proforma-issue.integration.test.ts
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

const ORG = "9f100000-0000-4000-8000-000000000001";
const USER = "9f100000-0000-4000-8000-000000000002";
const PROP = "9f100000-0000-4000-8000-000000000003";
const APT = "9f100000-0000-4000-8000-000000000004";
const ROOM = "9f100000-0000-4000-8000-000000000005";
const TENANT = "9f100000-0000-4000-8000-000000000006";
const OWNER = "9f100000-0000-4000-8000-000000000007";
const TEN = "9f100000-0000-4000-8000-000000000008";

const PERIOD = new Date("2026-06-01T00:00:00.000Z");

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
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
  await db.organization.create({ data: { id: ORG, name: "PF", slug: "pf-proforma", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "pf@example.test", fullName: "PF Operator", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-PF", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-PF", listingMode: "WHOLE" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.tenancy.create({ data: { id: TEN, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT, tenancyCode: "T-PF", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });

  await ensureChargeCategorySeeds(ORG);
  const cats = await db.chargeCategory.findMany({
    where: { organizationId: ORG, code: { in: ["electricity_tenant", "wifi_tenant", "electricity_owner"] } },
    select: { id: true, code: true },
  });
  return Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<string, string>;
}

let seq = 0;
async function makeCharge(partyId: string, categoryId: string, amount: string, tenancyId: string | null) {
  const db = getDb();
  seq += 1;
  return db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: `PFTEST-${seq}`, tenancyId, unitId: ROOM, partyId, categoryId,
      chargeType: "utility", status: "posted", postedAt: new Date(), description: `Line ${seq}`,
      dueDate: PERIOD, amount, currency: "MYR", outstandingAmount: amount, billingMonth: PERIOD, attachmentKeys: [],
    },
    select: { id: true },
  });
}

dn("grid issues a tenant proforma (R1)", () => {
  beforeEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });
  afterEach(async () => {
    await cleanup();
    delete process.env.ENABLE_PROFORMA_INVOICES;
  });

  it("flag ON — tenant gets a PI- proforma, owner still gets an IVOWN- invoice", async () => {
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    const db = getDb();
    const cats = await seed();
    const t1 = await makeCharge(TENANT, cats.electricity_tenant, "100.00", TEN);
    const t2 = await makeCharge(TENANT, cats.wifi_tenant, "60.00", TEN);
    const o1 = await makeCharge(OWNER, cats.electricity_owner, "40.00", null);

    const r = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [t1.id, t2.id, o1.id], USER));

    const tenantDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: r.tenantInvoiceIds[0] } });
    expect(tenantDoc.docType).toBe("proforma");
    expect(tenantDoc.documentNumber.startsWith("PI-")).toBe(true);
    // Totals are computed exactly as for any other document — a proforma is provisional
    // in STATUS, not in arithmetic. It has to state the real amount due.
    expect(Number(tenantDoc.total.toString())).toBe(160);
    // Never the graduation link: that is set on the invoice minted FROM this, not on it.
    expect(tenantDoc.proformaDocumentId).toBeNull();

    // R10: the owner side is untouched.
    const ownerDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: r.ownerInvoiceIds[0] } });
    expect(ownerDoc.docType).toBe("invoice");
    expect(ownerDoc.documentNumber.startsWith("IVOWN-")).toBe(true);
  });

  it("flag OFF — byte-identical to before: an IVTEN- invoice and no proforma anywhere (R12)", async () => {
    const db = getDb();
    const cats = await seed();
    const t1 = await makeCharge(TENANT, cats.electricity_tenant, "100.00", TEN);

    const r = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [t1.id], USER));

    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: r.tenantInvoiceIds[0] } });
    expect(doc.docType).toBe("invoice");
    expect(doc.documentNumber.startsWith("IVTEN-")).toBe(true);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "proforma" } })).toBe(0);
  });

  it("re-issuing the same charges returns the SAME proforma, never a second one", async () => {
    // issueDocumentTx dedupes on (organizationId, idempotencyKey), and the key now carries
    // the EFFECTIVE docType. Without that, a proforma and an invoice for the same
    // tenant/unit/month would compute an identical key and alias onto each other.
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    const db = getDb();
    const cats = await seed();
    const t1 = await makeCharge(TENANT, cats.electricity_tenant, "100.00", TEN);

    const first = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [t1.id], USER));
    const second = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [t1.id], USER));

    expect(second.tenantInvoiceIds).toEqual(first.tenantInvoiceIds);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, docType: "proforma" } })).toBe(1);
  });

  it("a tenant DEBIT NOTE is never turned into a proforma", async () => {
    // Aircond and the four utility DNs route to the DEP series as docType "debit_note".
    // They are not re-billable requests for payment, so they keep their own identity —
    // this is the deliberate narrowing of the spec's looser "the tenant-family group".
    process.env.ENABLE_PROFORMA_INVOICES = "true";
    const db = getDb();
    await seed();
    const dnCat = await db.chargeCategory.findFirstOrThrow({
      where: { organizationId: ORG, code: "utility_tnb" }, // DEP series, docType debit_note
      select: { id: true },
    });
    const c = await makeCharge(TENANT, dnCat.id, "80.00", TEN);

    const r = await db.$transaction((tx) => issueGroupedGridInvoiceTx(tx, [c.id], USER));

    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: r.tenantInvoiceIds[0] } });
    expect(doc.docType).toBe("debit_note");
    expect(doc.documentNumber.startsWith("PI-")).toBe(false);
  });
});
