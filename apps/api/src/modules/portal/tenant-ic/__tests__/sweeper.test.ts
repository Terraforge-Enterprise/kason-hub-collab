import { describe, it, expect, vi } from "vitest";
import { runTenantIcSweeper } from "../sweeper";

describe("runTenantIcSweeper", () => {
  it("acquires advisory lock, processes stale rows, marks expired — uses injected bucket NOT row.bucket", async () => {
    const acquired = { value: true };
    const prisma = {
      $queryRaw: vi.fn(async (strings: any) => {
        const sql = String(strings.raw?.[0] ?? "");
        if (sql.includes("pg_try_advisory_lock")) return [{ acquired: acquired.value }];
        if (sql.includes("FOR UPDATE SKIP LOCKED")) return [
          // rows carry the stale "tenant-ic" literal — the real object lives in listing-media
          { id: "r1", storageKey: "k1", bucket: "tenant-ic" },
          { id: "r2", storageKey: "k2", bucket: "tenant-ic" },
        ];
        if (sql.includes("pg_advisory_unlock")) return [{ released: true }];
        return [];
      }),
      pendingUpload: { update: vi.fn(async () => ({})) },
    } as any;
    const deleteObject = vi.fn(async () => undefined);
    // Pass the real bucket via deps.bucket — NOT inferred from row.bucket
    const result = await runTenantIcSweeper({ prisma, deleteObject, bucket: "listing-media" });
    expect(result.locked).toBe(false);
    expect(result.deleted).toBe(2);
    expect(result.errors).toBe(0);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    // The key assertion: deleteObject must use the injected bucket, not row.bucket
    expect(deleteObject).toHaveBeenCalledWith("listing-media", "k1");
    expect(deleteObject).toHaveBeenCalledWith("listing-media", "k2");
  });

  it("returns locked=true when advisory lock not acquired", async () => {
    const prisma = {
      $queryRaw: vi.fn(async (strings: any) => {
        const sql = String(strings.raw?.[0] ?? "");
        if (sql.includes("pg_try_advisory_lock")) return [{ acquired: false }];
        return [];
      }),
      pendingUpload: { update: vi.fn() },
    } as any;
    const result = await runTenantIcSweeper({ prisma, deleteObject: vi.fn(), bucket: "listing-media" });
    expect(result.locked).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it("treats bucket 404 as success (still marks expired)", async () => {
    const prisma = {
      $queryRaw: vi.fn(async (strings: any) => {
        const sql = String(strings.raw?.[0] ?? "");
        if (sql.includes("pg_try_advisory_lock")) return [{ acquired: true }];
        if (sql.includes("FOR UPDATE SKIP LOCKED")) return [
          { id: "r1", storageKey: "k1", bucket: "tenant-ic" },
        ];
        return [];
      }),
      pendingUpload: { update: vi.fn(async () => ({})) },
    } as any;
    const deleteObject = vi.fn(async () => { throw new Error("Object not found (404)"); });
    const result = await runTenantIcSweeper({ prisma, deleteObject, bucket: "listing-media" });
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
    expect(prisma.pendingUpload.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "expired" }) }),
    );
  });

  it("counts errors but doesn't throw on non-404 bucket failure", async () => {
    const prisma = {
      $queryRaw: vi.fn(async (strings: any) => {
        const sql = String(strings.raw?.[0] ?? "");
        if (sql.includes("pg_try_advisory_lock")) return [{ acquired: true }];
        if (sql.includes("FOR UPDATE SKIP LOCKED")) return [
          { id: "r1", storageKey: "k1", bucket: "tenant-ic" },
        ];
        return [];
      }),
      pendingUpload: { update: vi.fn() },
    } as any;
    const deleteObject = vi.fn(async () => { throw new Error("Permission denied (500)"); });
    const result = await runTenantIcSweeper({ prisma, deleteObject, bucket: "listing-media" });
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(1);
    expect(prisma.pendingUpload.update).not.toHaveBeenCalled();
  });
});
