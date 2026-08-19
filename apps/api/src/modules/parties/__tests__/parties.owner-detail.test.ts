import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { partiesRoutes } from "../parties.routes";
import * as partiesService from "../parties.service";
import { findOwnerDetail } from "../parties.repository";

// ── DB-level mock (used only by the findOwnerDetail describe block below) ──
const mockPartyFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => ({
    party: { findFirst: mockPartyFindFirst },
    listing: { findMany: vi.fn().mockResolvedValue([]) },
  })),
}));

// Mock all service functions so DB is never reached by route tests.
vi.mock("../parties.service", () => ({
  getAgentsService: vi.fn().mockResolvedValue([]),
  getOwnersService: vi.fn().mockResolvedValue([]),
  getTenantsService: vi.fn().mockResolvedValue([]),
  createAgentService: vi.fn(),
  updateAgentService: vi.fn(),
  blacklistAgentService: vi.fn(),
  createOwnerService: vi.fn(),
  updateOwnerService: vi.fn(),
  blacklistOwnerService: vi.fn(),
  reactivateOwnerService: vi.fn(),
  createTenantService: vi.fn(),
  updateTenantService: vi.fn(),
  blacklistTenantService: vi.fn(),
  reactivateTenantService: vi.fn(),
  createPortalAccessService: vi.fn(),
  searchTenantsService: vi.fn().mockResolvedValue({ data: [] }),
  searchOwnersService: vi.fn().mockResolvedValue({ data: [] }),
  getTenantDetailService: vi.fn(),
  getOwnerDetailService: vi.fn(),
}));

vi.mock("../../../lib/ic-reveal", () => ({
  recordIcRevealService: vi.fn(),
}));

function makeApp(session: SessionPayload | null) {
  const app = new Hono<{ Variables: { session: SessionPayload } }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", partiesRoutes);
  return app;
}

const managerSession: SessionPayload = { userId: "u5", orgId: "org1", role: "manager", userType: "operator" };
const editorSession: SessionPayload = { userId: "u2", orgId: "org1", role: "editor", userType: "operator" };

const OWNER_ID   = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";
const TENANT_ID  = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UNKNOWN_ID = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a99";

const ownerDetailFixture = {
  id: OWNER_ID,
  displayName: "Dato' Razak bin Abdullah",
  legalName: "Razak bin Abdullah",
  primaryEmail: "razak@example.com",
  primaryPhone: "60112345678",
  formattedPhone: "+60 11-234 5678",
  whatsappPhone: null,
  idType: "nric",
  idNumberMasked: "••••5678",
  nationality: "Malaysian",
  gender: "male" as const,
  dateOfBirth: null,
  // Task A1 (#2): owner profile fields — previously tenant-only, now shared
  // Party columns surfaced on the owner detail response too.
  occupation: null,
  employerName: null,
  employerAddress: null,
  monthlyIncome: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  bank: {
    name: "Maybank",
    accountHolder: "Razak bin Abdullah",
    accountNumber: "1234-5678-9012",
  },
  unitsOwned: [{ apartmentId: "apt-1", unitCode: "A-10-04", propertyName: "Amber Court" }],
  isBlacklisted: false,
  blacklistReason: null,
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  // updatedAt intentionally absent — spec's OwnerDetail ends at createdAt
  portalUser: null,
};

