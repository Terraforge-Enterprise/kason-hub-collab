import { describe, it, expect, vi, beforeEach } from "vitest";
import { SEED_CHARGE_CATEGORIES, SEED_DOCUMENT_SERIES } from "@kason/shared";

const mocks = vi.hoisted(() => ({
  seriesFindMany: vi.fn(),
  seriesCreate: vi.fn(),
  categoryFindMany: vi.fn(),
  categoryCreate: vi.fn(),
}));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    documentSeries: { findMany: mocks.seriesFindMany, create: mocks.seriesCreate },
    chargeCategory: { findMany: mocks.categoryFindMany, create: mocks.categoryCreate },
  }),
}));

import { ensureChargeCategorySeeds } from "../seed";

const ORG = "org-1";
const SERIES_ROWS = SEED_DOCUMENT_SERIES.map((s, i) => ({ id: `series-${i}`, code: s.code }));
const CATEGORY_CODE_ROWS = SEED_CHARGE_CATEGORIES.map((c) => ({ code: c.code }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureChargeCategorySeeds", () => {
  it("creates nothing when every seed code already exists — no updatedAt churn on existing rows", async () => {
    // Same mock backs both the existence-check read and the id-resolution
    // re-read; a stable DB returns the same rows either way.
    mocks.seriesFindMany.mockResolvedValue(SERIES_ROWS);
    mocks.categoryFindMany.mockResolvedValue(CATEGORY_CODE_ROWS);

    await ensureChargeCategorySeeds(ORG);

    expect(mocks.seriesCreate).not.toHaveBeenCalled();
    expect(mocks.categoryCreate).not.toHaveBeenCalled();
  });

  it("creates exactly every seed series and category when none exist yet", async () => {
    mocks.seriesFindMany
      .mockResolvedValueOnce([]) // existence check: nothing seeded yet
      .mockResolvedValueOnce(SERIES_ROWS); // id-resolution re-read after creates
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.seriesCreate.mockResolvedValue({});
    mocks.categoryCreate.mockResolvedValue({});

    await ensureChargeCategorySeeds(ORG);

    expect(mocks.seriesCreate).toHaveBeenCalledTimes(SEED_DOCUMENT_SERIES.length);
    expect(mocks.categoryCreate).toHaveBeenCalledTimes(SEED_CHARGE_CATEGORIES.length);
    for (const call of mocks.seriesCreate.mock.calls) {
      expect(call[0].data.organizationId).toBe(ORG);
    }
    for (const call of mocks.categoryCreate.mock.calls) {
      expect(call[0].data.organizationId).toBe(ORG);
    }
  });

  it("wires each category to its series id resolved by code", async () => {
    mocks.seriesFindMany.mockResolvedValue(SERIES_ROWS); // series already exist
    mocks.categoryFindMany.mockResolvedValue([]); // categories don't exist yet
    mocks.categoryCreate.mockResolvedValue({});

    await ensureChargeCategorySeeds(ORG);

    const rentalCall = mocks.categoryCreate.mock.calls.find((c) => c[0].data.code === "rental");
    // Rental Bill (redesign P2, 2026-07-22): rent wires to RB (its own "Rental Bill"
    // series), not the shared DEP debit-note pool it used to share with utilities/deposits.
    const rbId = SERIES_ROWS.find((s) => s.code === "RB")!.id;
    expect(rentalCall![0].data.seriesId).toBe(rbId);
    expect(rentalCall![0].data.ledgerCategory).toBe("rental_income");
    // carpark rental also moves to RB (Rental Bill = rent + parking rental).
    const carparkCall = mocks.categoryCreate.mock.calls.find((c) => c[0].data.code === "carpark");
    expect(carparkCall![0].data.seriesId).toBe(rbId);
  });

  it("does not throw when a category create hits P2002 (name collision or concurrent seed race)", async () => {
    mocks.seriesFindMany.mockResolvedValue(SERIES_ROWS);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.categoryCreate.mockRejectedValueOnce({ code: "P2002" }).mockResolvedValue({});

    await expect(ensureChargeCategorySeeds(ORG)).resolves.toBeUndefined();
    expect(mocks.categoryCreate).toHaveBeenCalledTimes(SEED_CHARGE_CATEGORIES.length);
  });

  it("does not throw when a series create hits P2002 (concurrent seed race)", async () => {
    mocks.seriesFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(SERIES_ROWS);
    mocks.categoryFindMany.mockResolvedValue(CATEGORY_CODE_ROWS); // categories already there too
    mocks.seriesCreate.mockRejectedValueOnce({ code: "P2002" }).mockResolvedValue({});

    await expect(ensureChargeCategorySeeds(ORG)).resolves.toBeUndefined();
    expect(mocks.seriesCreate).toHaveBeenCalledTimes(SEED_DOCUMENT_SERIES.length);
  });

  it("propagates a non-P2002 error from a category create", async () => {
    mocks.seriesFindMany.mockResolvedValue(SERIES_ROWS);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.categoryCreate.mockRejectedValueOnce(new Error("boom"));

    await expect(ensureChargeCategorySeeds(ORG)).rejects.toThrow("boom");
  });

  it("propagates a non-P2002 error from a series create", async () => {
    mocks.seriesFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.categoryFindMany.mockResolvedValue([]);
    mocks.seriesCreate.mockRejectedValueOnce(new Error("boom"));

    await expect(ensureChargeCategorySeeds(ORG)).rejects.toThrow("boom");
  });
});
