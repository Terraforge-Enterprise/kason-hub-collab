import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Mock the storage helper exactly like the receipts tests: the send path mints a
// signed download URL for the statement PDF — return a stub so the service is
// tested without a real bucket.
// approveStatementService now calls regenerateStatementPdf (post-commit PDF freshness)
// so putObject + deleteObject + requireBucket must also be mocked to avoid touching
// a real bucket.
vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(async () => "https://signed.example/owner-statement.pdf"),
  putObject: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
  requireBucket: vi.fn(() => "test-bucket"),
  fetchStorageBuffer: vi.fn(async () => Buffer.from("%PDF-attachment")),
}));

// regenerateStatementPdf calls assembleYannieStatement → mock to return null so the
// function short-circuits with a non-fatal 400 before touching storage / Chromium.
// approveStatementService treats a failed regenerate as a non-fatal console.warn:
// the approve still succeeds (ok:true, status:200). This keeps the unit test
// DB-free while preserving all approve-logic assertions.
vi.mock("../owner-statement-sections", () => ({
  assembleYannieStatement: vi.fn(async () => null),
}));

// Mock the repository so the DB is never reached — the service is tested in
// isolation. withTransaction runs the callback with a `{}` tx stub; the in-tx
// repo helpers are mocked directly (mirrors owner-billing.statement-lines.test.ts).
vi.mock("../owner-billing.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  findStatementById: vi.fn(),
  transitionStatementStatusGuarded: vi.fn(),
  setStatementPdfKey: vi.fn(),
  findOwnerLedgerAttachmentKeysForMonth: vi.fn(async () => []),
  resolveOwnerUnitsForMonth: vi.fn(async () => []),
  findFeeConfigsForOwner: vi.fn(async () => []),
  findDocumentSeriesInTx: vi.fn(),
}));

// redesign P1 — OST- statement numbering collaborators (mirrors
// expenses.service.test.ts's mock shape for the SAME mintDocumentNumberTx /
// ensureChargeCategorySeeds pair).
vi.mock("../../../lib/reference-codes/series-numbers", () => ({
  mintDocumentNumberTx: vi.fn(),
}));
vi.mock("../../charge-categories/seed", () => ({
  ensureChargeCategorySeeds: vi.fn(),
}));

import { recordAudit } from "../../../lib/audit";
import { createSignedDownloadUrl } from "../../../lib/storage";
import { StaleUpdateError } from "../../../lib/concurrency-error";
import { mintDocumentNumberTx } from "../../../lib/reference-codes/series-numbers";
import { ensureChargeCategorySeeds } from "../../charge-categories/seed";
import { assembleYannieStatement } from "../owner-statement-sections";
import {
  findStatementById,
  transitionStatementStatusGuarded,
  findDocumentSeriesInTx,
  type DbCharge,
  type DbInvoice,
} from "../owner-billing.repository";
import {
  approveStatementService,
  sendStatementService,
  voidStatementService,
} from "../owner-billing.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const INVOICE = "00000000-0000-0000-0000-0000000000d1";
const ISO = "2026-06-15T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const };

const dec = (s: string) => ({ toString: () => s }) as unknown as DbCharge["amount"];

function statement(status: string, inv: Partial<DbInvoice> = {}): DbInvoice {
  return {
    id: INVOICE,
    organizationId: ORG,
    invoiceNumber: "OS-202606-aaaaaaaa",
    partyId: OWNER,
    ownerPartyId: OWNER,
    tenancyId: null,
    propertyId: null,
    invoiceType: "owner_statement",
    status,
    invoiceDate: new Date(ISO),
    dueDate: null,
    periodMonth: new Date(Date.UTC(2026, 5, 1)),
    totalAmount: dec("316.00") as unknown as DbInvoice["totalAmount"],
    sstAmount: dec("16.00") as unknown as DbInvoice["sstAmount"],
    currency: "MYR",
    pdfKey: null,
    attachmentKeys: [],
    idempotencyKey: `owner:${OWNER}:2026-06`,
    approvedBy: null,
    approvedAt: null,
    statementNumber: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...inv,
    charges: [],
  } as unknown as DbInvoice;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assembleYannieStatement)
    .mockResolvedValueOnce({
      header: {
        reportMonth: "June 2026",
        propertyName: "Test Property",
        ownerName: "Test Owner",
        bankName: "Test Bank",
        accountHolder: "Test Owner",
        accountNumberMasked: "1234567890",
      },
      apartmentId: null,
      occupancy: { rows: [], occupiedCount: 0, vacantCount: 0, totalMonthlyRental: "0.00" },
      payoutSummary: { lines: [], netPayoutToOwner: "0.00", depositCollected: "0.00", depositHeld: "0.00" },
      incomeBreakdown: { rows: [], totalIncome: "0.00", passThroughIncome: "0.00", totalMgmtFee: "0.00" },
      expenseBreakdown: { rows: [], totalExpenses: "0.00" },
    })
    .mockResolvedValue(null);
  // withTransaction's tx here is a bare `{}` stub (see the repository mock
  // above) — it doesn't implement the raw Prisma tx methods issueStatementCreditNoteTx
  // needs for the void→CN path. That flag-on behavior has dedicated coverage in
  // statement-void-cn.integration.test.ts against a real DB. Force dark so a
  // full-suite run with ENABLE_PHASE2_BILLING_DOCS=1 set globally doesn't leak
  // into this file's void tests.
  delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  // redesign P1 — force dark by default so a full-suite run with this flag set
  // globally doesn't leak into tests that don't explicitly opt in.
  delete process.env.ENABLE_OWNER_DOC_NUMBERING;
});

