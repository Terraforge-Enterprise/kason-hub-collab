/**
 * Bills-grid attachment PREVIEW URL — getAttachmentUrlService (punch-list Item 4).
 *
 * A short-lived signed URL for INLINE preview of a GridAttachment (entry-level OR
 * per-line — one table, one id-scoped resolver, mirroring the shared DELETE route).
 * Same integration harness as line-attachment.integration.test.ts (getDb +
 * RUN_INTEGRATION gate + non-local-host guard + storage stub).
 *
 * STORAGE STUB: local Supabase storage is unconfigured, so putObject (fixture
 * upload) and createSignedDownloadUrl (the subject) are both mocked. putObject
 * resolves; createSignedDownloadUrl returns a deterministic fake URL and records
 * its (storageKey, opts) call args so the "inline, not forced-download" contract
 * (no `filename` opt) can be asserted.
 *
 * Run:
 *   export DATABASE_URL=$(grep -o 'DATABASE_URL="[^"]*"' .env | sed 's/DATABASE_URL="//;s/"$//') \
 *     && RUN_INTEGRATION=1 npm run test -w @kason/api -- attachment-url
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

import { getDb } from "@kason/db";
import { createSignedDownloadUrl } from "../../../lib/storage";
import {
  createExpensesService,
  getAttachmentUrlService,
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

// DEDICATED fixture org — see line-attachment.integration.test.ts for the full rationale.
// Adopting `organization.findFirstOrThrow()` here meant `cleanupGridFixtures(prisma, ORG)`
// wiped every grid entry / expense / bearer config in a REAL org, for every period.
const PERIOD_STR = "2026-10-01"; // a distinct month from the other bills-grid suites
const ORG = "a7730000-0000-4000-8000-000000000001";
const ACTOR = "a7730000-0000-4000-8000-000000000002";
const PROP = "a7730000-0000-4000-8000-000000000003";
let APT = "";
let EXPENSE_ID = "";
let ATT_ID = "";
let OTHER_ORG = "";

const session = (role: "editor" | "manager" | "admin" = "editor") => ({ orgId: ORG, userId: ACTOR, role });

const aFile = (name = "receipt.jpg") => ({
  filename: name,
  contentType: "image/jpeg",
  sizeBytes: 1234,
  body: Buffer.from("fake-image-bytes"),
});

/** Total, org-scoped teardown. Safe to call before a run too. */
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
    data: { id: ORG, name: "Attach URL", slug: "attach-url", status: "active", defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free" },
  });
  await prisma.user.create({
    data: { id: ACTOR, organizationId: ORG, email: "attach-url@example.test", fullName: "URL Operator", status: "active", role: "manager", userType: "operator" },
  });
  await prisma.property.create({
    data: { id: PROP, organizationId: ORG, name: "P", propertyCode: "P-ATT-URL", propertyType: "residential", addressLine1: "1", city: "KL", country: "MY", status: "active", publishStatus: "draft" },
  });
  await ensureChargeCategorySeeds(ORG);
  APT = (
    await prisma.apartment.create({
      data: { organizationId: ORG, propertyId: PROP, unitCode: "ATT-URL", listingMode: "WHOLE" },
    })
  ).id;

  const c = await createExpensesService(session("editor"), {
    apartmentId: APT,
    billingMonth: PERIOD_STR,
    bearer: "owner",
    items: [{ description: "Preview subject line", amount: "88.00", withSST: false }],
  });
  if (!c.ok) throw new Error(`fixture create failed: ${c.error}`);
  EXPENSE_ID = c.data.ids[0];

  const up = await uploadLineAttachmentService(session("editor"), EXPENSE_ID, aFile("preview-me.jpg"));
  if (!up.ok) throw new Error(`fixture upload failed: ${up.error}`);
  ATT_ID = up.data.id;

  const other = await prisma.organization.create({
    data: {
      name: "Other Org (att-url)",
      slug: `other-att-url-${Date.now()}`,
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
  await prisma.auditLog.deleteMany({
    where: { organizationId: ORG, entityType: { in: ["UnitBillsGridEntry", "GridExpense", "GridAttachment"] } },
  });
  if (OTHER_ORG) await prisma.organization.delete({ where: { id: OTHER_ORG } });
});

beforeEach(() => {
  vi.mocked(createSignedDownloadUrl).mockClear();
});

d("bills-grid attachment preview URL — getAttachmentUrlService (Item 4)", () => {
  it("U1: own attachment → 200 { downloadUrl, filename, contentType }, signed from the row's storageKey", async () => {
    const att = await prisma.gridAttachment.findUniqueOrThrow({ where: { id: ATT_ID } });

    const r = await getAttachmentUrlService(session("editor"), ATT_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe(200);
    expect(r.data.filename).toBe("preview-me.jpg");
    expect(r.data.contentType).toBe("image/jpeg");
    expect(r.data.downloadUrl).toBe(`https://signed.example/${att.storageKey}`);

    // Signed from the row's OWN storageKey.
    expect(createSignedDownloadUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSignedDownloadUrl).mock.calls[0][0]).toBe(att.storageKey);
  });

  it("U2: INLINE preview — the signed URL is minted WITHOUT a `filename` download opt (browser renders, not force-downloads)", async () => {
    await getAttachmentUrlService(session("editor"), ATT_ID);
    const opts = vi.mocked(createSignedDownloadUrl).mock.calls[0][1];
    // No opts, or opts without a `filename` — either way NOT a forced download.
    expect(opts?.filename).toBeUndefined();
  });

  it("U3: cross-org / non-existent attId → 404 ATTACHMENT_NOT_FOUND and NO signed URL is minted", async () => {
    const r = await getAttachmentUrlService({ orgId: OTHER_ORG }, ATT_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(404);
    expect(r.error).toBe("ATTACHMENT_NOT_FOUND");
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});
