import { describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
  requireBucket: vi.fn(() => "test-bucket"),
}));

import {
  RENOVATION_TMP_AGE_HOURS,
  RENOVATION_TMP_PATH_PREFIX,
  RENOVATION_TMP_PATH_MARKER,
  runRenovationClaimsSweeper,
} from "../sweeper";

describe("runRenovationClaimsSweeper", () => {
  const NOW = new Date("2026-04-27T12:00:00.000Z");

  function fakePrisma(acquired: boolean) {
    return {
      $queryRaw: vi.fn(async (strings: any) => {
        const sql = String(strings.raw?.[0] ?? "");
        if (sql.includes("pg_try_advisory_lock")) return [{ acquired }];
        if (sql.includes("pg_advisory_unlock")) return [{ released: true }];
        return [];
      }),
    } as any;
  }

  it("acquires advisory lock + deletes stale tmp objects > 24h", async () => {
    const prisma = fakePrisma(true);
    const tmpEntries = [
      // Older than 24h → should delete
      {
        storageKey: `${RENOVATION_TMP_PATH_PREFIX}org1${RENOVATION_TMP_PATH_MARKER}u1-q.pdf`,
        createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
      },
      {
        storageKey: `${RENOVATION_TMP_PATH_PREFIX}org1${RENOVATION_TMP_PATH_MARKER}u2-i.pdf`,
        createdAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
      },
      // Younger than 24h → must NOT delete
      {
        storageKey: `${RENOVATION_TMP_PATH_PREFIX}org1${RENOVATION_TMP_PATH_MARKER}u3.pdf`,
        createdAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000),
      },
    ];
    const deleteObject = vi.fn<(bucket: string, key: string) => Promise<void>>(
      async () => undefined,
    );
    const result = await runRenovationClaimsSweeper({
      prisma,
      listTmpObjects: async () => tmpEntries,
      deleteObject,
      now: () => NOW,
    });

    expect(result.locked).toBe(false);
    expect(result.deleted).toBe(2);
    expect(result.errors).toBe(0);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    // Both deletes target the tmp prefix and use the configured bucket
    // (resolved via requireBucket()).
    for (const call of deleteObject.mock.calls) {
      expect(call[0]).toBe("test-bucket");
      expect(call[1]).toContain(RENOVATION_TMP_PATH_MARKER);
    }
  });

  it("skips entries outside renovation-claims/.../tmp/ prefix", async () => {
    const prisma = fakePrisma(true);
    const entries = [
      // Wrong root prefix → skip
      {
        storageKey: `tenant-ic/org1/temp/u-q.pdf`,
        createdAt: new Date(NOW.getTime() - 100 * 60 * 60 * 1000),
      },
      // No /tmp/ marker → skip even though it's renovation-claims
      {
        storageKey: `${RENOVATION_TMP_PATH_PREFIX}org1/some-claim/u-q.pdf`,
        createdAt: new Date(NOW.getTime() - 100 * 60 * 60 * 1000),
      },
    ];
    const deleteObject = vi.fn(async () => undefined);
    const result = await runRenovationClaimsSweeper({
      prisma,
      listTmpObjects: async () => entries,
      deleteObject,
      now: () => NOW,
    });
    expect(result.deleted).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("returns locked=true when advisory lock not acquired", async () => {
    const prisma = fakePrisma(false);
    const result = await runRenovationClaimsSweeper({
      prisma,
      listTmpObjects: async () => [],
      deleteObject: vi.fn(),
      now: () => NOW,
    });
    expect(result.locked).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it("treats bucket 404 as success", async () => {
    const prisma = fakePrisma(true);
    const deleteObject = vi.fn(async () => {
      throw new Error("Object not found (404)");
    });
    const result = await runRenovationClaimsSweeper({
      prisma,
      listTmpObjects: async () => [
        {
          storageKey: `${RENOVATION_TMP_PATH_PREFIX}org1${RENOVATION_TMP_PATH_MARKER}u-q.pdf`,
          createdAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
        },
      ],
      deleteObject,
      now: () => NOW,
    });
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("counts errors but doesn't throw on non-404 failure", async () => {
    const prisma = fakePrisma(true);
    const deleteObject = vi.fn(async () => {
      throw new Error("Permission denied (500)");
    });
    const result = await runRenovationClaimsSweeper({
      prisma,
      listTmpObjects: async () => [
        {
          storageKey: `${RENOVATION_TMP_PATH_PREFIX}org1${RENOVATION_TMP_PATH_MARKER}u-q.pdf`,
          createdAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
        },
      ],
      deleteObject,
      now: () => NOW,
    });
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("constants reflect the 24h spec", () => {
    expect(RENOVATION_TMP_AGE_HOURS).toBe(24);
    expect(RENOVATION_TMP_PATH_PREFIX).toBe("renovation-claims/");
    expect(RENOVATION_TMP_PATH_MARKER).toBe("/tmp/");
  });
});
