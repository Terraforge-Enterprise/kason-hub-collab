import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { runOeaBackfill } from "../oea-backfill";

const RUN = process.env.RUN_INTEGRATION === "1";

const ORG = "0eab0000-0000-4000-8000-000000000001";
const OWNER = "0eab0000-0000-4000-8000-000000000002";
const USER = "0eab0000-0000-4000-8000-000000000003";
const SERIES = "0eab0000-0000-4000-8000-000000000004";
const CAT = "0eab0000-0000-4000-8000-000000000005";
const PROP = "0eab0000-0000-4000-8000-000000000006";
const APT = "0eab0000-0000-4000-8000-000000000007";
const ROOM = "0eab0000-0000-4000-8000-000000000008";
const MONTH = new Date("2026-05-01T00:00:00.000Z");

/**
 * OEA backfill (R9).
 *
 * The load-bearing property is NOT that documents appear — it is that NO money moves.
 * The deduction already exists; the backfill only makes it visible. That is what makes
 * writing into a frozen owner-statement period safe, and why the script deliberately
 * does not call assertPeriodOpen.
 */
async function seed(opts: { descriptionNull?: boolean; sstNull?: boolean } = {}) {
  const db = getDb();
  await db.organization.create({
    data: { id: ORG, name: "OEA-BF", slug: "oea-bf", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await db.user.create({
    data: { id: USER, organizationId: ORG, email: "oeabf@example.test", fullName: "OEA BF", status: "active", role: "manager", userType: "operator" },
  });
  await db.party.create({ data: { id: OWNER, organizationId: ORG, displayName: "Owner", partyType: "individual", status: "active" } });
  await db.property.create({ data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-OEABF", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" } });
  await db.apartment.create({ data: { id: APT, organizationId: ORG, propertyId: PROP, unitCode: "A-OEABF", listingMode: "PARTITIONED" } });
  await db.listing.create({ data: { id: ROOM, organizationId: ORG, apartmentId: APT, listingType: "master_room", occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: OWNER } });
  await db.documentSeries.create({ data: { id: SERIES, organizationId: ORG, code: "OEA", prefix: "OEA" } });
  await db.chargeCategory.create({
    data: { id: CAT, organizationId: ORG, code: "other_expense_owner", name: "Other expense (owner)", family: "owner_income", docType: "invoice", seriesId: SERIES, defaultSstRate: "0", isSystem: true, active: true, sortOrder: 1 },
  });

  const charge = await db.charge.create({
    data: {
      organizationId: ORG, chargeNumber: "GRIDEXP-202605-oeabf", chargeType: "expense", status: "posted",
      postedAt: new Date(), description: opts.descriptionNull ? null : "Roof repair",
      dueDate: MONTH, amount: "80.00", currency: "MYR", outstandingAmount: "80.00", billingMonth: MONTH,
      partyId: OWNER, unitId: ROOM, categoryId: CAT,
      sstRate: opts.sstNull ? null : "0", attachmentKeys: [],
    },
    select: { id: true },
  });

  await db.ownerLedgerEntry.create({
    data: {
      organizationId: ORG, ownerPartyId: OWNER, listingId: ROOM, statementMonth: MONTH,
      transactionDate: MONTH, direction: "debit", category: "other_expense", amount: "80.00",
      paidBy: "kaen", includeInPayout: true, sourceType: "owner_borne_expense", sourceChargeId: charge.id,
      status: "active", createdById: USER, updatedById: USER,
    },
  });
  return { chargeId: charge.id };
}

async function ledgerSnapshot() {
  const db = getDb();
  const rows = await db.ownerLedgerEntry.findMany({
    where: { organizationId: ORG },
    select: { id: true, amount: true, includeInPayout: true, sourceChargeId: true, statementMonth: true, status: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({ ...r, amount: r.amount.toString() }));
}

async function cleanup() {
  const db = getDb();
  await db.ownerLedgerEntry.deleteMany({ where: { organizationId: ORG } });
  await db.billingDocumentLine.deleteMany({ where: { document: { organizationId: ORG } } });
  await db.billingDocument.deleteMany({ where: { organizationId: ORG } });
  await db.charge.deleteMany({ where: { organizationId: ORG } });
  await db.listing.deleteMany({ where: { organizationId: ORG } });
  await db.apartment.deleteMany({ where: { organizationId: ORG } });
  await db.property.deleteMany({ where: { organizationId: ORG } });
  await db.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await db.documentSeries.deleteMany({ where: { organizationId: ORG } });
  // issueDocumentTx records an AuditLog referencing the actor — delete before the user.
  await db.auditLog.deleteMany({ where: { organizationId: ORG } });
  await db.referenceSequence.deleteMany({ where: { organizationId: ORG } });
  await db.user.deleteMany({ where: { organizationId: ORG } });
  await db.party.deleteMany({ where: { organizationId: ORG } });
  await db.organization.deleteMany({ where: { id: ORG } });
}

describe.skipIf(!RUN)("OEA backfill", () => {
  beforeEach(async () => { await cleanup(); });
  afterEach(async () => { await cleanup(); });

  it("dry run plans the document and writes NOTHING", async () => {
    await seed();
    const db = getDb();
    const before = await db.billingDocument.count({ where: { organizationId: ORG } });
    const res = await runOeaBackfill({ orgId: ORG });
    expect(res.groups).toBe(1);
    expect(await db.billingDocument.count({ where: { organizationId: ORG } })).toBe(before);
  });

  it("apply mints one OEA per (owner, listing, month) and leaves the ledger byte-identical", async () => {
    const { chargeId } = await seed();
    const db = getDb();
    const ledgerBefore = await ledgerSnapshot();

    const res = await runOeaBackfill({ apply: true, orgId: ORG, actorUserId: USER });
    expect(res.created).toBe(1);

    const docs = await db.billingDocument.findMany({
      where: { organizationId: ORG, docType: "owner_expense_advice" },
      select: { id: true, documentNumber: true, counterpartyType: true, issuedAt: true, total: true },
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.documentNumber).toMatch(/^OEA-/);
    expect(docs[0]!.counterpartyType).toBe("owner");
    // issuedAt stamped from the ledger period so date-ordered views stay correct.
    expect(docs[0]!.issuedAt.toISOString()).toBe(MONTH.toISOString());

    const lines = await db.billingDocumentLine.findMany({ where: { documentId: docs[0]!.id }, select: { chargeId: true } });
    expect(lines.map((l) => l.chargeId)).toEqual([chargeId]);

    // THE contract: no money moved.
    expect(await ledgerSnapshot()).toEqual(ledgerBefore);
  });

  it("is idempotent — a second apply creates no additional documents", async () => {
    await seed();
    const db = getDb();
    await runOeaBackfill({ apply: true, orgId: ORG, actorUserId: USER });
    const first = await db.billingDocument.count({ where: { organizationId: ORG, docType: "owner_expense_advice" } });
    await runOeaBackfill({ apply: true, orgId: ORG, actorUserId: USER });
    const second = await db.billingDocument.count({ where: { organizationId: ORG, docType: "owner_expense_advice" } });
    expect(second).toBe(first);
    expect(second).toBe(1);
  });

  it("refuses to apply without an actor (issuedById is a NOT NULL uuid)", async () => {
    await seed();
    await expect(runOeaBackfill({ apply: true, orgId: ORG })).rejects.toThrow(/actorUserId/);
  });

  it("refuses an actor id that is not a real user", async () => {
    await seed();
    await expect(
      runOeaBackfill({ apply: true, orgId: ORG, actorUserId: "00000000-0000-4000-8000-00000000dead" }),
    ).rejects.toThrow(/not an existing user/);
  });

  it("handles a nullable Charge.description and sstRate without crashing", async () => {
    await seed({ descriptionNull: true, sstNull: true });
    const db = getDb();
    const res = await runOeaBackfill({ apply: true, orgId: ORG, actorUserId: USER });
    expect(res.created).toBe(1);
    const line = await db.billingDocumentLine.findFirstOrThrow({
      where: { document: { organizationId: ORG } },
      select: { description: true, sstRate: true },
    });
    expect(line.description).toBe("Other expense (owner)"); // category-name fallback
    expect(Number(line.sstRate.toString())).toBe(0);
  });
});
