/**
 * service.create-bill-bearer.test.ts — Workstream C ("whole-unit bears all utilities").
 *
 * Unit-level (no DB; @kason/db aliased to the mock by vitest.config when
 * RUN_INTEGRATION is unset). Proves the BEARER DEFAULT at bill creation:
 *
 *   - WHOLE apartment  → indahWater/cleaning/wifi bearer DEFAULT to "tenant"
 *     (the single tenant bears ALL utilities; schema comment @2026-06-18 spec:
 *      "WHOLE units always have the single tenant bear all").
 *   - PARTITIONED apartment (subsidy / no_subsidy) → DEFAULT stays "owner".
 *   - An explicit input bearer ALWAYS wins (admin override), even on WHOLE.
 *
 * The compute/pooling/subsidy math (compute.ts) is intentionally NOT touched —
 * only the bearer column written at create. Mocks findApartmentModes so the
 * test is pure (no Postgres). The tx body runs against a fake tx whose
 * apartment.findFirst returns the apartment existence row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// recordAudit is a no-op in these tests (audit content is asserted elsewhere).
vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

// Wrap the aliased @kason/db stub so getDb is a spy we can repoint per-test.
vi.mock("@kason/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kason/db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

// Partial-mock the repository: stub the functions createUtilityBillService
// touches; keep everything else real. getBill is stubbed to null so the PART 1
// draft owner-borne snapshot block short-circuits (the snapshot is exercised by
// the meter integration suite; this unit test only asserts the bearer default
// written on the createBill call).
vi.mock("../repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository")>();
  return {
    ...actual,
    findApartmentModes: vi.fn(),
    findBillByAptPeriod: vi.fn(),
    createBill: vi.fn(),
    getBill: vi.fn(),
  };
});

import { getDb } from "@kason/db";
import * as repo from "../repository";
import { createUtilityBillService } from "../service";

const ORG = "c2000000-0000-4000-8000-000000000001";
const USER = "c2000000-0000-4000-8000-000000000002";
const APT = "c2000000-0000-4000-8000-000000000004";
const sess = { orgId: ORG, userId: USER, role: "manager" as const, userType: "operator" as const };

const findApartmentModes = vi.mocked(repo.findApartmentModes);
const findBillByAptPeriod = vi.mocked(repo.findBillByAptPeriod);
const createBill = vi.mocked(repo.createBill);
const getBill = vi.mocked(repo.getBill);

/** Fake tx whose only used method is apartment.findFirst → the existence row. */
function fakeTx() {
  return {
    apartment: { findFirst: vi.fn(async () => ({ id: APT })) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // getDb().$transaction(cb) → run cb against the fake tx.
  const tx = fakeTx();
  vi.mocked(getDb).mockReturnValue({
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  } as never);
  // No existing bill for the period (so create proceeds).
  findBillByAptPeriod.mockResolvedValue(null as never);
  // createBill echoes back an id so the service can return it.
  createBill.mockResolvedValue({ id: "bill-id" } as never);
  // PART 1: getBill null → the draft owner-borne snapshot block short-circuits.
  getBill.mockResolvedValue(null as never);
});

/** The data object passed to repo.createBill on the most recent call. */
function createdBill() {
  return createBill.mock.calls[0]![1] as {
    indahWaterBearer: string;
    cleaningBearer: string;
    wifiBearer: string;
  };
}

const baseInput = { apartmentId: APT, periodMonth: "2026-06-01", tnbTotal: "100.00" };

describe("createUtilityBillService — bearer default by apartment mode", () => {
  it("WHOLE apartment → indahWater/cleaning/wifi default to 'tenant'", async () => {
    findApartmentModes.mockResolvedValue({ listingMode: "WHOLE", partitionBillingMode: "NO_SUBSIDY" } as never);

    const res = await createUtilityBillService(sess, baseInput);
    expect(res.ok).toBe(true);

    const data = createdBill();
    expect(data.indahWaterBearer).toBe("tenant");
    expect(data.cleaningBearer).toBe("tenant");
    expect(data.wifiBearer).toBe("tenant");
  });

  it("PARTITIONED + NO_SUBSIDY apartment → bearers default to 'owner'", async () => {
    findApartmentModes.mockResolvedValue({ listingMode: "PARTITIONED", partitionBillingMode: "NO_SUBSIDY" } as never);

    const res = await createUtilityBillService(sess, baseInput);
    expect(res.ok).toBe(true);

    const data = createdBill();
    expect(data.indahWaterBearer).toBe("owner");
    expect(data.cleaningBearer).toBe("owner");
    expect(data.wifiBearer).toBe("owner");
  });

  it("PARTITIONED + SUBSIDY apartment → bearers default to 'owner'", async () => {
    findApartmentModes.mockResolvedValue({ listingMode: "PARTITIONED", partitionBillingMode: "SUBSIDY" } as never);

    const res = await createUtilityBillService(sess, baseInput);
    expect(res.ok).toBe(true);

    const data = createdBill();
    expect(data.indahWaterBearer).toBe("owner");
    expect(data.cleaningBearer).toBe("owner");
    expect(data.wifiBearer).toBe("owner");
  });

  it("explicit input bearer wins on a WHOLE apartment (admin override preserved)", async () => {
    findApartmentModes.mockResolvedValue({ listingMode: "WHOLE", partitionBillingMode: "NO_SUBSIDY" } as never);

    const res = await createUtilityBillService(sess, {
      ...baseInput,
      indahWaterBearer: "owner",
      // cleaning/wifi left unspecified → still take the WHOLE default ("tenant").
    });
    expect(res.ok).toBe(true);

    const data = createdBill();
    expect(data.indahWaterBearer).toBe("owner"); // explicit override beats the WHOLE default
    expect(data.cleaningBearer).toBe("tenant");
    expect(data.wifiBearer).toBe("tenant");
  });

  it("explicit 'tenant' bearer wins on a PARTITIONED apartment (admin override preserved)", async () => {
    findApartmentModes.mockResolvedValue({ listingMode: "PARTITIONED", partitionBillingMode: "NO_SUBSIDY" } as never);

    const res = await createUtilityBillService(sess, {
      ...baseInput,
      cleaningBearer: "tenant",
    });
    expect(res.ok).toBe(true);

    const data = createdBill();
    expect(data.indahWaterBearer).toBe("owner"); // PARTITIONED default
    expect(data.cleaningBearer).toBe("tenant"); // explicit override
    expect(data.wifiBearer).toBe("owner"); // PARTITIONED default
  });
});
