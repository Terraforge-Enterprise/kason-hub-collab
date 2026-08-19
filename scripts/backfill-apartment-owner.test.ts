import { describe, it, expect } from "vitest";
import { planApartmentOwnerBackfill, type BackfillRoom } from "./backfill-apartment-owner";

const room = (id: string, apartmentId: string, ownerPartyId: string | null): BackfillRoom => ({
  id,
  apartmentId,
  ownerPartyId,
});

describe("planApartmentOwnerBackfill", () => {
  it("backfills ownerless rooms to the apartment's single owner (the reported bug)", () => {
    // A-03-07: Master owned, Medium + Small ownerless.
    const plan = planApartmentOwnerBackfill([
      room("master", "apt-1", "owner-x"),
      room("medium", "apt-1", null),
      room("small", "apt-1", null),
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.backfills).toEqual([
      { apartmentId: "apt-1", ownerPartyId: "owner-x", roomIds: ["medium", "small"] },
    ]);
  });

  it("is a no-op when every room already shares the owner (idempotent re-run)", () => {
    const plan = planApartmentOwnerBackfill([
      room("master", "apt-1", "owner-x"),
      room("medium", "apt-1", "owner-x"),
    ]);
    expect(plan.backfills).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("skips an apartment with no owner anywhere (nothing to inherit)", () => {
    const plan = planApartmentOwnerBackfill([
      room("a", "apt-1", null),
      room("b", "apt-1", null),
    ]);
    expect(plan.backfills).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("reports (never backfills) a split-owner apartment — 2+ distinct owners", () => {
    const plan = planApartmentOwnerBackfill([
      room("a", "apt-1", "owner-x"),
      room("b", "apt-1", "owner-y"),
      room("c", "apt-1", null),
    ]);
    expect(plan.backfills).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.apartmentId).toBe("apt-1");
    expect([...plan.conflicts[0]!.owners].sort()).toEqual(["owner-x", "owner-y"]);
  });

  it("handles multiple apartments independently in one pass", () => {
    const plan = planApartmentOwnerBackfill([
      room("m1", "apt-1", "owner-x"), // apt-1: fix r1
      room("r1", "apt-1", null),
      room("m2", "apt-2", "owner-y"), // apt-2: already consistent
      room("r2", "apt-2", "owner-y"),
      room("m3", "apt-3", "owner-a"), // apt-3: conflict
      room("r3", "apt-3", "owner-b"),
    ]);
    expect(plan.backfills).toEqual([
      { apartmentId: "apt-1", ownerPartyId: "owner-x", roomIds: ["r1"] },
    ]);
    expect(plan.conflicts.map((c) => c.apartmentId)).toEqual(["apt-3"]);
  });
});
