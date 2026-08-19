import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client";

/**
 * Unit tests for searchProperties (portal.commissions.repository).
 *
 * Pattern mirrors existing tests in this folder:
 *  - Mock `@kason/db` with a mutable `dbMock` shape.
 *  - Call the repository function directly.
 *  - Assert the reshaped output (one units[] entry per unitCode, not one per listing).
 */

// ── DB mock ─────────────────────────────────────────────────────────────────
const dbMock = {
  property: {
    findMany: vi.fn(),
  },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import { searchProperties } from "../portal.commissions.repository";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// ── Helper: raw DB row simulating what Prisma returns for searchProperties ──
function makePropertyRow(overrides?: {
  id?: string;
  name?: string;
  apartments?: Array<{
    unitCode: string;
    listings: Array<{ id: string; listingType: string; rentalRate: Decimal | null }>;
  }>;
}) {
  return {
    id: overrides?.id ?? "p-aaaa-0001",
    name: overrides?.name ?? "Annex Residence",
    hasPaxDeduction: false,
    paxDeductionAmount: null,
    apartments: overrides?.apartments ?? [],
  };
}

// ── describe: reshape — one units[] entry per unitCode ──────────────────────
describe("searchProperties — reshape: one units[] entry per unitCode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns one units[] entry per apartment with rooms grouped (B-12-24 partitioned)", async () => {
    // Simulate a partitioned apartment B-12-24 with Master / Medium / Small listings.
    dbMock.property.findMany.mockResolvedValueOnce([
      makePropertyRow({
        apartments: [
          {
            unitCode: "B-12-24",
            listings: [
              { id: "l-master-1", listingType: "Master", rentalRate: new Decimal("1500.00") },
              { id: "l-medium-1", listingType: "Medium", rentalRate: new Decimal("1200.00") },
              { id: "l-small-1",  listingType: "Small",  rentalRate: new Decimal("900.00")  },
            ],
          },
        ],
      }),
    ]);

    const properties = await searchProperties(ORG);

    expect(properties).toHaveLength(1);
    const annex = properties[0];
    expect(annex.units).toHaveLength(1);

    const b1224 = annex.units.filter((u) => u.unitCode === "B-12-24");
    expect(b1224).toHaveLength(1); // KEY assertion — was 3 before fix

    const rooms = b1224[0].rooms;
    expect(rooms).toHaveLength(3);

    const roomTypes = rooms.map((r) => r.roomType).sort();
    expect(roomTypes).toEqual(["Master", "Medium", "Small"]);

    expect(rooms.every((r) => typeof r.id === "string")).toBe(true);
  });

  it("returns one units[] entry per apartment when listing is whole-unit (single listing)", async () => {
    dbMock.property.findMany.mockResolvedValueOnce([
      makePropertyRow({
        apartments: [
          {
            unitCode: "A-07-12",
            listings: [
              { id: "l-whole-1", listingType: "Whole Unit", rentalRate: new Decimal("2500.00") },
            ],
          },
        ],
      }),
    ]);

    const properties = await searchProperties(ORG);

    expect(properties[0].units).toHaveLength(1);
    expect(properties[0].units[0].unitCode).toBe("A-07-12");
    expect(properties[0].units[0].rooms).toHaveLength(1);
    expect(properties[0].units[0].rooms[0].roomType).toBe("Whole Unit");
  });

  it("returns an empty units[] when apartment has no non-archived listings", async () => {
    // The Prisma query already filters out archived listings at the DB layer,
    // so apartments with zero matching listings arrive with an empty array.
    dbMock.property.findMany.mockResolvedValueOnce([
      makePropertyRow({
        apartments: [
          { unitCode: "C-03-08", listings: [] },
        ],
      }),
    ]);

    const properties = await searchProperties(ORG);

    // The apartment should still appear as a units[] entry with an empty rooms[].
    expect(properties[0].units).toHaveLength(1);
    expect(properties[0].units[0].rooms).toHaveLength(0);
  });

  it("groups two apartments under the same property correctly", async () => {
    dbMock.property.findMany.mockResolvedValueOnce([
      makePropertyRow({
        apartments: [
          {
            unitCode: "D-05-20",
            listings: [
              { id: "l-d-master", listingType: "Master", rentalRate: new Decimal("1400.00") },
              { id: "l-d-medium", listingType: "Medium", rentalRate: new Decimal("1100.00") },
              { id: "l-d-small",  listingType: "Small",  rentalRate: new Decimal("850.00")  },
            ],
          },
          {
            unitCode: "E-01-03",
            listings: [
              { id: "l-e-whole", listingType: "Whole Unit", rentalRate: new Decimal("3200.00") },
            ],
          },
        ],
      }),
    ]);

    const properties = await searchProperties(ORG);

    expect(properties[0].units).toHaveLength(2);

    const d0520 = properties[0].units.find((u) => u.unitCode === "D-05-20")!;
    expect(d0520.rooms).toHaveLength(3); // was 3 separate units[] entries before fix

    const e0103 = properties[0].units.find((u) => u.unitCode === "E-01-03")!;
    expect(e0103.rooms).toHaveLength(1);
  });

  it("preserves hasPaxDeduction and paxDeductionAmount on the property", async () => {
    dbMock.property.findMany.mockResolvedValueOnce([
      {
        id: "p-pax-1",
        name: "Pax Test Condo",
        hasPaxDeduction: true,
        paxDeductionAmount: new Decimal("150.00"),
        apartments: [],
      },
    ]);

    const properties = await searchProperties(ORG);

    expect(properties[0].hasPaxDeduction).toBe(true);
    expect(properties[0].paxDeductionAmount).not.toBeNull();
  });
});
