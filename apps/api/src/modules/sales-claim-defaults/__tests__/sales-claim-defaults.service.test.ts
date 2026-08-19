import { describe, it, expect, beforeEach, vi } from "vitest";

const repo = {
  findByOrgAndAppliesTo: vi.fn(),
  upsert: vi.fn(),
};

vi.mock("../sales-claim-defaults.repository", () => ({
  salesClaimDefaultsRepository: () => repo,
}));

import { getDefaultsService, upsertDefaultsService } from "../sales-claim-defaults.service";

beforeEach(() => Object.values(repo).forEach((fn: any) => fn.mockReset()));

describe("getDefaultsService", () => {
  it("returns the default with its splits when found", async () => {
    repo.findByOrgAndAppliesTo.mockResolvedValue({
      id: "d1",
      defaultSplits: [{ id: "s1", roleLabel: "Sales Commission", splitType: "percent", splitValue: 100 }],
    });
    const result = await getDefaultsService({ orgId: "org-1", appliesTo: "__catchall__" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.defaultSplits).toHaveLength(1);
  });

  it("404s when not found", async () => {
    repo.findByOrgAndAppliesTo.mockResolvedValue(null);
    const result = await getDefaultsService({ orgId: "org-1", appliesTo: "__catchall__" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("defaults_not_found");
  });
});

describe("upsertDefaultsService", () => {
  it("calls repo.upsert with normalized payload", async () => {
    repo.upsert.mockResolvedValue({ id: "d1" });
    const result = await upsertDefaultsService(
      {
        appliesTo: "__catchall__",
        commissionType: "percent_of_purchase",
        commissionValue: 2,
        paymentType: "full",
        splits: [
          { roleLabel: "Sales Commission", splitType: "percent", splitValue: 100, sortOrder: 0 },
        ],
      },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    expect(repo.upsert).toHaveBeenCalledWith(
      "org-1",
      "u1",
      expect.objectContaining({
        appliesTo: "__catchall__",
        commissionType: "percent_of_purchase",
        commissionValue: 2,
        paymentType: "full",
        notes: null,
        splits: expect.arrayContaining([
          expect.objectContaining({ roleLabel: "Sales Commission", splitValue: 100 }),
        ]),
      }),
    );
  });
});
