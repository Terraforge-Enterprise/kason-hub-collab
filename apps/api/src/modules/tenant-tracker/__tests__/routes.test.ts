// HTTP-harness tests for the tenant-tracker routes (M1, Step 4).
//
// Mirrors listings-explorer.routes.test.ts for the bare-Hono-app + fake-session
// harness, but mocks at the @kason/db level (service.test.ts pattern) so the
// REAL repository + service run: IC masking, cursor decoding and the export
// page-walk are exercised genuinely instead of testing their own mocks.
//
// The flag gate reads process.env per-request (lib/feature-flags), so tests
// toggle ENABLE_PHASE2_TENANT_TRACKER without any module re-import tricks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import ExcelJS from "exceljs";
import type { SessionPayload } from "../../../lib/auth";

// ── In-memory stores (PATCH + ic-reveal paths) ──────────────────────────────

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
  property: {
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  },
  apartment: {
    findMany: vi.fn(async (_args?: unknown): Promise<RawApartment[]> => []),
    groupBy: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  },
  carparkAssignment: {
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  },
  tenancy: {
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    groupBy: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  },
  meterReading: {
    findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
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
import { tenantTrackerRoutes } from "../routes";

const recordAuditMock = vi.mocked(recordAudit);

// ── Harness ──────────────────────────────────────────────────────────────────

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/api/tenant-tracker", tenantTrackerRoutes);
  return app;
}

// ── Fixture ids ─────────────────────────────────────────────────────────────

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const PROP = "00000000-0000-4000-8000-000000000020";
const APT = "00000000-0000-4000-8000-000000000030";
const L_MASTER = "00000000-0000-4000-8000-000000000041";
const CP_ID = "00000000-0000-4000-8000-000000000043"; // Carpark bay id (was L_CARPARK)
const CA_ID = "00000000-0000-4000-8000-000000000044"; // CarparkAssignment id
const T_MASTER = "00000000-0000-4000-8000-000000000051";
const T_CARPARK = "00000000-0000-4000-8000-000000000052"; // renter's room tenancy id used in assignment
const P_ALICE = "00000000-0000-4000-8000-000000000061";
const P_PIC = "00000000-0000-4000-8000-000000000062";
const P_OTHER_ORG = "00000000-0000-4000-8000-000000000063";
const UNKNOWN_UUID = "00000000-0000-4000-8000-0000000000ff";

const adminSession: SessionPayload = {
  userId: "u-admin",
  orgId: ORG,
  role: "admin",
  userType: "operator",
};
const managerSession: SessionPayload = {
  userId: "u-manager",
  orgId: ORG,
  role: "manager",
  userType: "operator",
};
const editorSession: SessionPayload = {
  userId: "u-editor",
  orgId: ORG,
  role: "editor",
  userType: "operator",
};
const viewerSession: SessionPayload = {
  userId: "u-viewer",
  orgId: ORG,
  role: "viewer",
  userType: "operator",
};

// ── Fixture builders (service.test.ts shapes) ───────────────────────────────

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
    inChargePartyId: P_PIC,
    inChargeName: "Pic Person",
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    inChargeParty: { id: P_PIC, displayName: "Pic Person" },
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

/**
 * One apartment, one occupied Master room + one active CarparkAssignment.
 * Carparks are now sourced from CarparkAssignment, not from Listing.unitKind.
 */
function seedOneApartmentWithCarpark() {
  dbMock.apartment.findMany.mockResolvedValue([
    rawApartment({
      listings: [rawListing({ tenancies: [rawTenancy()] })],
    }),
  ]);
  dbMock.carparkAssignment.findMany.mockResolvedValue([
    {
      id: CA_ID,
      tenancyId: T_CARPARK,
      status: "active",
      carpark: { id: CP_ID, apartmentId: APT, label: "B2-115" },
      tenancy: { tenantParty: { id: P_ALICE, displayName: "Alice Tan" } },
    },
  ]);
}

