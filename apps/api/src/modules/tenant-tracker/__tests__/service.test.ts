// Unit tests for the tenant-tracker service (no DB) — mirrors the
// apartment.service.test.ts mocking approach: mock @kason/db + lib/audit and
// let the repository functions run for real against the in-memory dbMock.
//
// DB-backed proof that the assign WRITES its audit row in the SAME tx (and
// rolls back when the audit insert fails) lives in
// service.integration.test.ts (RUN_INTEGRATION=1).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../../../lib/auth";
import type { TenantTrackerListQuery } from "@kason/shared";

// ── In-memory stores ────────────────────────────────────────────────────────

type ListingRow = {
  id: string;
  organizationId: string;
  inChargePartyId: string | null;
  inChargeName: string | null;
  updatedAt: Date;
};

type PartyRow = {
  id: string;
  organizationId: string;
  displayName: string;
  idNumber: string | null;
};

const listingStore = new Map<string, ListingRow>();
const partyStore = new Map<string, PartyRow>();

/**
 * Stand-in for Prisma.PrismaClientKnownRequestError (P2025 detection).
 * vi.hoisted so the hoisted vi.mock("@kason/db") factory can reference it
 * eagerly without hitting the temporal dead zone.
 */
const { MockPrismaKnownRequestError } = vi.hoisted(() => {
  class MockPrismaKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(`mock prisma error ${code}`);
      this.code = code;
    }
  }
  return { MockPrismaKnownRequestError };
});

// ── Raw apartment fixtures (the shape apartment.findMany returns) ──────────

type Dec = { toNumber: () => number };
const dec = (n: number): Dec => ({ toNumber: () => n });

type RawTenancy = {
  id: string;
  status: string;
  startDate: Date;
  endDate: Date | null;
  termMonths: number | null;
  previousTenancyId: string | null;
  monthlyRentAmount: Dec;
  numberOfPax: number | null;
  agentLabel: string | null;
  accessCardNo: string | null;
  previousTenancy: { id: string; termMonths: number | null } | null;
  tenantParty: {
    id: string;
    displayName: string;
    primaryPhone: string | null;
    primaryEmail: string | null;
    gender: string | null;
    idType: string | null;
    idNumber: string | null;
  };
};

type RawListing = {
  id: string;
  listingType: string;
  occupancyStatus: string;
  baseRentAmount: Dec | null;
  rentalRate: Dec | null;
  accessCardQuantity: number | null;
  parkingNumbers: string[];
  inChargePartyId: string | null;
  inChargeName: string | null;
  updatedAt: Date;
  inChargeParty: { id: string; displayName: string } | null;
  _count: { tenancies: number };
  tenancies: RawTenancy[];
};

type RawApartment = {
  id: string;
  unitCode: string;
  floor: number | null;
  bedrooms: number | null;
  property: { id: string; name: string; propertyCode: string | null };
  listings: RawListing[];
};

const dbMock = {
  apartment: {
    findMany: vi.fn(async (): Promise<RawApartment[]> => []),
  },
  carparkAssignment: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  tenancy: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  listing: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string };
      const row = w.id ? listingStore.get(w.id) : undefined;
      if (!row) return null;
      if (w.organizationId && row.organizationId !== w.organizationId) return null;
      return row;
    }),
    update: vi.fn(
      async (args: {
        where: { id: string; organizationId?: string; updatedAt?: Date };
        data: Record<string, unknown>;
      }) => {
        const row = listingStore.get(args.where.id);
        if (!row) throw new MockPrismaKnownRequestError("P2025");
        if (args.where.organizationId && row.organizationId !== args.where.organizationId) {
          throw new MockPrismaKnownRequestError("P2025");
        }
        if (args.where.updatedAt && row.updatedAt.getTime() !== args.where.updatedAt.getTime()) {
          throw new MockPrismaKnownRequestError("P2025");
        }
        const next = { ...row, ...args.data } as ListingRow;
        listingStore.set(args.where.id, next);
        return next;
      },
    ),
  },
  party: {
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as { id?: string; organizationId?: string };
      const row = w.id ? partyStore.get(w.id) : undefined;
      if (!row) return null;
      if (w.organizationId && row.organizationId !== w.organizationId) return null;
      return row;
    }),
  },
  $transaction: vi
    .fn()
    .mockImplementation(async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock)),
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
  Prisma: { PrismaClientKnownRequestError: MockPrismaKnownRequestError },
}));

