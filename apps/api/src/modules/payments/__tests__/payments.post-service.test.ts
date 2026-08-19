/**
 * payments.post-service.test.ts
 * Unit tests for postPaymentService using mock-based style.
 *
 * CRITICAL: partial-mock so real error classes survive instanceof checks.
 * The service does `err instanceof StaleError` — that class lives in the
 * repository module and must stay real. The `...(await orig())` spread keeps
 * them real while stubbing the async functions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial-mock: spread orig so real class exports (StaleError) survive instanceof.
vi.mock("../payments.repository", async (orig) => ({
  ...(await orig()),
  postPaymentTx: vi.fn(),
}));

// Import after the vi.mock hoisting resolves.
import * as repo from "../payments.repository";
import { postPaymentService } from "../payments.service";

const { postPaymentTx, StaleError } = repo as typeof repo & {
  StaleError: typeof import("../payments.repository").StaleError;
};

const mockedPostTx = vi.mocked(postPaymentTx);

const session = { userId: "u1", orgId: "org1", role: "manager" };
const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const input = { paymentId: PAYMENT_ID };

beforeEach(() => vi.clearAllMocks());

// ── 404: payment not found ────────────────────────────────────────────────────
describe("postPaymentService — payment not found", () => {
  it("returns 404 when tx returns notFound", async () => {
    mockedPostTx.mockResolvedValueOnce({ notFound: true } as never);
    const res = await postPaymentService(session, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

// ── 400: wrong status ─────────────────────────────────────────────────────────
describe("postPaymentService — wrong status", () => {
  it("returns 400 when tx returns badStatus (already posted)", async () => {
    mockedPostTx.mockResolvedValueOnce({ badStatus: true, status: "posted" } as never);
    const res = await postPaymentService(session, input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.error).toContain("pending_approval");
    }
  });
});

// ── 200: happy path ───────────────────────────────────────────────────────────
describe("postPaymentService — happy path", () => {
  it("returns 200 with posted status when tx succeeds", async () => {
    mockedPostTx.mockResolvedValueOnce({ ok: true } as never);
    const res = await postPaymentService(session, input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ id: PAYMENT_ID, status: "posted" });
    }
  });
});

// ── 409: StaleError from tx ───────────────────────────────────────────────────
describe("postPaymentService — StaleError", () => {
  it("returns 409 when tx throws StaleError", async () => {
    mockedPostTx.mockRejectedValueOnce(new StaleError(PAYMENT_ID));
    const res = await postPaymentService(session, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── 409: ALLOC_EXCEEDS_OUTSTANDING ────────────────────────────────────────────
describe("postPaymentService — ALLOC_EXCEEDS_OUTSTANDING", () => {
  it("returns 409 when tx throws ALLOC_EXCEEDS_OUTSTANDING error", async () => {
    mockedPostTx.mockRejectedValueOnce(new Error(`ALLOC_EXCEEDS_OUTSTANDING:${PAYMENT_ID}`));
    const res = await postPaymentService(session, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

// ── 409: ALLOC_EXCEEDS_PAYMENT ────────────────────────────────────────────────
describe("postPaymentService — ALLOC_EXCEEDS_PAYMENT", () => {
  it("returns 409 when tx throws ALLOC_EXCEEDS_PAYMENT error", async () => {
    mockedPostTx.mockRejectedValueOnce(new Error("ALLOC_EXCEEDS_PAYMENT"));
    const res = await postPaymentService(session, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});
