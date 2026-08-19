import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above the imports — use vi.hoisted for any
// mocks the factory closes over so they exist when the factory runs.
const { findManyMock, amenityFindManyMock, createSignedDownloadUrlMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  amenityFindManyMock: vi.fn(),
  createSignedDownloadUrlMock: vi.fn(),
}));

vi.mock("@kason/db", () => ({
  getDb: () => ({
    listing: { findMany: findManyMock },
    amenity: { findMany: amenityFindManyMock },
  }),
}));

vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: createSignedDownloadUrlMock,
}));

import { listExplorerUnits } from "../listings-explorer.service";

const ORG = "org-123";

// Listing row shape post-refactor: apartment-shared fields live on the
// joined Apartment include; the Listing row itself carries the per-room
// offer columns (rentalRate, occupancy, sourcing).
function fakeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "u1",
    organizationId: ORG,
    listingType: "condo",
    listingStatus: "active",
    occupancyStatus: "vacant",
    visibilityMode: "PUBLIC",
    hiddenFromPartyIds: [],
    rentalRate: "2000",
    currency: "MYR",
    depositMonths: null,
    utilitiesDepositMonths: null,
    accessCardDepositPerPcs: null,
    accessCardQuantity: null,
    parkingQuantity: null,
    parkingNumbers: [],
    moveInDate: null,
    readyNow: true,
    vacantSince: null,
    inChargeName: null,
    inChargePartyId: null,
    sourcingAgentId: null,
    sourcingAgent: null,
    inChargeParty: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    tenancies: [],
    // Per spec 2026-05-24, media lives on the Listing row (per room type),
    // NOT on the Apartment.
    photoKeys: ["units/u1/photo-0.jpg"],
    coverPhotoKey: null,
    videoKeys: [],
    apartment: {
      id: "apt-1",
      unitCode: "A-1",
      listingMode: "WHOLE",
      bedrooms: 2,
      bathrooms: { toString: () => "1" },
      floorArea: { toString: () => "800" },
      floor: null,
      facing: null,
      furnishingLevel: null,
      amenities: [],
      highlights: [],
      publishedTitle: null,
      publishedDescription: null,
      property: { name: "Skyline", city: "KL" },
    },
    ...over,
  };
}

