/**
 * payments.batch-service.test.ts
 * Unit tests for allocatePaymentBatchService using mock-based style.
 *
 * CRITICAL: partial-mock so real error classes survive instanceof checks.
 * The service does `err instanceof StaleError / AlreadyAllocatedError /
 * PartyMismatchError` — those classes live in the repository module and must
 * stay real.  The `...(await orig())` spread keeps them real while stubbing
 * the async functions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@kason/db";

// Partial-mock: spread orig so real class exports survive instanceof.
vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  findPaymentForMutation: vi.fn(),
  allocatePaymentBatchTx: vi.fn(),
  findPaymentByIdempotencyKeyAdmin: vi.fn(),
}));

// Import after the vi.mock hoisting resolves.
import * as repo from "../payments.repository";
import { allocatePaymentBatchService } from "../payments.service";

const {
  findPaymentForMutation,
  allocatePaymentBatchTx,
  findPaymentByIdempotencyKeyAdmin,
  StaleError,
  AlreadyAllocatedError,
  PartyMismatchError,
} = repo as typeof repo & {
  StaleError: typeof import("../payments.repository").StaleError;
  AlreadyAllocatedError: typeof import("../payments.repository").AlreadyAllocatedError;
  PartyMismatchError: typeof import("../payments.repository").PartyMismatchError;
};

const mockedFindPayment = vi.mocked(findPaymentForMutation);
const mockedBatchTx = vi.mocked(allocatePaymentBatchTx);
const mockedFindByKey = vi.mocked(findPaymentByIdempotencyKeyAdmin);

const session = { userId: "u1", orgId: "org1", role: "editor" };

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE_ID_A = "22222222-2222-4222-8222-222222222222";
const CHARGE_ID_B = "33333333-3333-4333-8333-333333333333";
const IDEM_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_ID = "44444444-4444-4444-8444-444444444444";

const postedPayment = {
  id: PAYMENT_ID,
  amount: { toString: () => "1020" },
  status: "posted",
  partyId: PARTY_ID,
  idempotencyKey: null,
  updatedAt: new Date(),
};

const baseInput = {
  paymentId: PAYMENT_ID,
  idempotencyKey: IDEM_KEY,
  allocations: [
    { chargeId: CHARGE_ID_A, allocatedAmount: "900.00" },
    { chargeId: CHARGE_ID_B, allocatedAmount: "120.00" },
  ],
};

beforeEach(() => vi.clearAllMocks());

// ── 404: payment not found ────────────────────────────────────────────────────
describe("allocatePaymentBatchService — payment not found", () => {
  it("returns 404 when payment does not exist", async () => {
    mockedFindPayment.mockResolvedValueOnce(null);
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

// ── 400: payment status ≠ "posted" ───────────────────────────────────────────
describe("allocatePaymentBatchService — wrong status", () => {
  it("returns 400 when payment is pending_approval", async () => {
    mockedFindPayment.mockResolvedValueOnce({ ...postedPayment, status: "pending_approval" } as never);
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error).toContain("posted");
    }
  });
});

// ── 200 replay: same idempotencyKey already set on payment ───────────────────
describe("allocatePaymentBatchService — idempotency replay (pre-tx)", () => {
  it("returns 200 replayed when payment already carries the same key", async () => {
    mockedFindPayment.mockResolvedValueOnce({ ...postedPayment, idempotencyKey: IDEM_KEY } as never);
    const res = await allocatePaymentBatchService(session, { ...baseInput, idempotencyKey: IDEM_KEY });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ replayed: true });
    }
  });
});

// ── 409 conflict: different key on an already-allocated payment ───────────────
describe("allocatePaymentBatchService — key conflict (pre-tx)", () => {
  it("returns 409 when payment carries a DIFFERENT key", async () => {
    mockedFindPayment.mockResolvedValueOnce({
      ...postedPayment,
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    } as never);
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── 400: duplicate chargeId in batch ─────────────────────────────────────────
describe("allocatePaymentBatchService — duplicate chargeId", () => {
  it("returns 400 when a chargeId appears twice in the batch", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    const res = await allocatePaymentBatchService(session, {
      ...baseInput,
      allocations: [
        { chargeId: CHARGE_ID_A, allocatedAmount: "450.00" },
        { chargeId: CHARGE_ID_A, allocatedAmount: "450.00" },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

// ── 400: non-positive allocatedAmount ────────────────────────────────────────
describe("allocatePaymentBatchService — non-positive amount", () => {
  it("returns 400 when allocatedAmount is 0", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    const res = await allocatePaymentBatchService(session, {
      ...baseInput,
      allocations: [{ chargeId: CHARGE_ID_A, allocatedAmount: "0" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it("returns 400 when allocatedAmount is negative", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    const res = await allocatePaymentBatchService(session, {
      ...baseInput,
      allocations: [{ chargeId: CHARGE_ID_A, allocatedAmount: "-100" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

// ── 201 happy path ────────────────────────────────────────────────────────────
describe("allocatePaymentBatchService — happy path", () => {
  it("returns 201 with allocation list when tx succeeds", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockResolvedValueOnce({
      replayed: false,
      allocations: [
        { id: "al1", chargeId: CHARGE_ID_A, allocatedAmount: 900 },
        { id: "al2", chargeId: CHARGE_ID_B, allocatedAmount: 120 },
      ],
      paidChargeIds: [], // PART 3: nothing reached "paid" in this mock
      allocatedChargeIds: [CHARGE_ID_A, CHARGE_ID_B], // I-1: every touched charge
    } as never);
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(201);
      expect(res.data).toMatchObject({ id: PAYMENT_ID });
    }
  });
});

// ── 409: AlreadyAllocatedError from tx ───────────────────────────────────────
describe("allocatePaymentBatchService — AlreadyAllocatedError", () => {
  it("returns 409 when tx throws AlreadyAllocatedError", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(new AlreadyAllocatedError());
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── 400: PartyMismatchError from tx ──────────────────────────────────────────
describe("allocatePaymentBatchService — PartyMismatchError", () => {
  it("returns 400 when tx throws PartyMismatchError", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(new PartyMismatchError(CHARGE_ID_A));
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

// ── 409: StaleError from tx ───────────────────────────────────────────────────
describe("allocatePaymentBatchService — StaleError", () => {
  it("returns 409 when tx throws StaleError", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(new StaleError(CHARGE_ID_A));
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── P2002: idempotency key unique violation ───────────────────────────────────
describe("allocatePaymentBatchService — P2002 idempotency", () => {
  function makeP2002() {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
  }

  it("returns 200 replay when P2002 and owner.id === paymentId", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(makeP2002());
    mockedFindByKey.mockResolvedValueOnce({ id: PAYMENT_ID } as never);
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ replayed: true });
    }
  });

  it("returns 409 when P2002 and owner.id ≠ paymentId (key used by another payment)", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(makeP2002());
    mockedFindByKey.mockResolvedValueOnce({ id: "different-payment-id" } as never);
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── 400: ALLOC_EXCEEDS_OUTSTANDING ────────────────────────────────────────────
describe("allocatePaymentBatchService — ALLOC_EXCEEDS_OUTSTANDING", () => {
  it("returns 400 when tx throws ALLOC_EXCEEDS_OUTSTANDING error", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(new Error(`ALLOC_EXCEEDS_OUTSTANDING:${CHARGE_ID_A}`));
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

// ── 400: ALLOC_EXCEEDS_PAYMENT ────────────────────────────────────────────────
describe("allocatePaymentBatchService — ALLOC_EXCEEDS_PAYMENT", () => {
  it("returns 400 when tx throws ALLOC_EXCEEDS_PAYMENT error", async () => {
    mockedFindPayment.mockResolvedValueOnce(postedPayment as never);
    mockedBatchTx.mockRejectedValueOnce(new Error("ALLOC_EXCEEDS_PAYMENT"));
    const res = await allocatePaymentBatchService(session, baseInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});
