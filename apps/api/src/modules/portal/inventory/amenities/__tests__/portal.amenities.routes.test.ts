import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../../auth/portal.auth.types";

const serviceMocks = vi.hoisted(() => ({
  listAmenitiesService: vi.fn(),
}));

vi.mock("../../../../inventory/amenities/amenities.service", () => serviceMocks);

import { portalAmenitiesRoutes } from "../portal.amenities.routes";

function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.route("/", portalAmenitiesRoutes);
  return app;
}

const agentSession: PortalSessionPayload = {
  userId: "u1",
  orgId: "o1",
  partyId: "p1",
  userType: "agent",
  role: "agent",
  iat: 0,
  absoluteExp: 0,
};

describe("portal amenities route", () => {
  it("returns slim shape: id+name+sortOrder only (no isActive/timestamps)", async () => {
    serviceMocks.listAmenitiesService.mockResolvedValue([
      { id: "a1", organizationId: "o1", name: "Gym", sortOrder: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { id: "a2", organizationId: "o1", name: "Pool", sortOrder: 2, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await makeApp(agentSession).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: [
        { id: "a1", name: "Gym", sortOrder: 1 },
        { id: "a2", name: "Pool", sortOrder: 2 },
      ],
    });
  });

  it("forces activeOnly=true on the service (agent never sees inactive amenities)", async () => {
    serviceMocks.listAmenitiesService.mockClear();
    serviceMocks.listAmenitiesService.mockResolvedValue([]);
    await makeApp(agentSession).request("/");
    expect(serviceMocks.listAmenitiesService).toHaveBeenCalledWith("o1", { activeOnly: true });
  });
});
