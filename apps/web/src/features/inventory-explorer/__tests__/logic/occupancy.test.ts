import { describe, it, expect } from "vitest";
import { classifyOccupancy } from "../../logic/occupancy";
import type { InventoryListing } from "../../domain/types";

const FIXED_TODAY = new Date("2026-05-01T00:00:00.000Z");

const mk = (over: Partial<InventoryListing>): InventoryListing => ({
  id: "u1", unitCode: "A-01", unitType: "condo", bedrooms: 2, bathrooms: 1,
  floorArea: 800, rentalRate: "2000", currency: "MYR",
  moveInDate: null, readyNow: false,
  occupancyStatus: "occupied",
  inChargeName: "Alice", inChargePartyId: "p-alice", photoKeys: [], videoKeys: [],
  coverPhotoUrl: null,
  title: null, description: null, amenities: [], furnishingLevel: null,
  floor: null, facing: null, depositMonths: null,
  utilitiesDepositMonths: null, accessCardDepositPerPcs: null,
  accessCardQuantity: null, parkingQuantity: null, parkingNumbers: [],
  vacantSince: null,
  listingStatus: "active",
  visibilityMode: "PUBLIC", hiddenFromPartyIds: [],
  sourceFlag: "COMPANY", sourcingAgentId: null, sourcingAgentName: null, sourcingApproved: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  currentTenancyStartDate: null, currentTenancyEndDate: null,
  property: { name: "Bangsar South", city: "Kuala Lumpur" }, ...over,
});

describe("classifyOccupancy", () => {
  it("readyNow=true is always 'ready' regardless of other fields", () => {
    expect(
      classifyOccupancy(
        mk({ readyNow: true, currentTenancyEndDate: "2099-01-01" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("ready");
  });

  it("future moveInDate (and not ready) is 'upcoming'", () => {
    expect(
      classifyOccupancy(mk({ moveInDate: "2026-06-01" }), 60, FIXED_TODAY),
    ).toBe("upcoming");
  });

  it("moveInDate equal to today counts as 'upcoming'", () => {
    expect(
      classifyOccupancy(mk({ moveInDate: "2026-05-01" }), 60, FIXED_TODAY),
    ).toBe("upcoming");
  });

  it("currentTenancyEndDate within window is 'ending-soon'", () => {
    expect(
      classifyOccupancy(
        mk({ currentTenancyEndDate: "2026-05-31T00:00:00.000Z" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("ending-soon");
  });

  it("currentTenancyEndDate exactly today+window is still 'ending-soon' (inclusive)", () => {
    // 2026-05-01 + 60d = 2026-06-30
    expect(
      classifyOccupancy(
        mk({ currentTenancyEndDate: "2026-06-30T00:00:00.000Z" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("ending-soon");
  });

  it("currentTenancyEndDate one day past window is 'occupied'", () => {
    expect(
      classifyOccupancy(
        mk({ currentTenancyEndDate: "2026-07-01T00:00:00.000Z" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("occupied");
  });

  it("open-ended lease (no endDate, not ready, no future moveInDate) is 'occupied'", () => {
    expect(classifyOccupancy(mk({}), 60, FIXED_TODAY)).toBe("occupied");
  });

  it("stale moveInDate in the past is 'occupied'", () => {
    expect(
      classifyOccupancy(mk({ moveInDate: "2026-04-01" }), 60, FIXED_TODAY),
    ).toBe("occupied");
  });

  it("currentTenancyEndDate in the past is 'occupied' (manager hasn't deleted yet)", () => {
    expect(
      classifyOccupancy(
        mk({ currentTenancyEndDate: "2026-04-01T00:00:00.000Z" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("occupied");
  });

  it("readyNow=true wins over a past currentTenancyEndDate (precedence)", () => {
    expect(
      classifyOccupancy(
        mk({
          readyNow: true,
          currentTenancyEndDate: "2026-04-01T00:00:00.000Z",
        }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("ready");
  });

  it("future moveInDate wins over an in-window currentTenancyEndDate (precedence)", () => {
    expect(
      classifyOccupancy(
        mk({
          readyNow: false,
          moveInDate: "2026-06-01",
          currentTenancyEndDate: "2026-05-15T00:00:00.000Z",
        }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("upcoming");
  });

  it("windowDays=0 only classifies an end date exactly equal to today as 'ending-soon'", () => {
    expect(
      classifyOccupancy(
        mk({ currentTenancyEndDate: "2026-05-01T00:00:00.000Z" }),
        0,
        FIXED_TODAY,
      ),
    ).toBe("ending-soon");
    expect(
      classifyOccupancy(
        mk({ currentTenancyEndDate: "2026-05-02T00:00:00.000Z" }),
        0,
        FIXED_TODAY,
      ),
    ).toBe("occupied");
  });

  it("malformed date string throws (data-shape regression fails loud, not silent)", () => {
    expect(() =>
      classifyOccupancy(mk({ currentTenancyEndDate: "not-a-date" }), 60, FIXED_TODAY),
    ).toThrow(/invalid date string/);
  });

  it("occupancyStatus='vacant' is 'ready' even when readyNow=false", () => {
    expect(
      classifyOccupancy(
        mk({ readyNow: false, occupancyStatus: "vacant" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("ready");
  });

  it("future moveInDate beats occupancyStatus='vacant' (precedence)", () => {
    expect(
      classifyOccupancy(
        mk({
          readyNow: false,
          occupancyStatus: "vacant",
          moveInDate: "2026-06-01",
        }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("upcoming");
  });

  it("readyNow=true and occupancyStatus='vacant' is still 'ready' (no contradiction)", () => {
    expect(
      classifyOccupancy(
        mk({ readyNow: true, occupancyStatus: "vacant" }),
        60,
        FIXED_TODAY,
      ),
    ).toBe("ready");
  });
});
