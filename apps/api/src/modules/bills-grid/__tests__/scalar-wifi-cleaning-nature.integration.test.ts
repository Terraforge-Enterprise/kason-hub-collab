/**
 * Fix 2 (charge-nature-expense-profit-routing): the SCALAR WiFi/Cleaning path must
 * carry `nature` end-to-end. Built-in WiFi/Cleaning are the feature's motivating case
 * yet — unlike CUSTOM recurring lines (GridEntryRecurringLine, which already carries
 * `nature`) — they persist as scalar `entry.wifi`/`entry.cleaning` + `wifiBearer`/
 * `cleaningBearer` on UnitBillsGridEntry, a model with (before this fix) NO nature
 * column. So a WiFi/Cleaning definition set to "Expense" showed in the UI but the minted
 * scalar charge carried `nature:null` and still booked as KAEN revenue (IVTEN/IVOWN)
 * with no deduction.
 *
 * This suite proves the scalar charge now CARRIES the definition's nature, sourced
 * through the recurring-apply service's writeSnapshot (kind WIFI/CLEANING → the scalar
 * column + the new *Nature column), so the ALREADY-BUILT downstream routing (Task 5
 * issue-grouped tenant→EB / owner-exclude + fail-close; Task 6 owner-ledger Source 6
 * deduction) fires for built-in WiFi/Cleaning too.
 *
 * Seeded via applyRecurringService with kind:"WIFI"/"CLEANING" (NOT "CUSTOM") so it
 * exercises the SCALAR path — the exact surface Fix 2 changes.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/scalar-wifi-cleaning-nature.integration.test.ts
 *
 * Rows:
 *  a. scalar WiFi def (tenant) nature:"expense", flags ON → GRIDUTIL-WIFI lands on an
 *     EB- document, NEVER on IVTEN.
 *  b. scalar Cleaning def (owner) nature:"expense", flags ON, billed + ledger-synced →
 *     an IVOWN LINE bills it to the owner, and NO owner-ledger deduction is booked.
 *     (Reversed 2026-08-16 with the removal of ENABLE_OWNER_BORNE_DEDUCT — nature no
 *     longer diverts an owner charge off the invoice; the netting is the offset at
 *     collection instead.)
 *  c. ENABLE_CHARGE_NATURE_ROUTING OFF → WiFi on IVTEN / Cleaning on IVOWN, both charges
 *     nature null, NO EB doc, NO owner-borne-expense deduction (byte-identical).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";
import { applyRecurringService } from "../recurring.service";
import { syncMonthService } from "../../owner-ledger/owner-ledger.sync";
import type { OwnerLedgerActorCtx } from "../../owner-ledger/owner-ledger.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "d5c00000-0000-4000-8000-000000000001";
const USER = "d5c00000-0000-4000-8000-000000000002";
const PROP = "d5c00000-0000-4000-8000-000000000003";
const APT = "d5c00000-0000-4000-8000-000000000004";
const ROOM = "d5c00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "d5c00000-0000-4000-8000-000000000006";
const TENANT_PARTY = "d5c00000-0000-4000-8000-000000000007";
const TENANCY = "d5c00000-0000-4000-8000-000000000008";

const session = { orgId: ORG, userId: USER, role: "manager" };
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);
const MONTH = PERIOD.toISOString().slice(0, 7);

const ctx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest" };

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.gridEntryRecurringLine.deleteMany({ where: { organizationId: ORG } });
  await db.recurringChargeRevision.deleteMany({ where: { definition: { organizationId: ORG } } });
  await db.recurringChargeDefinition.deleteMany({ where: { organizationId: ORG } });
  await db.gridMeterReading.deleteMany({ where: { organizationId: ORG } });
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

/** Whole unit with an active tenancy + owner. tnb absorbed (owner-borne electricity, so
 * there is a real IVOWN in row b) + wifi/cleaning seeded 0 (the apply service overwrites
 * the relevant scalar). wifiBearer tenant / cleaningBearer owner mirror the two rows. */
async function seedWholeUnit(): Promise<string> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "SWC", slug: "swc", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "swc@example.test", fullName: "SWC", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-SWC", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-SWC", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-SWC", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "0.00", wifi: "0.00", cleaning: "0.00",
      tnbPattern: "absorbed", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "tenant", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  return entry.id;
}

/** Apply a built-in WIFI/CLEANING recurring definition (scalar path) carrying `nature`. */
async function applyScalar(kind: "WIFI" | "CLEANING", bearer: "owner" | "tenant", amount: string, nature: "expense" | "profit") {
  const out = await applyRecurringService(session, APT, {
    kind, name: kind === "WIFI" ? "WiFi" : "Cleaning", amount, bearer,
    effectiveFromMonth: PERIOD_STR, enabled: true, confirm: true, nature,
  });
  if (!out.ok) throw new Error(`applyRecurringService(${kind}) failed: ${JSON.stringify(out)}`);
}

