import { describe, expect, it, vi, beforeEach } from "vitest";

const listingFindManyMock = vi.fn();
const unitSubmissionFindManyMock = vi.fn();
const amenityFindManyMock = vi.fn();

vi.mock("@kason/db", () => ({
  getDb: () => ({
    listing: { findMany: listingFindManyMock },
    unitSubmission: { findMany: unitSubmissionFindManyMock },
    amenity: { findMany: amenityFindManyMock },
  }),
}));

import {
  findListingsForAgent,
  findOwnPendingSubmissions,
  shapeAmenities,
  shapeInventoryRow,
} from "../portal.listings.repository";
import { makeListingRow } from "./_fixtures";

beforeEach(() => {
  listingFindManyMock.mockReset();
  listingFindManyMock.mockResolvedValue([]);
  unitSubmissionFindManyMock.mockReset();
  unitSubmissionFindManyMock.mockResolvedValue([]);
  amenityFindManyMock.mockReset();
  amenityFindManyMock.mockResolvedValue([]);
});

describe("findListingsForAgent — portal visibility gate (DB layer)", () => {
  it("admits active listings AND the requesting agent's own listings", async () => {
    // Two disjoint admit sets:
    //   1. listingStatus='active' — drafts/archived hidden from every agent
    //   2. sourcingAgentId === requesting agent — the agent's own approved
    //      Listings (incl. drafts they sourced)
    //
    // Pending agent submissions are physically NOT in the Listing table
    // after the three-table refactor (they live in UnitSubmission), so the
    // legacy EXCLUDE-pending filter is gone — the WHERE clause is shorter.
    await findListingsForAgent("org-1", "agent-1");

    expect(listingFindManyMock).toHaveBeenCalledTimes(1);
    const callArg = listingFindManyMock.mock.calls[0]?.[0];
    expect(callArg?.where).toMatchObject({
      organizationId: "org-1",
      OR: [
        { listingStatus: "active" },
        { sourcingAgentId: "agent-1" },
      ],
    });
  });

  it("does NOT filter by visibilityMode here — RESTRICTED is gated by the service layer with grants", async () => {
    await findListingsForAgent("org-1", "agent-1");

    const callArg = listingFindManyMock.mock.calls[0]?.[0];
    // Implementation detail — visibilityMode filtering is deferred to
    // canAgentSeeUnit so RESTRICTED + grant flows still work.
    expect(callArg?.where).not.toHaveProperty("visibilityMode");
  });

  it("excludeRejected option is preserved on the signature but is a no-op (no pending Listings exist)", async () => {
    // The opt is kept on the signature so the SPA's existing call sites
    // (which pass excludeRejected:true/false) don't need a parallel rewrite.
    // After the three-table refactor, no Listing row is "rejected" — that
    // state lives in UnitSubmission — so the opt has no effect on the WHERE.
    await findListingsForAgent("org-1", "agent-1", { excludeRejected: true });
    const withFlag = listingFindManyMock.mock.calls[0]?.[0]?.where;
    listingFindManyMock.mockClear();
    await findListingsForAgent("org-1", "agent-1", { excludeRejected: false });
    const withoutFlag = listingFindManyMock.mock.calls[0]?.[0]?.where;

    expect(withFlag).toEqual(withoutFlag);
  });
});

describe("findListingsForAgent — sourcingAgentName mapping", () => {
  it("exposes sourcingAgentName from the joined sourcingAgent.displayName", async () => {
    listingFindManyMock.mockResolvedValue([
      makeListingRow({
        sourcingAgentId: "priya-party-id",
        sourcingAgent: { displayName: "Priya" },
      }),
    ]);

    const results = await findListingsForAgent("org-1", "agent-1");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourcingAgentName: "Priya" });
  });

  it("returns sourcingAgentName: null for COMPANY-sourced listings (no relation)", async () => {
    listingFindManyMock.mockResolvedValue([
      makeListingRow({
        sourcingAgentId: null,
        sourcingAgent: null,
      }),
    ]);

    const results = await findListingsForAgent("org-1", "agent-1");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourcingAgentName: null });
  });

  it("does NOT leak the raw sourcingAgent relation object into the response", async () => {
    // The mapper must destructure sourcingAgent out so the raw Prisma
    // relation object never surfaces in the API response shape.
    listingFindManyMock.mockResolvedValue([
      makeListingRow({
        sourcingAgentId: "priya-party-id",
        sourcingAgent: { displayName: "Priya" },
      }),
    ]);

    const results = await findListingsForAgent("org-1", "agent-1");

    expect(results[0]).not.toHaveProperty("sourcingAgent");
  });
});

