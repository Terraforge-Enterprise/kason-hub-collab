/**
 * Grid-bills repository query (Task 2) — apartment + ownership scoped read of GridAttachment
 * for the owner statement. GridAttachment carries NO owner column, so ownership is enforced
 * via the apartment's Listing.ownerPartyId BEFORE any row is returned; a foreign owner or a
 * null apartmentId must yield [] (never leak existence of another owner's bills).
 *
 * Integration suite (RUN_INTEGRATION=1) against the real local Postgres, mirroring the
 * module's established harness convention (getDb + RUN_INTEGRATION gate + non-local-host
 * guard — see owner-expense-proof.repository.test.ts, closed-period-guard.integration.test.ts).
 *
 * No shared `_helpers` module exists for this suite's FK graph (org → Party → Apartment →
 * Listing(ownerPartyId) → ChargeCategory(→DocumentSeries) → UnitBillsGridEntry →
 * GridExpense(chargeCategoryId) → GridAttachment) — seeded inline below, each helper creating
 * its own disjoint org (crypto.randomUUID() ids) so cross-owner tests need no shared-org
 * bookkeeping and cleanup is a straightforward per-org teardown.
 *
 * Run: from apps/api
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 npx vitest run src/modules/owner-billing/__tests__/statement-grid-bills.repository.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb } from "@kason/db";
import { findGridBillsForOwnerMonth } from "../statement-grid-bills.repository";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const M = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01

// Orgs created by seedOwnerApartment() across this file's tests, torn down in afterAll.
const createdOrgIds: string[] = [];

/** Fresh, self-contained org + owner Party + Property + Apartment + Listing(ownerPartyId).
 *  `listingStatus` defaults to "active"; pass "archived" to exercise the lifecycle gate. */
