/**
 * Bills-grid expenses — `chargeCategoryId` threading + cross-org ownership guard (Task 4).
 *
 * Integration suite (RUN_INTEGRATION=1) against the real local Postgres, mirroring
 * service.integration.test.ts's harness convention (getDb + RUN_INTEGRATION gate +
 * non-local-host guard) — under Prisma 7 the datasource has no `url`, so the client
 * is only constructible through @kason/db's PrismaPg adapter.
 *
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *     && RUN_INTEGRATION=1 npm run test -w @kason/api -- expense-category.integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@kason/db";
import { createExpensesService, listExpensesService, updateExpenseService } from "../service";

import { cleanupGridFixtures } from "./cleanup";

const prisma = getDb();

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
let ACTOR = "";
const PERIOD_STR = "2026-08-01"; // a distinct month from service.integration.test.ts's 2026-07-01
let ORG = "";
let APT = "";       // B1/B4: happy create + list surfacing
let APT_MULTI = ""; // B6: multi-item partial-write guard
let APT_LOCKED = ""; // B8: ENTRY_LOCKED-vs-category precedence
let APT_FOREIGN = ""; // B9: injected foreign chargeCategoryId, read-path leak check
let APT_INACTIVE = ""; // B10/B11 (review fix A): in-org but deactivated category, create + update
let FIX_APTS: string[] = [];

let OTHER_ORG = "";
let OTHER_SERIES = "";
let OTHER_CATEGORY = ""; // a real ChargeCategory row that belongs to OTHER_ORG

let SERIES = "";     // this org's DocumentSeries
let CATEGORY = "";    // this org's ChargeCategory (profitExpense: "expense")
let CATEGORY_2 = "";  // a second in-org category, for the update-to-a-new-category case
let CATEGORY_INACTIVE = ""; // review fix A: in-org but active:false — must be rejected on attach

const session = (role: "editor" | "manager" | "admin") => ({ orgId: ORG, userId: ACTOR, role });

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  ACTOR = (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG } })).id;

  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  const mkApt = async (tag: string) =>
    (await prisma.apartment.create({
      data: { organizationId: ORG, propertyId: prop.id, unitCode: `CAT-${tag}-${Date.now()}`, listingMode: "WHOLE" },
    })).id;
  APT = await mkApt("HAPPY");
  APT_MULTI = await mkApt("MULTI");
  APT_LOCKED = await mkApt("LOCKED");
  APT_FOREIGN = await mkApt("FOREIGN");
  APT_INACTIVE = await mkApt("INACTIVE");
  FIX_APTS = [APT, APT_MULTI, APT_LOCKED, APT_FOREIGN, APT_INACTIVE];

  // This org's DocumentSeries + two ChargeCategory rows.
  const series = await prisma.documentSeries.create({
    data: { organizationId: ORG, code: `CATT4-${Date.now()}`, prefix: "CTT", padding: 4, includeYear: false },
  });
  SERIES = series.id;
  const cat = await prisma.chargeCategory.create({
    data: {
      organizationId: ORG, code: `catt4-${Date.now()}`, name: `Cat T4 ${Date.now()}`,
      family: "tenant_income", docType: "invoice", seriesId: SERIES,
      profitExpense: "expense",
    },
  });
  CATEGORY = cat.id;
  const cat2 = await prisma.chargeCategory.create({
    data: {
      organizationId: ORG, code: `catt4b-${Date.now()}`, name: `Cat T4 B ${Date.now()}`,
      family: "tenant_income", docType: "invoice", seriesId: SERIES,
      profitExpense: "profit",
    },
  });
  CATEGORY_2 = cat2.id;

  // Review fix A: an in-org, deactivated (active:false) category — direct fixture
  // update (equivalent to deactivateChargeCategoryService's effect) rather than
  // routing through that service, since we don't need its isSystem interaction here.
  const catInactive = await prisma.chargeCategory.create({
    data: {
      organizationId: ORG, code: `catt4c-${Date.now()}`, name: `Cat T4 Inactive ${Date.now()}`,
      family: "tenant_income", docType: "invoice", seriesId: SERIES,
      profitExpense: "expense", active: false,
    },
  });
  CATEGORY_INACTIVE = catInactive.id;

  // A DIFFERENT org, with its OWN DocumentSeries + ChargeCategory — the cross-org subject.
  const other = await prisma.organization.create({
    data: { name: "Other Org (T4)", slug: `other-t4-${Date.now()}`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  OTHER_ORG = other.id;
  const otherSeries = await prisma.documentSeries.create({
    data: { organizationId: OTHER_ORG, code: `OTHT4-${Date.now()}`, prefix: "OTT", padding: 4, includeYear: false },
  });
  OTHER_SERIES = otherSeries.id;
  const otherCat = await prisma.chargeCategory.create({
    data: {
      organizationId: OTHER_ORG, code: `otht4-${Date.now()}`, name: `Other Cat T4 ${Date.now()}`,
      family: "tenant_income", docType: "invoice", seriesId: OTHER_SERIES,
      profitExpense: "profit",
    },
  });
  OTHER_CATEGORY = otherCat.id;

  await prisma.unitBillsGridEntry.deleteMany({ where: { organizationId: ORG, periodMonth: new Date(`${PERIOD_STR}T00:00:00.000Z`) } });
});

afterAll(async () => {
  if (!RUN) return;
  await cleanupGridFixtures(prisma, ORG, { apartmentIds: [APT, APT_MULTI, APT_LOCKED, APT_FOREIGN, APT_INACTIVE].filter(Boolean) });
  if (FIX_APTS.length) await prisma.apartment.deleteMany({ where: { id: { in: FIX_APTS } } });
  await prisma.auditLog.deleteMany({
    where: { organizationId: ORG, entityType: { in: ["UnitBillsGridEntry", "GridExpense", "GridAttachment", "UnitBillsBearerConfig"] } },
  });
  // OTHER_ORG is CREATED by this suite, so org-wide is correct there.
  // ORG is ADOPTED (`organization.findFirstOrThrow()`), which in a dev database is a REAL
  // org — deleting its categories/series org-wide destroyed the 37 seeded ChargeCategories
  // and 13 DocumentSeries every run, and with the series gone the org could not issue a
  // single document. Delete ONLY the rows this suite created there.
  // Categories before series: ChargeCategory.seriesId is onDelete: Restrict.
  await prisma.chargeCategory.deleteMany({
    where: { id: { in: [CATEGORY, CATEGORY_2, CATEGORY_INACTIVE].filter(Boolean) } },
  });
  await prisma.documentSeries.deleteMany({ where: { id: { in: [SERIES].filter(Boolean) } } });
  await prisma.chargeCategory.deleteMany({ where: { organizationId: OTHER_ORG } });
  await prisma.documentSeries.deleteMany({ where: { organizationId: OTHER_ORG } });
  await prisma.organization.delete({ where: { id: OTHER_ORG } });
});

d("bills-grid expenses — chargeCategoryId threading + cross-org guard", () => {
  it("B1: create with an in-org chargeCategoryId → list surfaces chargeCategoryId + category.name/.profitExpense", async () => {
    const items = [{ description: "Aircond service", amount: "150.00", withSST: true, chargeCategoryId: CATEGORY }];
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner", items,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const l = await listExpensesService(session("editor"), { apartmentId: APT, billingMonth: PERIOD_STR });
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const row = l.data.items.find((x) => x.id === c.data.ids[0]);
    expect(row).toBeDefined();
    expect(row!.chargeCategoryId).toBe(CATEGORY);
    expect(row!.category).toEqual({ name: expect.any(String), profitExpense: "expense" });
  });

  it("B4: create with chargeCategoryId omitted → stores null, list shows category: null", async () => {
    const items = [{ description: "Uncategorised repair", amount: "40.00", withSST: false }];
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner", items,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;

    const l = await listExpensesService(session("editor"), { apartmentId: APT, billingMonth: PERIOD_STR });
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const row = l.data.items.find((x) => x.id === c.data.ids[0]);
    expect(row).toBeDefined();
    expect(row!.chargeCategoryId).toBeNull();
    expect(row!.category).toBeNull();
  });

  it("B2: create with a cross-org chargeCategoryId → 400 CATEGORY_NOT_FOUND, NOTHING written", async () => {
    const beforeExpenses = await prisma.gridExpense.count({ where: { organizationId: ORG } });
    const beforeEntries = await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT } });

    const items = [{ description: "Should not persist", amount: "99.00", withSST: false, chargeCategoryId: OTHER_CATEGORY }];
    const r = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: "2026-10-01", bearer: "owner", items,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("CATEGORY_NOT_FOUND");

    // Nothing written — including no stray parent UnitBillsGridEntry for the fresh period.
    expect(await prisma.gridExpense.count({ where: { organizationId: ORG } })).toBe(beforeExpenses);
    expect(await prisma.unitBillsGridEntry.count({
      where: { organizationId: ORG, apartmentId: APT, periodMonth: new Date("2026-10-01T00:00:00.000Z") },
    })).toBe(0);
    expect(await prisma.gridExpense.count({ where: { organizationId: OTHER_ORG } })).toBe(0);
  });

  it("B6: multi-item create, item[0] valid in-org + item[2] cross-org → 400, ZERO rows written (not even item[0])", async () => {
    const beforeExpenses = await prisma.gridExpense.count({ where: { organizationId: ORG } });

    const items = [
      { description: "Valid item 0", amount: "10.00", withSST: false, chargeCategoryId: CATEGORY },
      { description: "Valid item 1, no category", amount: "20.00", withSST: false },
      { description: "Bad item 2", amount: "30.00", withSST: false, chargeCategoryId: OTHER_CATEGORY },
    ];
    const r = await createExpensesService(session("editor"), {
      apartmentId: APT_MULTI, billingMonth: PERIOD_STR, bearer: "owner", items,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("CATEGORY_NOT_FOUND");

    // ZERO rows written — item[0] and item[1] must NOT have been persisted either.
    expect(await prisma.gridExpense.count({ where: { organizationId: ORG } })).toBe(beforeExpenses);
    expect(await prisma.gridExpense.count({ where: { organizationId: ORG, apartmentId: APT_MULTI } })).toBe(0);
  });

  it("B3: update with a cross-org chargeCategoryId → 400 CATEGORY_NOT_FOUND, expense unchanged", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Update-target", amount: "55.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];
    const before = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });

    const r = await updateExpenseService(session("editor"), expenseId, { chargeCategoryId: OTHER_CATEGORY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("CATEGORY_NOT_FOUND");

    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.chargeCategoryId).toBeNull(); // unchanged — the cross-org id was never applied
    expect(after.updatedAt).toEqual(before.updatedAt); // no partial write, not even the updatedAt bump
  });

  it("B5: update with a valid in-org chargeCategoryId → succeeds, list reflects the new category", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Recategorise me", amount: "77.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    const r = await updateExpenseService(session("editor"), expenseId, { chargeCategoryId: CATEGORY_2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const l = await listExpensesService(session("editor"), { apartmentId: APT, billingMonth: PERIOD_STR });
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const row = l.data.items.find((x) => x.id === expenseId);
    expect(row).toBeDefined();
    expect(row!.chargeCategoryId).toBe(CATEGORY_2);
    expect(row!.category).toEqual({ name: expect.any(String), profitExpense: "profit" });

    // A sibling correctness guard: updating description-ONLY (chargeCategoryId omitted)
    // on an expense that ALREADY has a category must NOT clear it. This is the silent
    // data-loss failure mode of `data: { ..., chargeCategoryId: body.chargeCategoryId }`
    // if Prisma's updateMany treated an explicit `undefined` value as "set to null"
    // rather than "leave untouched" (it does the latter, matching description/amount/
    // withSST's existing optional-field behaviour) — verified here, not assumed.
    const r2 = await updateExpenseService(session("editor"), expenseId, { description: "Recategorise me (renamed)" });
    expect(r2.ok).toBe(true);
    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.chargeCategoryId).toBe(CATEGORY_2); // still there — description-only update did not clobber it
    expect(after.description).toBe("Recategorise me (renamed)");
  });

  it("B7: update with chargeCategoryId: null (explicit) on an expense that already HAS a category → clears it", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Clear my category", amount: "12.00", withSST: false, chargeCategoryId: CATEGORY }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    const r = await updateExpenseService(session("editor"), expenseId, { chargeCategoryId: null });
    expect(r.ok).toBe(true);

    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.chargeCategoryId).toBeNull();

    const l = await listExpensesService(session("editor"), { apartmentId: APT, billingMonth: PERIOD_STR });
    if (!l.ok) throw new Error("expected 200");
    const row = l.data.items.find((x) => x.id === expenseId);
    expect(row!.category).toBeNull();
  });

  it("B8: update against a BILLED entry with a cross-org chargeCategoryId → 409 ENTRY_LOCKED (wins over 400 CATEGORY_NOT_FOUND)", async () => {
    // Bill APT_LOCKED's period first, using an expense with no category.
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT_LOCKED, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Pre-bill expense", amount: "5.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];

    const entry = await prisma.unitBillsGridEntry.findFirstOrThrow({
      where: { organizationId: ORG, apartmentId: APT_LOCKED, periodMonth: new Date(`${PERIOD_STR}T00:00:00.000Z`) },
    });
    await prisma.unitBillsGridEntry.update({ where: { id: entry.id }, data: { billedAt: new Date(), lockedBy: ACTOR } });

    const r = await updateExpenseService(session("manager"), expenseId, { chargeCategoryId: OTHER_CATEGORY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409); // ENTRY_LOCKED wins — never leaks that the category is also invalid
    expect(r.error).toBe("ENTRY_LOCKED");
  });

  it("B9: a GridExpense whose chargeCategoryId points to ANOTHER org's category does not leak that category's name into the list (defence in depth)", async () => {
    // Injected directly, bypassing the now-hardened write path — simulates legacy/
    // tampered data, mirroring service.integration.test.ts's "FINDING 2 (read)" pattern.
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT_FOREIGN, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Foreign-category injection target", amount: "8.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    await prisma.gridExpense.update({ where: { id: c.data.ids[0] }, data: { chargeCategoryId: OTHER_CATEGORY } });

    const l = await listExpensesService(session("editor"), { apartmentId: APT_FOREIGN, billingMonth: PERIOD_STR });
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const row = l.data.items.find((x) => x.id === c.data.ids[0]);
    expect(row).toBeDefined();
    // Prisma's `include` resolves the relation by raw FK id with NO organizationId
    // predicate of its own — so if this ever regresses, the foreign category's real
    // name would leak straight into this org's list. Pinning it as `null` documents
    // the expected (safe) behavior TODAY; see Concerns in the task report re: whether
    // an explicit org-scoped guard is warranted here going forward.
    expect(row!.category).toBeNull();
    // Review fix C: the raw FK id must ALSO null out when its relation resolved to
    // null (org-scoped miss) — otherwise the list shows category:null next to a
    // non-null chargeCategoryId pointing at a foreign-org row, an inconsistent pair.
    expect(row!.chargeCategoryId).toBeNull();
  });

  it("B10 (review fix A): create with an in-org but DEACTIVATED (active:false) chargeCategoryId → 400 CATEGORY_INACTIVE, nothing written", async () => {
    const beforeExpenses = await prisma.gridExpense.count({ where: { organizationId: ORG } });
    const beforeEntries = await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT_INACTIVE } });

    const items = [{ description: "Should not persist (inactive category)", amount: "42.00", withSST: false, chargeCategoryId: CATEGORY_INACTIVE }];
    const r = await createExpensesService(session("editor"), {
      apartmentId: APT_INACTIVE, billingMonth: PERIOD_STR, bearer: "owner", items,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("CATEGORY_INACTIVE");

    // Nothing written — mirrors B2's stray-parent-entry guard for CATEGORY_NOT_FOUND.
    expect(await prisma.gridExpense.count({ where: { organizationId: ORG } })).toBe(beforeExpenses);
    expect(await prisma.unitBillsGridEntry.count({ where: { organizationId: ORG, apartmentId: APT_INACTIVE } })).toBe(beforeEntries);
  });

  it("B11 (review fix A): update with an in-org but DEACTIVATED (active:false) chargeCategoryId → 400 CATEGORY_INACTIVE, expense unchanged", async () => {
    const c = await createExpensesService(session("editor"), {
      apartmentId: APT_INACTIVE, billingMonth: PERIOD_STR, bearer: "owner",
      items: [{ description: "Update-target (inactive category)", amount: "63.00", withSST: false }],
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const expenseId = c.data.ids[0];
    const before = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });

    const r = await updateExpenseService(session("editor"), expenseId, { chargeCategoryId: CATEGORY_INACTIVE });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("CATEGORY_INACTIVE");

    const after = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(after.chargeCategoryId).toBeNull(); // unchanged — the inactive category was never applied
    expect(after.updatedAt).toEqual(before.updatedAt); // no partial write, not even the updatedAt bump
  });
});
