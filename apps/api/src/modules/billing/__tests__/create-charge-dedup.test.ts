import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@kason/db";

// getDb().$transaction runs its callback inline against an opaque tx by default.
// The P2002 race-backstop tests below override txMock (mockRejectedValueOnce) so
// the WHOLE transaction rejects with a P2002 — mirroring the real failure mode
// where the loser's INSERT violates a unique constraint and Prisma rolls the tx
// back (so the catch runs on the base connection and re-queries to classify).
// txMock is hoisted so the (also-hoisted) vi.mock factory can close over it.
// vi.importActual keeps `Prisma.PrismaClientKnownRequestError` real.
const { txMock } = vi.hoisted(() => ({
  txMock: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock("@kason/db", async () => {
  const actual = await vi.importActual<typeof import("@kason/db")>("@kason/db");
  return {
    ...actual,
    getDb: () => ({ $transaction: txMock }),
  };
});

vi.mock("../billing.repository", () => ({
  findChargeByNumber: vi.fn(),
  findChargeCategoryForCreate: vi.fn(),
  createCharge: vi.fn(),
  createChargeEvent: vi.fn(),
  findActiveDuplicateCharge: vi.fn(),
}));

import { createChargeService } from "../billing.service";
import * as repo from "../billing.repository";

const mockedRepo = vi.mocked(repo);

const session = { userId: "user-1", orgId: "org-1", role: "admin" };

const UNIT_ID = "10000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "20000000-0000-4000-8000-000000000001";
const PARTY_ID = "30000000-0000-4000-8000-000000000001";

// Compound dedup key is (unitId, categoryId, billingMonth, amount) — categoryId is
// only ever non-null when ENABLE_PHASE2_BILLING_DOCS is on (billing.service.ts's
// categoryId resolution), so most rows below run with the flag on + a resolved
// category; the legacy/flag-dark shape is exercised explicitly in its own test.
const BASE_INPUT = {
  chargeNumber: "CHG-DUP-BASE",
  partyId: PARTY_ID,
  chargeType: "rental",
  dueDate: "2026-07-15",
  amount: "100",
  currency: "MYR",
  description: "Monthly rental",
  tenancyId: "" as const,
  unitId: UNIT_ID,
  categoryId: CATEGORY_ID,
};

describe("createChargeService — duplicate-charge guard + create-time month derivation (Spec2 R1)", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so per-test mockResolvedValueOnce queues
    // are DRAINED between tests — otherwise an unconsumed once (e.g. a race test
    // whose SUT short-circuits before the catch re-query) leaks into the next
    // test's pre-tx findChargeByNumber. All base impls are re-established below.
    vi.resetAllMocks();
    txMock.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({}));
    process.env.ENABLE_PHASE2_BILLING_DOCS = "1";
    mockedRepo.findChargeByNumber.mockResolvedValue(null);
    mockedRepo.findChargeCategoryForCreate.mockResolvedValue({ id: CATEGORY_ID, active: true, code: "rental" });
    mockedRepo.findActiveDuplicateCharge.mockResolvedValue(null);
    mockedRepo.createChargeEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
  });

  it("rejects a non-ISO but schema-valid dueDate that would mis-bucket billingMonth to 1926 (Finding 1): 400, no charge created", async () => {
    // "26-07-01".slice(0,7) === "26-07-0" -> firstOfMonthUtc -> Date.UTC(26,6,1)
    // === 1926-07-01: a VALID Date in the WRONG month bucket, so the in-tx
    // check-first would query 1926-07, find nothing, and let a genuine July
    // duplicate through — silently defeating the R1 dedup guarantee. Fail fast.
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-would-be-misbucketed" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADFMT-1",
      dueDate: "26-07-01",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("rejects a slash-format dueDate that would derive an Invalid Date billingMonth (Finding 2): 400, not a 500", async () => {
    // "2026/07/01".slice(0,7) === "2026/07" -> firstOfMonthUtc does
    // Number("2026/07") === NaN -> Invalid Date. Against a real DB that Invalid
    // Date reaches Prisma and throws a NON-P2002 error -> the pre-fix path 500s.
    // Guard it to a 400 up front (the mocked repo here would otherwise 201).
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-would-be-invaliddate" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADFMT-2",
      dueDate: "2026/07/01",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("rejects a well-shaped but day-overflow dueDate that new Date() silently rolls into the NEXT month (Finding 1): 400, no charge created", async () => {
    // "2026-02-30" passes a shape-only guard, but Feb 2026 has 28 days:
    // new Date(Date.UTC(2026,1,30)) ROLLS to Mar 2, so the STORED dueDate is
    // effectively March while the billingMonth slice ("2026-02") buckets the row
    // in Feb. The (unit,cat,billingMonth,amount) dedup key then never matches a
    // genuine March charge of the same amount -> the check-first AND the partial
    // index both MISS and a real cross-month duplicate is created (201), silently
    // defeating the whole R1 guarantee. Reject the impossible calendar date up front.
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-day-overflow" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADCAL-1",
      dueDate: "2026-02-30",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/valid YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("rejects an impossible-calendar dueDate (month 13 / day 45) that becomes an Invalid Date -> 500 (Finding 2): 400, no charge created", async () => {
    // "2026-13-45" passes a shape-only guard; firstOfMonthUtc("2026-13") is
    // coincidentally a VALID Date (Date.UTC(2026,12,1) === 2027-01) so there's no
    // early crash, but the stored new Date("2026-13-45") is Invalid Date -> a real
    // DB rejects it and Prisma throws a NON-P2002 error -> the catch's `throw err`
    // -> HTTP 500 (the exact failure class this guard exists to kill).
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-impossible-cal" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADCAL-2",
      dueDate: "2026-13-45",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/valid YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("rejects a zero-month dueDate (month 00) that no calendar round-trip validates (Finding 2 sibling): 400, no charge created", async () => {
    // "2026-00-15" passes a shape-only guard but month 0 is not a real month. The
    // component round-trip (Date.UTC(2026,-1,15) === 2025-12-15) fails the equality
    // check (year 2025 !== 2026, month 11 !== -1) so we reject before deriving the
    // billingMonth slice.
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-zero-month" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADCAL-3",
      dueDate: "2026-00-15",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/valid YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("rejects a dueDate with trailing garbage after a valid YYYY-MM-DD prefix (prefix-only guard would pass it through to an Invalid Date -> 500): 400, no charge created", async () => {
    // "2026-07-01xyz" passes BOTH the /^(\d{4})-(\d{2})-(\d{2})/ prefix match AND
    // the component round-trip (year/month/day all agree with the parsed prefix),
    // so a guard that only checks the prefix + round-trip lets it through. But
    // new Date("2026-07-01xyz") is Invalid Date, which is then stored via
    // `dueDate: new Date(input.dueDate)` -> a real DB rejects it -> the catch's
    // `throw err` (non-P2002) -> HTTP 500. That's the exact "invalid date -> 500"
    // class this guard exists to prevent. A whole-string validity check
    // (Number.isNaN(new Date(input.dueDate).getTime())) closes this gap.
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-would-be-trailing-garbage" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADCAL-4",
      dueDate: "2026-07-01xyz",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/valid YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("rejects a dueDate with trailing space-separated garbage after a valid YYYY-MM-DD prefix (sibling of the above): 400, no charge created", async () => {
    // Same class as "2026-07-01xyz" above but with a space separator instead of
    // being glued directly onto the digits — confirms the whole-string check
    // isn't accidentally scoped to only the no-separator case.
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-would-be-trailing-garbage-2" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-BADCAL-5",
      dueDate: "2026-07-01 garbage",
    });

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/valid YYYY-MM-DD/) });
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
  });

  it("blocks a duplicate (unit, category, month, amount) on an active charge: 409 DUPLICATE_CHARGE + existingChargeId, no new row", async () => {
    mockedRepo.findActiveDuplicateCharge.mockResolvedValueOnce({ id: "charge-existing" });

    const result = await createChargeService(session, { ...BASE_INPUT, chargeNumber: "CHG-DUP-1" });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "DUPLICATE_CHARGE",
      existingChargeId: "charge-existing",
    });
    expect(mockedRepo.findActiveDuplicateCharge).toHaveBeenCalledWith(expect.anything(), session.orgId, {
      unitId: UNIT_ID,
      categoryId: CATEGORY_ID,
      billingMonth: new Date(Date.UTC(2026, 6, 1)),
      amount: 100,
    });
    // Only one row exists: the create + event calls never ran.
    expect(mockedRepo.createCharge).not.toHaveBeenCalled();
    expect(mockedRepo.createChargeEvent).not.toHaveBeenCalled();
  });

  it("allows a second charge with the same unit/category/month but a DIFFERENT amount (201)", async () => {
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-150" });

    const result = await createChargeService(session, { ...BASE_INPUT, chargeNumber: "CHG-DUP-2", amount: "150" });

    expect(result).toEqual({ ok: true, status: 201, data: { id: "charge-150" } });
    expect(mockedRepo.findActiveDuplicateCharge).toHaveBeenCalledWith(
      expect.anything(),
      session.orgId,
      expect.objectContaining({ amount: 150 }),
    );
    expect(mockedRepo.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 150, billingMonth: new Date(Date.UTC(2026, 6, 1)) }),
      expect.anything(),
    );
  });

  it("unit-less ad-hoc charges: two identical creates BOTH succeed (documented exclusion — no unit anchor to dedup)", async () => {
    const adHocInput = { ...BASE_INPUT, unitId: "" as const, chargeNumber: "CHG-ADHOC-1" };

    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-adhoc-1" });
    const first = await createChargeService(session, adHocInput);
    expect(first).toEqual({ ok: true, status: 201, data: { id: "charge-adhoc-1" } });

    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-adhoc-2" });
    const second = await createChargeService(session, { ...adHocInput, chargeNumber: "CHG-ADHOC-2" });
    expect(second).toEqual({ ok: true, status: 201, data: { id: "charge-adhoc-2" } });

    // No unit anchor -> the dedup guard is never even consulted.
    expect(mockedRepo.findActiveDuplicateCharge).not.toHaveBeenCalled();
    expect(mockedRepo.createCharge).toHaveBeenCalledTimes(2);
    expect(mockedRepo.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({ unitId: null, billingMonth: new Date(Date.UTC(2026, 6, 1)) }),
      expect.anything(),
    );
  });

  it("sets billingMonth to the first-of-month (UTC) of dueDate — legacy ad-hoc charge, flag dark, no unit/category (no longer null)", async () => {
    delete process.env.ENABLE_PHASE2_BILLING_DOCS;
    mockedRepo.createCharge.mockResolvedValueOnce({ id: "charge-bm" });

    const result = await createChargeService(session, {
      chargeNumber: "CHG-BM-1",
      partyId: PARTY_ID,
      chargeType: "misc",
      dueDate: "2026-11-03",
      amount: "75",
      currency: "MYR",
      description: "Ad-hoc misc charge",
      tenancyId: "" as const,
      unitId: "" as const,
    });

    expect(result).toEqual({ ok: true, status: 201, data: { id: "charge-bm" } });
    expect(mockedRepo.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: null,
        categoryId: null,
        billingMonth: new Date(Date.UTC(2026, 10, 1)),
      }),
      expect.anything(),
    );
    expect(mockedRepo.findActiveDuplicateCharge).not.toHaveBeenCalled();
  });

  it("derives billingMonth from the literal YYYY-MM date prefix, not a UTC-shifted Date().toISOString() — a +08:00 dueDate at local midnight still resolves to July, not June (Finding 2 regression)", async () => {
    mockedRepo.findActiveDuplicateCharge.mockResolvedValueOnce({ id: "charge-existing-tz" });

    const result = await createChargeService(session, {
      ...BASE_INPUT,
      chargeNumber: "CHG-TZ-1",
      dueDate: "2026-07-01T00:00:00+08:00",
    });

    // Buggy derivation (`new Date(input.dueDate).toISOString().slice(0,7)`)
    // converts to UTC first: 2026-07-01T00:00:00+08:00 -> 2026-06-30T16:00:00Z
    // -> "2026-06", so the check-first would query June and MISS this July
    // duplicate entirely. The TZ-safe fix slices the literal string instead.
    expect(mockedRepo.findActiveDuplicateCharge).toHaveBeenCalledWith(expect.anything(), session.orgId, {
      unitId: UNIT_ID,
      categoryId: CATEGORY_ID,
      billingMonth: new Date(Date.UTC(2026, 6, 1)), // 2026-07-01 — NOT June
      amount: 100,
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "DUPLICATE_CHARGE",
      existingChargeId: "charge-existing-tz",
    });
  });

  it("race backstop (dedup): a P2002 with NO meta.target (real Prisma 7 driver-adapter shape) RE-QUERIES and returns 409 DUPLICATE_CHARGE + existingChargeId (Finding 3)", async () => {
    // Real Prisma 7 leaves err.meta.target UNDEFINED — the constraint info lives
    // under the undocumented driverAdapterError.cause. The fix must classify by
    // RE-QUERYING, never by reading meta.target. $transaction itself rejects
    // because the loser's INSERT rolled the whole tx back.
    txMock.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { modelName: "Charge" }, // NO `target` key — mirrors the real shape
      }),
    );
    // pre-tx + catch re-query both find no chargeNumber clash...
    mockedRepo.findChargeByNumber.mockResolvedValue(null);
    // ...but the catch re-query finds the winning active dedup row.
    mockedRepo.findActiveDuplicateCharge.mockResolvedValueOnce({ id: "existing-race-id" });

    const result = await createChargeService(session, { ...BASE_INPUT, chargeNumber: "CHG-RACE-1" });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "DUPLICATE_CHARGE",
      existingChargeId: "existing-race-id",
    });
  });

  it("race backstop (chargeNumber): a P2002 with NO meta.target RE-QUERIES findChargeByNumber and returns 409 'Charge number already exists', NOT DUPLICATE_CHARGE (Finding 3)", async () => {
    txMock.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { modelName: "Charge" }, // NO `target` key
      }),
    );
    // pre-tx findChargeByNumber passes (null); the catch re-query finds the winner.
    mockedRepo.findChargeByNumber
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "num-race" });

    const result = await createChargeService(session, { ...BASE_INPUT, chargeNumber: "CHG-RACE-2" });

    expect(result).toEqual({ ok: false, status: 409, error: "Charge number already exists" });
  });

  it("race backstop (fail-closed): a P2002 whose re-queries find NEITHER row (winner voided in the gap) still returns 409 DUPLICATE_CHARGE, never a 500 (Finding 3)", async () => {
    txMock.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { modelName: "Charge" },
      }),
    );
    // Both re-queries come back empty (the winning row was voided microseconds
    // after it beat us to the INSERT). It was still a dedup-constraint dup, so
    // the backstop returns a clean 409 rather than failing OPEN to a 500.
    mockedRepo.findChargeByNumber.mockResolvedValue(null);
    mockedRepo.findActiveDuplicateCharge.mockResolvedValue(null);

    const result = await createChargeService(session, { ...BASE_INPUT, chargeNumber: "CHG-RACE-3" });

    expect(result).toEqual({ ok: false, status: 409, error: "DUPLICATE_CHARGE" });
  });
});
