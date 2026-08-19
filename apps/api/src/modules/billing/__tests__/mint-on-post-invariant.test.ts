// apps/api/src/modules/billing/__tests__/mint-on-post-invariant.test.ts
// B5 (2026-07-04 spec, amended): pins the mint-on-post invariant.
// (a) flag-ON manual post mints in-tx; (b) auto-draft approve never posts
// charges, so it can never create an undocumented posted charge.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { txMock, chargeUpdateMock, chargeUpdateManyMock, chargeEventCreateMock, chargeFindManyMock, invoiceUpdateMock } = vi.hoisted(() => ({
  txMock: vi.fn(),
  chargeUpdateMock: vi.fn(),
  chargeUpdateManyMock: vi.fn(),
  chargeEventCreateMock: vi.fn(),
  chargeFindManyMock: vi.fn(),
  invoiceUpdateMock: vi.fn(),
}));

vi.mock("@kason/db", async (orig) => ({
  ...(await orig()),
  getDb: () => ({ $transaction: txMock }),
}));
vi.mock("../../billing-documents/issue.service", () => ({ issueDocumentsForChargesTx: vi.fn() }));
vi.mock("../../billing-documents/credit-notes.service", async (orig) => ({ ...(await orig()) }));
vi.mock("../../../lib/feature-flags", () => ({ isPhase2FlagEnabled: vi.fn(() => true) }));
vi.mock("../billing.repository", async (orig) => ({
  ...(await orig()),
  // unitId: null → the owner-billing guard's listing scope is null, a documented
  // no-op (this test is about mint-on-post atomicity, not owner-billing readiness).
  // isPhase2FlagEnabled is mocked to always return true (line below) — WITHOUT a
  // null unitId, the guard would try to resolve a listing owner against this
  // file's fake tx (no `.listing` property) and throw.
  findChargeById: vi.fn().mockResolvedValue({
    id: "charge-1", status: "draft", unitId: null, billingMonth: null, dueDate: new Date("2026-06-15"),
  }),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({ syncOwnerLedgerForCharges: vi.fn() }));

import { issueDocumentsForChargesTx } from "../../billing-documents/issue.service";
import { postChargeService } from "../billing.service";
import { approveInvoiceService } from "../auto-draft.service";

const session = { orgId: "org1", userId: "u1", role: "admin" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  txMock.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({
      charge: {
        update: chargeUpdateMock,
        updateMany: chargeUpdateManyMock,
        findMany: chargeFindManyMock.mockResolvedValue([{ id: "charge-1", status: "draft" }]),
      },
      chargeEvent: { create: chargeEventCreateMock },
      invoice: { update: invoiceUpdateMock.mockResolvedValue({ id: "inv-1" }) },
    }),
  );
});

describe("mint-on-post invariant (B5)", () => {
  it("manual post mints: issueDocumentsForChargesTx called with the chargeId inside the tx", async () => {
    await postChargeService(session, { chargeId: "charge-1" });
    expect(vi.mocked(issueDocumentsForChargesTx)).toHaveBeenCalledWith(
      expect.anything(), ["charge-1"], "u1",
    );
    expect(chargeUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "posted" }) }),
    );
  });

  it("approve (flag on) posts the invoice's draft charges AND mints their documents", async () => {
    await approveInvoiceService(
      { orgId: "org1", actorUserId: "u1", actorRole: "admin" } as never,
      "inv-1",
      new Date().toISOString(),
    );
    expect(invoiceUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "approved" }) }),
    );
    // Draft charges flip to posted…
    expect(chargeUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "posted" }) }),
    );
    // …AND their documents are minted in the same tx → no undocumented posted charge.
    expect(vi.mocked(issueDocumentsForChargesTx)).toHaveBeenCalledWith(
      expect.anything(), ["charge-1"], "u1",
    );
  });
});
