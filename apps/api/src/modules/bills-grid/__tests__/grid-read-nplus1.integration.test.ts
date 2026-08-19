/**
 * getGridService read-path N+1 regression guard.
 *
 * getGridService's main loop used to run ONE `prisma.unitBillsGridEntry.findUnique`
 * PER apartment, plus a per-entry `paxByTenancyFor` query (via `buildGridRoomsFromEntry`)
 * — a serial N+1. Measured against real data: 62 apartments = 1218ms serial vs 59ms for
 * the SAME data batched (~20x). Both fetches are now hoisted out of the loop into ONE
 * `unitBillsGridEntry.findMany` + ONE batched pax lookup; the loop itself issues ZERO
 * DB queries. This suite pins the query-count contract so the N+1 cannot silently
 * return.
 *
 * Mirrors the batch-loaders.integration.test.ts / service.integration.test.ts harness
 * convention: real local Postgres, RUN_INTEGRATION gate, non-local host guard,
 * spyCallthrough (hand-restore, never spy.mockRestore() — see batch-loaders' doc
 * comment for why). Reuses the shared local seeded org (findFirstOrThrow) rather than
 * minting a dedicated org: this suite only READS via getGridService and never bills,
 * so it needs no isolated money state — just fresh Apartments/Listings/Tenancies
 * scoped under the shared org (same style as service.integration.test.ts's "Fix-pass"
 * apartments / batch-loaders' mkListing/mkTenancy), torn down via the shared
 * `cleanupGridFixtures` helper every other grid suite uses.
 *
 * Run:
 *   cd apps/api && DATABASE_URL=<local> RUN_INTEGRATION=1 ../../node_modules/.bin/vitest run \
 *     src/modules/bills-grid/__tests__/grid-read-nplus1.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import { getGridService } from "../service";
import { cleanupGridFixtures } from "./cleanup";

const prisma = getDb();

/**
 * `vi.spyOn(obj, method)` alone does NOT reliably call through to Prisma's real
 * model-delegate methods in this setup — empirically verified (see
 * batch-loaders.integration.test.ts's doc comment): the resulting spy invokes but
 * returns `undefined` instead of executing the query, because Prisma's generated
 * methods depend on a `this` binding that Vitest's default spy wrapper does not
 * preserve. Binding the captured original explicitly (and installing it via
 * `mockImplementation`) fixes call-through. `spy.mockRestore()` was ALSO found to
 * corrupt the property afterward, so restoration is by hand instead.
 */
function spyCallthrough<T extends object, K extends keyof T>(target: T, method: K) {
  const original = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
  const spy = vi.spyOn(target, method as never).mockImplementation(original as never);
  const restore = () => {
    (target as unknown as Record<string, unknown>)[method as string] = original;
  };
  return { spy, restore };
}

