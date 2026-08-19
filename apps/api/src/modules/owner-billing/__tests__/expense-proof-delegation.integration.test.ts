/**
 * Integration tests for listExpenseProofUrlsService DELEGATING to resolveStatementBills
 * (Task 4). Both the admin (owner-billing.routes.ts:538) and portal
 * (portal.owner-statements.routes.ts:133) proof routes call this ONE function — so this
 * seam surfaces grid bills on BOTH surfaces at once. Hits a real LOCAL Postgres
 * (RUN_INTEGRATION=1); storage is MOCKED per this module's established convention (see
 * owner-expense-proof.service.test.ts, statement-bills.aggregator.integration.test.ts).
 *
 * No shared `_helpers` module exists for this suite's FK graph — seeded inline below,
 * copying the seed graph from owner-expense-proof.repository.test.ts (manual proofs, via
 * the repository's own appendProof) and statement-bills.aggregator.integration.test.ts
 * (Task 3; owner/apartment graph + grid attachments), same disjoint-org-per-test precedent.
 *
 * Run: from apps/api
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 npx vitest run src/modules/owner-billing/__tests__/expense-proof-delegation.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Storage mocked: no real Supabase bucket/network needed (mirrors statement-bills.aggregator's
// convention — the delegated aggregator, and (pre-delegation) this service's own inline loop,
// both call createSignedDownloadUrl via the same "../../lib/storage" module path regardless of
// which sibling file does the importing).
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

import { getDb } from "@kason/db";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { appendProof } from "../owner-expense-proof.repository";
import { listExpenseProofUrlsService } from "../owner-expense-proof.service";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

// Hard safety: integration runs must only ever hit a local postgres.
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const M = "2026-07";
const MONTH = new Date(Date.UTC(2026, 6, 1));

function ctxFor(orgId: string): OwnerBillingActorCtx {
  return { orgId, actorUserId: crypto.randomUUID(), actorRole: "admin" };
}

/** Fresh, self-contained org + owner Party + Property + Apartment + Listing(ownerPartyId).
 *  Mirrors statement-bills.aggregator.integration.test.ts's seedOwnerApartment (Task 3). */
