// apps/api/src/modules/portal/tenant-ic/__tests__/delete-upload.test.ts
import { describe, it, expect, vi } from "vitest";
import { deleteUpload } from "../tenant-ic.service";

describe("deleteUpload", () => {
  const mkSession = () => ({ partyId: "party-1", orgId: "org-1", role: "agent" });
  const mkPrisma = (row: any | null) => ({
    pendingUpload: {
      findFirst: vi.fn(async () => row),
      update: vi.fn(async () => row),
    },
  }) as any;

  it("deletes from the injected bucket, NOT from row.bucket", async () => {
    const row = {
      id: "pu-1", storageKey: "tenant-ic/org-1/party-1/temp/x/front-y.jpg",
      // row.bucket is the stale literal key-prefix, not the real Supabase bucket
      bucket: "tenant-ic", status: "pending",
    };
    const prisma = mkPrisma(row);
    const deleteObject = vi.fn(async () => undefined);
    // The object physically lives in the configured bucket ("listing-media"),
    // not in row.bucket ("tenant-ic"). We inject the real bucket via deps.
    await deleteUpload({
      prisma, deleteObject, session: mkSession(),
      storageKey: row.storageKey,
      bucket: "listing-media",
    });
    expect(deleteObject).toHaveBeenCalledWith("listing-media", row.storageKey);
    expect(prisma.pendingUpload.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pu-1" }, data: expect.objectContaining({ status: "deleted" }) }),
    );
  });

  it("returns 404-shape error when row not found OR not owned", async () => {
    const prisma = mkPrisma(null);
    const deleteObject = vi.fn();
    await expect(
      deleteUpload({ prisma, deleteObject, session: mkSession(), storageKey: "tenant-ic/org-1/party-1/temp/x/front-y.jpg", bucket: "listing-media" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("returns 409 when row is already consumed", async () => {
    const row = {
      id: "pu-1", storageKey: "tenant-ic/org-1/party-1/temp/x/front-y.jpg",
      bucket: "tenant-ic", status: "consumed",
    };
    const prisma = {
      pendingUpload: { findFirst: vi.fn(async () => row), update: vi.fn() },
    } as any;
    const deleteObject = vi.fn();
    await expect(
      deleteUpload({ prisma, deleteObject, session: mkSession(), storageKey: row.storageKey, bucket: "listing-media" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("rejects storage key whose path doesn't begin with the org+party (defence in depth)", async () => {
    const row = {
      id: "pu-1", storageKey: "tenant-ic/other-org/other-party/temp/x/front-y.jpg",
      bucket: "tenant-ic", status: "pending",
    };
    const prisma = mkPrisma(row);
    await expect(
      deleteUpload({ prisma, deleteObject: vi.fn(), session: mkSession(), storageKey: row.storageKey, bucket: "listing-media" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