const RUN = process.env.RUN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;
if (RUN) {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run integration tests against non-local DB host: ${host}`);
  }
}

// Distinct from every other bills-grid suite's PERIOD (batch-loaders: 2026-08-01,
// service.integration: 2026-07-01, grid-read-paid: 2026-06-01) so a shared-DB run
// never collides.
const PERIOD_STR = "2026-09-01";
const PERIOD = new Date(`${PERIOD_STR}T00:00:00.000Z`);

let ORG = "";
let PROPERTY = "";
let ACTOR = "";
let PARTY = "";

let APT1 = ""; // HAS an entry + 1 reading on an occupied room — pax lookup fires
let APT2 = ""; // HAS an entry + 1 reading on an occupied room — pax lookup fires
let APT3 = ""; // NO entry for this period — exercises entryByApt's null path
let ROOM1 = "";
let ROOM2 = "";
let ROOM3 = "";
let TEN1 = "";
let TEN2 = "";

beforeAll(async () => {
  if (!RUN) return;
  const org = await prisma.organization.findFirstOrThrow();
  ORG = org.id;
  ACTOR = (await prisma.user.findFirstOrThrow({ where: { organizationId: ORG } })).id;
  const prop = await prisma.property.findFirstOrThrow({ where: { organizationId: ORG } });
  PROPERTY = prop.id;

  PARTY = (
    await prisma.party.create({
      data: { organizationId: ORG, displayName: "N+1 Regression Test Party", partyType: "individual", status: "active" },
    })
  ).id;

  const mkApt = async (tag: string) =>
    (
      await prisma.apartment.create({
        data: { organizationId: ORG, propertyId: PROPERTY, unitCode: `NP1-${tag}-${Date.now()}`, listingMode: "PARTITIONED" },
      })
    ).id;
  APT1 = await mkApt("A1");
  APT2 = await mkApt("A2");
  APT3 = await mkApt("A3"); // stays entry-less on purpose

  const mkListing = async (apartmentId: string, tag: string) =>
    (
      await prisma.listing.create({
        data: { organizationId: ORG, apartmentId, listingType: `np1-room-${tag}`, occupancyStatus: "occupied", listingStatus: "active", currency: "MYR", ownerPartyId: PARTY },
      })
    ).id;
  ROOM1 = await mkListing(APT1, "1");
  ROOM2 = await mkListing(APT2, "2");
  ROOM3 = await mkListing(APT3, "3"); // vacant — no Tenancy created for it

  const mkTenancy = async (unitId: string) =>
    (
      await prisma.tenancy.create({
        data: {
          organizationId: ORG, propertyId: PROPERTY, unitId, tenantPartyId: PARTY,
          tenancyCode: `NP1-T-${randomUUID()}`, status: "active", billingStatus: "current",
          startDate: new Date("2026-01-01T00:00:00.000Z"), monthlyRentAmount: "1000.00", numberOfPax: 2,
        },
      })
    ).id;
  TEN1 = await mkTenancy(ROOM1);
  TEN2 = await mkTenancy(ROOM2);

  const mkEntry = async (apartmentId: string) =>
    (
      await prisma.unitBillsGridEntry.create({
        data: {
          organizationId: ORG, apartmentId, periodMonth: PERIOD, createdBy: ACTOR,
          tnbTotalRaw: "100.00", airSelangorRaw: "20.00", wifi: "0.00", cleaning: "0.00",
          tnbPattern: "recharged", airPattern: "recharged",
          cleaningBearer: "owner", wifiBearer: "owner", maintenanceFeeBearer: "owner",
        },
      })
    ).id;
  const entry1 = await mkEntry(APT1);
  const entry2 = await mkEntry(APT2);
  // APT3 gets NO entry — proves entryByApt.get(apt.id) ?? null still renders its row.

  await prisma.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry1, apartmentId: APT1, periodMonth: PERIOD, listingId: ROOM1, tenancyId: TEN1, partyId: PARTY, amount: "10.00", createdBy: ACTOR } });
  await prisma.gridMeterReading.create({ data: { organizationId: ORG, entryId: entry2, apartmentId: APT2, periodMonth: PERIOD, listingId: ROOM2, tenancyId: TEN2, partyId: PARTY, amount: "10.00", createdBy: ACTOR } });
});

afterAll(async () => {
  if (!RUN) return;
  await cleanupGridFixtures(prisma, ORG, { apartmentIds: [APT1, APT2].filter(Boolean) }); // readings/entries FIRST — .apartment is onDelete:Restrict
  await prisma.tenancy.deleteMany({ where: { id: { in: [TEN1, TEN2] } } });
  await prisma.listing.deleteMany({ where: { id: { in: [ROOM1, ROOM2, ROOM3] } } });
  await prisma.apartment.deleteMany({ where: { id: { in: [APT1, APT2, APT3] } } });
  await prisma.party.deleteMany({ where: { id: PARTY } });
});

d("getGridService — read-path N+1 regression guard", () => {
  it("batches every apartment's entry + pax lookup: 0 findUnique, 1 findMany(entries), tenancy.findMany bounded not per-apartment", async () => {
    const findUniqueSpy = spyCallthrough(prisma.unitBillsGridEntry, "findUnique");
    const findManySpy = spyCallthrough(prisma.unitBillsGridEntry, "findMany");
    const tenancyFindManySpy = spyCallthrough(prisma.tenancy, "findMany");
    try {
      const res = await getGridService({ orgId: ORG }, { period: PERIOD_STR, months: 1 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Sanity: all three seeded apartments are present, including the entry-less one —
      // the batched lookup must not silently drop a row the old per-apartment
      // findUnique(returns null) used to still render.
      const ids = res.data.rows.map((r) => r.apartmentId);
      expect(ids).toEqual(expect.arrayContaining([APT1, APT2, APT3]));
      const row3 = res.data.rows.find((r) => r.apartmentId === APT3)!;
      expect(row3.entryId).toBeNull();

      // The fix: NEVER a per-apartment findUnique (was N — one per apartment, incl.
      // the entry-less one, which used to return null).
      expect(findUniqueSpy.spy).not.toHaveBeenCalled();
      // Every apartment's entry batched in exactly ONE findMany, regardless of count.
      expect(findManySpy.spy).toHaveBeenCalledTimes(1);
      // tenancy.findMany: ONE fixed call from resolveRoomRentsBatch (rent, pre-existing
      // batch loader) + ONE fixed call from the NOW-BATCHED paxByTenancyFor (pax) = 2
      // total — NOT one pax call per entry (which would be 3: 1 rent + 2 pax, since
      // APT1 and APT2 each have an entry with an occupied-room reading). A regression
      // back to per-entry pax fetching (buildGridRoomsFromEntry called inside the loop)
      // would push this to 3 and fail here, regardless of how many MORE apartments a
      // future page grows to — this count must stay 2, never scale with apartment count.
      expect(tenancyFindManySpy.spy).toHaveBeenCalledTimes(2);
    } finally {
      findUniqueSpy.restore();
      findManySpy.restore();
      tenancyFindManySpy.restore();
    }
  });
});