async function seedOwnerApartment() {
  const db = getDb();
  const orgId = crypto.randomUUID();
  const ownerPartyId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const apartmentId = crypto.randomUUID();
  const listingId = crypto.randomUUID();

  await db.organization.create({
    data: {
      id: orgId, name: "EPD Org", slug: `epd-org-${orgId}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: ownerPartyId, organizationId: orgId, displayName: "EPD Owner", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: propertyId, organizationId: orgId, name: "EPD Property", propertyCode: "EPD-P1",
      propertyType: "apartment", addressLine1: "1 Delegation St", city: "KL", country: "MY",
      status: "active", publishStatus: "draft",
    },
  });
  await db.apartment.create({
    data: { id: apartmentId, organizationId: orgId, propertyId, unitCode: "A-1", listingMode: "PARTITIONED" },
  });
  await db.listing.create({
    data: {
      id: listingId, organizationId: orgId, apartmentId, listingType: "room",
      occupancyStatus: "vacant", listingStatus: "active", currency: "MYR", ownerPartyId,
    },
  });

  return { orgId, ownerPartyId, apartmentId };
}

/** One manual OwnerExpenseProof row via the repository's own appendProof (in a tx) —
 *  mirrors owner-expense-proof.repository.test.ts's append() helper. */
async function seedManualProof(opts: {
  orgId: string;
  ownerPartyId: string;
  apartmentId: string | null;
  category: string;
  filename: string;
}) {
  const db = getDb();
  return db.$transaction((tx) =>
    appendProof(tx, {
      orgId: opts.orgId,
      ownerPartyId: opts.ownerPartyId,
      statementMonth: MONTH,
      apartmentId: opts.apartmentId,
      category: opts.category,
      storageKey: `owner-statements/${opts.ownerPartyId}/proofs/${crypto.randomUUID()}.pdf`,
      filename: opts.filename,
      uploadedById: crypto.randomUUID(),
    }),
  );
}

/**
 * UnitBillsGridEntry carries @@unique([organizationId, apartmentId, periodMonth]) — find-or-create
 * so a second grid attachment in the same (org, apartment, month) never collides.
 * Mirrors statement-bills.aggregator.integration.test.ts's getOrCreateGridEntry (Task 3).
 */
async function getOrCreateGridEntry(orgId: string, apartmentId: string): Promise<string> {
  const db = getDb();
  const existing = await db.unitBillsGridEntry.findFirst({
    where: { organizationId: orgId, apartmentId, periodMonth: MONTH },
    select: { id: true },
  });
  if (existing) return existing.id;
  const entryId = crypto.randomUUID();
  await db.unitBillsGridEntry.create({
    data: { id: entryId, organizationId: orgId, apartmentId, periodMonth: MONTH, createdBy: crypto.randomUUID() },
  });
  return entryId;
}

/** One GridAttachment on (orgId, apartmentId, MONTH), linked through a GridExpense to a
 *  ChargeCategory carrying ledgerCategory. Mirrors
 *  statement-bills.aggregator.integration.test.ts's seedGridAttachment (Task 3). */
async function seedGridAttachment(opts: {
  orgId: string;
  apartmentId: string;
  periodMonth: Date;
  ledgerCategory: string;
  filename: string;
}) {
  const db = getDb();
  const entryId = await getOrCreateGridEntry(opts.orgId, opts.apartmentId);
  const seriesId = crypto.randomUUID();
  const categoryId = crypto.randomUUID();
  const expenseId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const actorId = crypto.randomUUID();

  await db.documentSeries.create({
    data: { id: seriesId, organizationId: opts.orgId, code: `EPD-SER-${seriesId.slice(0, 8)}`, prefix: "EPD" },
  });
  await db.chargeCategory.create({
    data: {
      id: categoryId, organizationId: opts.orgId, code: `epd-cat-${categoryId.slice(0, 8)}`,
      name: `EPD Category ${categoryId.slice(0, 8)}`, family: "owner_income", docType: "invoice",
      seriesId, ledgerCategory: opts.ledgerCategory,
    },
  });
  await db.gridExpense.create({
    data: {
      id: expenseId, organizationId: opts.orgId, entryId, apartmentId: opts.apartmentId,
      periodMonth: opts.periodMonth, description: "Grid expense", amount: "100.00",
      chargeCategoryId: categoryId, createdBy: actorId,
    },
  });
  await db.gridAttachment.create({
    data: {
      id: attachmentId, organizationId: opts.orgId, apartmentId: opts.apartmentId,
      periodMonth: opts.periodMonth, entryId, expenseId,
      storageKey: `grid/${opts.orgId}/${attachmentId}.pdf`, filename: opts.filename,
      contentType: "application/pdf", sizeBytes: 1024, uploadedBy: actorId,
    },
  });

  return { attachmentId };
}

async function cleanupOrg(orgId: string) {
  const db = getDb();
  const where = { organizationId: orgId };
  await db.ownerExpenseProof.deleteMany({ where });
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

dn("listExpenseProofUrlsService delegation", () => {
  let orgId: string, owner: string, apt: string, ctx: OwnerBillingActorCtx;

  beforeEach(async () => {
    vi.mocked(createSignedDownloadUrl).mockImplementation(async (key: string) => `https://signed.example/${key}`);
    ({ orgId, ownerPartyId: owner, apartmentId: apt } = await seedOwnerApartment());
    ctx = ctxFor(orgId);
  });

  afterEach(async () => {
    delete process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;
    await cleanupOrg(orgId);
  });

  it("flag off parity", async () => {
    await seedManualProof({
      orgId, ownerPartyId: owner, apartmentId: apt, category: "cleaning", filename: "m.pdf",
    });

    const res = await listExpenseProofUrlsService(ctx, owner, M, apt);
    expect(res.ok && res.data).toEqual([
      { category: "cleaning", proofs: [expect.objectContaining({ filename: "m.pdf", source: "manual", readOnly: false })] },
    ]);
  });

  it("surfaces grid bill through the shared service", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    await seedGridAttachment({
      orgId, apartmentId: apt, periodMonth: MONTH, ledgerCategory: "water", filename: "water.pdf",
    });

    const res = await listExpenseProofUrlsService(ctx, owner, M, apt);
    const items = res.ok ? res.data.flatMap((g) => g.proofs) : [];
    expect(items.some((i) => i.source === "grid" && i.filename === "water.pdf")).toBe(true);
  });
});
