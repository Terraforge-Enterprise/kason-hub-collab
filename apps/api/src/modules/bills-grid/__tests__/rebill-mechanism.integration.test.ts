/**
 * Billing-mechanism rework — the re-Bill guard/confirmation/provenance rules.
 *
 * Covers the 11 required regression scenarios:
 *   1  current-month unbilled            → `invoiced` (no confirmation)
 *   2  current-month billed, no payment  → `rebill_confirmation_required` (with numbers)
 *   3  confirmed current-month re-Bill   → old voided (reason) + new itemized issued
 *   4  partial tenant payment            → `rebill_blocked_payment_exists`
 *   5  full tenant payment               → `rebill_blocked_payment_exists`
 *   6  previous-month invoice            → `rebill_blocked_previous_period`
 *   7  legacy sourceGridEntryId=null     → confirmation + re-Bill allowed (provenance)
 *   8  unrelated (meter) invoice         → `conflicting_invoice` (fail closed)
 *   9  retried confirmed re-Bill         → no duplicate invoices / notifications
 *   10 Billed tag                        → true for linked AND legacy null-linked invoices
 *   11 re-Billed invoice                 → preserves itemized (multi-line) rows
 *
 * Real local Postgres only. Periods are the org-local CURRENT / PREVIOUS month (computed
 * via currentBillingMonthUTC) so the previous-period guard is exercised deterministically.
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/rebill-mechanism.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, getGridService, currentBillingMonthUTC } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const TZ = "Asia/Kuala_Lumpur";
const CUR = currentBillingMonthUTC(TZ);
const CUR_STR = CUR.toISOString().slice(0, 10);
const PREV = new Date(Date.UTC(CUR.getUTCFullYear(), CUR.getUTCMonth() - 1, 1));
const PREV_STR = PREV.toISOString().slice(0, 10);
const ymOf = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const ORG = "b7900000-0000-4000-8000-000000000001";
const USER = "b7900000-0000-4000-8000-000000000002";
const PROP = "b7900000-0000-4000-8000-000000000003";
const APT = "b7900000-0000-4000-8000-000000000004";
const ROOM_A = "b7900000-0000-4000-8000-000000000005";
const ROOM_B = "b7900000-0000-4000-8000-000000000006";
const PARTY_A = "b7900000-0000-4000-8000-000000000007";
const PARTY_B = "b7900000-0000-4000-8000-000000000008";
const OWNER_PARTY = "b7900000-0000-4000-8000-000000000009";
const TEN_A = "b7900000-0000-4000-8000-00000000000a";
const TEN_B = "b7900000-0000-4000-8000-00000000000b";
const PAYMENT = "b7900000-0000-4000-8000-00000000000c";
const USER_A = "b7900000-0000-4000-8000-00000000000d";
const USER_OWNER = "b7900000-0000-4000-8000-00000000000e";
const USER_B = "b7900000-0000-4000-8000-00000000000f";

const session = { orgId: ORG, userId: USER, role: "manager" };

async function cleanup() {
  const db = getDb();
  await db.notification.deleteMany({ where: { organizationId: ORG } });
  await db.notificationQueue.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocationReversal.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.payment.deleteMany({ where: { organizationId: ORG } });
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

/** Partitioned apartment: 2 occupied rooms + owner. Absorbed TNB (owner-borne) + tenant
 *  wifi/recharged-water pools → a first Bill issues 2 IVTEN + 1 IVOWN, each tenant doc
 *  carrying 2 component lines (water + wifi). `period` is injectable. */