/** Recursively collect every object key in a JSON-parsed body. */
function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

async function loadWorkbook(res: Response): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await res.arrayBuffer());
  const sheet = workbook.getWorksheet("Tenant Tracker");
  if (!sheet) throw new Error("worksheet 'Tenant Tracker' missing");
  return sheet;
}

function colIndex(sheet: ExcelJS.Worksheet, header: string): number {
  let idx = -1;
  sheet.getRow(1).eachCell((cell, col) => {
    if (cell.value === header) idx = col;
  });
  if (idx === -1) throw new Error(`header "${header}" not found`);
  return idx;
}

/** Data rows (row 2..) as arrays of cell values. */
function dataRows(sheet: ExcelJS.Worksheet): ExcelJS.Row[] {
  const rows: ExcelJS.Row[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.actualCellCount > 0) rows.push(row);
  }
  return rows;
}

// ── Env + store lifecycle ────────────────────────────────────────────────────

beforeEach(() => {
  process.env.ENABLE_PHASE2_TENANT_TRACKER = "true";
  listingStore.clear();
  partyStore.clear();
  vi.clearAllMocks();
  dbMock.property.findMany.mockResolvedValue([]);
  dbMock.apartment.findMany.mockResolvedValue([]);
  dbMock.apartment.groupBy.mockResolvedValue([]);
  dbMock.carparkAssignment.findMany.mockResolvedValue([]);
  dbMock.tenancy.findMany.mockResolvedValue([]);
  dbMock.tenancy.groupBy.mockResolvedValue([]);
  dbMock.meterReading.findMany.mockResolvedValue([]);
  dbMock.$transaction.mockImplementation(
    async (cb: (tx: typeof dbMock) => Promise<unknown>) => cb(dbMock),
  );
});

afterEach(() => {
  delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
});

// ── Flag OFF: every route returns the canonical public-card 404 ─────────────

describe("flag OFF — per-request gate", () => {
  const DISABLED_BODY = { error: "not_found" }; // public-card/routes.ts notFound shape

  it.each([
    ["GET list", "/api/tenant-tracker", { method: "GET" }],
    ["GET lookup", "/api/tenant-tracker/lookup?phone=3456789", { method: "GET" }],
    ["GET agents", "/api/tenant-tracker/agents", { method: "GET" }],
    ["GET summary", "/api/tenant-tracker/summary", { method: "GET" }],
    [
      "PATCH in-charge",
      `/api/tenant-tracker/${L_MASTER}/in-charge`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inChargePartyId: null }),
      },
    ],
    [
      "POST ic-reveal",
      "/api/tenant-tracker/ic-reveal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: P_ALICE }),
      },
    ],
    ["GET export.xlsx", "/api/tenant-tracker/export.xlsx", { method: "GET" }],
  ] as const)("%s → canonical 404", async (_label, path, init) => {
    delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
    const res = await makeApp(adminSession).request(path, init);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });

  it("gate runs BEFORE requireRole: unauthenticated caller gets 404, not 401", async () => {
    delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
    const res = await makeApp(null).request("/api/tenant-tracker");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });

  it("gate runs BEFORE requireRole: viewer gets 404, not 403", async () => {
    delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
    const res = await makeApp(viewerSession).request("/api/tenant-tracker");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });

  it('flag value "false" is OFF too', async () => {
    process.env.ENABLE_PHASE2_TENANT_TRACKER = "false";
    const res = await makeApp(adminSession).request("/api/tenant-tracker");
    expect(res.status).toBe(404);
  });

  it("flag ON lets requireRole run: unauthenticated caller gets 401", async () => {
    const res = await makeApp(null).request("/api/tenant-tracker");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});

// ── GET / ────────────────────────────────────────────────────────────────────

