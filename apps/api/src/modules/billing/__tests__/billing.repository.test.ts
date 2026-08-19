import { describe, it, expect, vi, beforeEach } from "vitest";

// Spec §4.8 gap: GET /billing/charges register was unpaginated at 100+ unit
// scale. These tests cover listCharges' two modes directly against a mocked
// Prisma client — no-pagination must reproduce the OLD query byte-for-byte
// (no skip/take), and paginated mode must slice via skip/take AND scope the
// documentNumber enrich lookup to only the returned page's charge ids.

const { chargeFindManyMock, chargeCountMock, docLineFindManyMock } = vi.hoisted(() => ({
  chargeFindManyMock: vi.fn(),
  chargeCountMock: vi.fn(),
  docLineFindManyMock: vi.fn(),
}));

vi.mock("@kason/db", async () => {
  // Re-export the REAL Prisma.Decimal (from @prisma/client, not a
  // re-implementation) so findActiveDuplicateCharge's `new Prisma.Decimal(...)`
  // amount rounding under test is the IDENTICAL class this file's assertions
  // build expected values with below (decimal.js instances compare structurally
  // only when both sides come from the same class). Mirrors
  // payments.repository.test.ts's mock for findRecentDuplicatePayment.
  const { Prisma: RealPrisma } = await import("@prisma/client");
  return {
    getDb: () => ({
      charge: {
        findMany: chargeFindManyMock,
        count: chargeCountMock,
      },
      billingDocumentLine: {
        findMany: docLineFindManyMock,
      },
    }),
    Prisma: RealPrisma,
  };
});

import { Prisma } from "@kason/db";
import { listCharges, countCharges, findActiveDuplicateCharge } from "../billing.repository";

const ORG = "org-1";

function chargeRow(id: string) {
  return {
    id,
    chargeNumber: `CHG-${id}`,
    party: { displayName: "Alice" },
    tenancy: { tenancyCode: "T-1" },
    unit: { apartment: { unitCode: "A-1" } },
    invoice: null,
    chargeType: "rent",
    status: "posted",
    dueDate: new Date("2026-07-01T00:00:00.000Z"),
    amount: "100.00",
    outstandingAmount: "100.00",
    currency: "MYR",
    events: [],
  };
}

beforeEach(() => {
  chargeFindManyMock.mockReset();
  chargeCountMock.mockReset();
  docLineFindManyMock.mockReset();
  docLineFindManyMock.mockResolvedValue([]);
});

describe("listCharges — no pagination (back-compat, spec §4.8)", () => {
  it("queries the full list with NO skip/take when pagination is omitted", async () => {
    chargeFindManyMock.mockResolvedValueOnce([chargeRow("c1"), chargeRow("c2")]);

    const result = await listCharges(ORG);

    expect(chargeFindManyMock).toHaveBeenCalledTimes(1);
    const callArgs = chargeFindManyMock.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("skip");
    expect(callArgs).not.toHaveProperty("take");
    expect(callArgs.where).toEqual({ organizationId: ORG });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("enrich (documentNumber lookup) runs over the full returned set", async () => {
    chargeFindManyMock.mockResolvedValueOnce([chargeRow("c1"), chargeRow("c2"), chargeRow("c3")]);

    await listCharges(ORG);

    expect(docLineFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chargeId: { in: ["c1", "c2", "c3"] } },
      }),
    );
  });
});

describe("listCharges — paginated mode (spec §4.8 gap fix)", () => {
  it("applies skip/take from page + pageSize", async () => {
    chargeFindManyMock.mockResolvedValueOnce([chargeRow("c26")]);

    await listCharges(ORG, { page: 2, pageSize: 25 });

    const callArgs = chargeFindManyMock.mock.calls[0][0];
    expect(callArgs.skip).toBe(25);
    expect(callArgs.take).toBe(25);
  });

  it("page 1 has skip 0", async () => {
    chargeFindManyMock.mockResolvedValueOnce([]);
    await listCharges(ORG, { page: 1, pageSize: 10 });
    const callArgs = chargeFindManyMock.mock.calls[0][0];
    expect(callArgs.skip).toBe(0);
    expect(callArgs.take).toBe(10);
  });

  it("scopes the documentNumber enrich lookup to ONLY the returned page's charge ids, not the full table", async () => {
    // Prisma's mocked findMany already returns just the page slice (skip/take
    // is a DB-level concern) — the important assertion is that the batched
    // billingDocumentLine lookup keys off exactly those returned rows.
    chargeFindManyMock.mockResolvedValueOnce([chargeRow("page2-only")]);

    await listCharges(ORG, { page: 2, pageSize: 25 });

    expect(docLineFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chargeId: { in: ["page2-only"] } },
      }),
    );
    // Never asked for ids outside the page slice.
    const inIds = docLineFindManyMock.mock.calls[0][0].where.chargeId.in;
    expect(inIds).toEqual(["page2-only"]);
  });

  it("returns the same DTO shape as the unpaginated mode (documentNumber included)", async () => {
    docLineFindManyMock.mockResolvedValueOnce([
      { chargeId: "c1", document: { documentNumber: "IVTEN-0001", docType: "invoice" } },
    ]);
    chargeFindManyMock.mockResolvedValueOnce([chargeRow("c1")]);

    const result = await listCharges(ORG, { page: 1, pageSize: 25 });

    expect(result[0]).toMatchObject({ id: "c1", documentNumber: "IVTEN-0001" });
  });
});