vi.mock("../../../lib/audit", () => ({
  recordAudit: vi.fn(async () => undefined),
}));

import { recordAudit } from "../../../lib/audit";
import { decodeTrackerCursor, encodeTrackerCursor } from "../repository";
import {
  assignInChargeService,
  buildTermLabel,
  listAgentLabelsService,
  listTrackerService,
  lookupPhoneService,
  maskIdNumber,
  recordIcRevealService,
} from "../service";

const recordAuditMock = vi.mocked(recordAudit);

// ── Fixture ids ─────────────────────────────────────────────────────────────

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000010";
const PROP = "00000000-0000-4000-8000-000000000020";
const APT = "00000000-0000-4000-8000-000000000030";
const APT_2 = "00000000-0000-4000-8000-000000000031";
const L_MASTER = "00000000-0000-4000-8000-000000000041";
const L_STUDIO = "00000000-0000-4000-8000-000000000042";
const CP_ID = "00000000-0000-4000-8000-000000000043"; // Carpark bay id (was L_CARPARK)
const CA_ID = "00000000-0000-4000-8000-000000000044"; // CarparkAssignment id
const T_MASTER = "00000000-0000-4000-8000-000000000051";
const T_CARPARK = "00000000-0000-4000-8000-000000000052"; // renter's room tenancy id used in assignment
const P_ALICE = "00000000-0000-4000-8000-000000000061";
const P_PIC = "00000000-0000-4000-8000-000000000062";
const P_OTHER_ORG = "00000000-0000-4000-8000-000000000063";
const P_NOIC = "00000000-0000-4000-8000-000000000064";

const session: SessionPayload = { userId: USER, orgId: ORG, role: "manager" };

const query = (over: Partial<TenantTrackerListQuery> = {}): TenantTrackerListQuery => ({
  status: "active",
  limit: 25,
  ...over,
});

function rawTenancy(over: Partial<RawTenancy> = {}): RawTenancy {
  return {
    id: T_MASTER,
    status: "active",
    startDate: new Date("2025-01-01T00:00:00.000Z"),
    endDate: new Date("2026-01-01T00:00:00.000Z"),
    termMonths: 12,
    previousTenancyId: null,
    monthlyRentAmount: dec(1200.5),
    numberOfPax: 2,
    agentLabel: "KENDRA",
    accessCardNo: "AC-1100",
    previousTenancy: null,
    tenantParty: {
      id: P_ALICE,
      displayName: "Alice Tan",
      primaryPhone: "60123456789",
      primaryEmail: "alice@test.local",
      gender: "F",
      idType: "NRIC",
      idNumber: "990101-14-5678",
    },
    ...over,
  };
}

function rawListing(over: Partial<RawListing> = {}): RawListing {
  return {
    id: L_MASTER,
    listingType: "Master",
    occupancyStatus: "occupied",
    baseRentAmount: dec(1300),
    rentalRate: dec(1250),
    accessCardQuantity: 2,
    parkingNumbers: [],
    inChargePartyId: null,
    inChargeName: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    inChargeParty: null,
    _count: { tenancies: 0 },
    tenancies: [],
    ...over,
  };
}

function rawApartment(over: Partial<RawApartment> = {}): RawApartment {
  return {
    id: APT,
    unitCode: "A-10-3A",
    floor: 10,
    bedrooms: 3,
    property: { id: PROP, name: "M Vertica", propertyCode: "MV" },
    listings: [],
    ...over,
  };
}

