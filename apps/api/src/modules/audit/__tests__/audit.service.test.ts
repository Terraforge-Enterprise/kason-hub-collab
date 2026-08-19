import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../audit.repository", () => ({
  findAuditRows: vi.fn(async () => ({ rows: [], total: 0 })),
  purgeOlderThan: vi.fn(async () => ({ count: 0 })),
}));

import { listAudit, purgeExpiredAudit } from "../audit.service";
import { findAuditRows, purgeOlderThan } from "../audit.repository";
import { runtimeConfig } from "../../../lib/runtime-config";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("listAudit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects editor with 'forbidden'", async () => {
    await expect(
      listAudit({ orgId: "org1", role: "editor", filters: {}, page: 1, pageSize: 10 }),
    ).rejects.toThrow(/forbidden/i);
  });

  it("manager passes through with org-scoped where", async () => {
    await listAudit({
      orgId: "org1",
      role: "manager",
      filters: { entityType: "X" },
      page: 1,
      pageSize: 10,
    });
    expect(findAuditRows).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", entityType: "X" }),
      1,
      10,
    );
  });

  it("admin passes through (admin > manager)", async () => {
    await listAudit({
      orgId: "org1",
      role: "admin",
      filters: {},
      page: 1,
      pageSize: 50,
    });
    expect(findAuditRows).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1" }),
      1,
      50,
    );
  });

  it("applies entityId, actorUserId, action filters when provided", async () => {
    await listAudit({
      orgId: "org1",
      role: "manager",
      filters: {
        entityType: "claim",
        entityId: "11111111-1111-1111-1111-111111111111",
        actorUserId: "22222222-2222-2222-2222-222222222222",
        action: "approved",
      },
      page: 2,
      pageSize: 25,
    });
    const where = (findAuditRows as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(where).toMatchObject({
      organizationId: "org1",
      entityType: "claim",
      entityId: "11111111-1111-1111-1111-111111111111",
      actorUserId: "22222222-2222-2222-2222-222222222222",
      action: "approved",
    });
    expect(findAuditRows).toHaveBeenCalledWith(expect.anything(), 2, 25);
  });

  it("includes createdAt range when from/to provided", async () => {
    await listAudit({
      orgId: "org1",
      role: "manager",
      filters: { from: "2026-04-01T00:00:00.000Z", to: "2026-04-23T00:00:00.000Z" },
      page: 1,
      pageSize: 10,
    });
    const where = (findAuditRows as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as {
      createdAt: { gte: Date; lte: Date };
    };
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
    expect((where.createdAt.gte as Date).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect((where.createdAt.lte as Date).toISOString()).toBe("2026-04-23T00:00:00.000Z");
  });

  it("includes only createdAt.gte when only 'from' provided", async () => {
    await listAudit({
      orgId: "org1",
      role: "manager",
      filters: { from: "2026-04-01T00:00:00.000Z" },
      page: 1,
      pageSize: 10,
    });
    const where = (findAuditRows as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as {
      createdAt: { gte?: Date; lte?: Date };
    };
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeUndefined();
  });

  it("omits createdAt when neither from nor to provided", async () => {
    await listAudit({
      orgId: "org1",
      role: "manager",
      filters: {},
      page: 1,
      pageSize: 10,
    });
    const where = (findAuditRows as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as {
      createdAt?: unknown;
    };
    expect(where.createdAt).toBeUndefined();
  });
});

describe("purgeExpiredAudit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("computes cutoff = now - auditRetentionDays * 24h (from runtime config)", async () => {
    const retentionDays = runtimeConfig.limits.auditRetentionDays;
    const before = Date.now();
    await purgeExpiredAudit();
    const after = Date.now();
    expect(purgeOlderThan).toHaveBeenCalledTimes(1);
    const cutoff = (purgeOlderThan as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Date;
    const expectedMinCutoff = before - retentionDays * DAY_MS;
    const expectedMaxCutoff = after - retentionDays * DAY_MS;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMinCutoff);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMaxCutoff);
  });

  it("honors explicit retentionDays override", async () => {
    const before = Date.now();
    await purgeExpiredAudit(30);
    const cutoff = (purgeOlderThan as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Date;
    const expectedMinCutoff = before - 30 * DAY_MS - 100;
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 30 * DAY_MS + 100);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMinCutoff);
  });
});
