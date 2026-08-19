/**
 * payments.post-void-reverse.test.ts
 * Unit tests for updatePaymentStatusService (void) and reverseAllocationService,
 * using mock-based style.
 *
 * CRITICAL: partial-mock so real error classes survive instanceof checks.
 * The service does `err instanceof StaleError` — that class lives in the
 * repository module and must stay real. The `...(await orig())` spread keeps
 * them real while stubbing the async functions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@kason/db";

// Single partial-mock: spread orig so real class exports (StaleError) survive.
// All repository stubs declared here — do NOT call vi.mock for this module again.
vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  findPaymentById: vi.fn(),
  voidPaymentTx: vi.fn(),
  reverseAllocationTx: vi.fn(),
}));

// Import after the vi.mock hoisting resolves.
import * as repo from "../payments.repository";
import { updatePaymentStatusService, reverseAllocationService } from "../payments.service";

const { findPaymentById, voidPaymentTx, reverseAllocationTx, StaleError } = repo as typeof repo & {
  StaleError: typeof import("../payments.repository").StaleError;
};

const mockedFindById = vi.mocked(findPaymentById);
const mockedVoidTx = vi.mocked(voidPaymentTx);
const mockedReverseTx = vi.mocked(reverseAllocationTx);

const session = { userId: "u1", orgId: "org1", role: "admin" };
const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const ALLOC_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => vi.clearAllMocks());

// ── 404: findPaymentById not found ───────────────────────────────────────────
describe("updatePaymentStatusService — payment not found (pre-tx guard)", () => {
  it("returns 404 when findPaymentById returns null", async () => {
    mockedFindById.mockResolvedValueOnce(null);
    const res = await updatePaymentStatusService(session, {
      paymentId: PAYMENT_ID,
      status: "void",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
    expect(mockedVoidTx).not.toHaveBeenCalled();
  });
});

// ── 400: already void (pre-tx guard) ─────────────────────────────────────────
describe("updatePaymentStatusService — already void (pre-tx guard)", () => {
  it("returns 400 when existing.status is 'void' (before tx)", async () => {
    mockedFindById.mockResolvedValueOnce({
      id: PAYMENT_ID,
      amount: "900.00",
      status: "void",
      referenceNote: null,
    } as never);
    const res = await updatePaymentStatusService(session, {
      paymentId: PAYMENT_ID,
      status: "void",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(mockedVoidTx).not.toHaveBeenCalled();
  });
});

// ── 200: voidPaymentTx returns {ok} ──────────────────────────────────────────
describe("updatePaymentStatusService — happy path", () => {
  it("returns 200 when voidPaymentTx returns {ok}", async () => {
    mockedFindById.mockResolvedValueOnce({
      id: PAYMENT_ID,
      amount: "900.00",
      status: "posted",
      referenceNote: null,
    } as never);
    mockedVoidTx.mockResolvedValueOnce({ ok: true } as never);
    const res = await updatePaymentStatusService(session, {
      paymentId: PAYMENT_ID,
      status: "void",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.status).toBe(200);
  });
});

// ── 404: voidPaymentTx returns {notFound} ────────────────────────────────────
describe("updatePaymentStatusService — notFound from tx", () => {
  it("returns 404 when voidPaymentTx returns {notFound}", async () => {
    mockedFindById.mockResolvedValueOnce({
      id: PAYMENT_ID,
      amount: "900.00",
      status: "posted",
      referenceNote: null,
    } as never);
    mockedVoidTx.mockResolvedValueOnce({ notFound: true } as never);
    const res = await updatePaymentStatusService(session, {
      paymentId: PAYMENT_ID,
      status: "void",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

// ── 400: voidPaymentTx returns {alreadyVoid} ─────────────────────────────────
describe("updatePaymentStatusService — alreadyVoid from tx", () => {
  it("returns 400 when voidPaymentTx returns {alreadyVoid}", async () => {
    mockedFindById.mockResolvedValueOnce({
      id: PAYMENT_ID,
      amount: "900.00",
      status: "posted",
      referenceNote: null,
    } as never);
    mockedVoidTx.mockResolvedValueOnce({ alreadyVoid: true } as never);
    const res = await updatePaymentStatusService(session, {
      paymentId: PAYMENT_ID,
      status: "void",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

// ── 409: voidPaymentTx throws StaleError ─────────────────────────────────────
describe("updatePaymentStatusService — StaleError from tx", () => {
  it("returns 409 when voidPaymentTx throws StaleError", async () => {
    mockedFindById.mockResolvedValueOnce({
      id: PAYMENT_ID,
      amount: "900.00",
      status: "posted",
      referenceNote: null,
    } as never);
    mockedVoidTx.mockRejectedValueOnce(new StaleError(PAYMENT_ID));
    const res = await updatePaymentStatusService(session, {
      paymentId: PAYMENT_ID,
      status: "void",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// reverseAllocationService — service unit tests
// ═══════════════════════════════════════════════════════════════════════════════

const reverseInput = { paymentId: PAYMENT_ID, allocationId: ALLOC_ID, reason: "(unspecified)" };

// ── 404: reverseAllocationTx returns {notFound} ───────────────────────────────
describe("reverseAllocationService — notFound", () => {
  it("returns 404 when reverseAllocationTx returns {notFound}", async () => {
    mockedReverseTx.mockResolvedValueOnce({ notFound: true } as never);
    const res = await reverseAllocationService(session, reverseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

// ── 200: reverseAllocationTx returns {ok} ────────────────────────────────────
describe("reverseAllocationService — ok", () => {
  it("returns 200 with the reversal identifiers when reverseAllocationTx returns {ok}", async () => {
    mockedReverseTx.mockResolvedValueOnce({ ok: true, chargeId: "charge-1", reversalId: "rev-1", effectiveAllocated: 0 } as never);
    const res = await reverseAllocationService(session, reverseInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ reversalId: "rev-1", chargeId: "charge-1", effectiveAllocated: 0 });
    }
  });
});

// ── 409: reverseAllocationTx throws StaleError ───────────────────────────────
describe("reverseAllocationService — StaleError", () => {
  it("returns 409 when reverseAllocationTx throws StaleError", async () => {
    mockedReverseTx.mockRejectedValueOnce(new StaleError(PAYMENT_ID));
    const res = await reverseAllocationService(session, reverseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── 200: concurrent-replay P2002 → idempotent echo (R4) ──────────────────────
// A TRUE concurrent replay (same organizationId+idempotencyKey) has both requests
// pass the in-tx `prior` pre-check (READ COMMITTED hides the uncommitted sibling)
// and both reach create(); the loser hits the DB unique index (organizationId,
// idempotencyKey) → P2002. The winning reversal is already committed, so the
// service must re-invoke reverseAllocationTx ONCE — the retry hits the `prior`
// fast-path and returns the idempotent echo. Must be 200, NOT a 500 / rethrow.
describe("reverseAllocationService — concurrent-replay P2002 idempotent echo", () => {
  function makeP2002() {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
  }

  it("returns 200 with the winning reversalId when the first tx throws P2002 and the replay finds the prior reversal", async () => {
    // First call: this request lost the create() race → P2002.
    mockedReverseTx.mockRejectedValueOnce(makeP2002());
    // Second call (the service's replay): the `prior` fast-path returns the
    // committed reversal's identifiers (no `effectiveAllocated` on the replay echo).
    mockedReverseTx.mockResolvedValueOnce({
      ok: true,
      chargeId: "charge-1",
      reversalId: "rev-winner",
      replayed: true,
    } as never);

    const res = await reverseAllocationService(session, reverseInput);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ reversalId: "rev-winner", chargeId: "charge-1" });
    }
    // The service must have re-invoked the tx exactly twice (original + one replay).
    expect(mockedReverseTx).toHaveBeenCalledTimes(2);
  });
});
