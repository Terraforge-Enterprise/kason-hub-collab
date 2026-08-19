/**
 * Dashboard Billing Activity — CN/DN awareness (integration, RUN_INTEGRATION=1).
 *
 * The reported bug (2026-08-07): a tenant with a RM 30 credit note on a RM 400
 * charge saw the correct adjusted Balance headline (Σ outstandingAmount), but
 * the Home feed's rows still read the raw `amount` and never mentioned the
 * notes — details that visibly disagreed with the total above them. The
 * charges list/detail gained adjustment awareness in punch list B (2026-08-06);
 * this pins the dashboard preview to the same contract:
 *
 *   upcomingCharges[i] carries amount + debitNoteTotal + creditNoteTotal +
 *   adjustedAmount + outstandingAmount, and Σ outstanding == balance.netBalance.
 *
 * Real local Postgres only.
 *
 * Run: from apps/api
 *   set -a; . ../../.env; set +a; RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/portal/__tests__/dashboard-cn-dn-adjusted.integration.test.ts
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { getDashboardData } from "../dashboard/portal.dashboard.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing non-local DB host: ${host}`);
}

// Dedicated fixture namespace (d0a5) — cleanup is org-scoped and total.
const ORG = "d0a50000-0000-4000-8000-000000000001";
const USER = "d0a50000-0000-4000-8000-000000000002";
const TENANT = "d0a50000-0000-4000-8000-000000000003";
const SERIES = "d0a50000-0000-4000-8000-000000000004";
const CH_CN = "d0a50000-0000-4000-8000-000000000005";
const CH_DN = "d0a50000-0000-4000-8000-000000000006";
const CN = "d0a50000-0000-4000-8000-000000000007";
const DN = "d0a50000-0000-4000-8000-000000000008";
/** The invoice both notes adjust — every real note carries an originalDocumentId,
 *  and adjustmentSumsByChargeId now requires it (a pay_back_landlord PRIMARY bill
 *  is itself a debit_note, so docType alone cannot mean "correction"). */
const ORIG_DOC = "d0a50000-0000-4000-8000-000000000009";
/** D5-ELEC's own primary bill, in `debit_note` form — must net to nothing. */
const PRIMARY_BILL = "d0a50000-0000-4000-8000-00000000000a";

const scope = { partyId: TENANT, orgId: ORG };

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

/**
 * One tenant, two posted charges, one active note each:
 *   D5-ELEC  RM 400, CN −30 → adjusted 370, outstanding 370
 *   D5-REC   RM 150, DN +30 → adjusted 180, outstanding 180
 * outstandingAmount is seeded post-adjustment, exactly as the adjustment
 * service leaves it; the CN carries creditAmount 0.00 (fully netted against
 * outstanding at mint — nothing spendable), matching the unpaid-charge case.
 */