async function seedOwnerApartment(opts: { listingStatus?: string } = {}) {
  const db = getDb();
  const orgId = crypto.randomUUID();
  const ownerPartyId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const apartmentId = crypto.randomUUID();
  const listingId = crypto.randomUUID();
  createdOrgIds.push(orgId);

  await db.organization.create({
    data: {
      id: orgId, name: "GB Org", slug: `gb-org-${orgId}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: ownerPartyId, organizationId: orgId, displayName: "GB Owner", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: propertyId, organizationId: orgId, name: "GB Property", propertyCode: "GB-P1",
      propertyType: "apartment", addressLine1: "1 Grid St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: apartmentId, organizationId: orgId, propertyId, unitCode: "A-1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: listingId, organizationId: orgId, apartmentId, listingType: "room",
      occupancyStatus: "vacant", listingStatus: opts.listingStatus ?? "active", currency: "MYR", ownerPartyId,
    },
  });

  return { orgId, ownerPartyId, apartmentId };
}

/**
 * A GridAttachment on (orgId, apartmentId, periodMonth), linked through a GridExpense to a
 * ChargeCategory carrying ledgerCategory — mirrors the read shape findGridBillsForOwnerMonth
 * joins through (entry → expense → chargeCategory.ledgerCategory).
 */
async function seedGridAttachment(opts: {
  orgId: string;
  apartmentId: string;
  periodMonth: Date;
  ledgerCategory: string;
  filename: string;
  /** GridExpense.bearer — "tenant" (default) | "owner". */
  bearer?: "tenant" | "owner";
  /** GridExpense.partyId snapshot — owner-bearer expenses store null in prod, but the
   *  adversarial co-owned repro sets it to construct the leak scenario faithfully. */
  expensePartyId?: string | null;
  /** GridExpense.status — "active" (default) | "void" (the module's only retire path). */
  expenseStatus?: "active" | "void";
}) {
  const db = getDb();
  const seriesId = crypto.randomUUID();
  const categoryId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const expenseId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const actorId = crypto.randomUUID(); // createdBy/uploadedBy — plain column, no FK

  await db.documentSeries.create({
    data: { id: seriesId, organizationId: opts.orgId, code: `GB-SER-${seriesId.slice(0, 8)}`, prefix: "GB" },
  });
  await db.chargeCategory.create({
    data: {
      id: categoryId, organizationId: opts.orgId, code: `gb-cat-${categoryId.slice(0, 8)}`,
      name: `GB Category ${categoryId.slice(0, 8)}`, family: "owner_income", docType: "invoice",
      seriesId, ledgerCategory: opts.ledgerCategory,
    },
  });
  // Get-or-create the parent entry: UnitBillsGridEntry is @@unique([organizationId,
  // apartmentId, periodMonth]), so multiple attachments on one apartment/month share it.
  const entry = await db.unitBillsGridEntry.upsert({
    where: { organizationId_apartmentId_periodMonth: { organizationId: opts.orgId, apartmentId: opts.apartmentId, periodMonth: opts.periodMonth } },
    create: { id: entryId, organizationId: opts.orgId, apartmentId: opts.apartmentId, periodMonth: opts.periodMonth, createdBy: actorId },
    update: {},
    select: { id: true },
  });
  await db.gridExpense.create({
    data: {
      id: expenseId, organizationId: opts.orgId, entryId: entry.id, apartmentId: opts.apartmentId,
      periodMonth: opts.periodMonth, description: "Grid expense", amount: "100.00",
      chargeCategoryId: categoryId, createdBy: actorId,
      bearer: opts.bearer ?? "tenant",
      partyId: opts.expensePartyId ?? null,
      status: opts.expenseStatus ?? "active",
    },
  });
  await db.gridAttachment.create({
    data: {
      id: attachmentId, organizationId: opts.orgId, apartmentId: opts.apartmentId,
      periodMonth: opts.periodMonth, entryId: entry.id, expenseId,
      storageKey: `grid/${opts.orgId}/${attachmentId}.pdf`, filename: opts.filename,
      contentType: "application/pdf", sizeBytes: 1024, uploadedBy: actorId,
    },
  });

  return { attachmentId };
}

/**
 * A single apartment CO-OWNED by two parties (partitioned): two ACTIVE Listings with
 * DIFFERENT ownerPartyId (schema @@unique([apartmentId, listingType]) permits this — the
 * per-listing owner). This is the state Finding 1 leaks across: a grid attachment carries
 * no per-room owner link, so on a co-owned apartment no attachment is confidently
 * attributable to either owner.
 */
async function seedCoOwnedApartment() {
  const db = getDb();
  const orgId = crypto.randomUUID();
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const apartmentId = crypto.randomUUID();
  createdOrgIds.push(orgId);

  await db.organization.create({
    data: {
      id: orgId, name: "GB Org", slug: `gb-org-${orgId}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({ data: { id: ownerA, organizationId: orgId, displayName: "Owner A", partyType: "individual", status: "active" } });
  await db.party.create({ data: { id: ownerB, organizationId: orgId, displayName: "Owner B", partyType: "individual", status: "active" } });
  await db.property.create({
    data: {
      id: propertyId, organizationId: orgId, name: "GB Property", propertyCode: "GB-P1",
      propertyType: "apartment", addressLine1: "1 Grid St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({ data: { id: apartmentId, organizationId: orgId, propertyId, unitCode: "A-1", listingMode: "PARTITIONED" } });
  await db.listing.create({
    data: {
      id: crypto.randomUUID(), organizationId: orgId, apartmentId, listingType: "master",
      occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: ownerA,
    },
  });
  await db.listing.create({
    data: {
      id: crypto.randomUUID(), organizationId: orgId, apartmentId, listingType: "medium",
      occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId: ownerB,
    },
  });

  return { orgId, apartmentId, ownerA, ownerB };
}

async function cleanupOrg(orgId: string) {
  const db = getDb();
  const where = { organizationId: orgId };
  await db.gridExpense.deleteMany({ where });
  await db.gridAttachment.deleteMany({ where });
  await db.unitBillsGridEntry.deleteMany({ where });
  await db.chargeCategory.deleteMany({ where });
  await db.documentSeries.deleteMany({ where });
  await db.listing.deleteMany({ where });
  await db.apartment.deleteMany({ where });
  await db.property.deleteMany({ where });
  await db.party.deleteMany({ where });
  await db.organization.deleteMany({ where: { id: orgId } });
}

dn("findGridBillsForOwnerMonth", () => {
  let orgId: string, ownerO: string, ownerO2: string, aptA: string;

  beforeAll(async () => {
    ({ orgId, ownerPartyId: ownerO, apartmentId: aptA } = await seedOwnerApartment());
    ({ ownerPartyId: ownerO2 } = await seedOwnerApartment());
    await seedGridAttachment({ orgId, apartmentId: aptA, periodMonth: M, ledgerCategory: "utilities_tnb", filename: "tnb.pdf" });
  });

  afterAll(async () => {
    for (const org of createdOrgIds) await cleanupOrg(org);
  });

  it("returns grid bills for owner apartment", async () => {
    const rows = await findGridBillsForOwnerMonth(orgId, ownerO, aptA, M);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: "tnb.pdf", ledgerCategory: "utilities_tnb" });
    expect(rows[0].storageKey).toBeTruthy();
  });

  it("foreign owner gets empty", async () => {
    expect(await findGridBillsForOwnerMonth(orgId, ownerO2, aptA, M)).toEqual([]);
  });

  it("null apartment gets empty", async () => {
    expect(await findGridBillsForOwnerMonth(orgId, ownerO, null, M)).toEqual([]);
  });

  // ─── Finding 1 (Critical): co-owned apartment must never leak another owner's grid bill ───
  // Apartment X holds Listing(ownerA,"master") + Listing(ownerB,"medium"); the only grid bill
  // is owner B's private-room expense. The old apartment-granular gate let owner A (who owns a
  // room in X) read EVERY attachment on X — including owner B's. A grid attachment has no
  // per-room owner column, so on a co-owned apartment it is unattributable → exclude for all.
  it("co-owned apartment: owner A does NOT see owner B's private bill (fail-safe excludes both)", async () => {
    const { orgId: coOrg, apartmentId: coApt, ownerA, ownerB } = await seedCoOwnedApartment();
    await seedGridAttachment({
      orgId: coOrg, apartmentId: coApt, periodMonth: M, ledgerCategory: "utilities_tnb",
      filename: "ownerB-private-aircond.pdf", bearer: "owner", expensePartyId: ownerB,
    });
    // MUST be [] — owner A must not receive owner B's grid bill.
    expect(await findGridBillsForOwnerMonth(coOrg, ownerA, coApt, M)).toEqual([]);
    // Fail-safe is symmetric: owner B is also unattributable on a co-owned apartment → [].
    expect(await findGridBillsForOwnerMonth(coOrg, ownerB, coApt, M)).toEqual([]);
  });

  // ─── Finding 2 (Important): a voided GridExpense's attachment must not surface ───
  it("voided expense: attachment linked to a status:void expense is excluded", async () => {
    const { orgId: vOrg, ownerPartyId: vOwner, apartmentId: vApt } = await seedOwnerApartment();
    await seedGridAttachment({ orgId: vOrg, apartmentId: vApt, periodMonth: M, ledgerCategory: "utilities_tnb", filename: "keep.pdf" });
    await seedGridAttachment({ orgId: vOrg, apartmentId: vApt, periodMonth: M, ledgerCategory: "utilities_tnb", filename: "VOIDED-bill.pdf", expenseStatus: "void" });
    const rows = await findGridBillsForOwnerMonth(vOrg, vOwner, vApt, M);
    // The active bill is still returned; the voided (retracted) one is dropped.
    expect(rows.map((r) => r.filename)).toEqual(["keep.pdf"]);
  });

  // ─── Finding 3 (Important): an archived Listing must not satisfy the ownership gate ───
  it("archived listing: owner whose only listing is archived gets empty", async () => {
    const { orgId: aOrg, ownerPartyId: aOwner, apartmentId: aApt } = await seedOwnerApartment({ listingStatus: "archived" });
    await seedGridAttachment({ orgId: aOrg, apartmentId: aApt, periodMonth: M, ledgerCategory: "utilities_tnb", filename: "post-archive.pdf" });
    expect(await findGridBillsForOwnerMonth(aOrg, aOwner, aApt, M)).toEqual([]);
  });
});
