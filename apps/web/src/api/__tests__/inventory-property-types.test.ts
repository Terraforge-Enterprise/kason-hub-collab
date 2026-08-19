import { describe, it, expect, vi } from "vitest";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiFetch: apiFetchMock }));

import { listPropertyTypes, getPropertyTypeUsage } from "@/api/inventory-property-types";

// NOTE: apiFetchMock.mockReset() is called at the top of each `it()` below
// (inline) rather than in a shared `beforeEach`. Verified empirically: with
// this vitest/tinyspy version, resetting the SAME mock from a `beforeEach`
// hook (a separate task boundary) immediately before a test that does
// `mockRejectedValue()` + `expect(...).rejects.toThrow()` causes the
// rejection to surface as an unhandled error instead of being caught by the
// assertion — a harness timing quirk, not a defect in listPropertyTypes
// (confirmed: identical production code passes cleanly when the reset isn't
// hook-boundary-separated from the assertion). Resetting inline sidesteps it
// while preserving identical per-test mock isolation.
describe("inventory-property-types api client", () => {
  it("listPropertyTypes({activeOnly:true}) builds the query string and unwraps data", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ data: [{ id: "t1", name: "Condominium" }] });
    const out = await listPropertyTypes({ activeOnly: true });
    expect(apiFetchMock).toHaveBeenCalledWith("/inventory/property-types?activeOnly=true");
    expect(out).toEqual([{ id: "t1", name: "Condominium" }]);
  });
  it("listPropertyTypes() with no opts omits the query string", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ data: [] });
    await listPropertyTypes();
    expect(apiFetchMock).toHaveBeenCalledWith("/inventory/property-types");
  });
  it("getPropertyTypeUsage(id) hits the usage endpoint", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ data: { propertyCount: 2 } });
    const out = await getPropertyTypeUsage("t1");
    expect(apiFetchMock).toHaveBeenCalledWith("/inventory/property-types/t1/usage");
    expect(out).toEqual({ propertyCount: 2 });
  });
  it("propagates a rejected apiFetch (no swallow)", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockRejectedValue(new Error("boom"));
    await expect(listPropertyTypes()).rejects.toThrow("boom");
  });
});