async function seed(period: Date, withUsers = false): Promise<{ token: string }> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "BG9", slug: "bg9m", status: "active", defaultCurrency: "MYR", timezone: TZ, locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "bg9m@example.test", fullName: "Op", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-B9M", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-B9M", listingMode: "PARTITIONED" } });
  await db.party.create({ data: { id: PARTY_A, organizationId: ORG, displayName: "Tenant A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: PARTY_B, organizationId: ORG, displayName: "Tenant B", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  if (withUsers) {
    await db.user.create({ data: { id: USER_A, organizationId: ORG, partyId: PARTY_A, email: "ta-b9m@example.test", fullName: "Tenant A", status: "active", role: "tenant", userType: "portal" } });
    await db.user.create({ data: { id: USER_B, organizationId: ORG, partyId: PARTY_B, email: "tb-b9m@example.test", fullName: "Tenant B", status: "active", role: "tenant", userType: "portal" } });
    await db.user.create({ data: { id: USER_OWNER, organizationId: ORG, partyId: OWNER_PARTY, email: "ow-b9m@example.test", fullName: "Owner", status: "active", role: "owner", userType: "portal" } });
  }
  await db.listing.create({ data: { id: ROOM_A, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.listing.create({ data: { id: ROOM_B, organizationId: ORG, apartmentId: APT, listingType: "middle_room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TEN_A, organizationId: ORG, propertyId: PROP, unitId: ROOM_A, tenantPartyId: PARTY_A, tenancyCode: "T-A", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  await db.tenancy.create({ data: { id: TEN_B, organizationId: ORG, propertyId: PROP, unitId: ROOM_B, tenantPartyId: PARTY_B, tenancyCode: "T-B", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "1000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: period, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "40.00", wifi: "120.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: period, listingId: ROOM_A, tenancyId: TEN_A, partyId: PARTY_A, amount: "0.00", createdBy: USER } });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: period, listingId: ROOM_B, tenancyId: TEN_B, partyId: PARTY_B, amount: "0.00", createdBy: USER } });
  return { token: entry.updatedAt.toISOString() };
}

async function token(period: Date): Promise<string> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: period } } });
  return e.updatedAt.toISOString();
}
async function amendWifi(period: Date, wifi: string): Promise<void> {
  const db = getDb();
  const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: period } } });
  await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { wifi } });
}
async function bill(period: Date, opts: { confirm?: boolean } = {}) {
  const t = await token(period);
  const r = await billService(session, { period: period.toISOString().slice(0, 10), rows: [{ apartmentId: APT, expectedUpdatedAt: t, confirmRebill: opts.confirm }] });
  if (!r.ok) throw new Error("billService not ok");
  return r.data.results[0];
}
async function firstBill(period: Date) {
  const first = await bill(period);
  expect(first.outcome).toBe("invoiced");
  return first;
}
const liveDocs = () => getDb().billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" }, select: { id: true, counterpartyType: true } });
const cancelledCount = () => getDb().billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "CANCELLED" } });