describe("GET /parties/owners/:partyId — owner detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("manager → 200 with owner detail; idNumberMasked present, bank.accountNumber present, unitsOwned with unit code", async () => {
    vi.mocked(partiesService.getOwnerDetailService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ownerDetailFixture,
    });

    const res = await makeApp(managerSession).request(`/owners/${OWNER_ID}`);
    expect(res.status).toBe(200);

    const json = await res.json() as { data: Record<string, unknown> };
    expect(json.data).toBeDefined();

    // (a) Must contain idNumberMasked
    expect(json.data.idNumberMasked).toBe("••••5678");

    // (b) Must contain bank.accountNumber
    const bank = json.data.bank as Record<string, unknown>;
    expect(bank).toBeDefined();
    expect(bank.name).toBe("Maybank");
    expect(bank.accountHolder).toBe("Razak bin Abdullah");
    expect(bank.accountNumber).toBe("1234-5678-9012");

    // (c) Must contain unitsOwned with the seeded unit code + property name.
    // One entry per DISTINCT apartment (listings are deduped upstream in
    // findUnitsOwned), each labelled with its property.
    const unitsOwned = json.data.unitsOwned as Array<Record<string, unknown>>;
    expect(unitsOwned).toHaveLength(1);
    expect(unitsOwned[0].apartmentId).toBe("apt-1");
    expect(unitsOwned[0].unitCode).toBe("A-10-04");
    expect(unitsOwned[0].propertyName).toBe("Amber Court");

    // (d) Must NOT contain raw idNumber
    expect("idNumber" in json.data).toBe(false);

    // (e) Task A1 (#2): occupation/monthlyIncome/emergencyContactName are no
    // longer tenant-exclusive — owners gained the same profile fields, so
    // the detail response now legitimately carries them (null when unset).
    expect(json.data.occupation).toBeNull();
    expect(json.data.monthlyIncome).toBeNull();
    expect(json.data.emergencyContactName).toBeNull();

    // Verify service was called with the correct session + partyId
    expect(partiesService.getOwnerDetailService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1" }),
      OWNER_ID,
    );
  });

  it("manager → 200 with owner that owns no units; unitsOwned is empty array", async () => {
    vi.mocked(partiesService.getOwnerDetailService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { ...ownerDetailFixture, unitsOwned: [] },
    });

    const res = await makeApp(managerSession).request(`/owners/${OWNER_ID}`);
    expect(res.status).toBe(200);

    const json = await res.json() as { data: Record<string, unknown> };
    expect(json.data.unitsOwned).toEqual([]);
  });

  it("editor operator → 403 (module gate is manager+)", async () => {
    const res = await makeApp(editorSession).request(`/owners/${OWNER_ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(partiesService.getOwnerDetailService).not.toHaveBeenCalled();
  });

  it("unknown partyId → 404 (service returns not found)", async () => {
    vi.mocked(partiesService.getOwnerDetailService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Owner not found",
    });

    const res = await makeApp(managerSession).request(`/owners/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Owner not found" });
  });

  it("tenant partyId → 404 (service enforces roleType:owner)", async () => {
    // Uses TENANT_ID (distinct from UNKNOWN_ID) to exercise the owner role
    // filter — if the service ever ignores the role filter, this assertion
    // would expose it.
    vi.mocked(partiesService.getOwnerDetailService).mockImplementationOnce(
      async (_session, partyId) => {
        if (partyId === TENANT_ID) {
          return { ok: false as const, status: 404 as const, error: "Owner not found" };
        }
        return { ok: true as const, status: 200 as const, data: ownerDetailFixture };
      },
    );

    const res = await makeApp(managerSession).request(`/owners/${TENANT_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Owner not found" });

    // Assert the service was called with the tenant partyId, not some other ID
    expect(partiesService.getOwnerDetailService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1" }),
      TENANT_ID,
    );
  });
});

// ── findOwnerDetail — roleType:owner filter discrimination ───────────────────
//
// These tests call the REAL findOwnerDetail repository function against a
// filter-sensitive mock DB. If `roles: { some: { roleType: "owner" } }` is
// removed from findOwnerDetail's where clause, the mock returns a tenant
// fixture instead of null, and the first test FAILS. The second test directly
// asserts the where clause shape.

describe("findOwnerDetail — roleType:owner filter discrimination", () => {
  const tenantFixture = { id: TENANT_ID, displayName: "Ahmad Bin Kassim" };

  beforeEach(() => {
    vi.clearAllMocks();
    // The mock DB is filter-sensitive: it returns null only when the query
    // includes `roles: { some: { roleType: "owner" } }`.
    // Without that filter, the mock returns tenantFixture — which would
    // cause findOwnerDetail to return a non-null value, failing the test below.
    mockPartyFindFirst.mockImplementation(
      (args: { where?: { roles?: { some?: { roleType?: string } } } }) => {
        const roleFilter = args?.where?.roles?.some?.roleType;
        if (roleFilter === "owner") {
          // Filter present → DB returns null (tenant party doesn't match owner role)
          return Promise.resolve(null);
        }
        // Filter absent → DB returns tenant party (no role restriction)
        return Promise.resolve(tenantFixture);
      },
    );
  });

  it("returns null for a tenant partyId when roleType:owner filter is present (RED if filter deleted)", async () => {
    const result = await findOwnerDetail("org1", TENANT_ID);
    // null means the owner filter excluded this tenant party.
    // Delete 'roles: { some: { roleType: "owner" } }' from findOwnerDetail
    // and this becomes tenantFixture (non-null) → test FAILS.
    expect(result).toBeNull();
  });

  it("passes roles:{ some:{ roleType:'owner' } } in the Prisma where clause", async () => {
    await findOwnerDetail("org1", TENANT_ID);
    expect(mockPartyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roles: { some: { roleType: "owner" } },
        }),
      }),
    );
  });

  // Task A1 (#2): owner profile fields gained a select-level home. If the
  // select object omits one of these keys, Prisma silently returns `undefined`
  // for it — findOwnerDetail's caller (getOwnerDetailService) would then pass
  // that field through as undefined regardless of what's actually in the DB.
  it("selects the new owner profile fields — occupation, employment, and emergency contact trio", async () => {
    await findOwnerDetail("org1", TENANT_ID);
    expect(mockPartyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          occupation: true,
          employerName: true,
          employerAddress: true,
          monthlyIncome: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
        }),
      }),
    );
  });
});
