import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { SessionPayload } from "../../../lib/auth";
import { partiesRoutes } from "../parties.routes";
import * as partiesService from "../parties.service";
import { findTenantDetail } from "../parties.repository";

// ── DB-level mock (used only by the findTenantDetail describe block below) ──
const mockPartyFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => ({
    party: { findFirst: mockPartyFindFirst },
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
  getTenantDetailService: vi.fn(),
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

const TENANT_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const OWNER_ID  = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";
const UNKNOWN_ID = "c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a99";

const tenantDetailFixture = {
  id: TENANT_ID,
  displayName: "Ahmad Bin Kassim",
  legalName: "Ahmad Kassim",
  primaryEmail: "ahmad@example.com",
  primaryPhone: "60123456789",
  formattedPhone: "+60 12-345 6789",
  whatsappPhone: "60123456789",
  idType: "nric",
  idNumberMasked: "••••1234",
  nationality: "Malaysian",
  gender: "male",
  dateOfBirth: "1990-01-01T00:00:00.000Z",
  occupation: "Engineer",
  employerName: "Acme Sdn Bhd",
  employerAddress: "123 Jalan Bukit",
  monthlyIncome: "5000.00",
  emergencyContactName: "Siti Binti Kassim",
  emergencyContactPhone: "60198765432",
  emergencyContactRelation: "spouse",
  isBlacklisted: false,
  blacklistReason: null,
  status: "active",
  createdAt: "2024-01-01T00:00:00.000Z",
  // updatedAt intentionally absent — spec's TenantDetail ends at createdAt
  hasActiveTenancy: false,
  portalUser: null,
};

describe("GET /parties/tenants/:partyId — tenant detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("manager → 200 with tenant detail; idNumberMasked present, no raw idNumber key", async () => {
    vi.mocked(partiesService.getTenantDetailService).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: tenantDetailFixture,
    });

    const res = await makeApp(managerSession).request(`/tenants/${TENANT_ID}`);
    expect(res.status).toBe(200);

    const json = await res.json() as { data: Record<string, unknown> };
    expect(json.data).toBeDefined();

    // (a) Must contain idNumberMasked and required tenant fields
    expect(json.data.idNumberMasked).toBe("••••1234");
    expect(json.data.occupation).toBe("Engineer");
    expect(json.data.monthlyIncome).toBe("5000.00");
    expect(json.data.emergencyContactName).toBe("Siti Binti Kassim");

    // (a) Must NOT contain raw idNumber
    expect("idNumber" in json.data).toBe(false);

    // Verify service was called with the correct session + partyId
    expect(partiesService.getTenantDetailService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1" }),
      TENANT_ID,
    );
  });

  it("editor operator → 403 (module gate is manager+)", async () => {
    const res = await makeApp(editorSession).request(`/tenants/${TENANT_ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(partiesService.getTenantDetailService).not.toHaveBeenCalled();
  });

  it("missing session → 401", async () => {
    const res = await makeApp(null).request(`/tenants/${TENANT_ID}`);
    expect(res.status).toBe(401);
    expect(partiesService.getTenantDetailService).not.toHaveBeenCalled();
  });

  it("unknown partyId → 404 (service returns not found)", async () => {
    vi.mocked(partiesService.getTenantDetailService).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Tenant not found",
    });

    const res = await makeApp(managerSession).request(`/tenants/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Tenant not found" });
  });

  it("owner/agent partyId → 404 (service enforces roleType:tenant)", async () => {
    // Uses a DISTINCT OWNER_ID (not TENANT_ID) so that this test exercises a
    // different code path than the "unknown partyId" case above.
    // The mock returns 404 specifically for OWNER_ID — if the route ever called
    // the service with the wrong ID this assertion would expose it.
    vi.mocked(partiesService.getTenantDetailService).mockImplementationOnce(
      async (_session, partyId) => {
        if (partyId === OWNER_ID) {
          return { ok: false as const, status: 404 as const, error: "Tenant not found" };
        }
        return { ok: true as const, status: 200 as const, data: tenantDetailFixture };
      },
    );

    const res = await makeApp(managerSession).request(`/tenants/${OWNER_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Tenant not found" });

    // Assert the service was called with the owner partyId, not some other ID
    expect(partiesService.getTenantDetailService).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org1" }),
      OWNER_ID,
    );
  });
});

// ── findTenantDetail — roleType:tenant filter discrimination ─────────────────
//
// These tests call the REAL findTenantDetail repository function against a
// filter-sensitive mock DB. If `roles: { some: { roleType: "tenant" } }` is
// removed from findTenantDetail's where clause, the mock returns an owner
// fixture instead of null, and the first test FAILS. The second test directly
// asserts the where clause shape.

describe("findTenantDetail — roleType:tenant filter discrimination", () => {
  const ownerFixture = { id: OWNER_ID, displayName: "Dato Razak" };

  beforeEach(() => {
    vi.clearAllMocks();
    // The mock DB is filter-sensitive: it returns null only when the query
    // includes `roles: { some: { roleType: "tenant" } }`.
    // Without that filter, the mock returns the ownerFixture — which would
    // cause findTenantDetail to return a non-null value, failing the test below.
    mockPartyFindFirst.mockImplementation(
      (args: { where?: { roles?: { some?: { roleType?: string } } } }) => {
        const roleFilter = args?.where?.roles?.some?.roleType;
        if (roleFilter === "tenant") {
          // Filter present → DB returns null (owner party doesn't match)
          return Promise.resolve(null);
        }
        // Filter absent → DB returns owner party (no role restriction)
        return Promise.resolve(ownerFixture);
      },
    );
  });

  it("returns null for an owner partyId when roleType:tenant filter is present (RED if filter deleted)", async () => {
    const result = await findTenantDetail("org1", OWNER_ID);
    // null means the tenant filter excluded this owner party.
    // Delete 'roles: { some: { roleType: "tenant" } }' from findTenantDetail
    // and this becomes ownerFixture (non-null) → test FAILS.
    expect(result).toBeNull();
  });

  it("passes roles:{ some:{ roleType:'tenant' } } in the Prisma where clause", async () => {
    await findTenantDetail("org1", OWNER_ID);
    expect(mockPartyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roles: { some: { roleType: "tenant" } },
        }),
      }),
    );
  });
});
