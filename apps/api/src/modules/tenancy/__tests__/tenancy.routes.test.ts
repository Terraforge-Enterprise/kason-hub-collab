/**
 * Route-level test for POST /tenancies — T9 review Finding 1.
 *
 * createTenancyService returns a structured 409 body (`code` for every 409,
 * plus `incumbent` for UNIT_HAS_ACTIVE_TENANCY) but the route was forwarding
 * ONLY `{ error: result.error }`, dropping `code`/`incumbent` on the floor.
 * The sibling POST /:id/convert-to-tenancy route (reservations/routes.ts)
 * already spreads these through — this test proves POST /tenancies does the
 * same, mirroring that pattern.
 *
 * Service layer is mocked (no DB) so this runs in the standard suite.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { TenancySession } from "../tenancy.types";
import { tenancyRoutes } from "../tenancy.routes";
import { createTenancyService } from "../tenancy.service";

vi.mock("../tenancy.service", () => ({
  createLandlordTenancyService: vi.fn(),
  createTenancyService: vi.fn(),
  getLandlordTenanciesService: vi.fn().mockResolvedValue([]),
  getTenanciesService: vi.fn().mockResolvedValue([]),
  renewTenancyService: vi.fn(),
  updateLandlordTenancyStatusService: vi.fn(),
  updateTenancyService: vi.fn(),
}));

function makeApp(session: TenancySession) {
  const app = new Hono<{ Variables: { session: TenancySession } }>();
  app.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/", tenancyRoutes);
  return app;
}

const SESSION: TenancySession = { userId: "u1", orgId: "o1", role: "admin" };

const VALID_BODY = {
  propertyId: "11111111-1111-4111-8111-111111111111",
  unitId: "22222222-2222-4222-8222-222222222222",
  tenantPartyId: "33333333-3333-4333-8333-333333333333",
  tenancyCode: "TEN-ROUTE-TEST",
  startDate: "2026-01-01",
  monthlyRentAmount: "2000",
};

function postTenancy(app: ReturnType<typeof makeApp>) {
  return app.request("/tenancies", {
    method: "POST",
    body: JSON.stringify(VALID_BODY),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /tenancies — forwards structured 409 fields (T9 review Finding 1)", () => {
  it("forwards code + incumbent on 409 UNIT_HAS_ACTIVE_TENANCY", async () => {
    const incumbentEndDate = new Date("2026-11-30T00:00:00Z");
    vi.mocked(createTenancyService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "UNIT_HAS_ACTIVE_TENANCY",
      error: "Unit already has an active tenancy",
      incumbent: { tenantName: "Tenant A (incumbent)", endDate: incumbentEndDate },
    } as never);

    const res = await postTenancy(makeApp(SESSION));

    expect(res.status).toBe(409);
    const json = (await res.json()) as {
      error: string;
      code?: string;
      incumbent?: { tenantName: string; endDate: string | null };
    };
    expect(json.error).toBe("Unit already has an active tenancy");
    expect(json.code).toBe("UNIT_HAS_ACTIVE_TENANCY");
    expect(json.incumbent).toEqual({
      tenantName: "Tenant A (incumbent)",
      endDate: incumbentEndDate.toISOString(),
    });
  });

  it("forwards code (no incumbent field) on the race-backstop 409 CONCURRENT_ACTIVE_TENANCY", async () => {
    vi.mocked(createTenancyService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "CONCURRENT_ACTIVE_TENANCY",
      error: "Another active tenancy was created for this unit — retry.",
    } as never);

    const res = await postTenancy(makeApp(SESSION));

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; code?: string; incumbent?: unknown };
    expect(json.code).toBe("CONCURRENT_ACTIVE_TENANCY");
    expect(json.incumbent).toBeUndefined();
  });

  it("forwards code on 409 UNIT_HAS_NO_OWNER", async () => {
    vi.mocked(createTenancyService).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "UNIT_HAS_NO_OWNER",
      error: "This unit has no assigned owner. Assign an owner before creating a tenancy.",
    } as never);

    const res = await postTenancy(makeApp(SESSION));

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; code?: string };
    expect(json.code).toBe("UNIT_HAS_NO_OWNER");
  });
});
