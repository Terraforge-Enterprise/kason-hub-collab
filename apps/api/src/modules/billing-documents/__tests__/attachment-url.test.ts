// apps/api/src/modules/billing-documents/__tests__/attachment-url.test.ts
//
// resolveAttachmentUrlService (bill-expenses R6, Task 7) — signs a download
// URL for an expense-line attachment ONLY when it is genuinely linked to the
// requested document: attachment.expenseId -> a Charge with that
// sourceGridExpenseId whose BillingDocumentLine sits on documentId, all
// within orgId. Mirrors pdf.service.race.test.ts's mock convention
// (vi.mock("@kason/db") + vi.mock("../../../lib/storage")) rather than the
// real-DB integration harness — this is a pure linkage-guard/query-shape
// unit, no fixture graph is needed.
//
// Run:
//   npx vitest run apps/api/src/modules/billing-documents/__tests__/attachment-url.test.ts

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  gridAttachment: { findFirst: vi.fn() },
  charge: { findMany: vi.fn() },
  billingDocumentLine: { findFirst: vi.fn() },
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(),
}));

import { resolveAttachmentUrlService } from "../attachment-url.service";
import { createSignedDownloadUrl } from "../../../lib/storage";

const ORG = "org1";
const OTHER_ORG = "org2";
const DOC_X = "docX";
const DOC_OTHER = "docOther";
const ATT = "att1";

describe("resolveAttachmentUrlService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signs linked attachment: expense-sourced charge IS a line on this document", async () => {
    dbMock.gridAttachment.findFirst.mockResolvedValue({ storageKey: "k1", expenseId: "e1" });
    dbMock.charge.findMany.mockResolvedValue([{ id: "ch1" }]);
    dbMock.billingDocumentLine.findFirst.mockResolvedValue({ id: "ln1" });
    vi.mocked(createSignedDownloadUrl).mockResolvedValue("https://signed");

    const r = await resolveAttachmentUrlService(ORG, DOC_X, ATT);

    expect(r).toEqual({ url: "https://signed" });
    expect(dbMock.gridAttachment.findFirst).toHaveBeenCalledWith({
      where: { id: ATT, organizationId: ORG },
      select: { storageKey: true, expenseId: true },
    });
    expect(dbMock.charge.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, sourceGridExpenseId: "e1" },
      select: { id: true },
    });
    expect(dbMock.billingDocumentLine.findFirst).toHaveBeenCalledWith({
      where: { documentId: DOC_X, chargeId: { in: ["ch1"] } },
      select: { id: true },
    });
    expect(createSignedDownloadUrl).toHaveBeenCalledWith("k1");
  });

  it("unlinked returns 404 (null): the expense-sourced charge exists but is not a line on THIS document", async () => {
    dbMock.gridAttachment.findFirst.mockResolvedValue({ storageKey: "k1", expenseId: "e1" });
    dbMock.charge.findMany.mockResolvedValue([{ id: "ch1" }]);
    dbMock.billingDocumentLine.findFirst.mockResolvedValue(null); // no line on docOther

    const r = await resolveAttachmentUrlService(ORG, DOC_OTHER, ATT);

    expect(r).toBeNull();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("cross-org denied: attachment belongs to another org, org-scoped lookup finds nothing (no cross-org leak)", async () => {
    // orgId filter on gridAttachment.findFirst excludes a foreign-org row.
    dbMock.gridAttachment.findFirst.mockResolvedValue(null);

    const r = await resolveAttachmentUrlService(OTHER_ORG, DOC_X, ATT);

    expect(r).toBeNull();
    expect(dbMock.gridAttachment.findFirst).toHaveBeenCalledWith({
      where: { id: ATT, organizationId: OTHER_ORG },
      select: { storageKey: true, expenseId: true },
    });
    expect(dbMock.charge.findMany).not.toHaveBeenCalled();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("attachment not found returns null", async () => {
    dbMock.gridAttachment.findFirst.mockResolvedValue(null);

    const r = await resolveAttachmentUrlService(ORG, DOC_X, "nonexistent");

    expect(r).toBeNull();
    expect(dbMock.charge.findMany).not.toHaveBeenCalled();
  });

  it("attachment with no expenseId (entry-level upload, not per-line) returns null", async () => {
    dbMock.gridAttachment.findFirst.mockResolvedValue({ storageKey: "k1", expenseId: null });

    const r = await resolveAttachmentUrlService(ORG, DOC_X, ATT);

    expect(r).toBeNull();
    expect(dbMock.charge.findMany).not.toHaveBeenCalled();
  });

  it("no charges minted from that expense returns null (short-circuits before the line lookup)", async () => {
    dbMock.gridAttachment.findFirst.mockResolvedValue({ storageKey: "k1", expenseId: "e1" });
    dbMock.charge.findMany.mockResolvedValue([]);

    const r = await resolveAttachmentUrlService(ORG, DOC_X, ATT);

    expect(r).toBeNull();
    expect(dbMock.billingDocumentLine.findFirst).not.toHaveBeenCalled();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});
