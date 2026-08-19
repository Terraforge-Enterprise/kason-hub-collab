/**
 * charge-nature-routing (PASS-THROUGH utilities → Expense Bill): the scalar utility mint
 * must carry `nature` for the PASS-THROUGH utilities too — electricity (TNB), water (Air
 * Selangor), sewerage (Indah Water) — not just WiFi/Cleaning.
 *
 * A tenant-recovered pass-through utility line is COST RECOVERY (the tenant reimburses the
 * landlord's provider bill), never KAEN service revenue. The user confirmed these are ALWAYS
 * passed through AT COST (no markup). So when ENABLE_CHARGE_NATURE_ROUTING is ON, every
 * tenant-borne pass-through GRIDUTIL- charge whose classification is a RECOVERY
 * (recovery_of_advance | owner_funds — i.e. NOT manager_revenue) must be stamped
 * nature:"expense" and routed onto its OWN Expense Bill (EB-) document, OFF the tenant's
 * IVTEN. The ALREADY-BUILT downstream routing (issue-grouped tenant→EB) then fires.
 *
 * This suite drives the full billService → mint → issueGroupedGridInvoiceTx path with a
 * tenant-borne electricity (manager_advanced ⇒ recovery_of_advance — KAEN fronted TNB and
 * recovers from the tenant pool) AND a tenant-borne water (recharged ⇒ owner_funds — the
 * owner's Air Selangor bill recovered from the tenant pool). BOTH recovery classifications
 * are exercised, and BOTH must land on EB, never IVTEN.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/bills-grid/__tests__/passthrough-utility-eb.integration.test.ts
 *
 * Rows:
 *  a. tenant electricity (manager_advanced) + water (recharged), flags ON → both GRIDUTIL-
 *     charges carry nature:"expense" and land on an EB- document, NEVER on IVTEN.
 *  c. ENABLE_CHARGE_NATURE_ROUTING OFF (EB flag still on) → both charges nature null, both on
 *     IVTEN, NO EB document minted (byte-identical to pre-feature).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { billService, currentBillingMonthUTC } from "../service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

const ORG = "f7c00000-0000-4000-8000-000000000001";
const USER = "f7c00000-0000-4000-8000-000000000002";
const PROP = "f7c00000-0000-4000-8000-000000000003";
const APT = "f7c00000-0000-4000-8000-000000000004";
const ROOM = "f7c00000-0000-4000-8000-000000000005";
const OWNER_PARTY = "f7c00000-0000-4000-8000-000000000006";
const TENANT_PARTY = "f7c00000-0000-4000-8000-000000000007";
const TENANCY = "f7c00000-0000-4000-8000-000000000008";

const session = { orgId: ORG, userId: USER, role: "manager" };
const PERIOD = currentBillingMonthUTC("Asia/Kuala_Lumpur");
const PERIOD_STR = PERIOD.toISOString().slice(0, 10);

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.paymentAllocation.deleteMany({ where: { organizationId: ORG } });
  await db.chargeEvent.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
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

/**
 * Whole unit, active tenancy, owner assigned. Electricity manager_advanced (KAEN fronted TNB
 * → the FULL raw flows into the tenant pool, recovery_of_advance) + water recharged (the
 * owner's Air Selangor bill recovered from the tenant pool, owner_funds). No aircond reading
 * (amount 0) so leftoverTnb = the full tnbTotalRaw. Both patterns leave ownerBorne = 0, so
 * there is no owner side — the whole bill is the tenant's pass-through recovery.
 */
async function seedWholeUnit(): Promise<string> {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "PTU", slug: "ptu", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "ptu@example.test", fullName: "PTU", status: "active", role: "manager", userType: "operator" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-PTU", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.party.create({ data: { id: OWNER_PARTY, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT_PARTY, organizationId: ORG, displayName: "Tenant", partyType: "individual", status: "active" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-PTU", listingMode: "WHOLE" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "whole_unit", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER_PARTY } });
  await db.tenancy.create({ data: { id: TENANCY, organizationId: ORG, propertyId: PROP, unitId: ROOM, tenantPartyId: TENANT_PARTY, tenancyCode: "T-PTU", status: "active", billingStatus: "current", startDate: new Date("2026-01-01"), monthlyRentAmount: "2000.00", numberOfPax: 1 } });
  const entry = await db.unitBillsGridEntry.create({
    data: {
      organizationId: ORG, apartmentId: APT, periodMonth: PERIOD, createdBy: USER,
      tnbTotalRaw: "300.00", airSelangorRaw: "120.00", wifi: "0.00", cleaning: "0.00",
      tnbPattern: "manager_advanced", airPattern: "recharged", cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
    },
  });
  await db.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry.id, apartmentId: APT, periodMonth: PERIOD, listingId: ROOM, tenancyId: null, partyId: null, amount: "0.00", createdBy: USER } });
  return entry.id;
}

