import { describe, it, expect, vi } from "vitest";
import { findPartyByNaturalKey, findTenancyForRow } from "../repository";

describe("findPartyByNaturalKey", () => {
  it("returns null when both phone and idNumber absent (no query issued)", async () => {
    const findFirst = vi.fn();
    const tx = { party: { findFirst } } as unknown as Parameters<typeof findPartyByNaturalKey>[0];
    expect(await findPartyByNaturalKey(tx, "org1", null, null)).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("builds org-scoped OR with phone and idNumber", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "p1", displayName: "X", primaryPhone: "60123", idNumber: "880101" });
    const tx = { party: { findFirst } } as unknown as Parameters<typeof findPartyByNaturalKey>[0];
    const res = await findPartyByNaturalKey(tx, "org1", "60123", "880101");
    expect(res?.id).toBe("p1");
    const arg = (findFirst.mock.calls[0] as unknown[])[0] as { where: { organizationId: string; OR: unknown[] } };
    expect(arg.where.organizationId).toBe("org1");
    expect(arg.where.OR).toEqual([{ primaryPhone: "60123" }, { idNumber: "880101" }]);
  });
});

describe("findTenancyForRow", () => {
  it("queries org+party+unit+startDate", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "t1" });
    const tx = { tenancy: { findFirst } } as unknown as Parameters<typeof findTenancyForRow>[0];
    const start = new Date("2025-02-01");
    const res = await findTenancyForRow(tx, "org1", "party1", "unit1", start);
    expect(res?.id).toBe("t1");
    const arg = (findFirst.mock.calls[0] as unknown[])[0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ organizationId: "org1", tenantPartyId: "party1", unitId: "unit1", startDate: start });
  });
});
