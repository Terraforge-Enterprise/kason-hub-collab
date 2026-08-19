import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Mock the storage helper exactly like tasks-media tests: putObject is a no-op
// that records its calls, so the service is tested without a real bucket.
// createSignedDownloadUrl returns a deterministic per-key URL so the view-URL
// service can be asserted without touching Supabase.
vi.mock("../../../lib/storage", () => ({
  putObject: vi.fn(async () => undefined),
  createSignedDownloadUrl: vi.fn(async (key: string) => `https://signed.example/${key}?token=t`),
}));

// Mock the repository so the DB is never reached — the service is tested in
// isolation. withTransaction runs the callback with a `{}` tx stub; the in-tx
// repo helpers are mocked directly (mirrors owner-billing.statement-lines.test.ts).
vi.mock("../owner-billing.repository", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
  findStatementById: vi.fn(),
  findInvoiceByIdInTx: vi.fn(),
  findStatementByIdInTx: vi.fn(),
  appendInvoiceAttachmentKeys: vi.fn(),
  appendChargeAttachmentKeys: vi.fn(),
  detachInvoiceAttachmentKey: vi.fn(),
  detachChargeAttachmentKey: vi.fn(),
}));

import { recordAudit } from "../../../lib/audit";
import { createSignedDownloadUrl, putObject } from "../../../lib/storage";
import {
  appendChargeAttachmentKeys,
  appendInvoiceAttachmentKeys,
  detachChargeAttachmentKey,
  detachInvoiceAttachmentKey,
  findStatementById,
  findStatementByIdInTx,
  type DbCharge,
  type DbInvoice,
} from "../owner-billing.repository";
import {
  detachReceiptService,
  listReceiptUrlsService,
  uploadReceiptsService,
} from "../owner-billing-receipts.service";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000002";
const OWNER = "00000000-0000-0000-0000-0000000000aa";
const UNIT = "00000000-0000-0000-0000-0000000000c1";
const INVOICE = "00000000-0000-0000-0000-0000000000d1";
const CHARGE = "00000000-0000-0000-0000-0000000000e1";
const ISO = "2026-06-15T00:00:00.000Z";

const ctx = { orgId: ORG, actorUserId: ACTOR, actorRole: "admin" as const };

const dec = (s: string) => ({ toString: () => s }) as unknown as DbCharge["amount"];

function dbCharge(overrides: Partial<DbCharge> = {}): DbCharge {
  return {
    id: CHARGE,
    organizationId: ORG,
    chargeNumber: "OSC-202606-aaaaaaaa-0001",
    tenancyId: null,
    unitId: UNIT,
    partyId: OWNER,
    chargeType: "tnb",
    status: "draft",
    description: "TNB June",
    dueDate: new Date(Date.UTC(2026, 5, 1)),
    postedAt: null,
    amount: dec("120.00"),
    currency: "MYR",
    outstandingAmount: dec("120.00"),
    waivedReason: null,
    cancelledReason: null,
    isDisputed: false,
    disputeReason: null,
    disputeStatus: null,
    disputeResolution: null,
    disputeResolvedAt: null,
    chargeableFrom: null,
    chargeableTo: null,
    lateFeeApplied: false,
    lateFeeAmount: null,
    parentChargeId: null,
    attachmentKeys: [],
    invoiceId: INVOICE,
    approvedBy: null,
    approvedAt: null,
    billingMonth: new Date(Date.UTC(2026, 5, 1)),
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...overrides,
  } as DbCharge;
}

function statement(lines: Partial<DbCharge>[], inv: Partial<DbInvoice> = {}): DbInvoice {
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
    totalAmount: dec("120.00") as unknown as DbInvoice["totalAmount"],
    sstAmount: dec("0.00") as unknown as DbInvoice["sstAmount"],
    currency: "MYR",
    pdfKey: null,
    attachmentKeys: [],
    idempotencyKey: `owner:${OWNER}:2026-06`,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(ISO),
    updatedAt: new Date(ISO),
    ...inv,
    charges: lines.map((l, i) => dbCharge({ id: `chg-${i}`, ...l })),
  } as unknown as DbInvoice;
}

