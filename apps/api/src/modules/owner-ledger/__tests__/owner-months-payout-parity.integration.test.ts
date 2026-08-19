/**
 * I-2 — the /months card's netPayoutToOwner MUST equal the statement's
 * "Total Payout to Owner" for the same month, INCLUDING pre-statement months.
 *
 * Both numbers now flow through the shared computeOwnerPayout helper, so the card
 * reflects the per-line management fee (COMPUTED, not read from ledger rows) AND the
 * deposit collected — exactly like assembleYannieStatement. A pre-statement card that
 * omitted the fee would OVERSTATE the payout and an admin acting on it would overpay.
 *
 * Real LOCAL Postgres; opt-in via RUN_INTEGRATION=1. Disjoint fixed UUIDs (1a..).
 */
import { describe, it, expect, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { syncMonthService } from "../owner-ledger.sync";
import { getOwnerMonthsService } from "../owner-ledger.service";
import { assembleYannieStatement } from "../../owner-billing/owner-statement-sections";
import type { OwnerLedgerActorCtx } from "../owner-ledger.types";
import type { OwnerBillingActorCtx } from "../../owner-billing/owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const ORG = "1a000000-0000-4000-8000-0000000000a1";
const USER = "1a000000-0000-4000-8000-0000000000a2";
const PARTY = "1a000000-0000-4000-8000-0000000000a3";
const OWNER = "1a000000-0000-4000-8000-0000000000a4";
const TENANT = "1a000000-0000-4000-8000-0000000000a5";
const PROPERTY = "1a000000-0000-4000-8000-0000000000a6";
const MASTER = "1a000000-0000-4000-8000-0000000000b1";
const STUDIO = "1a000000-0000-4000-8000-0000000000b2";
const MEDIUM = "1a000000-0000-4000-8000-0000000000b3";
const PARTITION = "1a000000-0000-4000-8000-0000000000b4";
const CARPARK = "1a000000-0000-4000-8000-0000000000b5";

const MONTH = "2026-06";
const MONTH_START = new Date(Date.UTC(2026, 5, 1));
const MID_MONTH = new Date(Date.UTC(2026, 5, 15));

const ledgerCtx: OwnerLedgerActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin", ip: "127.0.0.1", userAgent: "vitest" };
const billingCtx: OwnerBillingActorCtx = { orgId: ORG, actorUserId: USER, actorRole: "admin" };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.ownerLedgerEntry.deleteMany({ where: org });
  await db.deposit.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.invoice.deleteMany({ where: org });
  await db.unitUtilityBill.deleteMany({ where: org });
  await db.managementFeeConfig.deleteMany({ where: org });
  await db.tenancy.deleteMany({ where: org });
  await db.listing.deleteMany({ where: org });
  await db.apartment.deleteMany({ where: org });
  await db.property.deleteMany({ where: org });
  await db.auditLog.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

type LineSpec = { id: string; rent: string; aircond?: string; deposit?: string };

const LINES: LineSpec[] = [
  { id: MASTER, rent: "1000.00" },
  { id: STUDIO, rent: "522.67", aircond: "8.46", deposit: "1960.00" },
  { id: MEDIUM, rent: "800.00" },
  { id: PARTITION, rent: "750.00" },
  { id: CARPARK, rent: "120.00", deposit: "120.00" },
];

/** Seed the Yannie A-19-02 fixture. `withStatement` adds the owner_statement Invoice + a maintenance charge. */
async function seed(withStatement: boolean) {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "Parity Org", slug: "parity-org", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.party.create({ data: { id: PARTY, organizationId: ORG, displayName: "Parity Operator", partyType: "individual", status: "active" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "parity-op@example.com", fullName: "Parity Operator", status: "active", role: "admin", userType: "operator", partyId: PARTY } });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Parity Owner", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Parity Tenant", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "Parity Residences", propertyCode: "PR9", propertyType: "apartment", addressLine1: "1 PR9 St", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });

  let n = 0;
  for (const line of LINES) {
    n += 1;
    const aptId = `1a000000-0000-4000-8000-0000000000d${n}`;
    await db.apartment.create({ data: { id: aptId, organizationId: ORG, propertyId: PROPERTY, unitCode: `A-19-0${n}`, listingMode: "PARTITIONED" } });
    await db.listing.create({ data: { id: line.id, organizationId: ORG, apartmentId: aptId, listingType: "room", occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
    const tenancyId = `1a000000-0000-4000-8000-0000000000c${n}`;
    await db.tenancy.create({ data: { id: tenancyId, organizationId: ORG, propertyId: PROPERTY, unitId: line.id, tenantPartyId: TENANT, tenancyCode: `PR-T${n}`, status: "active", billingStatus: "current", startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: line.rent } });
    await db.charge.create({ data: { organizationId: ORG, chargeNumber: `PR-RENT-${n}`, tenancyId, unitId: line.id, partyId: TENANT, chargeType: "rent", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: line.rent, currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START } });
    if (line.aircond) {
      await db.charge.create({ data: { organizationId: ORG, chargeNumber: `PR-AIRCOND-${n}`, tenancyId, unitId: line.id, partyId: TENANT, chargeType: "aircond", status: "paid", dueDate: new Date(Date.UTC(2026, 5, 5)), amount: line.aircond, currency: "MYR", outstandingAmount: "0.00", billingMonth: MONTH_START } });
    }
    if (line.deposit) {
      await db.deposit.create({ data: { organizationId: ORG, tenancyId, partyId: TENANT, unitId: line.id, type: "security", amount: line.deposit, status: "held", createdAt: MID_MONTH } });
    }
  }

  // UnitUtilityBill — CHARGED full supplier bills on the first apartment.
  await db.unitUtilityBill.create({ data: { organizationId: ORG, apartmentId: "1a000000-0000-4000-8000-0000000000d1", periodMonth: MONTH_START, billingMode: "subsidy", tnbTotal: "188.70", airSelangor: "35.74", indahWater: "0.00", cleaning: "0.00", wifi: "200.00", ownerBorneUtilitiesTotal: "180.24", status: "charged", createdBy: USER } });

  // ManagementFeeConfig — 10% + 8% SST (applies to rental/carpark income lines).
  await db.managementFeeConfig.create({ data: { organizationId: ORG, ownerPartyId: OWNER, propertyId: null, feeType: "percent", feeValue: "10.00", capAmount: null, sstPercent: "8.00", isActive: true } });

  if (withStatement) {
    const invoice = await db.invoice.create({ data: { organizationId: ORG, invoiceNumber: "PR-OS-2026-06", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "350.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}` } });
    await db.charge.create({ data: { organizationId: ORG, chargeNumber: "PR-MAINT", unitId: MASTER, partyId: OWNER, chargeType: "maintenance", status: "posted", dueDate: MONTH_START, amount: "350.00", currency: "MYR", outstandingAmount: "350.00", invoiceId: invoice.id, billingMonth: MONTH_START } });
    return invoice.id;
  }
  return null;
}

/** Pull the "Total Payout to Owner" 2dp string off an assembled statement. */
function totalPayoutOf(s: NonNullable<Awaited<ReturnType<typeof assembleYannieStatement>>>): string {
  return s.payoutSummary.lines.find((l) => l.label === "Total Payout to Owner")!.amount;
}

dn("getOwnerMonthsService — card net payout == statement Total Payout (I-2)", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("PRE-STATEMENT month: card netPayoutToOwner === assembleYannieStatement Total Payout (mgmt fee + deposit)", async () => {
    await cleanup();
    await seed(false); // no owner_statement Invoice yet

    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    // Read the card while the month is genuinely PRE-STATEMENT.
    const months = await getOwnerMonthsService(ledgerCtx, OWNER);
    expect(months.ok).toBe(true);
    if (!months.ok) return;
    const card = months.data.items.find((m) => m.month === MONTH)!;
    expect(card).toBeDefined();
    expect(card.statementId).toBeNull(); // proves pre-statement
    // The card folds in the deposit (2,080) — not the raw summarizeOwnerPeriod payout.
    expect(card.depositCollected).toBe("2080.00");

    // Materialise a BARE owner_statement anchor (NO child charges → no Source-2 rows)
    // so assembleYannieStatement can assemble the SAME ledger rows the card read.
    const db = getDb();
    const anchor = await db.invoice.create({ data: { organizationId: ORG, invoiceNumber: "PR-OS-ANCHOR", partyId: OWNER, ownerPartyId: OWNER, propertyId: PROPERTY, invoiceType: "owner_statement", status: "draft", invoiceDate: MONTH_START, periodMonth: MONTH_START, totalAmount: "0.00", sstAmount: "0.00", currency: "MYR", idempotencyKey: `owner:${OWNER}:${MONTH}` } });

    const s = await assembleYannieStatement(billingCtx, anchor.id);
    expect(s).not.toBeNull();

    // THE parity: card net payout === statement Total Payout, both fee+deposit aware.
    expect(card.netPayoutToOwner).toBe(totalPayoutOf(s!));
  });

  it("WITH-STATEMENT month: card netPayoutToOwner === statement Total Payout (the A-19-02 4,161.88 footing)", async () => {
    await cleanup();
    const invoiceId = await seed(true); // full Yannie statement (with maintenance)
    expect(invoiceId).not.toBeNull();

    const sync = await syncMonthService(ledgerCtx, { ownerPartyId: OWNER, month: MONTH });
    expect(sync.ok).toBe(true);

    const months = await getOwnerMonthsService(ledgerCtx, OWNER);
    expect(months.ok).toBe(true);
    if (!months.ok) return;
    const card = months.data.items.find((m) => m.month === MONTH)!;
    expect(card.statementId).toBe(invoiceId);

    const s = await assembleYannieStatement(billingCtx, invoiceId!);
    expect(s).not.toBeNull();

    expect(totalPayoutOf(s!)).toBe("4161.88"); // the canonical footing
    expect(card.netPayoutToOwner).toBe("4161.88");
    expect(card.netPayoutToOwner).toBe(totalPayoutOf(s!));
  });
});
