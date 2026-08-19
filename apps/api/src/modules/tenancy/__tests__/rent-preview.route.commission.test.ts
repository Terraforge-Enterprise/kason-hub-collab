import { describe, it, expect } from "vitest";
import { tenancyRoutes } from "../tenancy.routes";

// Minimal session middleware so the pure GET runs. rent-preview does no DB read.
function client() {
  return {
    get: (path: string) =>
      tenancyRoutes.request(path, {}, { session: { orgId: "o", userId: "u", role: "admin" } }),
  };
}

describe("rent-preview route — commission", () => {
  it("returns a commission object when firstMonthIsCommission=true", async () => {
    const res = await client().get("/tenancies/rent-preview?monthlyRent=3000&startDate=2026-08-01&firstMonthIsCommission=true&commissionSstBearer=kaen");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commission).toMatchObject({ month: "2026-08", commissionAmount: 3000, sstAmount: 240, sstBearer: "kaen" });
  });

  it("commission is null when the param is absent", async () => {
    const res = await client().get("/tenancies/rent-preview?monthlyRent=3000&startDate=2026-08-01");
    const body = await res.json();
    expect(body.commission).toBeNull();
    expect(body.data.month).toBe("2026-08");
  });

  it("commission is null for a no-full-month range", async () => {
    const res = await client().get("/tenancies/rent-preview?monthlyRent=3000&startDate=2026-08-15&endDate=2026-09-20&firstMonthIsCommission=true");
    const body = await res.json();
    expect(body.commission).toBeNull();
  });

  it("returns a commission object with sstBearer=owner on the owner-bearer path", async () => {
    const res = await client().get("/tenancies/rent-preview?monthlyRent=3000&startDate=2026-08-01&firstMonthIsCommission=true&commissionSstBearer=owner");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commission).toMatchObject({ sstBearer: "owner", commissionAmount: 3000, sstAmount: 240 });
  });

  it("defaults an unrecognized commissionSstBearer value to owner (safe default)", async () => {
    const res = await client().get("/tenancies/rent-preview?monthlyRent=3000&startDate=2026-08-01&firstMonthIsCommission=true&commissionSstBearer=KAEN");
    const body = await res.json();
    expect(body.commission.sstBearer).toBe("owner");
  });

  it("commission is null when firstMonthIsCommission is not the exact string \"true\"", async () => {
    const res = await client().get("/tenancies/rent-preview?monthlyRent=3000&startDate=2026-08-01&firstMonthIsCommission=1");
    const body = await res.json();
    expect(body.commission).toBeNull();
  });
});
