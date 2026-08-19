/**
 * findUnitsOwned — the owner "Portfolio → Units owned" data source.
 *
 * An owner owns a physical APARTMENT, but each apartment can carry many
 * Listing rows (PARTITIONED Master/Medium/Small rooms + carpark slots), all
 * sharing the apartment's unitCode. The portfolio must therefore collapse
 * listings to DISTINCT apartments (no "B-08-08, B-08-08, B-08-08, B-08-08")
 * and label each with its property (a bare unit code is ambiguous across
 * properties). This test file pins that dedupe + property-name contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = { listing: { findMany: vi.fn() } };

vi.mock("@kason/db", () => ({ getDb: () => dbMock, Prisma: {} }));

import { findUnitsOwned } from "../parties.repository";

beforeEach(() => {
  dbMock.listing.findMany.mockReset();
  dbMock.listing.findMany.mockResolvedValue([]);
});

describe("findUnitsOwned — dedupe + property", () => {
  it("dedupes multiple listings that share one apartment into a single entry", async () => {
    // One PARTITIONED apartment (apt-1 / "B-08-08") with 4 room listings, all
    // owned by the same owner — the exact "B-08-08 ×4" reported bug.
    dbMock.listing.findMany.mockResolvedValueOnce([
      { apartmentId: "apt-1", apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
      { apartmentId: "apt-1", apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
      { apartmentId: "apt-1", apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
      { apartmentId: "apt-1", apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
    ]);

    const result = await findUnitsOwned("org-1", "owner-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ apartmentId: "apt-1", unitCode: "B-08-08" });
  });

  it("labels each apartment with its property name", async () => {
    dbMock.listing.findMany.mockResolvedValueOnce([
      { apartmentId: "apt-1", apartment: { unitCode: "B-08-08", property: { name: "Vista Court" } } },
    ]);

    const result = await findUnitsOwned("org-1", "owner-1");

    expect(result[0]).toEqual({
      apartmentId: "apt-1",
      unitCode: "B-08-08",
      propertyName: "Vista Court",
    });
  });

  it("keeps distinct apartments and orders them by property then unit code", async () => {
    // Deliberately unsorted input across two properties.
    dbMock.listing.findMany.mockResolvedValueOnce([
      { apartmentId: "apt-3", apartment: { unitCode: "A-02-01", property: { name: "Zen Towers" } } },
      { apartmentId: "apt-1", apartment: { unitCode: "B-08-08", property: { name: "Amber Court" } } },
      { apartmentId: "apt-2", apartment: { unitCode: "A-01-01", property: { name: "Amber Court" } } },
    ]);

    const result = await findUnitsOwned("org-1", "owner-1");

    expect(result.map((u) => `${u.propertyName}/${u.unitCode}`)).toEqual([
      "Amber Court/A-01-01",
      "Amber Court/B-08-08",
      "Zen Towers/A-02-01",
    ]);
  });

  it("returns an empty array when the owner owns no listings", async () => {
    dbMock.listing.findMany.mockResolvedValueOnce([]);
    expect(await findUnitsOwned("org-1", "owner-1")).toEqual([]);
  });
});