describe("GET /api/tenant-tracker", () => {
  it("viewer → 403", async () => {
    const res = await makeApp(viewerSession).request("/api/tenant-tracker");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("editor → 200 grouped shape with nextCursor key and masked IC; no charge/payment keys", async () => {
    seedOneApartmentWithCarpark();
    const res = await makeApp(editorSession).request("/api/tenant-tracker");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect("nextCursor" in body).toBe(true);
    expect(body.nextCursor).toBeNull();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].apartment.unitCode).toBe("A-10-3A");
    expect(body.groups[0].rooms).toHaveLength(1);
    expect(body.groups[0].carparks).toHaveLength(1);

    const contact = body.groups[0].rooms[0].tenancies[0].party;
    expect(contact.idNumberMasked).toBe("••••5678");
    expect(contact.idNumber).toBeUndefined();

    // No Charge/Payment relation leaks (inCharge* is the PIC, not finance).
    const offending = [...collectKeys(body)].filter(
      (k) => /charge|payment/i.test(k) && !/^inCharge/.test(k),
    );
    expect(offending).toEqual([]);
  });

  it("passes session.orgId through to the org-scoped query", async () => {
    await makeApp(editorSession).request("/api/tenant-tracker");
    expect(dbMock.apartment.findMany).toHaveBeenCalledTimes(1);
    const args = dbMock.apartment.findMany.mock.calls[0]![0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    expect(args.where.AND[0]).toEqual({ organizationId: ORG });
  });

  it("garbage cursor → 400 INVALID_CURSOR", async () => {
    const res = await makeApp(editorSession).request("/api/tenant-tracker?cursor=garbage");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_CURSOR" });
  });

  it("limit=0 → 400 flattened field error without echoing the supplied value", async () => {
    const res = await makeApp(editorSession).request("/api/tenant-tracker?limit=0");
    expect(res.status).toBe(400);
    const body = await res.json();
    // Exact zod-error-mapper text — humanized and value-free (no input echo).
    expect(body.fieldErrors).toEqual({ limit: "limit is too small." });
    expect(body.error).toBe("limit is too small.");
  });
});

// ── GET /lookup ──────────────────────────────────────────────────────────────

describe("GET /api/tenant-tracker/lookup", () => {
  it("viewer → 403", async () => {
    const res = await makeApp(viewerSession).request(
      "/api/tenant-tracker/lookup?phone=3456789",
    );
    expect(res.status).toBe(403);
  });

  it("editor → 200 hit shape", async () => {
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
    const res = await makeApp(editorSession).request(
      "/api/tenant-tracker/lookup?phone=3456789",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
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

  it("no match → 200 [] (not 404)", async () => {
    const res = await makeApp(editorSession).request(
      "/api/tenant-tracker/lookup?phone=99999999",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("phone shorter than 4 chars → 400 without echoing the input", async () => {
    const res = await makeApp(editorSession).request("/api/tenant-tracker/lookup?phone=129");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.phone).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("129");
  });
});

// ── GET /agents ──────────────────────────────────────────────────────────────

describe("GET /api/tenant-tracker/agents", () => {
  it("viewer → 403", async () => {
    const res = await makeApp(viewerSession).request("/api/tenant-tracker/agents");
    expect(res.status).toBe(403);
  });

  it("editor → 200 {agents:[...]}", async () => {
    dbMock.tenancy.findMany.mockResolvedValue([
      { agentLabel: "KENDRA" },
      { agentLabel: "Yannie" },
    ]);
    const res = await makeApp(editorSession).request("/api/tenant-tracker/agents");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: ["KENDRA", "Yannie"] });
  });
});

// ── GET /summary ─────────────────────────────────────────────────────────────

describe("GET /api/tenant-tracker/summary", () => {
  /** Seed the four db calls getTrackerSummary issues in parallel. */
  function seedSummaryMocks() {
    // property.findMany
    dbMock.property.findMany.mockResolvedValue([
      { id: PROP, name: "M Vertica", propertyCode: "MV" },
    ]);
    // apartment.groupBy → 1 apartment under PROP
    dbMock.apartment.groupBy.mockResolvedValue([
      { propertyId: PROP, _count: { _all: 1 } },
    ]);
    // apartment.findMany → 1 apartment, 1 room listing (_count.listings = 1)
    // NOTE: apartment.findMany is also used by the list endpoint; the summary
    // call happens before any list call in this test, so the first resolved
    // value is consumed by the summary, leaving the default [] for any
    // subsequent list calls within the same test.
    // Summary uses a different select shape — cast to bypass RawApartment type.
    (dbMock.apartment.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { propertyId: PROP, _count: { listings: 1 } },
    ]);
    // tenancy.groupBy → 1 occupied room with 1 active tenancy on it
    dbMock.tenancy.groupBy.mockResolvedValue([
      { propertyId: PROP, unitId: L_MASTER, _count: { _all: 1 } },
    ]);
  }

  it("flag OFF → 404 { error: 'not_found' }", async () => {
    delete process.env.ENABLE_PHASE2_TENANT_TRACKER;
    const res = await makeApp(adminSession).request("/api/tenant-tracker/summary");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("viewer → 403", async () => {
    const res = await makeApp(viewerSession).request("/api/tenant-tracker/summary");
    expect(res.status).toBe(403);
  });

  it("editor → 200 { totals, properties }", async () => {
    seedSummaryMocks();
    const res = await makeApp(editorSession).request("/api/tenant-tracker/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect("totals" in body).toBe(true);
    expect("properties" in body).toBe(true);
    expect(body.properties).toHaveLength(1);
    expect(body.properties[0].propertyId).toBe(PROP);
    expect(body.properties[0].apartments).toBe(1);
    expect(body.properties[0].rooms).toBe(1);
    expect(body.properties[0].activeTenancies).toBe(1);
    expect(body.properties[0].vacantRooms).toBe(0);
    expect(body.totals).toEqual({ apartments: 1, rooms: 1, activeTenancies: 1, vacantRooms: 0 });
  });

  it("list ?occupiedOnly=false → 200 and treated as OFF (occupiedOnly false in where)", async () => {
    // occupiedOnly=false means the active-tenancy filter is NOT pushed.
    // When false, the list route should NOT push the occupiedOnly condition.
    // We verify: the apartment.findMany WHERE does NOT contain
    // a listings.some clause filtering for active tenancies.
    dbMock.apartment.findMany.mockResolvedValue([]);
    const res = await makeApp(editorSession).request(
      "/api/tenant-tracker?occupiedOnly=false",
    );
    expect(res.status).toBe(200);
    const callArgs = dbMock.apartment.findMany.mock.calls[0]![0] as {
      where: { AND: Array<Record<string, unknown>> };
    };
    // None of the AND conditions should be the occupiedOnly listing filter.
    const hasOccupiedOnlyCondition = callArgs.where.AND.some(
      (c) =>
        "listings" in c &&
        typeof c.listings === "object" &&
        c.listings !== null &&
        "some" in (c.listings as Record<string, unknown>) &&
        JSON.stringify(c.listings).includes('"active"'),
    );
    expect(hasOccupiedOnlyCondition).toBe(false);
  });
});

// ── PATCH /:unitId/in-charge ─────────────────────────────────────────────────

async function patchInCharge(
  session: SessionPayload | null,
  unitId: string,
  body: unknown,
): Promise<Response> {
  return makeApp(session).request(`/api/tenant-tracker/${unitId}/in-charge`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/tenant-tracker/:unitId/in-charge", () => {
  const UPDATED_AT = new Date("2026-06-01T00:00:00.000Z");

  beforeEach(() => {
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
      displayName: "Pic Person",
      idNumber: null,
    });
    partyStore.set(P_OTHER_ORG, {
      id: P_OTHER_ORG,
      organizationId: OTHER_ORG,
      displayName: "Stranger",
      idNumber: null,
    });
  });

  it("viewer → 403", async () => {
    const res = await patchInCharge(viewerSession, L_MASTER, { inChargePartyId: P_PIC });
    expect(res.status).toBe(403);
  });

  it("editor assign → 200 {inChargePartyId, inChargeName}", async () => {
    const res = await patchInCharge(editorSession, L_MASTER, { inChargePartyId: P_PIC });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inChargePartyId: P_PIC, inChargeName: "Pic Person" });
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
  });

  it("editor unassign (null) → 200 with both fields null", async () => {
    const res = await patchInCharge(editorSession, L_MASTER, { inChargePartyId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inChargePartyId: null, inChargeName: null });
  });

  it("unknown unit → 404 UNIT_NOT_FOUND", async () => {
    const res = await patchInCharge(editorSession, UNKNOWN_UUID, { inChargePartyId: P_PIC });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "UNIT_NOT_FOUND" });
  });

  it("cross-org assignee → 404 PARTY_NOT_FOUND", async () => {
    const res = await patchInCharge(editorSession, L_MASTER, {
      inChargePartyId: P_OTHER_ORG,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PARTY_NOT_FOUND" });
  });

  it("stale expectedUpdatedAt → 409 STALE", async () => {
    const res = await patchInCharge(editorSession, L_MASTER, {
      inChargePartyId: P_PIC,
      expectedUpdatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "STALE" });
  });

  it("non-uuid unitId → 400 without echoing the value", async () => {
    const res = await patchInCharge(editorSession, "not-a-uuid", { inChargePartyId: P_PIC });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("not-a-uuid");
  });

  it("non-uuid body partyId → 400 flattened field error without echo", async () => {
    const res = await patchInCharge(editorSession, L_MASTER, { inChargePartyId: "nope" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.inChargePartyId).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("nope");
  });
});

// ── POST /ic-reveal ──────────────────────────────────────────────────────────

async function postIcReveal(session: SessionPayload | null, body: unknown): Promise<Response> {
  return makeApp(session).request("/api/tenant-tracker/ic-reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tenant-tracker/ic-reveal", () => {
  beforeEach(() => {
    partyStore.set(P_ALICE, {
      id: P_ALICE,
      organizationId: ORG,
      displayName: "Alice Tan",
      idNumber: "990101-14-5678",
    });
  });

  it("editor → 403 (manager+ only)", async () => {
    const res = await postIcReveal(editorSession, { partyId: P_ALICE });
    expect(res.status).toBe(403);
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it("manager → 200 raw idNumber, audited", async () => {
    const res = await postIcReveal(managerSession, { partyId: P_ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partyId: P_ALICE, idNumber: "990101-14-5678" });
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    expect(recordAuditMock.mock.calls[0]![1]).toMatchObject({
      action: "leasing.tenant.ic_reveal",
      entityId: P_ALICE,
    });
  });

  it("unknown party → 404 PARTY_NOT_FOUND", async () => {
    const res = await postIcReveal(managerSession, { partyId: UNKNOWN_UUID });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PARTY_NOT_FOUND" });
  });

  it("invalid body → 400 flattened field error without echo", async () => {
    const res = await postIcReveal(managerSession, { partyId: "not-a-uuid" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.partyId).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("not-a-uuid");
  });
});

// ── GET /export.xlsx ─────────────────────────────────────────────────────────

describe("GET /api/tenant-tracker/export.xlsx", () => {
  it("editor → 403 (manager+ only)", async () => {
    const res = await makeApp(editorSession).request("/api/tenant-tracker/export.xlsx");
    expect(res.status).toBe(403);
  });

  it("manager → 200 with spreadsheet MIME + attachment disposition", async () => {
    seedOneApartmentWithCarpark();
    const res = await makeApp(managerSession).request("/api/tenant-tracker/export.xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="tenant-tracker.xlsx"',
    );
    // Can carry raw ICs (admin column) — must never land in any cache.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("one row per room tenancy; IC MASKED for a manager (carpark export deferred to future task)", async () => {
    seedOneApartmentWithCarpark();
    const res = await makeApp(managerSession).request("/api/tenant-tracker/export.xlsx");
    expect(res.status).toBe(200);

    const sheet = await loadWorkbook(res);
    const rows = dataRows(sheet);
    // Only the Master room tenancy — carpark export from CarparkAssignment deferred;
    // carpark Listings no longer exist post-redesign.
    expect(rows).toHaveLength(1);

    const ic = colIndex(sheet, "IC");
    const kind = colIndex(sheet, "Kind");
    const room = colIndex(sheet, "Room");
    const rent = colIndex(sheet, "Monthly Rent");
    const start = colIndex(sheet, "Start Date");

    const roomRow = rows[0];
    expect(roomRow).toBeDefined();

    expect(roomRow!.getCell(kind).value).toBe("room");
    expect(roomRow!.getCell(ic).value).toBe("••••5678");
    expect(roomRow!.getCell(room).value).toBe("Master");
    expect(roomRow!.getCell(rent).value).toBe(1200.5);
    expect(roomRow!.getCell(start).value).toBe("2025-01-01");
  });

  it("IC RAW for an admin session", async () => {
    seedOneApartmentWithCarpark();
    const res = await makeApp(adminSession).request("/api/tenant-tracker/export.xlsx");
    expect(res.status).toBe(200);

    const sheet = await loadWorkbook(res);
    const ic = colIndex(sheet, "IC");
    for (const row of dataRows(sheet)) {
      expect(row.getCell(ic).value).toBe("990101-14-5678");
    }
  });

  it("walks pages internally at 100/page (cursor passed page-to-page)", async () => {
    // Page 1: 101 empty apartments → repo slices to 100, emits nextCursor.
    // Page 2: the seeded apartment with one tenancy → 1 export row.
    const fillers = Array.from({ length: 101 }, (_, i) =>
      rawApartment({ id: `00000000-0000-4000-8000-0000000a${String(i).padStart(4, "0")}`, unitCode: `F-${i}` }),
    );
    dbMock.apartment.findMany
      .mockResolvedValueOnce(fillers)
      .mockResolvedValueOnce([rawApartment({ listings: [rawListing({ tenancies: [rawTenancy()] })] })]);

    const res = await makeApp(managerSession).request("/api/tenant-tracker/export.xlsx");
    expect(res.status).toBe(200);
    expect(dbMock.apartment.findMany).toHaveBeenCalledTimes(2);
    const firstArgs = dbMock.apartment.findMany.mock.calls[0]![0] as { take: number };
    expect(firstArgs.take).toBe(101); // limit 100 + 1 sentinel

    const sheet = await loadWorkbook(res);
    expect(dataRows(sheet)).toHaveLength(1);
  });

  it("ignores cursor/limit params entirely (no 400, no pagination override)", async () => {
    seedOneApartmentWithCarpark();
    const res = await makeApp(managerSession).request(
      "/api/tenant-tracker/export.xlsx?cursor=garbage&limit=0",
    );
    expect(res.status).toBe(200);
    // The walk still starts from page 1 at the export's own page size.
    const firstArgs = dbMock.apartment.findMany.mock.calls[0]![0] as { take: number };
    expect(firstArgs.take).toBe(101);
  });

  it("hard-caps the page walk at 100 pages (log-and-stop, no infinite loop)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Every page claims "more" — without the cap this would never end.
      dbMock.apartment.findMany.mockImplementation(async () =>
        Array.from({ length: 101 }, (_, i) =>
          rawApartment({ id: `00000000-0000-4000-8000-0000000b${String(i).padStart(4, "0")}`, unitCode: `C-${i}` }),
        ),
      );
      const res = await makeApp(managerSession).request("/api/tenant-tracker/export.xlsx");
      expect(res.status).toBe(200);
      expect(dbMock.apartment.findMany).toHaveBeenCalledTimes(100);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── GET / — electricity wiring (period × meter flag) ────────────────────────
//
// These tests assert the full HTTP path for the Tracker × Meter merge (Tasks
// 1–3). No real DB: meterReading.findMany is in dbMock and returns the seeded
// reading for the target listing id.

describe("GET /api/tenant-tracker — electricity (period + meter flag)", () => {
  // Distinct UUID prefix "ee" to avoid conflicts with other suites.
  const ELEC_READ_ID = "ee000000-0000-4000-8000-000000000051";

  /** Seed apartment + one room listing (L_MASTER, no carpark). */
  function seedApartmentWithRoom() {
    dbMock.apartment.findMany.mockResolvedValue([
      rawApartment({
        listings: [rawListing({ tenancies: [rawTenancy()] })],
      }),
    ]);
  }

  /**
   * Seed meterReading.findMany to return one submitted reading for L_MASTER
   * with 412 kWh and RM 247.20 — matches the electricity.test.ts fixture values
   * so the assertion is meaningful, not just "truthy".
   */
  function seedElectricityReading() {
    dbMock.meterReading.findMany.mockResolvedValue([
      {
        id: ELEC_READ_ID,
        unitId: L_MASTER,
        status: "submitted",
        consumption: "412",
        computedAmount: "247.20",
      },
    ]);
  }

  it("flag ON + period=2026-06 → room.electricity carries the seeded reading", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    try {
      seedApartmentWithRoom();
      seedElectricityReading();

      const res = await makeApp(editorSession).request("/api/tenant-tracker?period=2026-06");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.groups).toHaveLength(1);
      const room = body.groups[0].rooms[0];
      expect(room).toBeDefined();

      // The electricity field must carry real values — not just "non-null".
      expect(room.electricity).toMatchObject({
        readingId: ELEC_READ_ID,
        status: "submitted",
        kwh: 412,
        amount: 247.2,
      });

      // meterReading.findMany must have been called with the correct period date.
      expect(dbMock.meterReading.findMany).toHaveBeenCalledTimes(1);
      const meterArgs = dbMock.meterReading.findMany.mock.calls[0]![0] as {
        where: { periodMonth: Date; organizationId: string };
      };
      expect(meterArgs.where.periodMonth).toEqual(new Date("2026-06-01T00:00:00.000Z"));
      expect(meterArgs.where.organizationId).toBe(ORG);
    } finally {
      delete process.env.ENABLE_PHASE2_METER;
    }
  });

  it("period=June (invalid format) → 400 field error without echoing the input", async () => {
    process.env.ENABLE_PHASE2_METER = "true";
    try {
      const res = await makeApp(editorSession).request("/api/tenant-tracker?period=June");
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.fieldErrors?.period).toBeDefined();
      // The shared regex rejects "June" — the error message must not echo the raw value.
      expect(JSON.stringify(body)).not.toContain("June");
    } finally {
      delete process.env.ENABLE_PHASE2_METER;
    }
  });

  it("meter flag OFF → room.electricity is null regardless of period", async () => {
    // Explicitly ensure the meter flag is absent.
    delete process.env.ENABLE_PHASE2_METER;

    seedApartmentWithRoom();
    // Seed a reading — but it must NOT be returned because the flag is off.
    seedElectricityReading();

    const res = await makeApp(editorSession).request("/api/tenant-tracker?period=2026-06");
    expect(res.status).toBe(200);

    const body = await res.json();
    const room = body.groups[0]?.rooms[0];
    expect(room).toBeDefined();
    expect(room.electricity).toBeNull();

    // meterReading.findMany must NOT have been called when the flag is off.
    expect(dbMock.meterReading.findMany).not.toHaveBeenCalled();
  });
});