async function freshToken(entryId: string): Promise<string> {
  const e = await getDb().unitBillsGridEntry.findUniqueOrThrow({ where: { id: entryId } });
  return e.updatedAt.toISOString();
}

dn("bills-grid — pass-through utilities (electricity/water) route to EB (nature routing)", () => {
  beforeEach(async () => { await cleanup(); process.env.ENABLE_PHASE2_BILLING_DOCS = "true"; });
  afterEach(async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING;
    delete process.env.ENABLE_EXPENSE_BILL;
    await cleanup();
  });

  it("row a — tenant electricity (manager_advanced) + water (recharged), flags ON → both GRIDUTIL- land on EB-, NOT IVTEN", async () => {
    process.env.ENABLE_CHARGE_NATURE_ROUTING = "true";
    process.env.ENABLE_EXPENSE_BILL = "true";
    const db = getDb();
    const entryId = await seedWholeUnit();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    // Electricity: pass-through, manager_advanced → recovery_of_advance → nature "expense".
    const elec = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-ELECTRICITY" } } });
    expect(elec.nature).toBe("expense");
    expect(elec.chargeType).toBe("utility");
    expect(elec.sourceGridExpenseId).toBeNull();
    expect(elec.partyId).toBe(TENANT_PARTY);

    const elecDl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: elec.id } });
    const elecDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: elecDl.documentId } });
    expect(elecDoc.documentNumber.startsWith("EB-")).toBe(true);
    expect(elecDoc.counterpartyType).toBe("tenant");
    expect(await db.billingDocumentLine.findFirst({ where: { chargeId: elec.id, document: { documentNumber: { startsWith: "IVTEN-" } } } })).toBeNull();

    // Water: pass-through, recharged → owner_funds → nature "expense".
    const water = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-WATER" } } });
    expect(water.nature).toBe("expense");
    expect(water.chargeType).toBe("utility");

    const waterDl = await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: water.id } });
    const waterDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: waterDl.documentId } });
    expect(waterDoc.documentNumber.startsWith("EB-")).toBe(true);
    expect(await db.billingDocumentLine.findFirst({ where: { chargeId: water.id, document: { documentNumber: { startsWith: "IVTEN-" } } } })).toBeNull();

    // NO IVTEN document exists at all for this org (every tenant line was a pass-through recovery).
    expect(await db.billingDocument.count({ where: { organizationId: ORG, documentNumber: { startsWith: "IVTEN-" } } })).toBe(0);
  });

  it("row c — ENABLE_CHARGE_NATURE_ROUTING OFF → electricity/water on IVTEN, nature null, no EB (byte-identical)", async () => {
    delete process.env.ENABLE_CHARGE_NATURE_ROUTING; // routing OFF
    process.env.ENABLE_EXPENSE_BILL = "true";        // destination available but inert without routing
    const db = getDb();
    const entryId = await seedWholeUnit();

    const r = await billService(session, { period: PERIOD_STR, rows: [{ apartmentId: APT, expectedUpdatedAt: await freshToken(entryId) }] });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.data.results[0].outcome).toBe("invoiced");

    const elec = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-ELECTRICITY" } } });
    expect(elec.nature).toBeNull(); // routing OFF never stamps nature on the scalar pass-through charge
    const elecDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: (await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: elec.id } })).documentId } });
    expect(elecDoc.documentNumber.startsWith("IVTEN-")).toBe(true);

    const water = await db.charge.findFirstOrThrow({ where: { organizationId: ORG, chargeNumber: { contains: "-WATER" } } });
    expect(water.nature).toBeNull();
    const waterDoc = await db.billingDocument.findUniqueOrThrow({ where: { id: (await db.billingDocumentLine.findFirstOrThrow({ where: { chargeId: water.id } })).documentId } });
    expect(waterDoc.documentNumber.startsWith("IVTEN-")).toBe(true);

    // Nature routing fully inert — NO EB document minted for this org.
    expect(await db.billingDocument.count({ where: { organizationId: ORG, documentNumber: { startsWith: "EB-" } } })).toBe(0);
  });
});
