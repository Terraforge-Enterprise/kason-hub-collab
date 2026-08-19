/**
 * Integration tests for resolveStatementBills (Task 3) — the read authority behind the
 * owner-statement Bills & Proof panel. Unions the manual OwnerExpenseProof store (always
 * on) with GridAttachment (flag-gated via ENABLE_GRID_BILLS_ON_OWNER_STATEMENT), via the
 * two repositories this aggregator calls unmodified (owner-expense-proof.repository,
 * statement-grid-bills.repository — Task 2). Hits a real LOCAL Postgres (RUN_INTEGRATION=1);
 * storage is MOCKED per this module's established convention (see
 * owner-expense-proof.service.test.ts) so no real Supabase bucket/network is needed.
 *
 * No shared `_helpers` module exists for this suite's FK graph — seeded inline below,
 * copying the seed graph from owner-expense-proof.repository.test.ts (manual proofs, via
 * the repository's own appendProof) and statement-grid-bills.repository.integration.test.ts
 * (grid attachments; Task 2), each disjoint-org-per-test like both precedents.
 *
 * Run: from apps/api
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 npx vitest run src/modules/owner-billing/__tests__/statement-bills.aggregator.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Storage mocked: no real Supabase bucket/network needed. Default returns a deterministic
// per-key URL; the "one sign failure" test overrides this per-key via mockImplementation.
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

// Grid repository wrapped (not stubbed): default behavior calls straight through to the
// real DB-backed implementation (every other test in this file depends on that), but
// wrapping it in vi.fn() lets ONE test below override it with mockRejectedValueOnce to
// simulate a grid-query failure (e.g. a Prisma pool timeout) without touching the DB.
vi.mock("../statement-grid-bills.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../statement-grid-bills.repository")>();
  return { ...actual, findGridBillsForOwnerMonth: vi.fn(actual.findGridBillsForOwnerMonth) };
});

import { getDb } from "@kason/db";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { findGridBillsForOwnerMonth } from "../statement-grid-bills.repository";
import { appendProof } from "../owner-expense-proof.repository";
import { resolveStatementBills } from "../statement-bills";
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
 *  Mirrors statement-grid-bills.repository.integration.test.ts's seedOwnerApartment (Task 2). */
