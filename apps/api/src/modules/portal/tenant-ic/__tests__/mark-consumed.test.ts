// apps/api/src/modules/portal/tenant-ic/__tests__/mark-consumed.test.ts
import { describe, it, expect, vi } from "vitest";
import { markIcKeysConsumed } from "../tenant-ic.service";

describe("markIcKeysConsumed", () => {
  const mkTx = (foundCount: number) => ({
    pendingUpload: {
      updateMany: vi.fn(async () => ({ count: foundCount })),
    },
  }) as any;

  it("noop when keys array is empty", async () => {
    const tx = mkTx(0);
    const objectExists = vi.fn();
    await markIcKeysConsumed({
      tx, objectExists, keys: [],
      partyId: "p1", organizationId: "o1", claimItemId: "ci1",
    });
    expect(tx.pendingUpload.updateMany).not.toHaveBeenCalled();
    expect(objectExists).not.toHaveBeenCalled();
  });

  it("verifies each key exists in storage before promoting", async () => {
    const tx = mkTx(2);
    const objectExists = vi.fn(async () => true);
    await markIcKeysConsumed({
      tx, objectExists, keys: ["k1", "k2"],
      partyId: "p1", organizationId: "o1", claimItemId: "ci1",
    });
    expect(objectExists).toHaveBeenCalledTimes(2);
    expect(tx.pendingUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storageKey: { in: ["k1", "k2"] }, partyId: "p1", organizationId: "o1", status: "pending",
        }),
        data: expect.objectContaining({ status: "consumed", consumedClaimItemId: "ci1" }),
      }),
    );
  });

  it("throws when an uploaded key is missing from the bucket", async () => {
    const tx = mkTx(1);
    const objectExists = vi.fn(async (_bucket: string, key: string) => key !== "k2");
    await expect(
      markIcKeysConsumed({
        tx, objectExists, keys: ["k1", "k2"],
        partyId: "p1", organizationId: "o1", claimItemId: "ci1",
      }),
    ).rejects.toThrow(/not found in storage/i);
  });

  it("throws when updateMany row count != expected", async () => {
    const tx = mkTx(1);
    const objectExists = vi.fn(async () => true);
    await expect(
      markIcKeysConsumed({
        tx, objectExists, keys: ["k1", "k2"],
        partyId: "p1", organizationId: "o1", claimItemId: "ci1",
      }),
    ).rejects.toThrow(/count.mismatch|expected 2/i);
  });
});
