import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Storage: mock putObject + createSignedDownloadUrl + fetchStorageBuffer exactly
// like the document-templates / reservations tests — NEVER touch a real bucket.
// fetchStorageBuffer returns a small PDF-ish buffer by default (the proof-bundle
// download seam); per-test overrides drive the merge / image branches.
vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}`),
  fetchStorageBuffer: vi.fn(async () => Buffer.from("%PDF-attachment")),
  // No-orphan cleanup seam: regenerate deletes the OLD object on a key change.
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
}));

// Document-templates pipeline: mock htmlToPdf to return a tiny Buffer (NEVER
// launch real Chromium), stub render + template resolution, and stub mergePdfs
// (the pdf-lib append seam) so we can assert WHETHER it ran without loading
// pdf-lib. The mock tags the output so the merged-buffer assertion can see it.
vi.mock("../../../lib/document-templates/pdf", () => ({
  htmlToPdf: vi.fn(async () => Buffer.from("%PDF-stub")),
}));
vi.mock("../../../lib/document-templates/render", () => ({
  renderToHtml: vi.fn(() => "<html>stub</html>"),
}));
vi.mock("../../../lib/document-templates/service", () => ({
  getTemplateForOrgDocType: vi.fn(async () => ({ docType: "owner_statement", title: "Owner Statement" })),
}));
vi.mock("../../../lib/document-templates/merge-pdfs", () => ({
  mergePdfs: vi.fn(async (base: Buffer) => Buffer.concat([base, Buffer.from("-merged")])),
}));

// 5-section assembler — the render source of truth shared with the GET
// /sections endpoint and the owner portal. Mocked to a small valid fixture.
vi.mock("../owner-statement-sections", () => ({
  assembleYannieStatement: vi.fn(),
}));

// Owner-billing repository: DB never reached. withTransaction runs the callback
// with a `{}` tx stub; in-tx helpers mocked directly. findStatementById feeds
// the owner/period derivation; findOwnerLedgerAttachmentKeysForMonth feeds the
// proof-bundle key collection.
vi.mock("../owner-billing.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  findStatementById: vi.fn(),
  setStatementPdfKey: vi.fn(),
  findOwnerLedgerAttachmentKeysForMonth: vi.fn(async () => []),
  resolveOwnerUnitsForMonth: vi.fn(async () => []),
  findFeeConfigsForOwner: vi.fn(async () => []),
}));

import { recordAudit } from "../../../lib/audit";
import { putObject, createSignedDownloadUrl, fetchStorageBuffer, deleteObject } from "../../../lib/storage";
import { htmlToPdf } from "../../../lib/document-templates/pdf";
import { renderToHtml } from "../../../lib/document-templates/render";
import { mergePdfs } from "../../../lib/document-templates/merge-pdfs";
import { assembleYannieStatement } from "../owner-statement-sections";
import type { YannieSections } from "../owner-statement-sections";
import {
  findStatementById,
  setStatementPdfKey,
  findOwnerLedgerAttachmentKeysForMonth,
  type DbInvoice,
} from "../owner-billing.repository";
import {
  regenerateStatementPdf,
  getStatementPdfUrl,
  renderCleanStatementPdfBytes,
} from "../owner-billing.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const UNIT = "00000000-0000-0000-0000-0000000000c1";
const INVOICE = "00000000-0000-0000-0000-0000000000d1";
const ISO = "2026-06-15T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const };

const dec = (s: string) => ({ toString: () => s }) as unknown as DbInvoice["totalAmount"];

function statement(inv: Partial<DbInvoice> = {}): DbInvoice {
  return {
    id: INVOICE,
    organizationId: ORG,
    invoiceNumber: "OS-202606-aaaaaaaa",
    partyId: OWNER,
    ownerPartyId: OWNER,
    tenancyId: null,
    propertyId: null,
    invoiceType: "owner_statement",
    status: "draft",
    invoiceDate: new Date(ISO),
    dueDate: null,
    periodMonth: new Date(Date.UTC(2026, 5, 1)),
    totalAmount: dec("316.00"),
    sstAmount: dec("16.00"),
    currency: "MYR",
    pdfKey: null,
    attachmentKeys: [],
    idempotencyKey: `owner:${OWNER}:2026-06`,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    charges: [
      {
        id: "chg-fee",
        chargeNumber: "OSC-1",
        chargeType: "management_fee",
        unitId: UNIT,
        description: null,
        amount: dec("200.00"),
        currency: "MYR",
        status: "draft",
        attachmentKeys: [],
        updatedAt: new Date(ISO),
      },
      {
        id: "chg-clean",
        chargeNumber: "OSC-2",
        chargeType: "cleaning",
        unitId: UNIT,
        description: null,
        amount: dec("100.00"),
        currency: "MYR",
        status: "draft",
        attachmentKeys: [],
        updatedAt: new Date(ISO),
      },
    ],
    ...inv,
  } as unknown as DbInvoice;
}

/** A small but complete YannieSections fixture for the (real) PDF body render. */
function sectionsFixture(): YannieSections {
  return {
    header: {
      reportMonth: "June 2026",
      propertyName: "Park Villa 9",
      ownerName: "Tan Ah Kow",
      bankName: "Maybank",
      accountHolder: "Tan Ah Kow",
      accountNumberMasked: "••••1234",
    },
    apartmentId: null,
    occupancy: { rows: [], occupiedCount: 0, vacantCount: 0, totalMonthlyRental: "0.00" },
    payoutSummary: { lines: [], netPayoutToOwner: "0.00", depositCollected: "0.00", depositHeld: "0.00" },
    incomeBreakdown: { rows: [], totalIncome: "0.00", passThroughIncome: "0.00", totalMgmtFee: "0.00" },
    expenseBreakdown: { rows: [], totalExpenses: "0.00" },
  };
}

// The stored key now carries the apartment segment so two apartment-scoped
// statements for the same owner+month never COLLIDE on one object. apartmentId
// null (the legacy owner-combined fixture below) → "combined".
const EXPECTED_KEY = `owner-statements/${OWNER}/202606-combined.pdf`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setStatementPdfKey).mockResolvedValue(statement());
  vi.mocked(assembleYannieStatement).mockResolvedValue(sectionsFixture());
  vi.mocked(findOwnerLedgerAttachmentKeysForMonth).mockResolvedValue([]);
});

describe("regenerateStatementPdf (admin)", () => {
  it("renders the 5-section statement + stores the PDF, persists pdfKey, audits, returns a signed URL", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement());

    const result = await regenerateStatementPdf(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The 5-section assembler is the render source of truth (ctx + id forwarded).
    expect(assembleYannieStatement).toHaveBeenCalledWith(ctx, INVOICE);

    // putObject called with an "owner-statements/<owner>/<YYYYMM>.pdf" key + the
    // tiny stub buffer + the application/pdf content type.
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putObject).mock.calls[0]![0]).toBe(EXPECTED_KEY);
    expect(vi.mocked(putObject).mock.calls[0]![2]).toBe("application/pdf");

    // htmlToPdf was invoked (the render pipeline ran) — NEVER a real Chromium.
    expect(htmlToPdf).toHaveBeenCalledTimes(1);

    // No attachments → no proof-bundle download + no pdf-lib merge.
    expect(fetchStorageBuffer).not.toHaveBeenCalled();
    expect(mergePdfs).not.toHaveBeenCalled();

    // Invoice.pdfKey persisted in-tx with the SAME key.
    expect(setStatementPdfKey).toHaveBeenCalledWith({}, ORG, INVOICE, EXPECTED_KEY);

    // Audit in-tx with the locked action + Invoice entityType.
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordAudit).mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        action: "owner-billing.statement.regeneratePdf",
        entityType: "Invoice",
        entityId: INVOICE,
      }),
    );

    // The result carries the pdfKey + a freshly-minted signed URL.
    expect(result.data.pdfKey).toBe(EXPECTED_KEY);
    expect(result.data.downloadUrl).toBe(`https://signed.example/${EXPECTED_KEY}`);
  });

  it("ignores statement + ledger attachments — stores the CLEAN render, never folds in bills", async () => {
    // Even WITH a statement-level receipt AND a ledger-level scanned bill for the
    // month, the regenerated statement is the clean 5-section render: no download,
    // no pdf-lib merge, no appended bill pages. Bills live separately now.
    vi.mocked(findStatementById).mockResolvedValue(
      statement({ attachmentKeys: ["owner-statements/o1/receipt.jpg"] }),
    );
    vi.mocked(findOwnerLedgerAttachmentKeysForMonth).mockResolvedValue([
      "owner-statements/o1/june-tnb-bill.pdf",
    ]);

    const result = await regenerateStatementPdf(ctx, INVOICE);
    expect(result.ok).toBe(true);

    // No proof-bundle download, no merge.
    expect(fetchStorageBuffer).not.toHaveBeenCalled();
    expect(mergePdfs).not.toHaveBeenCalled();
    // The stored object's page count == the clean render's: it is EXACTLY the
    // htmlToPdf output, with no "-merged" tag (no appended bill pages).
    expect(vi.mocked(putObject).mock.calls[0]![1].toString()).toBe("%PDF-stub");
    // …and the rendered body names no bill ("attached separately" is gone).
    const renderBodyHtml = vi.mocked(renderToHtml).mock.calls[0]![0].bodyHtml;
    expect(renderBodyHtml).not.toContain("attached separately");
    expect(renderBodyHtml).not.toContain("june-tnb-bill");
  });

  it("two apartments' statements for one owner+month produce DISTINCT pdfKeys + objects", async () => {
    // Apartment-scoped statements share owner+month; the key carries the apartment
    // (first 8 of apartmentId) so the second never OVERWRITES the first.
    const APT_A = "aaaaaaaa-1111-4111-8111-111111111111";
    const APT_B = "bbbbbbbb-2222-4222-8222-222222222222";

    vi.mocked(findStatementById).mockResolvedValue(statement({ apartmentId: APT_A }));
    const a = await regenerateStatementPdf(ctx, INVOICE);
    vi.mocked(findStatementById).mockResolvedValue(statement({ apartmentId: APT_B }));
    const b = await regenerateStatementPdf(ctx, INVOICE);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const keyA = `owner-statements/${OWNER}/202606-${APT_A.slice(0, 8)}.pdf`;
    const keyB = `owner-statements/${OWNER}/202606-${APT_B.slice(0, 8)}.pdf`;
    expect(a.data.pdfKey).toBe(keyA);
    expect(b.data.pdfKey).toBe(keyB);
    expect(keyA).not.toBe(keyB);

    // Two distinct objects written (one per apartment) at the two distinct keys.
    const writtenKeys = vi.mocked(putObject).mock.calls.map((c) => c[0]);
    expect(writtenKeys).toEqual([keyA, keyB]);
  });

  it("NO ORPHAN: deletes the OLD pdf object when regenerating to a DIFFERENT key", async () => {
    // The statement was first stored under the legacy "…/<YYYYMM>.pdf" key; the new
    // key now carries the apartment segment ("…-combined.pdf"). The prior object
    // must be deleted so its bytes are not orphaned (standing no-orphan directive).
    const OLD_KEY = `owner-statements/${OWNER}/202606.pdf`;
    vi.mocked(findStatementById).mockResolvedValue(statement({ pdfKey: OLD_KEY }));

    const result = await regenerateStatementPdf(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // New object written + pdfKey repointed to the new key…
    expect(result.data.pdfKey).toBe(EXPECTED_KEY);
    expect(vi.mocked(putObject).mock.calls[0]![0]).toBe(EXPECTED_KEY);
    // …then EXACTLY ONE best-effort delete of the OLD key (storageKey is arg 1).
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteObject).mock.calls[0]![1]).toBe(OLD_KEY);
  });

  it("does NOT delete when the regenerated key EQUALS the existing key (overwrite in place, no self-orphan)", async () => {
    // Same-key regenerate: putObject upserts the object in place, so there is no
    // prior object to clean up — a delete here would self-orphan the fresh bytes.
    vi.mocked(findStatementById).mockResolvedValue(statement({ pdfKey: EXPECTED_KEY }));

    const result = await regenerateStatementPdf(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.pdfKey).toBe(EXPECTED_KEY);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("404s for a cross-org / unknown statement (no PDF written, assembler never run)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);

    const result = await regenerateStatementPdf(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(putObject).not.toHaveBeenCalled();
    expect(setStatementPdfKey).not.toHaveBeenCalled();
    expect(assembleYannieStatement).not.toHaveBeenCalled();
  });

  it("400s when the assembler returns null (no owner / billing period)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement());
    vi.mocked(assembleYannieStatement).mockResolvedValue(null);

    const result = await regenerateStatementPdf(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(putObject).not.toHaveBeenCalled();
    expect(setStatementPdfKey).not.toHaveBeenCalled();
  });
});