async function seedOwnerApartment() {
  const db = getDb();
  const orgId = crypto.randomUUID();
  const ownerPartyId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const apartmentId = crypto.randomUUID();
  const listingId = crypto.randomUUID();

  await db.organization.create({
    data: {
      id: orgId, name: "SB Org", slug: `sb-org-${orgId}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: ownerPartyId, organizationId: orgId, displayName: "SB Owner", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: propertyId, organizationId: orgId, name: "SB Property", propertyCode: "SB-P1",
      propertyType: "apartment", addressLine1: "1 Statement St", city: "KL", country: "MY",
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
  storageKey?: string;
}) {
  const db = getDb();
  return db.$transaction((tx) =>
    appendProof(tx, {
      orgId: opts.orgId,
      ownerPartyId: opts.ownerPartyId,
      statementMonth: MONTH,
      apartmentId: opts.apartmentId,
      category: opts.category,
      storageKey: opts.storageKey ?? `owner-statements/${opts.ownerPartyId}/proofs/${crypto.randomUUID()}.pdf`,
      filename: opts.filename,
      uploadedById: crypto.randomUUID(),
    }),
  );
}

/**
 * UnitBillsGridEntry carries @@unique([organizationId, apartmentId, periodMonth]) — ONE
 * entry per apartment per month, with multiple GridExpense/GridAttachment rows hanging off
 * it (mirrors the real grid UI: a month's whole entry, many line items). Find-or-create so
 * seeding a SECOND grid attachment in the same (org, apartment, month) — needed to test
 * "one of several bills fails to sign" — doesn't collide on the unique constraint.
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

/**
 * One GridAttachment on (orgId, apartmentId, MONTH). `ledgerCategory: null` seeds an
 * entry-level attachment (no linked GridExpense — expenseId stays null), mirroring
 * GridBillRow's real null case; a string seeds the full
 * GridExpense→ChargeCategory(ledgerCategory) chain — mirrors
 * statement-grid-bills.repository.integration.test.ts's seedGridAttachment (Task 2).
 */
async function seedGridAttachment(opts: {
  orgId: string;
  apartmentId: string;
  ledgerCategory: string | null;
  filename: string;
  storageKey?: string;
}) {
  const db = getDb();
  const entryId = await getOrCreateGridEntry(opts.orgId, opts.apartmentId);
  const attachmentId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  const storageKey = opts.storageKey ?? `grid/${opts.orgId}/${attachmentId}.pdf`;

  let expenseId: string | null = null;
  if (opts.ledgerCategory !== null) {
    const seriesId = crypto.randomUUID();
    const categoryId = crypto.randomUUID();
    expenseId = crypto.randomUUID();
    await db.documentSeries.create({
      data: { id: seriesId, organizationId: opts.orgId, code: `SB-SER-${seriesId.slice(0, 8)}`, prefix: "SB" },
    });
    await db.chargeCategory.create({
      data: {
        id: categoryId, organizationId: opts.orgId, code: `sb-cat-${categoryId.slice(0, 8)}`,
        name: `SB Category ${categoryId.slice(0, 8)}`, family: "owner_income", docType: "invoice",
        seriesId, ledgerCategory: opts.ledgerCategory,
      },
    });
    await db.gridExpense.create({
      data: {
        id: expenseId, organizationId: opts.orgId, entryId, apartmentId: opts.apartmentId,
        periodMonth: MONTH, description: "Grid expense", amount: "100.00",
        chargeCategoryId: categoryId, createdBy: actorId,
      },
    });
  }

  await db.gridAttachment.create({
    data: {
      id: attachmentId, organizationId: opts.orgId, apartmentId: opts.apartmentId,
      periodMonth: MONTH, entryId, expenseId,
      storageKey, filename: opts.filename, contentType: "application/pdf", sizeBytes: 1024,
      uploadedBy: actorId,
    },
  });

  return { attachmentId, storageKey };
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

dn("resolveStatementBills", () => {
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

  it("flag off = manual only", async () => {
    const proof = await seedManualProof({
      orgId, ownerPartyId: owner, apartmentId: apt, category: "cleaning", filename: "manual.pdf",
    });
    const grid = await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: "utilities_tnb", filename: "tnb.pdf",
    });

    const res = await resolveStatementBills(ctx, owner, M, apt);
    expect(res.ok).toBe(true);
    const items = res.ok ? res.data.flatMap((g) => g.proofs) : [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: proof.id, filename: "manual.pdf", source: "manual", readOnly: false });
    // Grid not merely absent from the result — never even consulted for a signed URL.
    expect(createSignedDownloadUrl).not.toHaveBeenCalledWith(grid.storageKey);
  });

  it("unions manual and grid", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const proof = await seedManualProof({
      orgId, ownerPartyId: owner, apartmentId: apt, category: "cleaning", filename: "manual.pdf",
    });
    const grid = await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: "utilities_tnb", filename: "tnb.pdf",
    });
    // Entry-level attachment (no linked GridExpense) — Task 1's gridBillGroupKey must
    // route this to the never-drop "bill_grid" fallback group, not silently disappear.
    const entryLevel = await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: null, filename: "unclassified.pdf",
    });
    // Same category string as the manual proof, from the OTHER source — must MERGE into
    // one "cleaning" group (shared Map keyed by category string), not split into two
    // same-named groups just because the items came from different sources.
    const gridSameCategory = await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: "cleaning", filename: "cleaning-grid.pdf",
    });

    const res = await resolveStatementBills(ctx, owner, M, apt);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const items = res.data.flatMap((g) => g.proofs);
    expect(items.find((i) => i.source === "manual" && i.readOnly === false)).toBeTruthy();
    expect(items.find((i) => i.source === "grid" && i.readOnly === true)).toBeTruthy();
    expect(items).toHaveLength(4);

    const groupOf = (id: string) => res.data.find((g) => g.proofs.some((p) => p.id === id))?.category;
    expect(groupOf(proof.id)).toBe("cleaning");
    expect(groupOf(grid.attachmentId)).toBe("utilities_tnb"); // non-null ledgerCategory passes through
    expect(groupOf(entryLevel.attachmentId)).toBe("bill_grid"); // null ledgerCategory falls back

    const cleaningGroups = res.data.filter((g) => g.category === "cleaning");
    expect(cleaningGroups).toHaveLength(1); // one group, not two same-named groups
    expect(cleaningGroups[0]!.proofs.map((p) => p.id).sort()).toEqual(
      [proof.id, gridSameCategory.attachmentId].sort(),
    );
  });

  it("a different owner in the same org/apartment sees none of the first owner's bills", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    await seedManualProof({
      orgId, ownerPartyId: owner, apartmentId: apt, category: "cleaning", filename: "manual.pdf",
    });
    await seedGridAttachment({ orgId, apartmentId: apt, ledgerCategory: "utilities_tnb", filename: "tnb.pdf" });

    // A second owner in the SAME org with NO Listing tying them to `apt` — pins that
    // ownerPartyId reaches both repository calls in the right positional slot (both
    // orgId and ownerPartyId are plain strings, so a transposed call would type-check
    // but silently scope to the wrong party).
    const otherOwner = crypto.randomUUID();
    await getDb().party.create({
      data: { id: otherOwner, organizationId: orgId, displayName: "Other Owner", partyType: "individual", status: "active" },
    });

    const res = await resolveStatementBills(ctx, otherOwner, M, apt);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.flatMap((g) => g.proofs)).toEqual([]);
  });

  it("one sign failure degrades that item only", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const badKey = "grid/will-fail.pdf";
    const okKey = "grid/will-succeed.pdf";
    const bad = await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: "utilities_tnb", filename: "bad.pdf", storageKey: badKey,
    });
    const ok = await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: "water", filename: "ok.pdf", storageKey: okKey,
    });
    // Reject by KEY, not call order — Promise.all's result order is stable regardless of
    // resolution order, but keying on the argument value is the deterministic, honest way
    // to target exactly one row regardless of any future concurrency change.
    vi.mocked(createSignedDownloadUrl).mockImplementation(async (key: string) => {
      if (key === badKey) throw new Error("sign failed");
      return `https://signed.example/${key}`;
    });

    const res = await resolveStatementBills(ctx, owner, M, apt);
    expect(res.ok).toBe(true); // the whole call must never throw/fail for one bad item
    if (!res.ok) return;

    const items = res.data.flatMap((g) => g.proofs);
    expect(items).toHaveLength(1); // the failing item is dropped, not present as a broken stub
    expect(items[0]).toMatchObject({ id: ok.attachmentId, filename: "ok.pdf" }); // exact identity, not just "some item"
    expect(items.find((i) => i.id === bad.attachmentId)).toBeUndefined();
  });

  it("no storageKey in dto", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    await seedManualProof({
      orgId, ownerPartyId: owner, apartmentId: apt, category: "cleaning", filename: "manual.pdf",
    });
    await seedGridAttachment({
      orgId, apartmentId: apt, ledgerCategory: "utilities_tnb", filename: "tnb.pdf",
    });

    const res = await resolveStatementBills(ctx, owner, M, apt);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const items = res.data.flatMap((g) => g.proofs);
    expect(items.length).toBeGreaterThan(0); // guard against a vacuous pass on an empty array
    expect(items.every((i) => !("storageKey" in i))).toBe(true);
    // Exact key set (not just "no storageKey") — future-proofs against ANY stray field
    // leaking in later (e.g. an accidental `...row` spread), not only this one property.
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["filename", "id", "readOnly", "source", "url"]);
    }
  });

  it("grid bills query failure degrades to manual-only (never rejects)", async () => {
    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const proof = await seedManualProof({
      orgId, ownerPartyId: owner, apartmentId: apt, category: "cleaning", filename: "manual.pdf",
    });
    // Simulate a grid-query failure (e.g. a Prisma P2024 pool timeout) — the manual proof
    // above must still come back; the whole call must never reject just because the
    // flag-gated grid branch blew up.
    vi.mocked(findGridBillsForOwnerMonth).mockRejectedValueOnce(new Error("P2024: pool timeout"));

    const res = await resolveStatementBills(ctx, owner, M, apt);
    expect(res.ok).toBe(true); // degrade to manual-only, never throw/reject
    if (!res.ok) return;

    const items = res.data.flatMap((g) => g.proofs);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: proof.id, filename: "manual.pdf", source: "manual", readOnly: false });
    expect(items.find((i) => i.source === "grid")).toBeUndefined();
  });
});
