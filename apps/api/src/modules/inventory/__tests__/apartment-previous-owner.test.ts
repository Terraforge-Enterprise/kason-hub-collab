/**
 * I3 — after an apartment's owner is re-pointed, the OLD owner's UnitMonthLedger
 * must be re-materialised, or that owner keeps income for rows that no longer
 * foot to them.
 *
 * `updateApartmentSharedService` used to probe the previous owner with a bare
 * `listing.findFirst` carrying neither an `ownerPartyId: { not: null }` filter nor
 * an `orderBy`. It answered `null` — "this apartment had no owner" — for two real
 * states:
 *
 *   1. the apartment's only owned row is a carpark BAY (since the owner fan-out
 *      reached bays, a bay-only apartment is reachable), and
 *   2. the arbitrary `findFirst` lands on an active-but-OWNERLESS sibling while an
 *      owned sibling sits behind it (these exist — scripts/backfill-apartment-owner.ts).
 *
 * `null` makes the re-materialisation guard skip the old owner entirely.
 *
 * `rematerializeOwnerRecentMonths` no-ops unless ENABLE_UNIT_MONTH_LEDGER is on, so
 * these tests spy the OUTER call rather than any ledger write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rematerializeOwnerRecentMonths = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../owner-ledger/unit-month-ledger.remateralize-range", () => ({
  rematerializeOwnerRecentMonths,
}));

const recordAudit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../lib/audit", () => ({ recordAudit }));

vi.mock("../listing-mode", () => ({
  getUnitGroupMode: vi.fn().mockResolvedValue(null),
  resolveRoomTypeKind: vi.fn().mockResolvedValue(null),
}));

vi.mock("../apartment.repository", () => ({
  findApartmentById: vi.fn(),
  updateApartmentModeTx: vi.fn(),
  updateApartmentSharedTx: vi.fn(),
}));

const ORG = "00000000-0000-4000-8000-000000000000";
const APT = "apt-1";
const OLD_OWNER = "11111111-1111-4111-8111-111111111111";
const NEW_OWNER = "22222222-2222-4222-8222-222222222222";

type Row = { id: string; ownerPartyId: string | null; listingStatus?: string; status?: string };

let listingRows: Row[] = [];
let carparkRows: Row[] = [];

/**
 * Honours the filters the owner resolvers actually issue. The old probe passed no
 * `ownerPartyId` filter and no `orderBy`, so it took whatever row came first —
 * that is precisely what these fixtures must be able to express.
 */
function matches(row: Row, where: Record<string, unknown>, statusKey: "listingStatus" | "status") {
  if (where.ownerPartyId && typeof where.ownerPartyId === "object") {
    // `{ not: null }` — skip ownerless rows.
    if (row.ownerPartyId === null) return false;
  }
  const s = where[statusKey];
  const rowStatus = row[statusKey];
  if (typeof s === "string" && rowStatus !== s) return false;
  if (s && typeof s === "object" && rowStatus === (s as { not?: string }).not) return false;
  return true;
}

const dbMock = {
  listing: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
      const hits = listingRows.filter((r) => matches(r, args.where, "listingStatus"));
      const ordered = args.orderBy ? [...hits].sort((a, b) => a.id.localeCompare(b.id)) : hits;
      return ordered[0] ?? null;
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  carpark: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
      const hits = carparkRows.filter((r) => matches(r, args.where, "status"));
      const ordered = args.orderBy ? [...hits].sort((a, b) => a.id.localeCompare(b.id)) : hits;
      return ordered[0] ?? null;
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  partyRole: { findFirst: vi.fn(async () => ({ id: "role-1" })) },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({ getDb: () => dbMock, Prisma: {} }));

import { updateApartmentSharedService } from "../apartment.service";
import * as aptRepo from "../apartment.repository";

const mockedAptRepo = vi.mocked(aptRepo);
const session = { orgId: ORG, userId: "u1" };

/** The partyIds handed to `rematerializeOwnerRecentMonths`, in call order. */
function rematerializedOwners(): unknown[] {
  return rematerializeOwnerRecentMonths.mock.calls.map((c) => (c as unknown[])[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  listingRows = [];
  carparkRows = [];
  dbMock.$transaction.mockImplementation((cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock));
  mockedAptRepo.findApartmentById.mockResolvedValue({
    id: APT,
    propertyId: "prop-1",
    unitCode: "A-18-06",
    listingMode: "PARTITIONED",
  } as never);
  mockedAptRepo.updateApartmentSharedTx.mockResolvedValue({ id: APT } as never);
});

describe("updateApartmentSharedService — the OLD owner's ledger is re-materialised", () => {
  // B9. The apartment's only owned row is an active carpark bay.
  it("finds the previous owner on an active bay when the apartment has no listings", async () => {
    carparkRows = [{ id: "bay-1", ownerPartyId: OLD_OWNER, status: "available" }];

    const res = await updateApartmentSharedService(session, APT, { ownerPartyId: NEW_OWNER });

    expect(res.ok).toBe(true);
    expect(rematerializedOwners()).toEqual([OLD_OWNER, NEW_OWNER]);
  });

  // B10. The first non-archived sibling is ownerless; an owned sibling sits behind it.
  it("skips an ownerless sibling to find the previous owner on an owned one", async () => {
    listingRows = [
      { id: "l-1", ownerPartyId: null, listingStatus: "draft" },
      { id: "l-2", ownerPartyId: OLD_OWNER, listingStatus: "active" },
    ];

    const res = await updateApartmentSharedService(session, APT, { ownerPartyId: NEW_OWNER });

    expect(res.ok).toBe(true);
    expect(rematerializedOwners()).toEqual([OLD_OWNER, NEW_OWNER]);
  });

  // B10b (adversarial audit, finding 5). CLEARING the owner is the sharper case:
  // `if (input.ownerPartyId)` skips the new-owner re-materialisation, so the old
  // owner's is the ONLY one that fires. A null previous-owner probe means the old
  // owner's ledger is never rebuilt at all.
  it("re-materialises the old owner when the owner is CLEARED to null", async () => {
    listingRows = [
      { id: "l-1", ownerPartyId: null, listingStatus: "draft" },
      { id: "l-2", ownerPartyId: OLD_OWNER, listingStatus: "active" },
    ];

    const res = await updateApartmentSharedService(session, APT, { ownerPartyId: null });

    expect(res.ok).toBe(true);
    expect(rematerializedOwners()).toEqual([OLD_OWNER]);
  });

  // B11. A genuinely ownerless apartment must not produce a phantom old-owner call.
  it("re-materialises only the new owner when the apartment had none", async () => {
    listingRows = [{ id: "l-1", ownerPartyId: null, listingStatus: "draft" }];

    const res = await updateApartmentSharedService(session, APT, { ownerPartyId: NEW_OWNER });

    expect(res.ok).toBe(true);
    expect(rematerializedOwners()).toEqual([NEW_OWNER]);
  });

  // An ARCHIVED listing's owner is stale after a re-point; it must never be read as
  // the previous owner (the inheritance resolver excludes it by design).
  it("never reads the previous owner from an archived listing", async () => {
    listingRows = [{ id: "l-1", ownerPartyId: OLD_OWNER, listingStatus: "archived" }];

    const res = await updateApartmentSharedService(session, APT, { ownerPartyId: NEW_OWNER });

    expect(res.ok).toBe(true);
    expect(rematerializedOwners()).toEqual([NEW_OWNER]);
  });
});