const RECEIPT_RE = new RegExp(`^owner-statements/${OWNER}/receipts/[0-9a-f-]{36}\\.pdf$`);
const pdfFile = (name = "receipt.pdf") => ({
  filename: name,
  mimeType: "application/pdf",
  content: Buffer.from("%PDF-1.4 fake"),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uploadReceiptsService", () => {
  it("statement-level: appends the uploaded key(s) to Invoice.attachmentKeys + audits", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement([{ chargeType: "tnb" }]));
    vi.mocked(findStatementByIdInTx).mockResolvedValue(statement([{ chargeType: "tnb" }]));
    vi.mocked(appendInvoiceAttachmentKeys).mockImplementation(
      async (_tx, _org, _inv, keys) => statement([{ chargeType: "tnb" }], { attachmentKeys: keys }),
    );

    const result = await uploadReceiptsService(ctx, INVOICE, [pdfFile()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);

    // The key was minted under owner-statements/<ownerPartyId>/receipts/<uuid>.pdf
    const putCall = vi.mocked(putObject).mock.calls[0]!;
    const storedKey = putCall[0] as string;
    expect(storedKey).toMatch(RECEIPT_RE);

    // Appended to the INVOICE (statement-level — no chargeId), not a Charge.
    expect(appendInvoiceAttachmentKeys).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      [storedKey],
    );
    expect(appendChargeAttachmentKeys).not.toHaveBeenCalled();
    expect(result.data.attachmentKeys).toEqual([storedKey]);

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "owner-billing.statement.receipt.attach",
        entityType: "Invoice",
        entityId: INVOICE,
      }),
    );
  });

  it("uploads MULTIPLE files → both keys appended in one call", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement([]));
    vi.mocked(findStatementByIdInTx).mockResolvedValue(statement([]));
    vi.mocked(appendInvoiceAttachmentKeys).mockImplementation(
      async (_tx, _org, _inv, keys) => statement([], { attachmentKeys: keys }),
    );

    const result = await uploadReceiptsService(ctx, INVOICE, [pdfFile("a.pdf"), pdfFile("b.pdf")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(putObject).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(appendInvoiceAttachmentKeys).mock.calls[0]![3] as string[];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(RECEIPT_RE);
  });

  it("line-level: a chargeId on the statement appends to Charge.attachmentKeys (not the Invoice)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb" }]),
    );
    vi.mocked(findStatementByIdInTx).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb" }]),
    );
    vi.mocked(appendChargeAttachmentKeys).mockImplementation(
      async (_tx, _org, _inv, _chg, keys) => dbCharge({ id: CHARGE, attachmentKeys: keys }),
    );

    const result = await uploadReceiptsService(ctx, INVOICE, [pdfFile()], CHARGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const putCall = vi.mocked(putObject).mock.calls[0]!;
    const storedKey = putCall[0] as string;
    expect(storedKey).toMatch(RECEIPT_RE);

    expect(appendChargeAttachmentKeys).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      CHARGE,
      [storedKey],
    );
    expect(appendInvoiceAttachmentKeys).not.toHaveBeenCalled();

    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "owner-billing.statement.receipt.attach",
        entityType: "Charge",
        entityId: CHARGE,
      }),
    );
  });

  it("404s a cross-org / unknown statement (no upload, no write)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);
    const result = await uploadReceiptsService(ctx, INVOICE, [pdfFile()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(putObject).not.toHaveBeenCalled();
    expect(appendInvoiceAttachmentKeys).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("404s a chargeId that is not on the statement", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement([{ id: "other", chargeType: "tnb" }]));
    const result = await uploadReceiptsService(ctx, INVOICE, [pdfFile()], CHARGE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("400s an empty upload (no files)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement([]));
    const result = await uploadReceiptsService(ctx, INVOICE, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("400s an unsupported mime type without uploading", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement([]));
    const result = await uploadReceiptsService(ctx, INVOICE, [
      { filename: "x.exe", mimeType: "application/x-msdownload", content: Buffer.from("MZ") },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(putObject).not.toHaveBeenCalled();
  });
});

describe("detachReceiptService", () => {
  it("removes a key from Invoice.attachmentKeys (statement-level) + audits; NEVER deletes a Charge", async () => {
    const key = `owner-statements/${OWNER}/receipts/11111111-2222-3333-4444-555555555555.pdf`;
    vi.mocked(findStatementByIdInTx).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb", attachmentKeys: [] }], { attachmentKeys: [key] }),
    );
    vi.mocked(detachInvoiceAttachmentKey).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb" }], { attachmentKeys: [] }),
    );

    const result = await detachReceiptService(ctx, INVOICE, key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    // The repo helper receives the already-FILTERED next array (the key removed).
    expect(detachInvoiceAttachmentKey).toHaveBeenCalledWith(expect.anything(), ORG, INVOICE, []);
    expect(detachChargeAttachmentKey).not.toHaveBeenCalled();
    expect(result.data.attachmentKeys).toEqual([]);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "owner-billing.statement.receipt.detach",
        entityType: "Invoice",
        entityId: INVOICE,
      }),
    );
  });

  it("removes a key that lives on a Charge (line-level) from that Charge's attachmentKeys", async () => {
    const key = `owner-statements/${OWNER}/receipts/99999999-2222-3333-4444-555555555555.pdf`;
    vi.mocked(findStatementByIdInTx).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb", attachmentKeys: [key] }], { attachmentKeys: [] }),
    );
    vi.mocked(detachChargeAttachmentKey).mockResolvedValue(
      dbCharge({ id: CHARGE, attachmentKeys: [] }),
    );

    const result = await detachReceiptService(ctx, INVOICE, key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The repo helper receives the already-FILTERED next array for that Charge.
    expect(detachChargeAttachmentKey).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      INVOICE,
      CHARGE,
      [],
    );
    expect(detachInvoiceAttachmentKey).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "owner-billing.statement.receipt.detach",
        entityType: "Charge",
        entityId: CHARGE,
      }),
    );
  });

  it("404s a key that is on neither the Invoice nor any Charge", async () => {
    vi.mocked(findStatementByIdInTx).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb", attachmentKeys: [] }], { attachmentKeys: [] }),
    );
    const key = `owner-statements/${OWNER}/receipts/00000000-2222-3333-4444-555555555555.pdf`;
    const result = await detachReceiptService(ctx, INVOICE, key);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(detachInvoiceAttachmentKey).not.toHaveBeenCalled();
    expect(detachChargeAttachmentKey).not.toHaveBeenCalled();
  });

  it("404s a cross-org / unknown statement", async () => {
    vi.mocked(findStatementByIdInTx).mockResolvedValue(null);
    const result = await detachReceiptService(
      ctx,
      INVOICE,
      `owner-statements/${OWNER}/receipts/11111111-2222-3333-4444-555555555555.pdf`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("listReceiptUrlsService", () => {
  const K1 = `owner-statements/${OWNER}/receipts/aaaaaaaa-2222-4333-8444-555555555555.png`;
  const K2 = `owner-statements/${OWNER}/receipts/bbbbbbbb-2222-4333-8444-555555555555.pdf`;
  // A line-level (Charge) key — NOT in Invoice.attachmentKeys. Must NEVER be signed.
  const CHARGE_KEY = `owner-statements/${OWNER}/receipts/cccccccc-2222-4333-8444-555555555555.jpg`;

  it("signs ONE {key,url} per statement-level attachmentKey, in order", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement([{ id: CHARGE, chargeType: "tnb" }], { attachmentKeys: [K1, K2] }),
    );

    const result = await listReceiptUrlsService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data).toEqual([
      { key: K1, url: `https://signed.example/${K1}?token=t` },
      { key: K2, url: `https://signed.example/${K2}?token=t` },
    ]);
    expect(createSignedDownloadUrl).toHaveBeenCalledTimes(2);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(K1);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(K2);
  });

  it("SECURITY: signs only Invoice.attachmentKeys — a non-member (line-level) key is never signed", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement(
        // The charge carries CHARGE_KEY, but it is NOT on Invoice.attachmentKeys.
        [{ id: CHARGE, chargeType: "tnb", attachmentKeys: [CHARGE_KEY] }],
        { attachmentKeys: [K1] },
      ),
    );

    const result = await listReceiptUrlsService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((r) => r.key)).toEqual([K1]);
    expect(createSignedDownloadUrl).toHaveBeenCalledTimes(1);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(K1);
    expect(createSignedDownloadUrl).not.toHaveBeenCalledWith(CHARGE_KEY);
  });

  it("de-dupes a doubled key (signs it once)", async () => {
    vi.mocked(findStatementById).mockResolvedValue(
      statement([], { attachmentKeys: [K1, K1] }),
    );

    const result = await listReceiptUrlsService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([{ key: K1, url: `https://signed.example/${K1}?token=t` }]);
    expect(createSignedDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("returns [] (200) for a statement with no receipts — never touches the signer", async () => {
    vi.mocked(findStatementById).mockResolvedValue(statement([], { attachmentKeys: [] }));

    const result = await listReceiptUrlsService(ctx, INVOICE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("404s a cross-org / unknown statement — no signing", async () => {
    vi.mocked(findStatementById).mockResolvedValue(null);

    const result = await listReceiptUrlsService(ctx, INVOICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});
