/**
 * Bills-grid PER-LINE attachments — upload + list services (Task 2, spec R5/R6).
 *
 * Integration suite (RUN_INTEGRATION=1) against the real local Postgres, mirroring
 * expense-category.integration.test.ts's harness convention (getDb + RUN_INTEGRATION
 * gate + non-local-host guard) — under Prisma 7 the datasource has no `url`, so the
 * client is only constructible through @kason/db's PrismaPg adapter.
 *
 * STORAGE STUB (mandatory — local Supabase storage is unconfigured, so putObject
 * would throw `SUPABASE_STORAGE_BUCKET is not configured` on the happy path). We
 * `vi.mock("../../../lib/storage", …)` the storage module: `putObject` is a spy the
 * per-test controls — resolved for the happy + 404 rows, made to REJECT for the 502
 * fail-closed row (via mockRejectedValueOnce). `requireBucket` is stubbed harmlessly
 * (the mocked putObject never reaches it, but the service module imports it).
 *
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *     && RUN_INTEGRATION=1 npm run test -w @kason/api -- line-attachment
 * (DATABASE_URL in this worktree's .env already points at the dedicated
 * kaenproperties_cat_t3 DB — export it so vitest's process sees it.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

import { getDb } from "@kason/db";
import { putObject } from "../../../lib/storage";
import {
  createExpensesService,
  listLineAttachmentService,
  uploadLineAttachmentService,
} from "../service";
import { cleanupGridFixtures } from "./cleanup";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";

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
// DEDICATED fixture org, never `organization.findFirstOrThrow()`.
//
// This suite used to adopt whatever org came back first — in a dev database that is a
// REAL org — and then tore down with `cleanupGridFixtures(prisma, ORG)`, which deletes
// every UnitBillsGridEntry / GridExpense / UnitBillsBearerConfig in that org for EVERY
// period. One `RUN_INTEGRATION=1` run over bills-grid therefore destroyed real grid data
// (observed 2026-07-28: a unit's saved entry, its 4 expenses and its bearer config, plus
// the org's seeded ChargeCategories and DocumentSeries via the sibling suites).
//
// Fixed ids in an isolated namespace keep teardown total AND org-scoped, so the suite can
// never reach anything it did not create. Same reasoning as itemized-mint.test.ts.
const PERIOD_STR = "2026-09-01"; // a distinct month from the other bills-grid suites
const ORG = "a7720000-0000-4000-8000-000000000001";
const ACTOR = "a7720000-0000-4000-8000-000000000002";
const PROP = "a7720000-0000-4000-8000-000000000003";
let APT = "";
let EXPENSE_ID = ""; // an own, persisted GridExpense (the upload/list subject)

let OTHER_ORG = "";

const session = (role: "editor" | "manager" | "admin" = "editor") => ({ orgId: ORG, userId: ACTOR, role });

const aFile = (name = "receipt.jpg") => ({
  filename: name,
  contentType: "image/jpeg",
  sizeBytes: 1234,
  body: Buffer.from("fake-image-bytes"),
});

/** Total, org-scoped teardown. Safe to call before a run too — a crashed prior run
 * leaves the fixture org behind, and every row hangs off it. */