/** The entry's current updatedAt token — the apply service bumps it, so read fresh before Bill. */
async function freshToken(entryId: string): Promise<string> {
  const e = await getDb().unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
  return e.updatedAt.toISOString();
}

dn("bills-grid — scalar WiFi/Cleaning carry nature end-to-end (Fix 2)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  it("row a — scalar WiFi def (tenant, nature:'expense'), flags ON → GRIDUTIL-WIFI lands on EB-, NOT IVTEN", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const entryId = await seedWholeUnit();
    await applyScalar("WIFI", "tenant", "120.00", "expense");

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    // The scalar WiFi charge is chargeType "utility" (NOT a grid-expense charge) and now
    // carries nature "expense" — so its EB routing is driven PURELY by nature.
    const wifi = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-WIFI" } } });
    expect(wifi.nature).toBe("expense");
    expect(wifi.chargeType).toBe("utility");
    expect(wifi.sourceGridExpenseId).toBeNull();

    const dl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: wifi.id } });
    const doc = await db.billingDocument.findUniqueOrThrow({ where: { id: dl.documentId } });
    expect(doc.documentNumber.startsWith("EB-")).toBe(true);
    expect(doc.counterpartyType).toBe("tenant");

    const ivtenLine = await db.billingDocumentLine.findFirst({ where: { chargeId: wifi.id, document: { documentNumber: { startsWith: "IVTEN-" } } } });
    expect(ivtenLine).toBeNull();
  });

  it("row b — scalar Cleaning def (owner, nature:'expense'), flags ON, billed + synced → an IVOWN LINE, and NO ledger deduction", async () => {
    // OUTCOME CHANGED 2026-08-16. This used to assert the opposite on both counts: the
    // charge was kept OFF the IVOWN and booked as an owner-ledger Source-6 deduction
    // (ENABLE_OWNER_BORNE_DEDUCT). The owner must SEE the cost on an invoice; the netting
    // happens at collection instead, on the offset rail.
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const entryId = await seedWholeUnit();
    await applyScalar("CLEANING", "owner", "80.00", "expense");

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const cleaning = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-CLEANING" } } });
    expect(cleaning.nature).toBe("expense"); // nature is still stamped — it just no longer diverts an owner charge
    expect(cleaning.partyId).toBe(OWNER_PARTY);

    // MONEY: it IS billed to the owner. Without this line the owner is never invoiced
    // and the auto-offset hook has nothing to net against the payout.
    const ivownLine = await db.billingDocumentLine.findFirst({ where: { chargeId: cleaning.id, document: { documentNumber: { startsWith: "IVOWN-" } } } });
    expect(ivownLine).not.toBeNull();
    expect(Number(ivownLine!.amount.toString())).toBe(80);

    // …and it is NOT ALSO a ledger deduction. Both at once would double-charge the owner.
    const sync = await syncMonthService(ctx, { ownerPartyId: OWNER_PARTY, month: MONTH });
    expect(sync.ok).toBe(true); if (!sync.ok) return;
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, sourceType: "owner_borne_expense" } })).toBe(0);
  });

  it("row c — ENABLE_CHARGE_NATURE_ROUTING OFF → WiFi on IVTEN / Cleaning on IVOWN, both nature null, no EB, no deduction (byte-identical)", async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // routing OFF
    process.env.ENABLE_EXPENSE_BILL = "true";        // destinations available but inert without routing
    const db = getDb();
    const entryId = await seedWholeUnit();
    await applyScalar("WIFI", "tenant", "120.00", "expense");
    await applyScalar("CLEANING", "owner", "80.00", "expense");

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const wifi = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-WIFI" } } });
    expect(wifi.nature).toBeNull(); // routing OFF never stamps nature on the scalar charge
    const wifiDl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: wifi.id } });
    const wifiDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: wifiDl.documentId } });
    expect(wifiDoc.documentNumber.startsWith("IVTEN-")).toBe(true);

    const cleaning = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-CLEANING" } } });
    expect(cleaning.nature).toBeNull();
    const cleaningDl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: cleaning.id } });
    const cleaningDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: cleaningDl.documentId } });
    expect(cleaningDoc.documentNumber.startsWith("IVOWN-")).toBe(true);

    // Nature routing fully inert — no EB doc, and the ledger sync books no owner-borne deduction.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, documentNumber: { startsWith: "EB-" } } })).toBe(0);
    const sync = await syncMonthService(ctx, { ownerPartyId: OWNER_PARTY, month: MONTH });
    expect(sync.ok).toBe(true); if (!sync.ok) return;
    expect(await db.ownerLedgerEntry.count({ where: { organizationId: ORG, sourceType: "owner_borne_expense" } })).toBe(0);
  });
});