describe("findListingsForAgent — derived sourceFlag for wire compat", () => {
  it("returns sourceFlag='AGENT_SOURCED' when sourcingAgentId is set", async () => {
    listingFindManyMock.mockResolvedValue([
      makeListingRow({ sourcingAgentId: "p1", sourcingAgent: { displayName: "P" } }),
    ]);
    const [row] = await findListingsForAgent("org-1", "agent-1");
    expect(row.sourceFlag).toBe("AGENT_SOURCED");
  });

  it("returns sourceFlag='COMPANY' when sourcingAgentId is null", async () => {
    listingFindManyMock.mockResolvedValue([
      makeListingRow({ sourcingAgentId: null, sourcingAgent: null }),
    ]);
    const [row] = await findListingsForAgent("org-1", "agent-1");
    expect(row.sourceFlag).toBe("COMPANY");
  });

  it("returns sourcingApproved=true for every Listing (approved by definition)", async () => {
    listingFindManyMock.mockResolvedValue([
      makeListingRow({ sourcingAgentId: "p1", sourcingAgent: { displayName: "P" } }),
    ]);
    const [row] = await findListingsForAgent("org-1", "agent-1");
    expect(row.sourcingApproved).toBe(true);
  });
});

describe("shapeAmenities — catalog join", () => {
  it("converts amenity ID array to {id, name}[] using the catalog Map", () => {
    const catalog = new Map([["a1", "Gym"], ["a2", "Pool"]]);
    const result = shapeAmenities(["a1", "a2"], catalog);
    expect(result).toEqual([
      { id: "a1", name: "Gym" },
      { id: "a2", name: "Pool" },
    ]);
  });

  it("filters out amenity IDs missing from the catalog (hard-deleted)", () => {
    const catalog = new Map([["a1", "Gym"]]);
    const result = shapeAmenities(["a1", "a-orphan"], catalog);
    expect(result).toEqual([{ id: "a1", name: "Gym" }]);
  });

  it("returns empty array when input is empty", () => {
    const catalog = new Map([["a1", "Gym"]]);
    expect(shapeAmenities([], catalog)).toEqual([]);
  });
});

describe("shapeInventoryRow — apartment-shared field surfacing", () => {
  it("hoists Apartment.bedrooms / amenities + per-Listing photoKeys to the top level for wire compat", () => {
    const row = makeListingRow({
      apartment: {
        bedrooms: 3,
        amenities: ["a1"],
      },
      photoKeys: ["p1.jpg"],
    });
    const catalog = new Map([["a1", "Gym"]]);
    const shaped = shapeInventoryRow(row, catalog);
    expect(shaped.bedrooms).toBe(3);
    expect(shaped.amenities).toEqual([{ id: "a1", name: "Gym" }]);
    expect(shaped.photoKeys).toEqual(["p1.jpg"]);
  });

  it("hoists Apartment.publishedTitle/publishedDescription as title/description", () => {
    const row = makeListingRow({
      apartment: {
        publishedTitle: "Cozy studio",
        publishedDescription: "Steps from KLCC",
      },
    });
    const shaped = shapeInventoryRow(row, new Map());
    expect(shaped.title).toBe("Cozy studio");
    expect(shaped.description).toBe("Steps from KLCC");
  });
});

describe("findOwnPendingSubmissions", () => {
  it("queries UnitSubmission scoped to the agent, all states, newest first", async () => {
    await findOwnPendingSubmissions("org-1", "agent-1");

    expect(unitSubmissionFindManyMock).toHaveBeenCalledTimes(1);
    const callArg = unitSubmissionFindManyMock.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      where: { organizationId: "org-1", sourcingAgentId: "agent-1" },
      orderBy: { createdAt: "desc" },
      include: { approvedListing: { select: { id: true } } },
    });
  });
});
