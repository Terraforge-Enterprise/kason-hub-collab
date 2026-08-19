import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PortalEnv } from "../../auth/portal.auth.types";

const repoMock = {
  list: vi.fn(),
};

vi.mock("../../../renovation-stages/renovation-stages.repository", () => ({
  renovationStagesRepository: () => repoMock,
}));

import { portalRenovationStagesRoutes } from "../portal.renovation-stages.routes";

function appWithAgent() {
  const app = new Hono<PortalEnv>();
  app.use("*", async (c, next) => {
    c.set("session", {
      userId: "u1",
      userType: "agent",
      partyId: "p1",
      orgId: "org-1",
      role: "editor",
      iat: 0,
      absoluteExp: 9999999999,
    });
    await next();
  });
  app.route("/renovation/stages", portalRenovationStagesRoutes);
  return app;
}

beforeEach(() => repoMock.list.mockReset());

describe("portalRenovationStagesRoutes", () => {
  it("GET / returns active stages trimmed for portal", async () => {
    repoMock.list.mockResolvedValue([
      {
        id: "s1",
        key: "demo",
        label: "Demolition",
        sortOrder: 1,
        archived: false,
        organizationId: "org-1",
        createdAt: new Date(),
        updatedAt: new Date(),
        description: null,
      },
    ]);

    const app = appWithAgent();
    const res = await app.request("/renovation/stages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { id: "s1", key: "demo", label: "Demolition", sortOrder: 1 },
    ]);
    expect(repoMock.list).toHaveBeenCalledWith("org-1", false);
  });
});
