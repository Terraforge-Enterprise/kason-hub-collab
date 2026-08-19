import { describe, expect, it, vi } from "vitest";

import { buildDeletionPreview } from "../listings.deletion";

const ORG = "00000000-0000-0000-0000-000000000001";
const UNIT_ID = "11111111-1111-4111-8111-111111111111";

interface Counts {
  reservations?: number;
  tenancies?: number;
  charges?: number;
  deposits?: number;
  attributes?: number;
  grants?: number;
}

function makeClient(c: Counts = {}) {
  return {
    listing: {
      findFirst: vi.fn(async () => ({
        id: UNIT_ID,
        apartment: {
          unitCode: "A-12-03",
          property: { name: "Sunway Tower" },
        },
      })),
    },
    unitReservation: {
      count: vi.fn(async () => c.reservations ?? 0),
      findMany: vi.fn(async () =>
        Array.from({ length: Math.min(c.reservations ?? 0, 5) }, (_, i) => ({
          id: `r${i}`,
        })),
      ),
    },
    tenancy: {
      count: vi.fn(async () => c.tenancies ?? 0),
      findMany: vi.fn(async () =>
        Array.from({ length: Math.min(c.tenancies ?? 0, 5) }, (_, i) => ({
          id: `t${i}`,
        })),
      ),
    },
    charge: {
      count: vi.fn(async () => c.charges ?? 0),
      findMany: vi.fn(async () =>
        Array.from({ length: Math.min(c.charges ?? 0, 5) }, (_, i) => ({
          id: `c${i}`,
        })),
      ),
    },
    deposit: {
      count: vi.fn(async () => c.deposits ?? 0),
      findMany: vi.fn(async () =>
        Array.from({ length: Math.min(c.deposits ?? 0, 5) }, (_, i) => ({
          id: `d${i}`,
        })),
      ),
    },
    unitAttribute: { count: vi.fn(async () => c.attributes ?? 0) },
    listingVisibilityGrant: { count: vi.fn(async () => c.grants ?? 0) },
  } as never;
}

describe("buildDeletionPreview", () => {
  it("returns null when unit does not exist or is in another org", async () => {
    const client = makeClient();
    (client as { listing: { findFirst: ReturnType<typeof vi.fn> } }).listing.findFirst.mockResolvedValueOnce(
      null,
    );
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report).toBeNull();
  });

  it("canDelete=true when no business activity exists; cascades still counted", async () => {
    const client = makeClient({ attributes: 4, grants: 2 });
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report).not.toBeNull();
    expect(report!.canDelete).toBe(true);
    expect(report!.blockers).toHaveLength(0);
    expect(report!.cascades).toEqual([
      { kind: "unit-attributes", count: 4 },
      { kind: "listing-visibility-grants", count: 2 },
    ]);
    expect(report!.unitCode).toBe("A-12-03");
    expect(report!.unitLabel).toContain("Sunway Tower");
    expect(report!.unitLabel).toContain("A-12-03");
  });

  it("ANY reservation row blocks (active or otherwise)", async () => {
    const client = makeClient({ reservations: 3 });
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report!.canDelete).toBe(false);
    const blocker = report!.blockers.find((b) => b.kind === "any-reservations");
    expect(blocker).toBeDefined();
    expect(blocker!.count).toBe(3);
    expect(blocker!.sampleIds).toHaveLength(3);
  });

  it("ANY tenancy row blocks (audit trail must survive)", async () => {
    const client = makeClient({ tenancies: 1 });
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report!.canDelete).toBe(false);
    expect(
      report!.blockers.some((b) => b.kind === "any-tenancy"),
    ).toBe(true);
  });

  it("any charge row blocks (financial activity)", async () => {
    const client = makeClient({ charges: 2 });
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report!.canDelete).toBe(false);
    expect(
      report!.blockers.some((b) => b.kind === "non-zero-charges"),
    ).toBe(true);
  });

  it("any deposit row blocks", async () => {
    const client = makeClient({ deposits: 1 });
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report!.canDelete).toBe(false);
    expect(
      report!.blockers.some((b) => b.kind === "any-deposit"),
    ).toBe(true);
  });

  it("reports ALL blockers simultaneously when more than one exists", async () => {
    const client = makeClient({
      reservations: 1,
      tenancies: 1,
      charges: 1,
      deposits: 1,
    });
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(report!.canDelete).toBe(false);
    expect(report!.blockers.map((b) => b.kind).sort()).toEqual([
      "any-deposit",
      "any-reservations",
      "any-tenancy",
      "non-zero-charges",
    ]);
  });

  it("limits sample IDs to 5 even when more rows exist", async () => {
    const client = makeClient({ reservations: 20 });
    // findMany only returns up to take:5 in our mock — reflects the real query
    const report = await buildDeletionPreview(client, ORG, UNIT_ID);
    const blocker = report!.blockers.find(
      (b) => b.kind === "any-reservations",
    );
    expect(blocker!.count).toBe(20);
    expect(blocker!.sampleIds.length).toBeLessThanOrEqual(5);
  });

  it("scopes count queries by organizationId AND unitId", async () => {
    const client = makeClient({ reservations: 1 });
    await buildDeletionPreview(client, ORG, UNIT_ID);
    expect(
      (client as { unitReservation: { count: ReturnType<typeof vi.fn> } })
        .unitReservation.count,
    ).toHaveBeenCalledWith({
      where: { organizationId: ORG, unitId: UNIT_ID },
    });
  });
});
