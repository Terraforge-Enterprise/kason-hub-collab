/**
 * Integration tests for the proof pack's GRID source.
 *
 * The owner-statement Bills & Proof panel has read-time-unioned the manual
 * OwnerExpenseProof store with GridAttachment since the grid-bills work
 * (`resolveStatementBills`, flag ENABLE_GRID_BILLS_ON_OWNER_STATEMENT). The proof
 * pack — the bundle the Owner Ledger's "Print Invoice" button APPENDS to the
 * itemised receipt (`buildReceiptWithBillsPdf` → `buildProofPackPdf`) — did not:
 * it read `findProofsForOwnerMonth` alone. So an admin who attached a bill on the
 * bills grid saw it on screen and then got a printed invoice with nothing appended.
 *
 * These tests pin the two surfaces to ONE source list: whatever the panel shows,
 * the print appends. Flag OFF keeps today's manual-only behaviour byte-for-byte.
 *
 * Hits a real LOCAL Postgres (RUN_INTEGRATION=1); storage is mocked. Run:
 *   set -a; . /Users/cadistan/Documents/Github/Kason-Hub/.env; set +a
 *   RUN_INTEGRATION=1 npx vitest run \
 *     src/modules/owner-billing/__tests__/proof-pack.grid-union.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  fetchStorageBuffer: vi.fn(),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
}));

import { getDb } from "@kason/db";
import { PDFDocument } from "pdf-lib";
import { fetchStorageBuffer } from "../../../lib/storage";
import { buildProofPackPdf } from "../proof-pack.service";
import { resolveStatementBills } from "../statement-bills";
import type { OwnerBillingActorCtx } from "../owner-billing.types";

const RUN = process.env.RUN_INTEGRATION === "1";
const dn = RUN ? describe : describe.skip;

if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

const M = "2026-07";
const MONTH = new Date(Date.UTC(2026, 6, 1));

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function onePagePdf(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  return Buffer.from(await d.save());
}

function ctxFor(orgId: string): OwnerBillingActorCtx {
  return { orgId, actorUserId: crypto.randomUUID(), actorRole: "admin" };
}

/** Disjoint org per test (mirrors statement-bills.aggregator.integration.test.ts). */
async function seedOwnerApartment() {
  const db = getDb();
  const orgId = crypto.randomUUID();
  const ownerPartyId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const apartmentId = crypto.randomUUID();
  const listingId = crypto.randomUUID();

  await db.organization.create({
    data: {
      id: orgId, name: "PPG Org", slug: `ppg-org-${orgId}`, status: "active",
      defaultCurrency: "MYR", timezone: "Asia/Kuala_Lumpur", locale: "en-MY", subscriptionPlan: "free",
    },
  });
  await db.party.create({
    data: { id: ownerPartyId, organizationId: orgId, displayName: "PPG Owner", partyType: "individual", status: "active" },
  });
  await db.property.create({
    data: {
      id: propertyId, organizationId: orgId, name: "PPG Property", propertyCode: "PPG-P1",
      propertyType: "apartment", addressLine1: "1 Pack St", city: "KL", country: "MY",
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

async function seedManualProof(orgId: string, ownerPartyId: string, apartmentId: string, storageKey: string) {
  await getDb().ownerExpenseProof.create({
    data: {
      organizationId: orgId, ownerPartyId, statementMonth: MONTH, apartmentId,
      category: "utilities_tnb", storageKey, filename: "manual-tnb.pdf",
      uploadedById: crypto.randomUUID(),
    },
  });
}

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

/** `ledgerCategory: null` ⇒ the UNIT-level attachment the bills-grid AttachmentsPanel writes
 *  (expenseId null); a string ⇒ the ROW-level attachment the ExpensesDialog writes. */
async function seedGridAttachment(opts: {
  orgId: string; apartmentId: string; ledgerCategory: string | null; filename: string; storageKey: string;
}) {
  const db = getDb();
  const entryId = await getOrCreateGridEntry(opts.orgId, opts.apartmentId);
  const actorId = crypto.randomUUID();
  let expenseId: string | null = null;
  if (opts.ledgerCategory !== null) {
    const seriesId = crypto.randomUUID();
    const categoryId = crypto.randomUUID();
    expenseId = crypto.randomUUID();
    await db.documentSeries.create({
      data: { id: seriesId, organizationId: opts.orgId, code: `PPG-SER-${seriesId.slice(0, 8)}`, prefix: "PPG" },
    });
    await db.chargeCategory.create({
      data: {
        id: categoryId, organizationId: opts.orgId, code: `ppg-cat-${categoryId.slice(0, 8)}`,
        name: `PPG Category ${categoryId.slice(0, 8)}`, family: "owner_income", docType: "invoice",
        seriesId, ledgerCategory: opts.ledgerCategory,
      },
    });
    await db.gridExpense.create({
      data: {
        id: expenseId, organizationId: opts.orgId, entryId, apartmentId: opts.apartmentId,
        periodMonth: MONTH, description: "Owner expense", amount: "100.00",
        chargeCategoryId: categoryId, createdBy: actorId,
      },
    });
  }
  await db.gridAttachment.create({
    data: {
      id: crypto.randomUUID(), organizationId: opts.orgId, apartmentId: opts.apartmentId,
      periodMonth: MONTH, entryId, expenseId, storageKey: opts.storageKey, filename: opts.filename,
      contentType: "application/pdf", sizeBytes: 1024, uploadedBy: actorId,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;
});

afterEach(() => {
  delete process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT;
});

dn("buildProofPackPdf — grid attachments (the 'Print Invoice' append)", () => {
  it("flag ON: a UNIT-level grid attachment lands in the pack even with no manual proof", async () => {
    const { orgId, ownerPartyId, apartmentId } = await seedOwnerApartment();
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: null,
      filename: "unit-level-tnb.pdf", storageKey: "grid/unit-level-tnb.pdf",
    });
    const pdf = await onePagePdf();
    vi.mocked(fetchStorageBuffer).mockResolvedValue(pdf);

    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const bytes = await buildProofPackPdf(ctxFor(orgId), ownerPartyId, M, apartmentId);

    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect((await PDFDocument.load(bytes!)).getPageCount()).toBe(1);
  });

  it("flag ON: a ROW-level grid attachment lands in the pack too", async () => {
    const { orgId, ownerPartyId, apartmentId } = await seedOwnerApartment();
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: "repairs",
      filename: "row-level-repair.pdf", storageKey: "grid/row-level-repair.pdf",
    });
    vi.mocked(fetchStorageBuffer).mockResolvedValue(await onePagePdf());

    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const bytes = await buildProofPackPdf(ctxFor(orgId), ownerPartyId, M, apartmentId);

    expect(bytes).not.toBeNull();
    expect((await PDFDocument.load(bytes!)).getPageCount()).toBe(1);
  });

  it("flag ON: manual + grid bills BOTH appear — one page each, no dedupe collapse", async () => {
    const { orgId, ownerPartyId, apartmentId } = await seedOwnerApartment();
    await seedManualProof(orgId, ownerPartyId, apartmentId, "manual/tnb.pdf");
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: "repairs",
      filename: "row-level-repair.png", storageKey: "grid/row-level-repair.png",
    });
    const pdf = await onePagePdf();
    vi.mocked(fetchStorageBuffer).mockImplementation(async (key: string) =>
      key === "manual/tnb.pdf" ? pdf : key === "grid/row-level-repair.png" ? PNG_1x1 : null,
    );

    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const bytes = await buildProofPackPdf(ctxFor(orgId), ownerPartyId, M, apartmentId);

    expect(bytes).not.toBeNull();
    expect((await PDFDocument.load(bytes!)).getPageCount()).toBe(2);
  });

  it("the printed pack and the on-screen panel agree on the SAME bill count", async () => {
    const { orgId, ownerPartyId, apartmentId } = await seedOwnerApartment();
    await seedManualProof(orgId, ownerPartyId, apartmentId, "manual/tnb.pdf");
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: null,
      filename: "unit-level.pdf", storageKey: "grid/unit-level.pdf",
    });
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: "repairs",
      filename: "row-level.pdf", storageKey: "grid/row-level.pdf",
    });
    vi.mocked(fetchStorageBuffer).mockResolvedValue(await onePagePdf());

    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const panel = await resolveStatementBills(ctxFor(orgId), ownerPartyId, M, apartmentId);
    const onScreen = panel.ok ? panel.data.flatMap((g) => g.proofs).length : -1;
    const bytes = await buildProofPackPdf(ctxFor(orgId), ownerPartyId, M, apartmentId);
    const printed = bytes ? (await PDFDocument.load(bytes)).getPageCount() : 0;

    expect(onScreen).toBe(3);
    expect(printed).toBe(onScreen);
  });

  it("flag OFF: grid attachments stay out — manual-only parity with today", async () => {
    const { orgId, ownerPartyId, apartmentId } = await seedOwnerApartment();
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: "repairs",
      filename: "row-level-repair.pdf", storageKey: "grid/row-level-repair.pdf",
    });
    vi.mocked(fetchStorageBuffer).mockResolvedValue(await onePagePdf());

    const bytes = await buildProofPackPdf(ctxFor(orgId), ownerPartyId, M, apartmentId);

    expect(bytes).toBeNull();
    expect(fetchStorageBuffer).not.toHaveBeenCalled();
  });

  it("flag ON but a FOREIGN owner asks: the attribution gate still yields nothing", async () => {
    const { orgId, apartmentId } = await seedOwnerApartment();
    await seedGridAttachment({
      orgId, apartmentId, ledgerCategory: "repairs",
      filename: "row-level-repair.pdf", storageKey: "grid/row-level-repair.pdf",
    });
    vi.mocked(fetchStorageBuffer).mockResolvedValue(await onePagePdf());

    process.env.ENABLE_GRID_BILLS_ON_OWNER_STATEMENT = "1";
    const stranger = crypto.randomUUID();
    const bytes = await buildProofPackPdf(ctxFor(orgId), stranger, M, apartmentId);

    expect(bytes).toBeNull();
  });
});