async function seed() {
  const db = getDb();
  await db.organization.create({ data: { id: ORG, name: "D5", slug: "d5", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" } });
  await db.user.create({ data: { id: USER, organizationId: ORG, email: "d5@example.test", fullName: "D5 Operator", status: "active", role: "manager", userType: "operator" } });
  await db.party.create({ data: { id: TENANT, organizationId: ORG, displayName: "Adjusted Tenant", partyType: "individual", status: "active" } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "CN", prefix: "CN", padding: 4, includeYear: false, active: true } });

  const base = { organizationId: ORG, partyId: TENANT, currency: "MYR", dueDate: new Date("2026-08-15T00:00:00.000Z") };
  await db.charge.create({ data: { ...base, id: CH_CN, chargeNumber: "D5-ELEC", chargeType: "utility", status: "posted", amount: "400.00", outstandingAmount: "370.00", description: "Electricity" } });
  await db.charge.create({ data: { ...base, id: CH_DN, chargeNumber: "D5-REC", chargeType: "recurring", status: "posted", amount: "150.00", outstandingAmount: "180.00", description: "Recurring fee" } });

  // The primary bill the two notes correct. originalDocumentId null — that is what
  // makes it a bill; the notes below point AT it.
  await db.billingDocument.create({
    data: {
      id: ORIG_DOC, organizationId: ORG, docType: "invoice", documentNumber: "IVTEN-D5-1",
      seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, subtotal: "550.00", sstAmount: 0, total: "550.00",
    },
  });

  // documentStatus defaults to "ISSUED" — the one status adjustmentSumsByChargeId counts.
  await db.billingDocument.create({
    data: {
      id: CN, organizationId: ORG, docType: "credit_note", documentNumber: "CN-D5-1",
      seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, creditAmount: "0.00", subtotal: "30.00", sstAmount: 0, total: "30.00",
      originalDocumentId: ORIG_DOC,
      lines: { create: [{ chargeId: CH_CN, description: "Meter misread", amount: "30.00", sstRate: 0, sstAmount: 0 }] },
    },
  });
  await db.billingDocument.create({
    data: {
      id: DN, organizationId: ORG, docType: "debit_note", documentNumber: "DN-D5-1",
      seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, subtotal: "30.00", sstAmount: 0, total: "30.00",
      originalDocumentId: ORIG_DOC,
      lines: { create: [{ chargeId: CH_DN, description: "Under-billed", amount: "30.00", sstRate: 0, sstAmount: 0 }] },
    },
  });

  // ⚠️ REGRESSION GUARD. D5-ELEC's OWN bill, in the `pay_back_landlord` shape every
  // rent/carpark/deposit/tenant-utility charge gets (seed-categories.ts): docType
  // `debit_note`, originalDocumentId NULL. Counting it as an adjustment made the
  // portal render a charge at DOUBLE its real amount.
  await db.billingDocument.create({
    data: {
      id: PRIMARY_BILL, organizationId: ORG, docType: "debit_note", documentNumber: "DEP-D5-1",
      seriesId: SERIES, status: "issued", issuedById: USER, counterpartyType: "tenant",
      partyId: TENANT, subtotal: "400.00", sstAmount: 0, total: "400.00",
      lines: { create: [{ chargeId: CH_CN, description: "Electricity", amount: "400.00", sstRate: 0, sstAmount: 0 }] },
    },
  });
}

dn("dashboard feed rows carry CN/DN-adjusted figures", () => {
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  it("upcomingCharges expose note totals + adjusted + outstanding, and foot with netBalance", async () => {
    const d = await getDashboardData(scope);
    const byNumber = new Map(d.upcomingCharges.map((c) => [c.chargeNumber, c]));

    expect(byNumber.get("D5-ELEC")).toMatchObject({
      amount: 400, debitNoteTotal: 0, creditNoteTotal: 30,
      adjustedAmount: 370, outstandingAmount: 370,
    });
    expect(byNumber.get("D5-REC")).toMatchObject({
      amount: 150, debitNoteTotal: 30, creditNoteTotal: 0,
      adjustedAmount: 180, outstandingAmount: 180,
    });

    // The invariant the bug broke: the rows the tenant reads must sum to the
    // headline figure above them.
    const rowSum = d.upcomingCharges.reduce((s, c) => s + c.outstandingAmount, 0);
    expect(rowSum).toBe(d.balance.netBalance);
    expect(d.balance.netBalance).toBe(550);
  });

  it("a cancelled note stops counting — figures fall back to the raw amount", async () => {
    const db = getDb();
    await db.billingDocument.update({ where: { id: CN }, data: { documentStatus: "CANCELLED" } });
    const d = await getDashboardData(scope);
    const elec = d.upcomingCharges.find((c) => c.chargeNumber === "D5-ELEC");
    // Only the note totals revert here — outstandingAmount is the service's
    // write (a real void also restores it), which this display read never
    // second-guesses.
    expect(elec).toMatchObject({ creditNoteTotal: 0, adjustedAmount: 400 });
  });
});
