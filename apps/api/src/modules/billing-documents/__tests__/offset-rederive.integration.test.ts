/**
 * Phase 0B.2: `offset` is a DERIVED (non-terminal) status for TENANT documents, so a
 * document can leave `offset` when a charge is later un-credited (Phase-4 un-void).
 *
 * D9 GATE (owner IVOWN): owner statement-reversal sets the IVOWN doc `offset` WITHOUT
 * crediting its charges ("Child line Charges are left as-is", owner-billing.service.ts).
 * Removing the terminal skip WHOLESALE would un-offset voided owner statements — so the
 * skip is kept for owner docs. This test pins that owner offsets stay terminal.
 *
 * Real LOCAL Postgres (opt-in RUN_INTEGRATION=1).
 *   cd apps/api
 *   RUN_INTEGRATION=1 ENABLE_PHASE2_BILLING_DOCS=1 \
 *     npx vitest run src/modules/billing-documents/__tests__/offset-rederive.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { refreshDocumentStatusForCharges } from "../status.service";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
  process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
}

const ORG = "b7300000-0000-4000-8000-000000000001";
const USER = "b7300000-0000-4000-8000-000000000002";
const TENANT = "b7300000-0000-4000-8000-000000000003";
const CAT = "b7300000-0000-4000-8000-000000000004";
const SERIES = "b7300000-0000-4000-8000-000000000005";

async function cleanup() {
  const db = getDb();
  const org = { organizationId: ORG };
  await db.billingDocumentLine.deleteMany({ where: { document: org } });
  await db.billingDocument.deleteMany({ where: org });
  await db.chargeEvent.deleteMany({ where: org });
  await db.charge.deleteMany({ where: org });
  await db.referenceSequence.deleteMany({ where: org });
  await db.chargeCategory.deleteMany({ where: org });
  await db.documentSeries.deleteMany({ where: org });
  await db.user.deleteMany({ where: { id: USER } });
  await db.party.deleteMany({ where: org });
  await db.organization.deleteMany({ where: { id: ORG } });
}

async function seedBase() {
  const db = getDb();
  await db.organization.create({
    data: {
      id: ORG, name: "Offset Rederive Org", slug: `org-${ORG}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.user.create({
    data: {
      id: USER, organizationId: ORG, email: "b730@test.local", passwordHash: "x", role: "admin",
      fullName: "B730 Admin", status: "active", userType: "operator",
    },
  });
  await db.party.create({
    data: { id: TENANT, organizationId: ORG, displayName: "Rederive Party", partyType: "individual", status: "active" },
  });
  await db.documentSeries.create({
    data: { id: SERIES, organizationId: ORG, code: "DEP", prefix: "DEP", padding: 4, includeYear: false, active: true },
  });
  await db.chargeCategory.create({
    data: {
      id: CAT, organizationId: ORG, code: "rental", name: "Rental",
      family: "pay_back_landlord", docType: "debit_note", seriesId: SERIES,
      defaultSstRate: 0, eInvoiceEligible: false, ledgerCategory: "rental_income",
      isSystem: true, active: true, sortOrder: 1,
    },
  });
}

/** A charge + a doc (status forced to `offset`) with 1 line, of the given counterparty. */
async function seedOffsetDoc(opts: {
  chargeId: string; docId: string; num: string; amount: string; outstanding: string;
  chargeStatus: string; counterpartyType: "tenant" | "owner"; statementInvoiceId?: string;
}) {
  const db = getDb();
  await db.charge.create({
    data: {
      id: opts.chargeId, organizationId: ORG, chargeNumber: `B730-${opts.num}`, partyId: TENANT,
      chargeType: "rental", categoryId: CAT, status: opts.chargeStatus, postedAt: new Date(),
      description: "line", dueDate: new Date("2026-06-30"), amount: opts.amount, currency: "MYR",
      outstandingAmount: opts.outstanding, billingMonth: new Date("2026-06-01"),
    },
  });
  await db.billingDocument.create({
    data: {
      id: opts.docId, organizationId: ORG, docType: "invoice", documentNumber: opts.num, seriesId: SERIES,
      status: "offset", settlementStatus: "PAID", issuedById: USER, counterpartyType: opts.counterpartyType,
      partyId: TENANT, statementInvoiceId: opts.statementInvoiceId ?? null,
      billingMonth: new Date("2026-06-01"), subtotal: opts.amount, sstAmount: 0, total: opts.amount,
      lines: { create: [{ chargeId: opts.chargeId, categoryId: CAT, description: "line", amount: opts.amount, sstRate: 0, sstAmount: 0 }] },
    },
  });
}

const statusOf = async (id: string) => (await getDb().billingDocument.findUniqueOrThrow({ where: { id } })).status;

dn("offset re-derivation (integration)", () => {
  beforeEach(async () => {
    await cleanup();
    await seedBase();
  });
  afterAll(cleanup);

  it("TENANT: offset doc whose charge is no longer credited → re-derives AWAY from offset", async () => {
    const C = "b7300000-0000-4000-8000-000000000011";
    const D = "b7300000-0000-4000-8000-000000000012";
    // charge posted with full outstanding (as if a CN was voided → charge reopened)
    await seedOffsetDoc({ chargeId: C, docId: D, num: "DEP-T1", amount: "100.00", outstanding: "100.00", chargeStatus: "posted", counterpartyType: "tenant" });

    await refreshDocumentStatusForCharges([C]);
    expect(await statusOf(D)).toBe("issued"); // left offset — charge fully owes again
  });

  it("TENANT: offset doc whose charge is genuinely credited → STAYS offset (stable)", async () => {
    const C = "b7300000-0000-4000-8000-000000000021";
    const D = "b7300000-0000-4000-8000-000000000022";
    await seedOffsetDoc({ chargeId: C, docId: D, num: "DEP-T2", amount: "100.00", outstanding: "0.00", chargeStatus: "credited", counterpartyType: "tenant" });

    await refreshDocumentStatusForCharges([C]);
    expect(await statusOf(D)).toBe("offset"); // all credited → derives offset again
  });

  it("D9 GATE — OWNER IVOWN: manually-offset statement doc (charges left as-is) STAYS offset", async () => {
    const C = "b7300000-0000-4000-8000-000000000031";
    const D = "b7300000-0000-4000-8000-000000000032";
    // charge still posted/owing (statement void leaves charges as-is), but doc is offset.
    await seedOffsetDoc({ chargeId: C, docId: D, num: "DEP-O1", amount: "100.00", outstanding: "100.00", chargeStatus: "posted", counterpartyType: "owner", statementInvoiceId: "b7300000-0000-4000-8000-0000000000ff" });

    await refreshDocumentStatusForCharges([C]);
    expect(await statusOf(D)).toBe("offset"); // owner offset is terminal — accounting preserved
  });
});
