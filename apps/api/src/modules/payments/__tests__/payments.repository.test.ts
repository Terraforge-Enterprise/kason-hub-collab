/**
 * payments.repository.test.ts
 * Repository-level tests for listPayments' allocation documentNumber
 * enrichment (Spec1 R6): each allocation carries the allocated charge's
 * minted BillingDocument number (resolved via findDocumentsByChargeIds),
 * falling back to null when the charge has none.
 *
 * Exercises BOTH findMany paths — the `hasUnallocated` in-memory-filter
 * branch AND the default keyset branch — since both feed the same mapRow
 * (payments.repository.ts:124-136, :166-177).
 *
 * Mocks @kason/db only (payment.findMany + billingDocumentLine.findMany).
 * findDocumentsByChargeIds itself is NOT mocked — it runs for real (from
 * billing.repository.ts), so these tests also prove the wiring integrates
 * with the real helper rather than a stand-in double.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { paymentFindManyMock, billingDocumentLineFindManyMock, paymentFindFirstMock } = vi.hoisted(() => ({
  paymentFindManyMock: vi.fn(),
  billingDocumentLineFindManyMock: vi.fn(),
  paymentFindFirstMock: vi.fn(),
}));
vi.mock("@kason/db", async () => {
  // Real Prisma.Decimal (from the actual @prisma/client, not a re-implementation)
  // so findRecentDuplicatePayment's `new Prisma.Decimal(...)` construction under
  // test is the IDENTICAL class this file's own assertions build expected
  // values with below (decimal.js instances compare structurally, but only
  // when both sides come from the same class).
  const { Prisma: RealPrisma } = await import("@prisma/client");
  return {
    getDb: () => ({
      payment: { findMany: paymentFindManyMock, findFirst: paymentFindFirstMock },
      billingDocumentLine: { findMany: billingDocumentLineFindManyMock },
    }),
    Prisma: RealPrisma,
  };
});

import { Prisma } from "@kason/db";
import { listPayments, findRecentDuplicatePayment } from "../payments.repository";

const ORG = "org-1";

function allocRow(chargeId: string, chargeNumber: string, over: Record<string, unknown> = {}) {
  return {
    id: `alloc-${chargeId}`,
    allocatedAmount: { toString: () => "1500" },
    allocatedAt: new Date("2026-06-30T05:53:00.000Z"),
    charge: { id: chargeId, chargeNumber },
    ...over,
  };
}

function paymentRow(id: string, allocations: ReturnType<typeof allocRow>[], over: Record<string, unknown> = {}) {
  return {
    id,
    partyId: "party-1",
    paymentNumber: `PAY-${id}`,
    party: { displayName: "Ahmad" },
    paymentType: "rental_payment",
    paymentMethod: "fpx",
    status: "posted",
    amount: { toString: () => "1500" },
    currency: "MYR",
    receivedAt: new Date("2026-06-30T05:53:00.000Z"),
    referenceNote: null,
    idempotencyKey: null,
    allocations,
    ...over,
  };
}

beforeEach(() => {
  paymentFindManyMock.mockReset();
  billingDocumentLineFindManyMock.mockReset();
});

describe("listPayments — allocation documentNumber (Spec1 R6)", () => {
  it("keyset path: allocation documentNumber resolves from the charge's minted document", async () => {
    paymentFindManyMock.mockResolvedValue([paymentRow("1", [allocRow("charge-1", "RENT-1")])]);
    billingDocumentLineFindManyMock.mockResolvedValue([
      { chargeId: "charge-1", document: { id: "doc-1", documentNumber: "DEP-0011", docType: "invoice" } },
    ]);

    const result = await listPayments(ORG, {});

    expect(result.data[0].allocations[0].documentNumber).toBe("DEP-0011");
  });

  it("keyset path: allocation documentNumber is null when the charge has no minted document", async () => {
    paymentFindManyMock.mockResolvedValue([paymentRow("1", [allocRow("charge-2", "RENT-2")])]);
    billingDocumentLineFindManyMock.mockResolvedValue([]); // no minted documents anywhere

    const result = await listPayments(ORG, {});

    expect(result.data[0].allocations[0].documentNumber).toBeNull();
  });

  it("hasUnallocated path: allocation documentNumber resolves the same way as the keyset path", async () => {
    paymentFindManyMock.mockResolvedValue([paymentRow("1", [allocRow("charge-1", "RENT-1")])]);
    billingDocumentLineFindManyMock.mockResolvedValue([
      { chargeId: "charge-1", document: { id: "doc-1", documentNumber: "DEP-0011", docType: "invoice" } },
    ]);

    const result = await listPayments(ORG, { hasUnallocated: false });

    expect(result.data[0].allocations[0].documentNumber).toBe("DEP-0011");
  });

  it("boundary: a zero-allocation row alongside an allocated row does not break documentNumber resolution", async () => {
    paymentFindManyMock.mockResolvedValue([
      paymentRow("1", []), // no allocations at all
      paymentRow("2", [allocRow("charge-1", "RENT-1")]),
    ]);
    billingDocumentLineFindManyMock.mockResolvedValue([
      { chargeId: "charge-1", document: { id: "doc-1", documentNumber: "DEP-0011", docType: "invoice" } },
    ]);

    const result = await listPayments(ORG, {});

    expect(result.data[0].allocations).toEqual([]);
    expect(result.data[1].allocations[0].documentNumber).toBe("DEP-0011");
  });
});

// ── findRecentDuplicatePayment (Spec2 R9) ───────────────────────────────────
// Best-effort in-window duplicate-payment guard for
// recordAndAllocatePaymentService — NOT a DB constraint. Scoped fake timers
// (local to this describe block) pin "now" so the createdAt window boundary
// is deterministic without touching the listPayments tests above.
describe("findRecentDuplicatePayment — where-clause construction (Spec2 R9)", () => {
  const PARTY = "44444444-4444-4444-8444-444444444444";
  const CHARGE_A = "22222222-2222-4222-8222-222222222222";
  const CHARGE_B = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    paymentFindFirstMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the where-clause: org-scoped identity match, posted-only, deterministic createdAt window, chargeId overlap across ALL allocation lines", async () => {
    paymentFindFirstMock.mockResolvedValue({ id: "existing-pay-1" });

    const result = await findRecentDuplicatePayment(ORG, {
      partyId: PARTY,
      amount: 321.5,
      paymentMethod: "bank_transfer",
      chargeIds: [CHARGE_A, CHARGE_B],
      sinceMinutes: 10,
    });

    // amount is asserted as a Decimal (not the raw number 321.5): the
    // where-clause value is now built via Prisma.Decimal so it matches
    // exactly how Payment.amount (numeric(12,2)) is actually stored (Spec2
    // R9 adversarial-review fix) — a clean 2dp input's VALUE is unchanged,
    // only its TYPE going into the query is.
    expect(paymentFindFirstMock).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        partyId: PARTY,
        amount: new Prisma.Decimal("321.5"),
        paymentMethod: "bank_transfer",
        status: "posted",
        createdAt: { gte: new Date("2026-07-06T09:50:00.000Z") },
        allocations: { some: { chargeId: { in: [CHARGE_A, CHARGE_B] } } },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    expect(result).toEqual({ id: "existing-pay-1" });
  });

  // Spec2 R9 adversarial-review fix: the guard used to round its query amount
  // with Math.round(amount*100)/100 (plain float math) at the SERVICE call
  // site. For a 3dp allocation amount (proration/percentage UIs can emit
  // these — allocatedAmount is z.string().min(1), uncapped decimal places),
  // that float rounding disagreed with how Postgres actually rounds
  // numeric(12,2) on write (half-up on the exact decimal string), so a real
  // duplicate payment's stored row was silently missed by the guard's query
  // -> a second payment posted -> double-collection. The fix rounds via
  // Prisma.Decimal (the same decimal-string + half-up pipeline Postgres uses)
  // instead of float math. These three cases share ONE code path/delta
  // (findRecentDuplicatePayment's amount rounding) exercised via three
  // representative inputs, each asserting the FULL where-object so a future
  // regression to any other field (org scope, window, chargeId overlap) is
  // still caught by this same test.
  it("Spec2 R9 fix: a 3-decimal amount that rounds UP under half-up (1.005) builds the where-clause amount as Decimal(1.01) — matching Postgres numeric(12,2) storage — not 1.00 (stale float Math.round) or the raw 1.005", async () => {
    paymentFindFirstMock.mockResolvedValue(null);

    await findRecentDuplicatePayment(ORG, {
      partyId: PARTY,
      amount: 1.005,
      paymentMethod: "bank_transfer",
      chargeIds: [CHARGE_A],
      sinceMinutes: 10,
    });

    expect(paymentFindFirstMock).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        partyId: PARTY,
        amount: new Prisma.Decimal("1.01"),
        paymentMethod: "bank_transfer",
        status: "posted",
        createdAt: { gte: new Date("2026-07-06T09:50:00.000Z") },
        allocations: { some: { chargeId: { in: [CHARGE_A] } } },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("float-summation noise (100.10 + 200.20 = 300.29999999999995 in JS) still rounds down to the stored 2dp value Decimal(300.3) — unchanged from the previous Math.round behavior, now via Decimal", async () => {
    paymentFindFirstMock.mockResolvedValue(null);

    await findRecentDuplicatePayment(ORG, {
      partyId: PARTY,
      amount: 300.29999999999995,
      paymentMethod: "bank_transfer",
      chargeIds: [CHARGE_A],
      sinceMinutes: 10,
    });

    expect(paymentFindFirstMock).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        partyId: PARTY,
        amount: new Prisma.Decimal("300.3"),
        paymentMethod: "bank_transfer",
        status: "posted",
        createdAt: { gte: new Date("2026-07-06T09:50:00.000Z") },
        allocations: { some: { chargeId: { in: [CHARGE_A] } } },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("classic float-representation boundary value (2.675) rounds UP to Decimal(2.68), matching Postgres — decimal-string canonicalization sidesteps 2.675's binary imprecision (stored internally as ~2.67499999999999982)", async () => {
    paymentFindFirstMock.mockResolvedValue(null);

    await findRecentDuplicatePayment(ORG, {
      partyId: PARTY,
      amount: 2.675,
      paymentMethod: "bank_transfer",
      chargeIds: [CHARGE_A],
      sinceMinutes: 10,
    });

    expect(paymentFindFirstMock).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        partyId: PARTY,
        amount: new Prisma.Decimal("2.68"),
        paymentMethod: "bank_transfer",
        status: "posted",
        createdAt: { gte: new Date("2026-07-06T09:50:00.000Z") },
        allocations: { some: { chargeId: { in: [CHARGE_A] } } },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("Spec2 R9 fix hardening: rounding mode is pinned explicitly to HALF_UP, immune to a hostile/accidental global Prisma.Decimal.set() elsewhere in the codebase (Decimal.rounding is shared global mutable state across every Decimal user — commissions, renovation-claims, owner-billing, ...)", async () => {
    paymentFindFirstMock.mockResolvedValue(null);
    const originalRounding = Prisma.Decimal.rounding;
    Prisma.Decimal.set({ rounding: Prisma.Decimal.ROUND_DOWN }); // hostile global state set by "some other code path"
    try {
      await findRecentDuplicatePayment(ORG, {
        partyId: PARTY,
        amount: 1.005,
        paymentMethod: "bank_transfer",
        chargeIds: [CHARGE_A],
        sinceMinutes: 10,
      });

      expect(paymentFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ amount: new Prisma.Decimal("1.01") }),
        }),
      );
    } finally {
      // MUST restore: Decimal.rounding is global mutable state shared by the
      // whole test run (other files' tests would silently break if this leaked).
      Prisma.Decimal.set({ rounding: originalRounding });
    }
  });
});