beforeEach(() => {
  listingStore.clear();
  partyStore.clear();
  vi.clearAllMocks();
  dbMock.apartment.findMany.mockResolvedValue([]);
  dbMock.carparkAssignment.findMany.mockResolvedValue([]);
  dbMock.tenancy.findMany.mockResolvedValue([]);
  dbMock.$transaction.mockImplementation(
    async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock),
  );
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("maskIdNumber", () => {
  it("null → null", () => {
    expect(maskIdNumber(null)).toBeNull();
  });

  it('masks all but the last 4 chars ("••••" + last4)', () => {
    expect(maskIdNumber("990101-14-5678")).toBe("••••5678");
    expect(maskIdNumber("A1234567")).toBe("••••4567");
  });

  it('length ≤ 4 → fully masked "••••"', () => {
    expect(maskIdNumber("1234")).toBe("••••");
    expect(maskIdNumber("777")).toBe("••••");
    expect(maskIdNumber("")).toBe("••••");
  });

  it("length 5 keeps only the last 4", () => {
    expect(maskIdNumber("12345")).toBe("••••2345");
  });
});

describe("buildTermLabel", () => {
  it('12 → "1Y"', () => {
    expect(buildTermLabel(12, null)).toBe("1Y");
  });

  it('24 → "2Y"', () => {
    expect(buildTermLabel(24, null)).toBe("2Y");
  });

  it('other non-null n → "<n>M"', () => {
    expect(buildTermLabel(7, null)).toBe("7M");
    expect(buildTermLabel(36, null)).toBe("36M");
  });

  it("null → null", () => {
    expect(buildTermLabel(null, null)).toBeNull();
    expect(buildTermLabel(null, undefined)).toBeNull();
  });

  it('chains "<prevLabel> + <currentLabel>" when previous termMonths present', () => {
    expect(buildTermLabel(12, 12)).toBe("1Y + 1Y");
    expect(buildTermLabel(12, 24)).toBe("2Y + 1Y");
    expect(buildTermLabel(6, 12)).toBe("1Y + 6M");
  });

  it("no current term → null even when a previous term exists (no orphan chain)", () => {
    expect(buildTermLabel(null, 12)).toBeNull();
  });

  it("previous tenancy without termMonths → plain current label", () => {
    expect(buildTermLabel(12, null)).toBe("1Y");
    expect(buildTermLabel(12, undefined)).toBe("1Y");
  });
});

// ── listTrackerService ───────────────────────────────────────────────────────

describe("listTrackerService", () => {
  it("malformed cursor → 400 INVALID_CURSOR (no silent page-1 fallback)", async () => {
    const res = await listTrackerService(session, query({ cursor: "not-base64-json" }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(400);
    expect(res.error).toBe("INVALID_CURSOR");
    expect(dbMock.apartment.findMany).not.toHaveBeenCalled();
  });

  it("well-formed cursor is accepted", async () => {
    const cursor = encodeTrackerCursor({
      propertyName: "M Vertica",
      unitCode: "A-10-3A",
      apartmentId: APT,
    });
    const res = await listTrackerService(session, query({ cursor }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ groups: [], nextCursor: null });
    expect(dbMock.apartment.findMany).toHaveBeenCalledTimes(1);
  });

  it("re-sources carparks from CarparkAssignment (not Listings), keeps rooms and vacant rooms intact, masks IC, labels terms", async () => {
    dbMock.apartment.findMany.mockResolvedValue([
      rawApartment({
        listings: [
          rawListing({
            id: L_MASTER,
            listingType: "Master",
            inChargePartyId: P_PIC,
            inChargeName: "PIC Person",
            inChargeParty: { id: P_PIC, displayName: "PIC Person" },
            tenancies: [
              rawTenancy({
                previousTenancyId: "00000000-0000-4000-8000-000000000059",
                previousTenancy: {
                  id: "00000000-0000-4000-8000-000000000059",
                  termMonths: 12,
                },
              }),
            ],
          }),
          rawListing({
            id: L_STUDIO,
            listingType: "Studio",
            occupancyStatus: "vacant",
            baseRentAmount: null,
            rentalRate: null,
            accessCardQuantity: null,
            tenancies: [],
          }),
          // No carpark Listing here — carparks come from CarparkAssignment.
        ],
      }),
    ]);
    dbMock.carparkAssignment.findMany.mockResolvedValue([
      {
        id: CA_ID,
        tenancyId: T_CARPARK,
        status: "active",
        carpark: { id: CP_ID, apartmentId: APT, label: "B2-12" },
        tenancy: { tenantParty: { id: P_ALICE, displayName: "Alice Tan" } },
      },
    ]);

    const res = await listTrackerService(session, query());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    const group = res.data.groups[0];
    expect(group).toBeDefined();
    if (!group) throw new Error("expected one group");

    expect(group.apartment).toEqual({ id: APT, unitCode: "A-10-3A", floor: 10, bedrooms: 3 });
    expect(group.property).toEqual({ id: PROP, name: "M Vertica", propertyCode: "MV" });

    // Both room listings (Master + vacant Studio) appear in rooms[]; no carpark listing.
    expect(group.rooms.map((r) => r.unit.id)).toEqual([L_MASTER, L_STUDIO]);
    // Carpark assignment mapped to TrackerCarpark shape (slotLabel = Carpark.label).
    expect(group.carparks).toEqual([
      {
        tenancyId: T_CARPARK,
        partyId: P_ALICE,
        displayName: "Alice Tan",
        slotLabel: "B2-12",
        unitId: CP_ID,
        status: "active",
      },
    ]);

    // Vacant room is included with tenancies: [] — vacant rows are actionable.
    expect(group.rooms[1]?.tenancies).toEqual([]);

    // Room shape: ISO updatedAt, repo-converted numbers, PIC passthrough.
    const master = group.rooms[0];
    expect(master?.unit.updatedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(master?.unit.baseRentAmount).toBe(1300);
    expect(master?.inChargeParty).toEqual({ id: P_PIC, displayName: "PIC Person" });
    expect(master?.inChargeName).toBe("PIC Person");

    // Term label chain + masked IC on the master tenancy.
    const tenancy = master?.tenancies[0];
    expect(tenancy?.termLabel).toBe("1Y + 1Y");
    expect(tenancy?.monthlyRentAmount).toBe(1200.5);
    expect(tenancy?.party.idNumberMasked).toBe("••••5678");

    // The raw idNumber must NEVER appear anywhere in the list payload —
    // and the "idNumber" key itself must not exist (only "idNumberMasked").
    const json = JSON.stringify(res.data);
    expect(json).not.toContain("990101-14-5678");
    expect(json).not.toMatch(/"idNumber":/);
    expect(json).toContain("••••5678");
  });

  it("carpark slotLabel = Carpark.label from the new CarparkAssignment model", async () => {
    dbMock.apartment.findMany.mockResolvedValue([rawApartment()]);
    dbMock.carparkAssignment.findMany.mockResolvedValue([
      {
        id: CA_ID,
        tenancyId: T_CARPARK,
        status: "active",
        carpark: { id: CP_ID, apartmentId: APT, label: "P-08" },
        tenancy: { tenantParty: { id: P_ALICE, displayName: "Alice Tan" } },
      },
    ]);

    const res = await listTrackerService(session, query());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.groups[0]?.carparks[0]?.slotLabel).toBe("P-08");
    // No listings in rawApartment() default → rooms is empty.
    expect(res.data.groups[0]?.rooms).toEqual([]);
  });

  it("fully masks a short (≤4 chars) idNumber — nothing of it survives", async () => {
    dbMock.apartment.findMany.mockResolvedValue([
      rawApartment({
        listings: [
          rawListing({
            tenancies: [
              rawTenancy({
                tenantParty: {
                  id: P_ALICE,
                  displayName: "Short Ic",
                  primaryPhone: null,
                  primaryEmail: null,
                  gender: null,
                  idType: "PASSPORT",
                  idNumber: "Z9Q",
                },
              }),
            ],
          }),
        ],
      }),
    ]);

    const res = await listTrackerService(session, query());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.groups[0]?.rooms[0]?.tenancies[0]?.party.idNumberMasked).toBe("••••");
    expect(JSON.stringify(res.data)).not.toContain("Z9Q");
  });

  it("passes nextCursor through from the repo page", async () => {
    dbMock.apartment.findMany.mockResolvedValue([
      rawApartment({ id: APT, unitCode: "A-10-3A" }),
      rawApartment({ id: APT_2, unitCode: "A-10-3B" }),
    ]);

    const res = await listTrackerService(session, query({ limit: 1 }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.groups).toHaveLength(1);
    expect(res.data.nextCursor).not.toBeNull();
    expect(decodeTrackerCursor(res.data.nextCursor ?? "")).toEqual({
      propertyName: "M Vertica",
      unitCode: "A-10-3A",
      apartmentId: APT,
    });
  });
});

// ── lookupPhoneService ───────────────────────────────────────────────────────

describe("lookupPhoneService", () => {
  it("empty match → ok([]) with status 200, NOT 404", async () => {
    const res = await lookupPhoneService(session, "0000");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it("maps repo hits through unchanged", async () => {
    // lookupByPhone issues TWO queries: suffix block, then contains-fill
    // (whose `id: notIn` excludes the suffix rows — model that here).
    dbMock.tenancy.findMany
      .mockResolvedValueOnce([
        {
          id: T_MASTER,
          unitId: L_MASTER,
          propertyId: PROP,
          tenantParty: { displayName: "Alice Tan" },
          unit: { apartmentId: APT, apartment: { unitCode: "A-10-3A" } },
        },
      ])
      .mockResolvedValueOnce([]); // fill query: notIn excludes it

    const res = await lookupPhoneService(session, "6789");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual([
      {
        tenancyId: T_MASTER,
        unitId: L_MASTER,
        apartmentId: APT,
        propertyId: PROP,
        displayName: "Alice Tan",
        unitCode: "A-10-3A",
      },
    ]);
  });
});

// ── listAgentLabelsService ───────────────────────────────────────────────────

describe("listAgentLabelsService", () => {
  it("wraps the distinct labels as {agents}", async () => {
    dbMock.tenancy.findMany.mockResolvedValue([
      { agentLabel: "KENDRA" },
      { agentLabel: "Kendra" },
    ]);
    const res = await listAgentLabelsService(session);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ agents: ["KENDRA", "Kendra"] });
  });
});

// ── assignInChargeService ────────────────────────────────────────────────────

const UPDATED_AT = new Date("2026-06-10T12:00:00.000Z");

function seedAssignFixtures() {
  listingStore.set(L_MASTER, {
    id: L_MASTER,
    organizationId: ORG,
    inChargePartyId: null,
    inChargeName: null,
    updatedAt: UPDATED_AT,
  });
  partyStore.set(P_PIC, {
    id: P_PIC,
    organizationId: ORG,
    displayName: "PIC Person",
    idNumber: "880808-08-8888",
  });
  partyStore.set(P_OTHER_ORG, {
    id: P_OTHER_ORG,
    organizationId: OTHER_ORG,
    displayName: "Outsider",
    idNumber: null,
  });
}

describe("assignInChargeService", () => {
  beforeEach(seedAssignFixtures);

  it("assign success returns the new pair and audits in the same tx", async () => {
    const res = await assignInChargeService(session, L_MASTER, { inChargePartyId: P_PIC });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ inChargePartyId: P_PIC, inChargeName: "PIC Person" });
    expect(listingStore.get(L_MASTER)).toMatchObject({
      inChargePartyId: P_PIC,
      inChargeName: "PIC Person",
    });

    // org-scoped WHERE; no updatedAt clause when expectedUpdatedAt is absent.
    const updateArgs = dbMock.listing.update.mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({ id: L_MASTER, organizationId: ORG });

    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    expect(recordAuditMock.mock.calls[0]?.[0]).toBe(dbMock); // called with the tx client
    expect(recordAuditMock.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      actorUserId: USER,
      actorRole: "manager",
      action: "leasing.unit.assign_in_charge",
      entityType: "Listing",
      entityId: L_MASTER,
      diff: {
        before: { inChargePartyId: null, inChargeName: null },
        after: { inChargePartyId: P_PIC, inChargeName: "PIC Person" },
      },
    });
  });

  it("matching expectedUpdatedAt puts updatedAt in the WHERE and succeeds", async () => {
    const res = await assignInChargeService(session, L_MASTER, {
      inChargePartyId: P_PIC,
      expectedUpdatedAt: UPDATED_AT.toISOString(),
    });
    expect(res.ok).toBe(true);
    const updateArgs = dbMock.listing.update.mock.calls[0]?.[0];
    expect(updateArgs?.where.updatedAt).toEqual(UPDATED_AT);
  });

  it("ms-truncated but instant-equal expectedUpdatedAt does NOT 409 (instant pre-check)", async () => {
    // Same instant as UPDATED_AT (ms=000) but without the milliseconds part —
    // ISO-string equality would spuriously flag this as stale.
    const res = await assignInChargeService(session, L_MASTER, {
      inChargePartyId: P_PIC,
      expectedUpdatedAt: "2026-06-10T12:00:00Z",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ inChargePartyId: P_PIC, inChargeName: "PIC Person" });
  });

  it("unassign (null) clears both id and denormalized name", async () => {
    listingStore.set(L_MASTER, {
      id: L_MASTER,
      organizationId: ORG,
      inChargePartyId: P_PIC,
      inChargeName: "PIC Person",
      updatedAt: UPDATED_AT,
    });

    const res = await assignInChargeService(session, L_MASTER, { inChargePartyId: null });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ inChargePartyId: null, inChargeName: null });
    expect(listingStore.get(L_MASTER)).toMatchObject({
      inChargePartyId: null,
      inChargeName: null,
    });
    expect(dbMock.party.findFirst).not.toHaveBeenCalled(); // no assignee to validate
    expect(recordAuditMock.mock.calls[0]?.[1]).toMatchObject({
      diff: {
        before: { inChargePartyId: P_PIC, inChargeName: "PIC Person" },
        after: { inChargePartyId: null, inChargeName: null },
      },
    });
  });

  it("unknown unit → 404, nothing written, nothing audited", async () => {
    const res = await assignInChargeService(session, "00000000-0000-4000-8000-00000000dead", {
      inChargePartyId: P_PIC,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(404);
    expect(dbMock.listing.update).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("party not in org → 404, nothing written", async () => {
    const res = await assignInChargeService(session, L_MASTER, {
      inChargePartyId: P_OTHER_ORG,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(404);
    expect(dbMock.listing.update).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("stale expectedUpdatedAt (pre-check) → 409 STALE before any write", async () => {
    const res = await assignInChargeService(session, L_MASTER, {
      inChargePartyId: P_PIC,
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(409);
    expect(res.error).toBe("STALE");
    expect(dbMock.listing.update).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("P2025 from the updatedAt-in-WHERE update → 409 STALE, no audit", async () => {
    dbMock.listing.update.mockRejectedValueOnce(new MockPrismaKnownRequestError("P2025"));
    const res = await assignInChargeService(session, L_MASTER, {
      inChargePartyId: P_PIC,
      expectedUpdatedAt: UPDATED_AT.toISOString(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(409);
    expect(res.error).toBe("STALE");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("audit failure rethrows out of the $transaction callback (real tx would roll back)", async () => {
    recordAuditMock.mockRejectedValueOnce(new Error("audit down"));

    await expect(
      assignInChargeService(session, L_MASTER, { inChargePartyId: P_PIC }),
    ).rejects.toThrow("audit down");

    // The update DID run before the audit threw — the rejection propagating
    // through $transaction is what makes real Prisma roll it back. DB-level
    // proof lives in service.integration.test.ts.
    expect(dbMock.listing.update).toHaveBeenCalledTimes(1);
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ── recordIcRevealService ────────────────────────────────────────────────────

describe("recordIcRevealService", () => {
  beforeEach(() => {
    partyStore.set(P_PIC, {
      id: P_PIC,
      organizationId: ORG,
      displayName: "PIC Person",
      idNumber: "880808-08-8888",
    });
    partyStore.set(P_NOIC, {
      id: P_NOIC,
      organizationId: ORG,
      displayName: "No Ic",
      idNumber: null,
    });
    partyStore.set(P_OTHER_ORG, {
      id: P_OTHER_ORG,
      organizationId: OTHER_ORG,
      displayName: "Outsider",
      idNumber: "770707-07-7777",
    });
  });

  it("returns the raw idNumber and audits leasing.tenant.ic_reveal in the same tx", async () => {
    const res = await recordIcRevealService(session, P_PIC);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ partyId: P_PIC, idNumber: "880808-08-8888" });

    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    expect(recordAuditMock.mock.calls[0]?.[0]).toBe(dbMock);
    expect(recordAuditMock.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      actorUserId: USER,
      actorRole: "manager",
      action: "leasing.tenant.ic_reveal",
      entityType: "Party",
      entityId: P_PIC,
    });
  });

  it("cross-org party → 404, no audit row", async () => {
    const res = await recordIcRevealService(session, P_OTHER_ORG);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(404);
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("party without an idNumber → 404 NO_IC, no audit row (documented choice)", async () => {
    const res = await recordIcRevealService(session, P_NOIC);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    expect(res.status).toBe(404);
    expect(res.error).toBe("NO_IC");
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});