describe("listExplorerUnits", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    amenityFindManyMock.mockReset();
    amenityFindManyMock.mockResolvedValue([]); // empty catalog by default
    createSignedDownloadUrlMock.mockReset();
    createSignedDownloadUrlMock.mockResolvedValue("https://signed.example/cover.jpg");
  });

  it("scopes the query to orgId only — no per-agent visibility filter, no EXCLUDE", async () => {
    findManyMock.mockResolvedValue([]);
    await listExplorerUnits(ORG);

    const call = findManyMock.mock.calls[0][0];
    // Post-refactor: pending agent submissions live in UnitSubmission, not
    // Listing. The explorer no longer needs the legacy
    // EXCLUDE_PENDING_AGENT_SUBMISSIONS spread — the where clause is
    // intentionally minimal.
    expect(call.where).toEqual({ organizationId: ORG });
    expect(JSON.stringify(call.where)).not.toMatch(/visibilityMode|hiddenFromPartyIds|sourceFlag|sourcingApproved/);
  });

  it("orders rows newest-first by createdAt", async () => {
    findManyMock.mockResolvedValue([]);
    await listExplorerUnits(ORG);
    expect(findManyMock.mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("returns the canonical InventoryListing shape (Decimal → number, dates → ISO, etc.)", async () => {
    findManyMock.mockResolvedValue([fakeRow()]);
    const out = await listExplorerUnits(ORG);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "u1",
      unitCode: "A-1",
      bathrooms: 1,
      floorArea: 800,
      title: null,
      description: null,
      vacantSince: null,
      currentTenancyEndDate: null,
      coverPhotoUrl: "https://signed.example/cover.jpg",
      property: { name: "Skyline", city: "KL" },
    });
  });

  it("derives currentTenancyEndDate from the first active tenancy", async () => {
    findManyMock.mockResolvedValue([
      fakeRow({ tenancies: [{ startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-09-30T00:00:00Z") }] }),
    ]);
    const out = await listExplorerUnits(ORG);
    expect(out[0].currentTenancyEndDate).toBe("2026-09-30T00:00:00.000Z");
  });

  it("prefers inChargeParty.displayName over the legacy inChargeName column", async () => {
    findManyMock.mockResolvedValue([
      fakeRow({
        inChargeName: "Stale Cached Name",
        inChargeParty: { displayName: "Alice Tan" },
      }),
    ]);
    const out = await listExplorerUnits(ORG);
    expect(out[0].inChargeName).toBe("Alice Tan");
  });

  it("computes sourcingAgentName from the joined sourcingAgent.displayName", async () => {
    findManyMock.mockResolvedValue([
      fakeRow({
        sourcingAgentId: "agent-99",
        sourcingAgent: { displayName: "Bob Lim" },
      }),
    ]);
    const out = await listExplorerUnits(ORG);
    expect(out[0].sourcingAgentName).toBe("Bob Lim");
  });

  it("derives sourceFlag from sourcingAgentId for wire compat", async () => {
    findManyMock.mockResolvedValue([
      fakeRow({
        sourcingAgentId: "agent-99",
        sourcingAgent: { displayName: "Bob Lim" },
      }),
    ]);
    const out = await listExplorerUnits(ORG);
    // TODO: drop in Phase C when the web layer migrates.
    expect(out[0].sourceFlag).toBe("AGENT_SOURCED");
    expect(out[0].sourcingApproved).toBe(true);
  });

  it("never leaks the raw nested Apartment / sourcingAgent / inChargeParty objects", async () => {
    findManyMock.mockResolvedValue([
      fakeRow({
        inChargeParty: { displayName: "Alice" },
        sourcingAgent: { displayName: "Bob" },
        apartment: {
          ...fakeRow().apartment,
          publishedTitle: "Sky High Suite",
          publishedDescription: "Pitch text",
        },
      }),
    ]);
    const out = await listExplorerUnits(ORG);
    expect(out[0]).not.toHaveProperty("sourcingAgent");
    expect(out[0]).not.toHaveProperty("inChargeParty");
    expect(out[0]).not.toHaveProperty("publishedTitle");
    expect(out[0]).not.toHaveProperty("publishedDescription");
    expect(out[0]).not.toHaveProperty("tenancies");
    expect(out[0]).not.toHaveProperty("apartment");
    // Flattened versions should be present.
    expect(out[0].title).toBe("Sky High Suite");
    expect(out[0].description).toBe("Pitch text");
  });

  it("sourcingAgentName is null when the listing has no sourcing agent (COMPANY-sourced)", async () => {
    findManyMock.mockResolvedValue([fakeRow()]); // default: no sourcingAgent
    const out = await listExplorerUnits(ORG);
    expect(out[0].sourcingAgentName).toBeNull();
    expect(out[0].sourceFlag).toBe("COMPANY");
  });

  it("joins the amenity catalog and returns {id, name}[] in unit.amenities", async () => {
    amenityFindManyMock.mockResolvedValue([
      { id: "a1", name: "Gym" },
      { id: "a2", name: "Pool" },
    ]);
    findManyMock.mockResolvedValue([
      fakeRow({
        apartment: { ...fakeRow().apartment, amenities: ["a1", "a2"] },
      }),
    ]);
    const out = await listExplorerUnits(ORG);
    expect(out[0].amenities).toEqual([
      { id: "a1", name: "Gym" },
      { id: "a2", name: "Pool" },
    ]);
  });

  it("signs the first photoKey as a thumbnail cover (400x300, cover resize)", async () => {
    findManyMock.mockResolvedValue([fakeRow()]);
    await listExplorerUnits(ORG);

    expect(createSignedDownloadUrlMock).toHaveBeenCalledWith(
      "units/u1/photo-0.jpg",
      { transform: { width: 400, height: 300, resize: "cover" } },
    );
  });

  it("returns coverPhotoUrl: null when the listing has no photos", async () => {
    findManyMock.mockResolvedValue([fakeRow({ photoKeys: [] })]);
    const out = await listExplorerUnits(ORG);
    expect(out[0].coverPhotoUrl).toBeNull();
    expect(createSignedDownloadUrlMock).not.toHaveBeenCalled();
  });

  it("falls back to coverPhotoUrl: null when signing throws (does not crash the request)", async () => {
    findManyMock.mockResolvedValue([fakeRow()]);
    createSignedDownloadUrlMock.mockRejectedValue(new Error("storage offline"));
    const out = await listExplorerUnits(ORG);
    expect(out[0].coverPhotoUrl).toBeNull();
  });
});
