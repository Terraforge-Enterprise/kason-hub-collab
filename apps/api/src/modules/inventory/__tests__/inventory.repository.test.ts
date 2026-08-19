// Repository-level tests for the inventory module.
//
// The previous suite tested `listUnitsWithPendingChanges` — a function that
// served the pendingChanges JSON mechanism on Listing. That mechanism is
// gone (amendments now live in UnitSubmission), so the function has been
// removed from the repo. The test is dropped along with it.
//
// The `createListingTx — unitKind discriminator` suite (workstream E, Part 1)
// is also removed: unitKind is gone from the Listing model (Task 5.3 —
// carparks are now a separate Carpark table, not a Listing with unitKind).
//
// New repo-level coverage for the Listing query shapes (listListings,
// findListingById) lives alongside the service tests, which already
// exercise these via vi.mock.
import { describe, it, expect, vi } from "vitest";
import { createListingTx } from "../inventory.repository";

describe("inventory.repository", () => {
  it.skip("listUnitsWithPendingChanges — DELETED (pendingChanges JSON mechanism removed, see UnitSubmission)", () => {});
  it.skip("createListingTx — unitKind discriminator — DELETED (unitKind removed in Task 5.3; carparks are now a separate Carpark table)", () => {});
});

// A room is born ownerless unless it inherits the apartment's owner. The writer
// must actually persist ownerPartyId (the create path used to omit the column,
// so a room added after owner-assignment could never carry an owner — the
// UNIT_HAS_NO_OWNER "can't occupy a sibling" bug). See owner-inheritance tests
// in inventory.service.test.ts for the service-level enforcement.
describe("createListingTx — ownerPartyId write", () => {
  it("persists ownerPartyId when provided", async () => {
    const create = vi.fn().mockResolvedValue({ id: "u1" });
    const tx = { listing: { create } };
    await createListingTx(tx, {
      organizationId: "o1",
      apartmentId: "a1",
      listingType: "small",
      ownerPartyId: "owner-x",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerPartyId: "owner-x" }) }),
    );
  });

  it("persists ownerPartyId as null when absent (a fresh apartment's first room)", async () => {
    const create = vi.fn().mockResolvedValue({ id: "u1" });
    const tx = { listing: { create } };
    await createListingTx(tx, {
      organizationId: "o1",
      apartmentId: "a1",
      listingType: "small",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerPartyId: null }) }),
    );
  });
});
