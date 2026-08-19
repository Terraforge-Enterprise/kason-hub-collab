import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindChargeById = vi.fn();
const mockUpdateChargeStatus = vi.fn();
const mockCreateChargeEvent = vi.fn();
vi.mock("../billing.repository", () => ({
  createCharge: vi.fn(),
  createChargeEvent: (...a: unknown[]) => mockCreateChargeEvent(...a),
  findChargeById: (...a: unknown[]) => mockFindChargeById(...a),
  findChargeByNumber: vi.fn(),
  listCharges: vi.fn(),
  updateChargeStatus: (...a: unknown[]) => mockUpdateChargeStatus(...a),
}));

const mockVoidWithCn = vi.fn();
vi.mock("../../billing-documents/credit-notes.service", () => ({
  voidPostedChargeWithCreditNote: (...a: unknown[]) => mockVoidWithCn(...a),
  CreditNoteVoidError: class CreditNoteVoidError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
}));

const mockFlag = vi.fn();
vi.mock("../../../lib/feature-flags", () => ({
  isPhase2FlagEnabled: (f: string) => mockFlag(f),
}));

const mockSync = vi.fn();
vi.mock("../../owner-ledger/owner-ledger.sync-hook", () => ({
  syncOwnerLedgerForCharges: (...a: unknown[]) => mockSync(...a),
}));

import { voidChargeService } from "../billing.service";

const session = { orgId: "org-1", userId: "user-1", role: "admin" } as never;
const CHARGE = "3f0b8a52-9c1d-4f6e-8a7b-2c3d4e5f6a7b";

describe("voidChargeService (P3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flag OFF + posted charge → legacy plain void, CN path never called, sync hook fired", async () => {
    mockFlag.mockReturnValue(false);
    mockFindChargeById.mockResolvedValue({ id: CHARGE, status: "posted" });
    const r = await voidChargeService(session, { chargeId: CHARGE, reason: "wrong amount" });
    expect(r.ok).toBe(true);
    expect(mockVoidWithCn).not.toHaveBeenCalled();
    expect(mockUpdateChargeStatus).toHaveBeenCalledWith({
      chargeId: CHARGE, status: "void", cancelledReason: "wrong amount", outstandingAmount: 0,
    });
    expect(mockCreateChargeEvent).toHaveBeenCalled();
    expect(mockSync).toHaveBeenCalledWith("org-1", "user-1", "admin", [CHARGE]);
  });

  it("flag OFF + paid charge → 400 (unchanged legacy guard)", async () => {
    mockFlag.mockReturnValue(false);
    mockFindChargeById.mockResolvedValue({ id: CHARGE, status: "paid" });
    const r = await voidChargeService(session, { chargeId: CHARGE, reason: "oops" });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("flag ON + posted charge → delegates to voidPostedChargeWithCreditNote", async () => {
    mockFlag.mockReturnValue(true);
    mockFindChargeById.mockResolvedValue({ id: CHARGE, status: "posted" });
    mockVoidWithCn.mockResolvedValue({ creditNoteId: "cn-1", creditNoteNumber: "CN-0001", plainVoid: false });
    const r = await voidChargeService(session, { chargeId: CHARGE, reason: "wrong amount", paidHandling: "hold_credit" });
    expect(mockVoidWithCn).toHaveBeenCalledWith({
      organizationId: "org-1", chargeId: CHARGE, reason: "wrong amount",
      strategy: undefined, paidHandling: "hold_credit", refund: undefined,
      actorUserId: "user-1", actorRole: "admin",
    });
    expect(r).toMatchObject({ ok: true, status: 200, data: { creditNoteNumber: "CN-0001" } });
    expect(mockUpdateChargeStatus).not.toHaveBeenCalled();
  });

  it("flag ON + posted charge → forwards the R1 strategy through to the CN path", async () => {
    mockFlag.mockReturnValue(true);
    mockFindChargeById.mockResolvedValue({ id: CHARGE, status: "posted" });
    mockVoidWithCn.mockResolvedValue({ creditNoteId: "cn-2", creditNoteNumber: "CN-0002", plainVoid: false });
    await voidChargeService(session, { chargeId: CHARGE, reason: "wrong amount", strategy: "CREDIT_ADJUSTMENT" });
    expect(mockVoidWithCn).toHaveBeenCalledWith({
      organizationId: "org-1", chargeId: CHARGE, reason: "wrong amount",
      strategy: "CREDIT_ADJUSTMENT", paidHandling: undefined, refund: undefined,
      actorUserId: "user-1", actorRole: "admin",
    });
  });

  it("flag ON + draft charge → legacy plain void (drafts never mint CNs)", async () => {
    mockFlag.mockReturnValue(true);
    mockFindChargeById.mockResolvedValue({ id: CHARGE, status: "draft" });
    const r = await voidChargeService(session, { chargeId: CHARGE, reason: "draft cleanup" });
    expect(r.ok).toBe(true);
    expect(mockVoidWithCn).not.toHaveBeenCalled();
    expect(mockUpdateChargeStatus).toHaveBeenCalled();
  });

  it("flag ON + CN path throws CreditNoteVoidError → mapped to {ok:false,status,error}", async () => {
    // R1: a paid charge corrected with NO strategy (and no deprecated paidHandling)
    // now yields 400 STRATEGY_REQUIRED — the old error_revert_first 409 is gone.
    mockFlag.mockReturnValue(true);
    mockFindChargeById.mockResolvedValue({ id: CHARGE, status: "partially_paid" });
    const { CreditNoteVoidError } = await import("../../billing-documents/credit-notes.service");
    mockVoidWithCn.mockRejectedValue(new CreditNoteVoidError(400, "STRATEGY_REQUIRED"));
    const r = await voidChargeService(session, { chargeId: CHARGE, reason: "paid in error" });
    expect(r).toMatchObject({ ok: false, status: 400, error: "STRATEGY_REQUIRED" });
  });
});