dn("bills-grid re-Bill mechanism (guards + confirmation + provenance)", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    await cleanup();
  });

  it("1: current-month unbilled → Bill succeeds without confirmation (invoiced)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    await seed(CUR);
    const r = await bill(CUR);
    expect(r.outcome).toBe("invoiced");
    expect(await liveDocs()).toHaveLength(3);
  });

  it("2: current-month billed, no payment, edited → confirmation required with invoice numbers, nothing mutated", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    const before = await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT }, select: { id: true, documentNumber: true, counterpartyType: true } });
    expect(before).toHaveLength(3);
    const ivten = before.find((d) => d.counterpartyType === "tenant")!.documentNumber;
    const ivown = before.find((d) => d.counterpartyType === "owner")!.documentNumber;

    await amendWifi(CUR, "240.00");
    const r = await bill(CUR); // NO confirm
    expect(r.outcome).toBe("rebill_confirmation_required");
    expect(r.existingTenantInvoiceNumber).toBe(ivten);
    expect(r.existingOwnerInvoiceNumber).toBe(ivown);
    // Nothing mutated: same 3 ISSUED docs, none cancelled, no new docs.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT } })).toBe(3);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } })).toBe(3);
    expect(await cancelledCount()).toBe(0);
  });

  it("3: confirmed current-month re-Bill → old tenant+owner voided (reason) and new itemized issued", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    const firstIds = new Set((await db.billingDocument.findMany({ where: { organizationId: ORG, apartmentId: APT }, select: { id: true } })).map((d) => d.id));

    await amendWifi(CUR, "240.00");
    const r = await bill(CUR, { confirm: true });
    expect(r.outcome).toBe("reinvoiced");
    expect(r.tenantInvoiceIds).toHaveLength(2);
    expect(r.ownerInvoiceIds).toHaveLength(1);

    // Old 3 preserved as CANCELLED with a void reason + superseded link (rule 5.3/5.4).
    const olds = await db.billingDocument.findMany({ where: { id: { in: [...firstIds] } }, select: { documentStatus: true, reason: true, supersededByDocumentId: true } });
    expect(olds).toHaveLength(3);
    for (const d of olds) {
      expect(d.documentStatus).toBe("CANCELLED");
      expect(d.reason ?? "").toMatch(/superseded/i);
      expect(d.supersededByDocumentId).toBeTruthy();
    }
    // Only the 3 fresh docs are live.
    const live = await liveDocs();
    expect(live).toHaveLength(3);
    for (const d of live) expect(firstIds.has(d.id)).toBe(false);
  });

  it("4: partial tenant payment → re-Bill denied (owner invoice untouched, no reversal)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    // Pay HALF of one live tenant charge.
    const line = (await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG, documentStatus: "ISSUED", counterpartyType: "tenant" } }, select: { chargeId: true } }))
      .map((l) => l.chargeId).filter((x): x is string => !!x)[0];
    const ch = await db.charge.findUniqueOrThrow({ where: { id: line }, select: { partyId: true, amount: true } });
    const half = (Number(ch.amount) / 2).toFixed(2);
    await db.payment.create({ data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-B9M-1", partyId: ch.partyId, paymentType: "receipt", paymentMethod: "cash", status: "posted", amount: half, currency: "MYR", receivedAt: new Date() } });
    await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId: line, allocatedAmount: half, allocatedAt: new Date() } });

    await amendWifi(CUR, "240.00");
    const r = await bill(CUR, { confirm: true });
    expect(r.outcome).toBe("rebill_blocked_payment_exists");
    expect(r.paidBlockers).toHaveLength(1);
    expect(r.paidBlockers?.[0]).toMatchObject({ counterparty: "tenant", paymentState: "partial" });
    expect(r.paidBlockers?.[0].paidAmount).toBeCloseTo(Number(half), 2);
    // Nothing voided/reversed; payment intact; owner invoice still live.
    expect(await cancelledCount()).toBe(0);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED", counterpartyType: "owner" } })).toBe(1);
    expect(await db.paymentAllocationReversal.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await db.paymentAllocation.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it("5: full tenant payment → re-Bill denied", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    const lines = (await db.billingDocumentLine.findMany({ where: { document: { organizationId: ORG, documentStatus: "ISSUED", counterpartyType: "tenant" } }, select: { chargeId: true } }))
      .map((l) => l.chargeId).filter((x): x is string => !!x);
    const chs = await db.charge.findMany({ where: { id: { in: lines } }, select: { id: true, partyId: true, amount: true } });
    const total = chs.reduce((s, c) => s + Number(c.amount), 0).toFixed(2);
    await db.payment.create({ data: { id: PAYMENT, organizationId: ORG, paymentNumber: "PY-B9M-2", partyId: chs[0].partyId, paymentType: "receipt", paymentMethod: "cash", status: "posted", amount: total, currency: "MYR", receivedAt: new Date() } });
    for (const c of chs) await db.paymentAllocation.create({ data: { organizationId: ORG, paymentId: PAYMENT, chargeId: c.id, allocatedAmount: c.amount, allocatedAt: new Date() } });

    await amendWifi(CUR, "240.00");
    const r = await bill(CUR, { confirm: true });
    expect(r.outcome).toBe("rebill_blocked_payment_exists");
    expect(r.paidBlockers?.length).toBeGreaterThanOrEqual(1);
    expect(r.paidBlockers?.some((b) => b.counterparty === "tenant" && b.paymentState === "paid")).toBe(true);
    expect(await cancelledCount()).toBe(0);
  });

  it("6: previous-month invoice → re-Bill denied (blocked previous period)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    await seed(PREV);
    await firstBill(PREV); // first issuance of a past month is allowed; RE-Bill is not
    await amendWifi(PREV, "240.00");
    const r = await bill(PREV, { confirm: true });
    expect(r.outcome).toBe("rebill_blocked_previous_period");
    expect(await cancelledCount()).toBe(0);
  });

  it("7: legacy sourceGridEntryId=null (same workflow/unit/month, no payment) → confirmation + re-Bill allowed", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    // Simulate the onDelete:SetNull orphaning + entry recreation: null the charges' link
    // and reset the entry's billed/invoiced stamps (so ONLY provenance can recognise them).
    await db.charge.updateMany({ where: { organizationId: ORG, sourceGridEntryId: { not: null } }, data: { sourceGridEntryId: null } });
    const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: CUR } } });
    await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { invoicedAt: null, billedAt: null } });

    await amendWifi(CUR, "240.00");
    const confirmNeeded = await bill(CUR); // NO confirm → detected by provenance
    expect(confirmNeeded.outcome).toBe("rebill_confirmation_required");
    expect(confirmNeeded.existingTenantInvoiceNumber).toBeTruthy();

    const r = await bill(CUR, { confirm: true });
    expect(r.outcome).toBe("reinvoiced");
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } })).toBe(3);
    expect(await cancelledCount()).toBe(3);
  });

  it("8: unrelated (meter-path) invoice for the same unit-month → conflicting_invoice (fail closed)", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    // A NON-grid utility charge (meter chargeNumber UTIL-, no grid provenance) + a live
    // invoice referencing it, for the SAME unit-month → must fail closed as a conflict.
    const series = await db.documentSeries.create({ data: { organizationId: ORG, code: `CONF-${ymOf(CUR)}`, prefix: "IVTEN" } });
    const conflictCharge = await db.charge.create({ data: { organizationId: ORG, chargeNumber: `UTIL-${ymOf(CUR)}-${ROOM_A}`, tenancyId: TEN_A, unitId: ROOM_A, partyId: PARTY_A, chargeType: "utility", status: "posted", amount: "99.00", currency: "MYR", outstandingAmount: "99.00", billingMonth: CUR, dueDate: CUR, attachmentKeys: [] } });
    const doc = await db.billingDocument.create({ data: { organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-CONF-1", seriesId: series.id, issuedById: USER, counterpartyType: "tenant", partyId: PARTY_A, apartmentId: APT, listingId: ROOM_A, billingMonth: CUR, subtotal: "99.00", total: "99.00", documentStatus: "ISSUED" } });
    await db.billingDocumentLine.create({ data: { documentId: doc.id, chargeId: conflictCharge.id, description: "Utility", amount: "99.00" } });

    const r = await bill(CUR);
    expect(r.outcome).toBe("conflicting_invoice");
    // Grid issued nothing.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED", counterpartyType: "owner" } })).toBe(0);
  });

  it("9: retried confirmed re-Bill → no duplicate invoices or notifications", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR, true);
    await firstBill(CUR);
    await db.notification.deleteMany({ where: { organizationId: ORG } });

    await amendWifi(CUR, "240.00");
    const r1 = await bill(CUR, { confirm: true });
    expect(r1.outcome).toBe("reinvoiced");
    const notifsAfter1 = await db.notification.count({ where: { organizationId: ORG, domain: "finance" } });
    expect(notifsAfter1).toBe(3);
    const liveAfter1 = await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } });
    expect(liveAfter1).toBe(3);

    // RETRY with the fresh token, same confirm — nothing changed since → already_billed no-op.
    const r2 = await bill(CUR, { confirm: true });
    expect(["already_billed", "stale"]).toContain(r2.outcome);
    expect(await db.billingDocument.count({ where: { organizationId: ORG, apartmentId: APT, documentStatus: "ISSUED" } })).toBe(3);
    expect(await db.notification.count({ where: { organizationId: ORG, domain: "finance" } })).toBe(3); // no new notification
  });

  it("10: Billed tag is true for BOTH normally-linked and legacy null-linked invoices", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);

    const linked = await getGridService({ orgId: ORG }, { period: CUR_STR, months: 1 });
    if (!linked.ok) throw new Error("read not ok");
    expect(linked.data.rows.find((r) => r.apartmentId === APT)?.billed).toBe(true);

    // Orphan the link — Billed must still be derived from provenance, not invoicedAt.
    await db.charge.updateMany({ where: { organizationId: ORG, sourceGridEntryId: { not: null } }, data: { sourceGridEntryId: null } });
    const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: CUR } } });
    await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { invoicedAt: null, billedAt: null } });

    const legacy = await getGridService({ orgId: ORG }, { period: CUR_STR, months: 1 });
    if (!legacy.ok) throw new Error("read not ok");
    expect(legacy.data.rows.find((r) => r.apartmentId === APT)?.billed).toBe(true);
  });

  it("11: re-Billed invoice preserves itemized (multi-line) rows, not a merged lump", async () => {
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    await amendWifi(CUR, "240.00");
    const r = await bill(CUR, { confirm: true });
    expect(r.outcome).toBe("reinvoiced");
    // Each fresh tenant doc keeps a line per non-zero utility component (water + wifi) — 2 lines.
    for (const id of r.tenantInvoiceIds ?? []) {
      const lines = await db.billingDocumentLine.count({ where: { documentId: id } });
      expect(lines).toBeGreaterThanOrEqual(2);
    }
  });

  it("12: changing a bearer on a LEGACY billed unit (null-category charges) does NOT false-positive occupancy_changed", async () => {
    // Regression for the reported bug: a legacy lump OWNER charge carries no per-utility
    // category (family null) — the occupancy guard used to misread it as a TENANT charge
    // and compare its OWNER partyId against the fresh TENANT party → false
    // `occupancy_changed` whenever the admin changed a bearer + re-Billed. The owner charge
    // must be classified by its `GRIDOWN-` provenance instead.
    process.env.ENABLE_PHASE2_BILLING_DOCS = "true";
    const db = getDb();
    await seed(CUR);
    await firstBill(CUR);
    // Reproduce the real A-08-03 state: orphan the entry link AND drop the category
    // (old lump charges have categoryId null → family null).
    await db.charge.updateMany({ where: { organizationId: ORG, sourceGridEntryId: { not: null } }, data: { sourceGridEntryId: null, categoryId: null } });
    const e = await db.unitBillsGridEntry.findUniqueOrThrow({ where: { organizationId_apartmentId_periodMonth: { organizationId: ORG, apartmentId: APT, periodMonth: CUR } } });
    // Change a bearer (owner-borne TNB → tenant-recharged) + reset the billed stamps.
    await db.unitBillsGridEntry.update({ where: { id: e.id }, data: { invoicedAt: null, billedAt: null, tnbPattern: "recharged" } });

    const r1 = await bill(CUR); // NO confirm
    expect(r1.outcome).not.toBe("occupancy_changed"); // the bug returned this
    expect(r1.outcome).toBe("rebill_confirmation_required");
    const r2 = await bill(CUR, { confirm: true });
    expect(r2.outcome).toBe("reinvoiced");
  });
});
