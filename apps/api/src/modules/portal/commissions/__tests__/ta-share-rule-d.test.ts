import { describe, it, expect, vi } from "vitest";
import { validateRuleD } from "../claim-validator";
import { isClaimError, type ClaimErrorData } from "../claim-errors";

const baseArgs = {
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  claimType: "tenant_portion",
  items: [
    {
      propertyId: "11111111-1111-4111-8111-111111111111",
      unitCode: "A-08-02",
      roomType: "Master",
      moveInDate: new Date("2026-04-20"),
      taSharePercent: "50",
    },
  ],
};

describe("validateRuleD (Σ taShare ≤ 100 on deal key, tenant-side only)", () => {
  it("passes when existing + proposed ≤ 100 (existing 50, proposed 50 → total 100)", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ sum: "50" }]),
    } as never;

    await expect(
      validateRuleD({ ...baseArgs, db }),
    ).resolves.toBeUndefined();

    expect((db as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects with ta_share_sum_invalid when existing + proposed > 100 (existing 80, proposed 30)", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ sum: "80" }]),
    } as never;

    await expect(
      validateRuleD({ ...baseArgs, db, items: [{ ...baseArgs.items[0], taSharePercent: "30" }] }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!isClaimError(err)) return false;
      expect(err.code).toBe("ta_share_sum_invalid");
      const data = err.data as ClaimErrorData<"ta_share_sum_invalid">;
      expect(data.existingPct).toBe("80.00");
      expect(data.proposedPct).toBe("30.00");
      expect(data.totalPct).toBe("110.00");
      expect(data.key.propertyId).toBe("11111111-1111-4111-8111-111111111111");
      expect(data.key.unitCode).toBe("A-08-02");
      expect(data.key.roomType).toBe("Master");
      expect(data.key.moveInDate).toBe("2026-04-20");
      return true;
    });
  });

  it("skips entirely for listing_portion (mock never called)", async () => {
    const db = {
      $queryRaw: vi.fn(),
    } as never;

    await expect(
      validateRuleD({ ...baseArgs, db, claimType: "listing_portion" }),
    ).resolves.toBeUndefined();

    expect((db as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });

  it("skips items with null taSharePercent", async () => {
    const db = {
      $queryRaw: vi.fn(),
    } as never;

    await expect(
      validateRuleD({
        ...baseArgs,
        db,
        items: [{ ...baseArgs.items[0], taSharePercent: null }],
      }),
    ).resolves.toBeUndefined();

    expect((db as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });

  it("skips items with taSharePercent <= 0", async () => {
    const db = {
      $queryRaw: vi.fn(),
    } as never;

    await expect(
      validateRuleD({
        ...baseArgs,
        db,
        items: [{ ...baseArgs.items[0], taSharePercent: "0" }],
      }),
    ).resolves.toBeUndefined();

    expect((db as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw).not.toHaveBeenCalled();
  });

  it("counts 'amended' status — SQL includes amended in the status filter", async () => {
    // Seed an amended claim with 80%; proposing 30 → total 110 → reject.
    const queryMock = vi.fn().mockResolvedValueOnce([{ sum: "80" }]);
    const db = { $queryRaw: queryMock } as never;

    await expect(
      validateRuleD({ ...baseArgs, db, items: [{ ...baseArgs.items[0], taSharePercent: "30" }] }),
    ).rejects.toSatisfy((err: unknown) => isClaimError(err) && err.code === "ta_share_sum_invalid");

    // Verify the SQL template includes 'amended' somewhere in its bound args or raw string.
    const call = queryMock.mock.calls[0];
    // call[0] is the TemplateStringsArray; join its parts and check for 'amended'.
    const sqlParts: string[] = call[0] as string[];
    const sqlText = sqlParts.join(" ");
    expect(sqlText).toMatch(/amended/);
  });

  it("applies to tenant_listing_portion (not just tenant_portion)", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ sum: "80" }]),
    } as never;

    await expect(
      validateRuleD({
        ...baseArgs,
        db,
        claimType: "tenant_listing_portion",
        items: [{ ...baseArgs.items[0], taSharePercent: "30" }],
      }),
    ).rejects.toSatisfy((err: unknown) => isClaimError(err) && err.code === "ta_share_sum_invalid");
  });
});