describe("renderCleanStatementPdfBytes (pure renderer)", () => {
  it("returns the clean PDF bytes with NO putObject / NO pdfKey write / NO audit", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement());

    const bytes = await renderCleanStatementPdfBytes(ctx, INVOICE);

    // Returns the htmlToPdf output as a Buffer (the single source of statement bytes).
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString()).toBe("%PDF-stub");
    // Built from the 5-section assemble → one-arg buildYanniePdfHtml → render pipeline.
    expect(assembleYannieStatement).toHaveBeenCalledWith(ctx, INVOICE);
    expect(renderToHtml).toHaveBeenCalledTimes(1);
    expect(htmlToPdf).toHaveBeenCalledTimes(1);

    // PURE / side-effect-free: no storage write, no pdfKey persistence, no audit row.
    expect(putObject).not.toHaveBeenCalled();
    expect(setStatementPdfKey).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    // …and never folds in bills (no download, no merge).
    expect(fetchStorageBuffer).not.toHaveBeenCalled();
    expect(mergePdfs).not.toHaveBeenCalled();
  });
});

describe("getStatementPdfUrl (manager)", () => {
  it("returns a signed url when pdfKey is present", async () => {
    const key = `owner-statements/${OWNER}/202606.pdf`;
    vi.mocked(findStatementById).mockResolvedValue(statement({ pdfKey: key }));

    const result = await getStatementPdfUrl(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.downloadUrl).toBe(`https://signed.example/${key}`);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(key);
  });

  it("404s 'PDF not generated' when pdfKey is absent", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement({ pdfKey: null }));

    const result = await getStatementPdfUrl(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("PDF not generated");
  });

  it("404s for a cross-org / unknown statement", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);

    const result = await getStatementPdfUrl(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});
