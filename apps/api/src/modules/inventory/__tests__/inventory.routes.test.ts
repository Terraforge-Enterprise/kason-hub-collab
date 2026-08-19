import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { InventorySession } from "../inventory.types";

// Mock the service layer so these tests exercise ROUTING (registration order,
// q parsing, response shape), not the DB. The repository query is covered by
// the integration path.
const { searchApartmentsServiceMock, getApartmentsByPropertyServiceMock } = vi.hoisted(() => ({
  searchApartmentsServiceMock: vi.fn(),
  getApartmentsByPropertyServiceMock: vi.fn(),
}));

vi.mock("../inventory.service", () => ({
  searchApartmentsService: searchApartmentsServiceMock,
  getApartmentsByPropertyService: getApartmentsByPropertyServiceMock,
  // remaining named imports the route module pulls in — no-op stubs
  createPropertyService: vi.fn(),
  createUnitService: vi.fn(),
  createUnitsBatchService: vi.fn(),
  getInventoryPropertiesService: vi.fn(),
  getInventoryPropertyByIdService: vi.fn(),
  getInventorySummaryService: vi.fn(),
  getInventoryUnitByIdService: vi.fn(),
  getInventoryUnitsService: vi.fn(),
  updatePropertyService: vi.fn(),
  updateUnitService: vi.fn(),
}));

const session = { orgId: "o1", userId: "u1", role: "manager", userType: "operator" } as unknown as InventorySession;

function makeApp() {
  const app = new Hono<{ Variables: { session: InventorySession } }>();
  app.use("*", async (c, next) => { c.set("session", session); await next(); });
  return app;
}

describe("inventory routes — apartment search (label→id picker)", () => {
  it("GET /apartments?q= → 200, passes parsed q to the service, returns { data }", async () => {
    searchApartmentsServiceMock.mockClear();
    searchApartmentsServiceMock.mockResolvedValue([{ id: "a1", unitCode: "A-08-02", propertyName: "Bangsar South" }]);
    const { inventoryRoutes } = await import("../inventory.routes");
    const app = makeApp(); app.route("/", inventoryRoutes);

    const res = await app.request("/apartments?q=A-08");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: "a1", unitCode: "A-08-02", propertyName: "Bangsar South" }] });
    expect(searchApartmentsServiceMock).toHaveBeenCalledWith(expect.anything(), { q: "A-08" });
  });

  // Regression guard: the new exact "/apartments" must not shadow the longer
  // "/apartments/by-property/:propertyId" sub-resource.
  it("GET /apartments/by-property/:id still routes to its own service, NOT the search", async () => {
    searchApartmentsServiceMock.mockClear();
    getApartmentsByPropertyServiceMock.mockClear();
    getApartmentsByPropertyServiceMock.mockResolvedValue({ ok: true, status: 200, data: [] });
    const { inventoryRoutes } = await import("../inventory.routes");
    const app = makeApp(); app.route("/", inventoryRoutes);

    const res = await app.request("/apartments/by-property/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(200);
    expect(getApartmentsByPropertyServiceMock).toHaveBeenCalled();
    expect(searchApartmentsServiceMock).not.toHaveBeenCalled();
  });
});
