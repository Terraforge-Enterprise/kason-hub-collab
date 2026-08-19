import { describe, expect, it, vi } from "vitest";

vi.mock("../portal.listings.repository", () => ({
  findListingsForAgent: vi.fn(),
  findGrantsForAgent: vi.fn(),
}));

import { getVisibleUnit, listVisibleUnits } from "../portal.listings.service";
import { findGrantsForAgent, findListingsForAgent } from "../portal.listings.repository";

type UnitShape = {
  id: string;
  unitCode: string;
  unitType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  floorArea: number | null;
  rentalRate: number | null;
  currency: string;
  moveInDate: Date | null;
  readyNow: boolean;
  occupancyStatus: string;
  inChargeName: string | null;
  inChargePartyId: string | null;
  photoKeys: string[];
  videoKeys: string[];
  title: string | null;
  description: string | null;
  amenities: { id: string; name: string }[];
  furnishingLevel: string | null;
  floor: number | null;
  facing: string | null;
  depositMonths: number | null;
  vacantSince: string | null;
  listingStatus: string;
  visibilityMode: "PUBLIC" | "RESTRICTED";
  hiddenFromPartyIds: string[];
  sourceFlag: "COMPANY" | "AGENT_SOURCED";
  sourcingAgentId: string | null;
  sourcingApproved: boolean;
  createdAt: Date;
  currentTenancyEndDate: string | null;
  property: { name: string; city: string | null } | null;
};

function baseUnit(over: Partial<UnitShape> = {}): UnitShape {
  return {
    id: "u1",
    unitCode: "A-01",
    unitType: "apartment",
    bedrooms: 2,
    bathrooms: 1,
    floorArea: 50,
    rentalRate: 1500,
    currency: "MYR",
    moveInDate: null,
    readyNow: true,
    occupancyStatus: "occupied",
    inChargeName: "Iv",
    inChargePartyId: "iv-party",
    photoKeys: [],
    videoKeys: [],
    title: null,
    description: null,
    amenities: [],
    furnishingLevel: null,
    floor: null,
    facing: null,
    depositMonths: null,
    vacantSince: null,
    listingStatus: "active",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    // Every Listing in the new model is approved by definition. The derived
    // sourceFlag mirrors whether sourcingAgentId is set.
    sourceFlag: "COMPANY",
    sourcingAgentId: null,
    sourcingApproved: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    currentTenancyEndDate: null,
    property: { name: "Prop", city: "KL" },
    ...over,
  };
}

describe("listVisibleUnits", () => {
  it("PUBLIC visible to all agents not hidden", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([baseUnit()]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const rows = await listVisibleUnits("org", "agent-1");
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });

  it("PUBLIC + hidden-from agent: not visible", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({ hiddenFromPartyIds: ["agent-1"] }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const rows = await listVisibleUnits("org", "agent-1");
    expect(rows).toEqual([]);
  });

  it("RESTRICTED no grant: not visible", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({ visibilityMode: "RESTRICTED" }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const rows = await listVisibleUnits("org", "agent-1");
    expect(rows).toEqual([]);
  });

  it("RESTRICTED + grant: visible", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({ visibilityMode: "RESTRICTED" }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { unitId: "u1" },
    ]);
    const rows = await listVisibleUnits("org", "agent-1");
    expect(rows).toHaveLength(1);
  });

  it("AGENT_SOURCED listing: owner-contact masked for non-sourcing agent", async () => {
    // Every Listing is approved (pending lives in UnitSubmission), so the
    // mask rule is now: AGENT_SOURCED && sourcingAgentId !== me -> mask.
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({
        sourceFlag: "AGENT_SOURCED",
        sourcingAgentId: "agent-1",
        sourcingApproved: true,
      }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const rows = await listVisibleUnits("org", "agent-2");
    expect(rows).toHaveLength(1);
    expect(rows[0].inChargeName).toBeNull();
    expect(rows[0].inChargePartyId).toBeNull();
  });

  it("AGENT_SOURCED listing: sourcing agent sees full owner-contact", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({
        sourceFlag: "AGENT_SOURCED",
        sourcingAgentId: "agent-1",
        sourcingApproved: true,
      }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const rows = await listVisibleUnits("org", "agent-1");
    expect(rows[0].inChargeName).toBe("Iv");
    expect(rows[0].inChargePartyId).toBe("iv-party");
  });

  it("in-charge agent sees a RESTRICTED listing with no grant (override)", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({ visibilityMode: "RESTRICTED", inChargePartyId: "agent-1" }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const rows = await listVisibleUnits("org", "agent-1");
    expect(rows).toHaveLength(1);
    // Owner-contact mask must NOT strip the in-charge agent's own name.
    expect(rows[0].inChargeName).toBe("Iv");
    expect(rows[0].inChargePartyId).toBe("agent-1");
  });
});

describe("getVisibleUnit", () => {
  it("returns the listing when visible", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([baseUnit()]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const unit = await getVisibleUnit("org", "agent-1", "u1");
    expect(unit?.id).toBe("u1");
  });

  it("returns null when listing is not visible (restricted, no grant)", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      baseUnit({ visibilityMode: "RESTRICTED" }),
    ]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const unit = await getVisibleUnit("org", "agent-1", "u1");
    expect(unit).toBeNull();
  });

  it("returns null when unit id does not exist", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([baseUnit()]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const unit = await getVisibleUnit("org", "agent-1", "nonexistent");
    expect(unit).toBeNull();
  });
});

describe("repository wiring — service passes opts through to findListingsForAgent", () => {
  it("listVisibleUnits forwards excludeRejected:true (legacy back-compat — opt is now a no-op)", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await listVisibleUnits("org", "agent-1");

    expect(findListingsForAgent).toHaveBeenCalledWith("org", "agent-1", { excludeRejected: true });
  });

  it("getVisibleUnit forwards excludeRejected:false (legacy back-compat — opt is now a no-op)", async () => {
    (findListingsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (findGrantsForAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await getVisibleUnit("org", "agent-1", "u1");

    expect(findListingsForAgent).toHaveBeenCalledWith("org", "agent-1", { excludeRejected: false });
  });
});
