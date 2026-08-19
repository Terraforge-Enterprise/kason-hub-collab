import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { PortalEnv, PortalSessionPayload } from "../../../auth/portal.auth.types";

const serviceMocks = vi.hoisted(() => ({ listPropertyTypesService: vi.fn() }));
vi.mock("../../../../inventory/property-types/property-types.service", () => serviceMocks);

import { portalPropertyTypesRoutes } from "../portal.property-types.routes";

function makeApp(session: PortalSessionPayload | null) {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => { if (session) c.set("session", session); await next(); });
  app.route("/", portalPropertyTypesRoutes);
  return app;
}

const agentSession: PortalSessionPayload = {
  userId: "u1", orgId: "o1", partyId: "p1", userType: "agent", role: "agent", iat: 0, absoluteExp: 0,
};

describe("portal property-types route", () => {
  it("returns slim shape id+name+sortOrder only", async () => {
    serviceMocks.listPropertyTypesService.mockResolvedValue([
      { id: "t1", organizationId: "o1", name: "Condominium", sortOrder: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { id: "t2", organizationId: "o1", name: "Landed", sortOrder: 2, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await makeApp(agentSession).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ id: "t1", name: "Condominium", sortOrder: 1 }, { id: "t2", name: "Landed", sortOrder: 2 }],
    });
  });
  it("forces activeOnly=true on the service", async () => {
    serviceMocks.listPropertyTypesService.mockClear();
    serviceMocks.listPropertyTypesService.mockResolvedValue([]);
    await makeApp(agentSession).request("/");
    expect(serviceMocks.listPropertyTypesService).toHaveBeenCalledWith("o1", { activeOnly: true });
  });
});
