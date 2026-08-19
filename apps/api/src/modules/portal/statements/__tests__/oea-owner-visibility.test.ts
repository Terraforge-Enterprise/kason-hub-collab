import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { listOwnStatementDocuments } from "../portal.statements.repository";

const RUN = process.env.RUN_INTEGRATION === "1";

// Fixed UUIDs so cleanup is exact and this file cannot collide with other suites.
const ORG = "0ea00000-0000-4000-8000-000000000001";
const OWNER = "0ea00000-0000-4000-8000-000000000002";
const OTHER_OWNER = "0ea00000-0000-4000-8000-000000000003";
const USER = "0ea00000-0000-4000-8000-000000000004";
const SERIES = "0ea00000-0000-4000-8000-000000000005";
const PERIOD = new Date("2026-07-01T00:00:00.000Z");

/**
 * Owner-facing OEA visibility (R6).
 *
 * An OEA is issued at BILL time, long before a statement exists, so it never carries
 * statementInvoiceId — the key this listing was originally built on. A read-time union
 * on (owner, period) surfaces it without mutating issued documents.
 *
 * Deliberately NOT gated by ENABLE_OWNER_WEB_EXPENSE_HIDE: that flag declutters the
 * statement's utility list, but this document is the audit trail for money taken out of
 * the owner's rent and must always be reachable.
 *
 * This suite SEEDS its own fixture rather than probing ambient data — an early-return
 * "no matching rows, pass" would be a vacuous green on owner-scoped portal data, where
 * the load-bearing property is own-data-only.
 */
async function seed() {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "OEA-VIS", slug: "oea-vis", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.party.createMany({
    data: [
      { id: OWNER, organizationId: ORG, partyType: "individual", displayName: "OEA Owner", status: "active" },
      { id: OTHER_OWNER, organizationId: ORG, partyType: "individual", displayName: "Other Owner", status: "active" },
    ],
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "oeavis@example.test", fullName: "OEA Vis Operator", status: "active", role: "manager", userType: "operator" },
  });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "OEA", prefix: "OEA" } });

  const statement = await db.invoice.create({
    data: {
      organizationId: ORG, invoiceNumber: "OS-07-oeavis", partyId: OWNER, ownerPartyId: OWNER,
      invoiceType: "owner_statement", invoiceDate: PERIOD, periodMonth: PERIOD,
      totalAmount: "0.00", updatedAt: new Date(),
    },
    select: { id: true },
  });

  const mkOea = async (num: string, partyId: string) =>
    db.billingDocument.create({
      data: {
        organizationId: ORG, docType: "owner_expense_advice", documentNumber: num, seriesId: SERIES,
        issuedById: USER, counterpartyType: "owner", partyId, billingMonth: PERIOD,
        statementInvoiceId: null, // the shape the union exists for
        subtotal: "80.00", total: "80.00", updatedAt: new Date(),
      },
      select: { id: true },
    });

  const mine = await mkOea("OEA-9001", OWNER);
  const theirs = await mkOea("OEA-9002", OTHER_OWNER);
  return { statementId: statement.id, mineId: mine.id, theirsId: theirs.id };
}

async function cleanup() {
  const db = getDb();
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.invoice.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

describe.skipIf(!RUN)("owner sees their own OEA documents", () => {
  beforeEach(async () => { await cleanup(); });
  afterEach(async () => { await cleanup(); });

  it("surfaces an OEA for the statement's period even though its statementInvoiceId is null", async () => {
    const { statementId, mineId } = await seed();
    const rows = await listOwnStatementDocuments({ partyId: OWNER, orgId: ORG }, statementId);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.id)).toContain(mineId);
    expect(rows!.find((r) => r.id === mineId)!.docType).toBe("owner_expense_advice");
  });

  it("never returns another owner's OEA for the same period", async () => {
    const { statementId, theirsId } = await seed();
    const rows = await listOwnStatementDocuments({ partyId: OWNER, orgId: ORG }, statementId);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.id)).not.toContain(theirsId);
  });

  it("returns null for a statement that is not this owner's (never leaks existence)", async () => {
    const { statementId } = await seed();
    const rows = await listOwnStatementDocuments({ partyId: OTHER_OWNER, orgId: ORG }, statementId);
    expect(rows).toBeNull();
  });
});

// ─── Punch list C (2026-08-06): owner CN/DN read-time union ──────────────────
// Owner charge-adjustment notes carry originalDocumentId (the statement's
// IVOWN document), never statementInvoiceId — before the third OR branch they
// were invisible in this listing even though the owner could fetch one by id.
describe.skipIf(!RUN)("owner sees CN/DN notes issued against their statement's IVOWN", () => {
  beforeEach(async () => { await cleanup(); });
  afterEach(async () => { await cleanup(); });

  async function seedIvownWithNotes() {
    const db = getDb();
    const { statementId } = await seed();
    const ivown = await db.billingDocument.create({
      data: {
        organizationId: ORG, docType: "invoice", documentNumber: "IVOWN-9001", seriesId: SERIES,
        issuedById: USER, counterpartyType: "owner", partyId: OWNER, billingMonth: PERIOD,
        statementInvoiceId: statementId,
        subtotal: "916.00", total: "916.00", updatedAt: new Date(),
      },
      select: { id: true },
    });
    const mkNote = async (docType: "credit_note" | "debit_note", num: string, partyId: string) =>
      db.billingDocument.create({
        data: {
          organizationId: ORG, docType, documentNumber: num, seriesId: SERIES,
          issuedById: USER, counterpartyType: "owner", partyId,
          billingMonth: PERIOD, originalDocumentId: ivown.id,
          statementInvoiceId: null, // the shape the third OR branch exists for
          subtotal: "100.00", total: "100.00", updatedAt: new Date(),
        },
        select: { id: true },
      });
    const myCn = await mkNote("credit_note", "CN-9001", OWNER);
    const myDn = await mkNote("debit_note", "DN-9001", OWNER);
    // Corrupt/foreign shape: references MY ivown but belongs to another party —
    // the partyId re-proof must exclude it.
    const foreign = await mkNote("credit_note", "CN-9002", OTHER_OWNER);
    return { statementId, ivownId: ivown.id, myCnId: myCn.id, myDnId: myDn.id, foreignId: foreign.id };
  }

  it("lists the owner's CN and DN alongside the IVOWN itself", async () => {
    const { statementId, ivownId, myCnId, myDnId } = await seedIvownWithNotes();
    const rows = await listOwnStatementDocuments({ partyId: OWNER, orgId: ORG }, statementId);
    expect(rows).not.toBeNull();
    const ids = rows!.map((r) => r.id);
    expect(ids).toContain(ivownId);
    expect(ids).toContain(myCnId);
    expect(ids).toContain(myDnId);
    expect(rows!.find((r) => r.id === myCnId)!.docType).toBe("credit_note");
  });

  it("never returns a note belonging to another party, even when it references this owner's IVOWN", async () => {
    const { statementId, foreignId } = await seedIvownWithNotes();
    const rows = await listOwnStatementDocuments({ partyId: OWNER, orgId: ORG }, statementId);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.id)).not.toContain(foreignId);
  });
});