// ─── approve ────────────────────────────────────────────────────────────────

describe("approveStatementService", () => {
  it("approves a DRAFT statement → approved + audit owner-billing.statement.approve", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("draft"));
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(statement("approved"));

    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.status).toBe("approved");

    // Guarded transition keyed on the pre-read updatedAt → "approved", AND it
    // stamps the first-class approval-provenance columns (approvedBy = actor,
    // approvedAt = now) in the same guarded write so they are not left null.
    expect(transitionStatementStatusGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      ISO,
      "approved",
      expect.objectContaining({ approvedBy: ACTOR, approvedAt: expect.any(Date) }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.statement.approve",
        entityType: "Invoice",
        entityId: INVOICE,
      }),
    );
  });

  it("approving a NON-draft (approved) statement → 409, no write", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("approved"));
    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  // ── redesign P1: OST- statement display numbering ───────────────────────────

  it("(flag ON) mints an OST- number and stamps it in the SAME guarded transition as approvedBy/approvedAt", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    vi.mocked(findStatementById).mockResolvedValue(statement("draft"));
    vi.mocked(findDocumentSeriesInTx).mockResolvedValue({
      id: "series-ost",
      organizationId: ORG,
      code: "OST",
      prefix: "OST",
      padding: 4,
      includeYear: false,
      active: true,
      createdAt: new Date(ISO),
      updatedAt: new Date(ISO),
    });
    vi.mocked(mintDocumentNumberTx).mockResolvedValue("OST-0001");
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(
      statement("approved", { statementNumber: "OST-0001" }),
    );

    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The org's OST series is ensured (lazy per-org seed) BEFORE the mint.
    expect(ensureChargeCategorySeeds).toHaveBeenCalledWith(ORG);
    expect(findDocumentSeriesInTx).toHaveBeenCalledWith(expect.anything(), ORG, "OST");
    expect(mintDocumentNumberTx).toHaveBeenCalledTimes(1);

    // Stamped in the SAME guarded write as approvedBy/approvedAt (mirrors that
    // pair's own "single guarded write" idiom) — never a second, separate update.
    expect(transitionStatementStatusGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      ISO,
      "approved",
      expect.objectContaining({
        approvedBy: ACTOR,
        approvedAt: expect.any(Date),
        statementNumber: "OST-0001",
      }),
    );
  });

  it("(flag OFF) never mints — the guarded write carries no statementNumber key at all", async () => {
    // ENABLE_OWNER_DOC_NUMBERING intentionally left unset (beforeEach forces dark).
    vi.mocked(findStatementById).mockResolvedValue(statement("draft"));
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(statement("approved"));

    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);

    expect(ensureChargeCategorySeeds).not.toHaveBeenCalled();
    expect(findDocumentSeriesInTx).not.toHaveBeenCalled();
    expect(mintDocumentNumberTx).not.toHaveBeenCalled();
    // Exact (non-partial) match: proves `statementNumber` is not merely undefined
    // but ABSENT from the object entirely — omitted from `data`, so the guarded
    // UPDATE never touches that column.
    expect(transitionStatementStatusGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      ISO,
      "approved",
      { approvedBy: ACTOR, approvedAt: expect.any(Date) },
    );
  });

  it("(flag ON, defensive idempotency) a draft that ALREADY carries a statementNumber is never re-minted", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    vi.mocked(findStatementById).mockResolvedValue(statement("draft", { statementNumber: "OST-0007" }));
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(
      statement("approved", { statementNumber: "OST-0007" }),
    );

    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);

    expect(ensureChargeCategorySeeds).not.toHaveBeenCalled();
    expect(mintDocumentNumberTx).not.toHaveBeenCalled();
    expect(transitionStatementStatusGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      ISO,
      "approved",
      { approvedBy: ACTOR, approvedAt: expect.any(Date) },
    );
  });

  it("(flag ON) re-approving an already-approved (numbered) statement → 409, mint never attempted, no write", async () => {
    process.env.ENABLE_OWNER_DOC_NUMBERING = "true";
    vi.mocked(findStatementById).mockResolvedValue(statement("approved", { statementNumber: "OST-0001" }));

    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(ensureChargeCategorySeeds).not.toHaveBeenCalled();
    expect(mintDocumentNumberTx).not.toHaveBeenCalled();
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
  });

  it("approving a SENT statement → 409, no write", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("sent"));
    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
  });

  it("404s a cross-org / unknown statement id (no write)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);
    const result = await approveStatementService(ctx, INVOICE);
    expect(result).toEqual({ ok: false, status: 404, error: "Statement not found" });
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
  });

  it("maps a stale guarded transition to 409 with the EXACT message", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("draft"));
    vi.mocked(transitionStatementStatusGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await approveStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("Record changed — reloaded");
  });
});