describe("countCharges", () => {
  it("counts all org charges regardless of pagination", async () => {
    chargeCountMock.mockResolvedValueOnce(137);
    const total = await countCharges(ORG);
    expect(total).toBe(137);
    expect(chargeCountMock).toHaveBeenCalledWith({ where: { organizationId: ORG } });
  });
});

// ── findActiveDuplicateCharge — where-clause amount rounding (Spec2 R1/R9) ────
// Payment-guard parity: the duplicate-charge check-first must round its query
// `amount` the SAME way Charge.amount (numeric(12,2)) is stored — via
// Prisma.Decimal half-up — so a sub-cent (3dp) charge amount still matches the
// stored 2dp row and the 409 returns the existing charge id. createChargeSchema
// amount is z.string().min(1) (no decimal-place cap), so a 3dp amount is
// API/tracker-reachable. A raw-float query value (the previous `amount: k.amount`)
// silently missed the stored row for such inputs — the DB partial index still
// blocked the double-charge, but the 409 lost existingChargeId. Mirrors
// payments.repository.test.ts's findRecentDuplicatePayment rounding tests.
describe("findActiveDuplicateCharge — where-clause amount rounding (Spec2 R1/R9 parity)", () => {
  const UNIT = "10000000-0000-4000-8000-000000000001";
  const CATEGORY = "20000000-0000-4000-8000-000000000001";
  const BILLING_MONTH = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01 UTC

  function txWithFindFirst(result: { id: string } | null) {
    const findFirst = vi.fn().mockResolvedValue(result);
    return { tx: { charge: { findFirst } } as never, findFirst };
  }

  it("rounds a 3-decimal amount UP under half-up (100.005) to Decimal(100.01) — matching Postgres numeric(12,2) storage — not the raw 100.005; full where-object asserted so any other field regression is caught too", async () => {
    const { tx, findFirst } = txWithFindFirst({ id: "charge-existing" });

    const result = await findActiveDuplicateCharge(tx, "org-1", {
      unitId: UNIT,
      categoryId: CATEGORY,
      billingMonth: BILLING_MONTH,
      amount: 100.005,
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        unitId: UNIT,
        categoryId: CATEGORY,
        billingMonth: BILLING_MONTH,
        amount: new Prisma.Decimal("100.01"),
        status: { notIn: ["void", "credited"] },
      },
      select: { id: true },
    });
    expect(result).toEqual({ id: "charge-existing" });
  });

  it("a clean 2-decimal amount (100) is unchanged in VALUE — only its TYPE going into the query becomes Decimal(100)", async () => {
    const { tx, findFirst } = txWithFindFirst(null);

    await findActiveDuplicateCharge(tx, "org-1", {
      unitId: UNIT,
      categoryId: CATEGORY,
      billingMonth: BILLING_MONTH,
      amount: 100,
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amount: new Prisma.Decimal("100") }),
      }),
    );
  });

  it("rounding mode is pinned to HALF_UP explicitly — immune to a hostile/accidental global Prisma.Decimal.set() elsewhere (Decimal.rounding is shared global mutable state across every Decimal user)", async () => {
    const { tx, findFirst } = txWithFindFirst(null);
    const originalRounding = Prisma.Decimal.rounding;
    Prisma.Decimal.set({ rounding: Prisma.Decimal.ROUND_DOWN }); // hostile global set by "some other code path"
    try {
      await findActiveDuplicateCharge(tx, "org-1", {
        unitId: UNIT,
        categoryId: CATEGORY,
        billingMonth: BILLING_MONTH,
        amount: 100.005,
      });

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ amount: new Prisma.Decimal("100.01") }),
        }),
      );
    } finally {
      // MUST restore: Decimal.rounding is global mutable state shared by the
      // whole test run (other files' tests would silently break if this leaked).
      Prisma.Decimal.set({ rounding: originalRounding });
    }
  });
});
