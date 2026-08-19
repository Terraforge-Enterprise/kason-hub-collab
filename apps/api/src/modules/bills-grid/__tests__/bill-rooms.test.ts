// Task 3: buildBillRooms — the bill-path room-set builder.
//
// UNIT test in DEFAULT (mocked) mode — @kason/db is aliased to the stub (vitest.config.ts),
// so Prisma never initializes. buildBillRooms only ever touches the `tx` we pass in, so a
// thin `mkTx` stub (canned gridMeterReading.findMany rows + a pax map via tenancy.findMany)
// fully exercises it. Do NOT run with RUN_INTEGRATION=1 (that swaps in the real @kason/db
// and breaks the mock these unit tests depend on).
import { describe, it, expect } from "vitest";
import type { Prisma } from "@kason/db";
import { buildBillRooms } from "../service";

/** A canned GridMeterReading row, as tx.gridMeterReading.findMany returns it. */
type Reading = { listingId: string; tenancyId: string | null; partyId: string | null; amount: number | null };

/**
 * A thin Prisma.TransactionClient stub. buildBillRooms → buildGridRooms calls
 * `tx.gridMeterReading.findMany` (the readings) and `paxByTenancyFor` calls
 * `tx.tenancy.findMany` (→ {id, numberOfPax}). Only those two are stubbed.
 * `amount` is coerced to a Prisma.Decimal-alike (a `{ toString() }`) so num() reads it.
 */
function mkTx(readings: Reading[], paxByTenancy: Record<string, number>): Prisma.TransactionClient {
  const dec = (n: number | null) => (n == null ? null : ({ toString: () => String(n) } as never));
  return {
    gridMeterReading: {
      findMany: async () =>
        readings.map((r, i) => ({
          id: `rd-${i}`,
          listingId: r.listingId,
          tenancyId: r.tenancyId,
          partyId: r.partyId,
          amount: dec(r.amount),
        })),
    },
    tenancy: {
      findMany: async () =>
        Object.entries(paxByTenancy).map(([id, numberOfPax]) => ({ id, numberOfPax })),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("buildBillRooms", () => {
  it("whole-synth: injects one 1-pax occupied room for a 0-pax whole tenancy", async () => {
    // Whole unit: grid readings carry tenancyId:null (vacant bucket). The active
    // tenancy is stored at pax 0. Two readings summing aircon 12 + 8 = 20.
    const tx = mkTx(
      [
        { listingId: "u1", tenancyId: null, partyId: null, amount: 12 },
        { listingId: "u1", tenancyId: null, partyId: null, amount: 8 },
      ],
      {},
    );
    const res = await buildBillRooms(tx, "org1", { id: "e1" }, true, {
      tenancyId: "t1",
      partyId: "p1",
      unitId: "u1",
    });

    expect(res.rooms).toHaveLength(1);
    expect(res.rooms[0]).toMatchObject({ tenancyId: "t1", partyId: "p1", unitId: "u1", pax: 1 });
    expect(res.rooms[0]!.airconCharge).toBe(20); // SUM of the entry's readings' airconCharge
    expect(res.blockedTenancyIds).toEqual([]);
  });

  it("whole-vacant: a whole unit with no active tenancy bills nothing", async () => {
    const tx = mkTx([{ listingId: "u1", tenancyId: null, partyId: null, amount: 5 }], {});
    const res = await buildBillRooms(tx, "org1", { id: "e1" }, true, null);
    expect(res).toEqual({ rooms: [], blockedTenancyIds: [] });
  });

  it("partition-zero-pax: reports the zero-pax active tenancy as blocked", async () => {
    // A partitioned unit: one active room whose tenancy is stored at pax 0.
    const tx = mkTx([{ listingId: "u2", tenancyId: "t2", partyId: "p2", amount: null }], { t2: 0 });
    const res = await buildBillRooms(tx, "org1", { id: "e1" }, false, null);
    expect(res.blockedTenancyIds).toContain("t2");
    // The real rooms are returned as-is (Task 4 feeds them to computeAllocation).
    expect(res.rooms).toHaveLength(1);
    expect(res.rooms[0]).toMatchObject({ tenancyId: "t2", partyId: "p2", pax: 0 });
  });

  it("partition-healthy: an active pax>0 room + a vacant room block nothing", async () => {
    const tx = mkTx(
      [
        { listingId: "u3a", tenancyId: "t3", partyId: "p3", amount: 10 },
        { listingId: "u3b", tenancyId: null, partyId: null, amount: 4 },
      ],
      { t3: 2 },
    );
    const res = await buildBillRooms(tx, "org1", { id: "e1" }, false, null);
    expect(res.blockedTenancyIds).toEqual([]);
    expect(res.rooms).toHaveLength(2);
  });

  it("partition-negative-pax: a NEGATIVE-pax active room is blocked (not silently billed RM0)", async () => {
    // Review fix (money bug): compute.ts's partition() puts a room in `occupied`
    // ONLY when pax > 0. The complement of `pax > 0` is `pax <= 0`, NOT `pax === 0`.
    // A negative numberOfPax is reachable via the M9 Excel import (no negative clamp),
    // so an active partitioned room at pax -1 must be BLOCKED — otherwise partition()
    // drops it from BOTH buckets, it's billed RM0, and its pool is absorbed by others
    // with no `pax_blocked` signal. RED pre-fix (predicate `pax === 0` misses -1),
    // GREEN post-fix (predicate `!(partyId != null && pax > 0)`).
    const tx = mkTx([{ listingId: "u4", tenancyId: "t4", partyId: "p4", amount: null }], { t4: -1 });
    const res = await buildBillRooms(tx, "org1", { id: "e1" }, false, null);
    expect(res.blockedTenancyIds).toContain("t4");
    expect(res.rooms).toHaveLength(1);
    expect(res.rooms[0]).toMatchObject({ tenancyId: "t4", partyId: "p4", pax: -1 });
  });

  it("partition-null-party: an active room with a NULL partyId is blocked (defensive orphan trap)", async () => {
    // A `tenancyId != null, partyId == null` active room (pax > 0) also fails partition()'s
    // occupied rule (requires partyId != null), so it too must be blocked rather than
    // slipping out of both buckets. Unreachable today, but the complement predicate closes
    // the latent trap. RED pre-fix (old predicate required partyId != null to block),
    // GREEN post-fix.
    const tx = mkTx([{ listingId: "u5", tenancyId: "t5", partyId: null, amount: 7 }], { t5: 3 });
    const res = await buildBillRooms(tx, "org1", { id: "e1" }, false, null);
    expect(res.blockedTenancyIds).toContain("t5");
    expect(res.rooms).toHaveLength(1);
    expect(res.rooms[0]).toMatchObject({ tenancyId: "t5", partyId: null, pax: 3 });
  });
});