async function dropFixtureOrg() {
  await cleanupGridFixtures(prisma, ORG);
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.apartment.deleteMany({ where: { organizationId: ORG } });
  await prisma.chargeCategory.deleteMany({ where: { organizationId: ORG } });
  await prisma.documentSeries.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

beforeAll(async () => {
  if (!RUN) return;
  await dropFixtureOrg(); // clear anything a crashed prior run left behind
  await prisma.organization.create({
    data: { id: ORG, name: "Line Attach T2", slug: `line-attach-t2`, status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await prisma.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "line-attach-t2@example.test", fullName: "T2 Operator", status: "active", role: "manager", userType: "operator" },
  });
  await prisma.property.create({
    data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-ATT-T2", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await ensureChargeCategorySeeds(ORG);
  APT = (
    await prisma.apartment.create({
      data: { organizationId: ORG, propertyId: PROP, unitCode: "ATT-T2", listingMode: "WHOLE" },
    })
  ).id;

  // Create one own, persisted GridExpense via the real create service (also
  // creates its parent UnitBillsGridEntry) — this is the line we attach to.
  const c = await createExpensesService(session("editor"), {
    apartmentId: APT,
    billingMonth: PERIOD_STR,
    bearer: "owner",
    items: [{ description: "Aircond receipt line", amount: "150.00", withSST: false }],
  });
  if (!c.ok) throw new Error(`fixture create failed: ${c.error}`);
  EXPENSE_ID = c.data.ids[0];

  // A DIFFERENT org — the cross-org 404 subject.
  const other = await prisma.organization.create({
    data: {
      name: "Other Org (T2 attach)",
      slug: `other-att-t2-${Date.now()}`,
      status: "active",
      defaultCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      locale: "en-MY",
      subscriptionPlan: "free",
    },
  });
  OTHER_ORG = other.id;
});

afterAll(async () => {
  if (!RUN) return;
  await dropFixtureOrg();
  if (OTHER_ORG) await prisma.organization.delete({ where: { id: OTHER_ORG } });
});

beforeEach(() => {
  vi.mocked(putObject).mockReset();
  vi.mocked(putObject).mockResolvedValue(undefined); // default: storage confirms (2xx)
});

d("bills-grid per-line attachments — upload + list (Task 2)", () => {
  it("B1: upload on an own expense persists a GridAttachment with expenseId + line-scoped key; list surfaces it", async () => {
    const r = await uploadLineAttachmentService(session("editor"), EXPENSE_ID, aFile("b1-receipt.jpg"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(201);

    // putObject was called with the line-scoped key BEFORE the row was written.
    expect(putObject).toHaveBeenCalledTimes(1);
    const keyArg = vi.mocked(putObject).mock.calls[0][0];
    expect(keyArg).toMatch(new RegExp(`^bills-grid/${ORG}/[0-9a-f-]+/${EXPENSE_ID}/[0-9a-f-]+-b1-receipt\\.jpg$`));
    expect(r.data.storageKey).toBe(keyArg);

    // The row exists with expenseId = this line and entryId/apartmentId/periodMonth
    // copied from the expense.
    const exp = await prisma.gridExpense.findUniqueOrThrow({ where: { id: EXPENSE_ID } });
    const row = await prisma.gridAttachment.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.expenseId).toBe(EXPENSE_ID);
    expect(row.entryId).toBe(exp.entryId);
    expect(row.apartmentId).toBe(exp.apartmentId);
    expect(row.periodMonth.toISOString()).toBe(exp.periodMonth.toISOString());
    expect(row.storageKey).toBe(r.data.storageKey);
    // Storage key really embeds the {entryId}/{expenseId} segments.
    expect(row.storageKey).toContain(`/${exp.entryId}/${EXPENSE_ID}/`);

    // list surfaces exactly this attachment for the line.
    const l = await listLineAttachmentService(session("editor"), EXPENSE_ID);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const listed = l.data.items.find((x) => x.id === r.data.id);
    expect(listed).toBeDefined();
    expect(listed!.filename).toBe("b1-receipt.jpg");
    expect(listed!.storageKey).toBe(r.data.storageKey);
    // Projection: createdAt is an ISO string (not a Date), uploadedBy surfaced.
    expect(typeof listed!.createdAt).toBe("string");
    expect(listed!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listed!.uploadedBy).toBe(ACTOR);

    // Audit row written IN the same transaction as the attachment row.
    const audits = await prisma.auditLog.count({
      where: { organizationId: ORG, action: "grid.line-attachment.upload", entityId: r.data.id },
    });
    expect(audits).toBe(1);
  });

  it("B2: upload with a cross-org / non-existent expenseId → 404 EXPENSE_NOT_FOUND and writes NO row (putObject never called)", async () => {
    const before = await prisma.gridAttachment.count({ where: { organizationId: ORG } });

    // Same real expense id, but a session scoped to a DIFFERENT org → the
    // org-scoped findFirst misses. This is the SOLE cross-org defense.
    const r = await uploadLineAttachmentService(
      { orgId: OTHER_ORG, userId: ACTOR, role: "editor" },
      EXPENSE_ID,
      aFile("should-not-persist.jpg"),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
    expect(r.error).toBe("EXPENSE_NOT_FOUND");

    // Fail BEFORE storage — putObject must never have been reached — and NO row.
    expect(putObject).not.toHaveBeenCalled();
    expect(await prisma.gridAttachment.count({ where: { organizationId: ORG } })).toBe(before);
    expect(await prisma.gridAttachment.count({ where: { organizationId: OTHER_ORG } })).toBe(0);
    // No audit for the cross-org attempt.
    expect(
      await prisma.auditLog.count({ where: { organizationId: OTHER_ORG, action: "grid.line-attachment.upload" } }),
    ).toBe(0);
  });

  it("B3: putObject throws → 502 ATTACHMENT_UPLOAD_FAILED and NO GridAttachment row is written (fail-closed)", async () => {
    const before = await prisma.gridAttachment.count({ where: { organizationId: ORG, expenseId: EXPENSE_ID } });
    vi.mocked(putObject).mockRejectedValueOnce(new Error("storage down"));

    const r = await uploadLineAttachmentService(session("editor"), EXPENSE_ID, aFile("b3-doomed.jpg"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(502);
    expect(r.error).toBe("ATTACHMENT_UPLOAD_FAILED");

    // putObject WAS attempted (proving the failure is the storage throw, not a
    // pre-storage guard), but NO row was written for this line.
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(await prisma.gridAttachment.count({ where: { organizationId: ORG, expenseId: EXPENSE_ID } })).toBe(before);
    // Belt-and-braces: no row anywhere carries the doomed filename.
    expect(await prisma.gridAttachment.count({ where: { filename: "b3-doomed.jpg" } })).toBe(0);
    // And the public read path confirms it too — the doomed file never surfaces.
    const l = await listLineAttachmentService(session("editor"), EXPENSE_ID);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.data.items.some((x) => x.filename === "b3-doomed.jpg")).toBe(false);
    // No audit for the failed upload.
    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: "grid.line-attachment.upload", meta: { path: ["filename"], equals: "b3-doomed.jpg" } },
      }),
    ).toBe(0);
  });

  it("B4: list with a cross-org / non-existent expenseId → 404 EXPENSE_NOT_FOUND (list-side cross-org defense)", async () => {
    const r = await listLineAttachmentService({ orgId: OTHER_ORG }, EXPENSE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
    expect(r.error).toBe("EXPENSE_NOT_FOUND");
  });

  it("B7: list is scoped by expenseId, not entryId — a SECOND line on the same entry returns only its own attachments", async () => {
    // A second expense on the SAME apartment-month (⇒ same parent entry).
    const c2 = await createExpensesService(session("editor"), {
      apartmentId: APT,
      billingMonth: PERIOD_STR,
      bearer: "owner",
      items: [{ description: "Second line — different receipt", amount: "20.00", withSST: false }],
    });
    expect(c2.ok).toBe(true);
    if (!c2.ok) return;
    const expense2 = c2.data.ids[0];

    // Same parent entry as EXPENSE_ID (guards that the test really exercises the
    // expenseId filter and not an entryId one).
    const e1 = await prisma.gridExpense.findUniqueOrThrow({ where: { id: EXPENSE_ID } });
    const e2 = await prisma.gridExpense.findUniqueOrThrow({ where: { id: expense2 } });
    expect(e2.entryId).toBe(e1.entryId);

    const up2 = await uploadLineAttachmentService(session("editor"), expense2, aFile("b7-line2.jpg"));
    expect(up2.ok).toBe(true);
    if (!up2.ok) return;

    // Listing line 2 returns ONLY line 2's file — none of line 1's (B1's b1-receipt.jpg).
    const l2 = await listLineAttachmentService(session("editor"), expense2);
    expect(l2.ok).toBe(true);
    if (!l2.ok) return;
    expect(l2.data.items.map((x) => x.id)).toEqual([up2.data.id]);
    expect(l2.data.items.every((x) => x.filename === "b7-line2.jpg")).toBe(true);

    // And listing line 1 still does NOT include line 2's file.
    const l1 = await listLineAttachmentService(session("editor"), EXPENSE_ID);
    expect(l1.ok).toBe(true);
    if (!l1.ok) return;
    expect(l1.data.items.some((x) => x.filename === "b7-line2.jpg")).toBe(false);
  });

  it("B8: list on a valid own expense with NO attachments → 200 { items: [] } (distinct from the 404 missing-expense case)", async () => {
    const c3 = await createExpensesService(session("editor"), {
      apartmentId: APT,
      billingMonth: PERIOD_STR,
      bearer: "owner",
      items: [{ description: "Line with no attachments", amount: "5.00", withSST: false }],
    });
    expect(c3.ok).toBe(true);
    if (!c3.ok) return;

    const r = await listLineAttachmentService(session("editor"), c3.data.ids[0]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.data.items).toEqual([]);
  });

  it("B9: two uploads to one line → two distinct rows (distinct UUIDs + storage keys), both listed in createdAt asc", async () => {
    const c4 = await createExpensesService(session("editor"), {
      apartmentId: APT,
      billingMonth: PERIOD_STR,
      bearer: "owner",
      items: [{ description: "Multi-file line", amount: "30.00", withSST: false }],
    });
    expect(c4.ok).toBe(true);
    if (!c4.ok) return;
    const line = c4.data.ids[0];

    const a = await uploadLineAttachmentService(session("editor"), line, aFile("b9-first.jpg"));
    expect(a.ok).toBe(true);
    const b = await uploadLineAttachmentService(session("editor"), line, aFile("b9-second.jpg"));
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.data.id).not.toBe(b.data.id);
    expect(a.data.storageKey).not.toBe(b.data.storageKey);

    const l = await listLineAttachmentService(session("editor"), line);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    // Exactly these two, in createdAt ascending order (first-uploaded first).
    expect(l.data.items.map((x) => x.filename)).toEqual(["b9-first.jpg", "b9-second.jpg"]);
  });
});