// ─── void ───────────────────────────────────────────────────────────────────

describe("voidStatementService", () => {
  it("voids a DRAFT statement → void + audit owner-billing.statement.void", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("draft"));
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(statement("void"));

    const result = await voidStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.status).toBe("void");
    expect(transitionStatementStatusGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      ISO,
      "void",
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "owner-billing.statement.void", entityType: "Invoice" }),
    );
  });

  it("voids an APPROVED statement → void (any non-paid state)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("approved"));
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(statement("void"));
    const result = await voidStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("void");
  });

  it("voids a SENT statement → void (any non-paid state)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("sent"));
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(statement("void"));
    const result = await voidStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("void");
  });

  it("voiding a PAID statement → 409, no write", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("paid"));
    const result = await voidStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("voiding an already-void statement → 409 (idempotent guard, no write)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("void"));
    const result = await voidStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
  });

  it("404s a cross-org / unknown statement id", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);
    const result = await voidStatementService(ctx, INVOICE);
    expect(result).toEqual({ ok: false, status: 404, error: "Statement not found" });
  });

  it("maps a stale guarded transition to 409 with the EXACT message", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("draft"));
    vi.mocked(transitionStatementStatusGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await voidStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("Record changed — reloaded");
  });
});

// ─── send (soft-copy only; NEVER auto-send) ──────────────────────────────────

describe("sendStatementService", () => {
  it("sends an APPROVED statement WITH a pdfKey → sent + signed download URL", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("approved", { pdfKey: "owner-statements/aa/os-202606.pdf" }),
    );
    vi.mocked(transitionStatementStatusGuarded).mockResolvedValue(
      statement("sent", { pdfKey: "owner-statements/aa/os-202606.pdf" }),
    );

    const result = await sendStatementService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.statement.status).toBe("sent");
    expect(result.data.downloadUrl).toBe("https://signed.example/owner-statement.pdf");

    // The URL is minted from the statement's pdfKey.
    expect(createSignedDownloadUrl).toHaveBeenCalledWith("owner-statements/aa/os-202606.pdf");
    // Guarded transition keyed on the pre-read updatedAt → "sent".
    expect(transitionStatementStatusGuarded).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      ISO,
      "sent",
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "owner-billing.statement.send", entityType: "Invoice" }),
    );
  });

  it("sending a DRAFT statement → 409, no write, no URL", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("draft", { pdfKey: "owner-statements/aa/os-202606.pdf" }),
    );
    const result = await sendStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("sending an APPROVED statement with NO pdfKey → 400 (generate the PDF first), no write", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement("approved", { pdfKey: null }));
    const result = await sendStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(transitionStatementStatusGuarded).not.toHaveBeenCalled();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("404s a cross-org / unknown statement id", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);
    const result = await sendStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.error).toBe("Statement not found");
  });

  it("maps a stale guarded transition to 409 with the EXACT message", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement("approved", { pdfKey: "owner-statements/aa/os-202606.pdf" }),
    );
    vi.mocked(transitionStatementStatusGuarded).mockRejectedValue(new StaleUpdateError());
    const result = await sendStatementService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("Record changed — reloaded");
  });
});
