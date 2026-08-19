import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = {
  taTier: {
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock)),
};
vi.mock("@kason/db", () => ({ getDb: () => dbMock }));

import {
  createTaTierService,
  updateTaTierService,
  deleteTaTierService,
} from "../ta-tiers.service";

const session = {
  orgId: "org-1",
  userId: "user-1",
  role: "admin" as const,
  userType: "operator" as const,
};

describe("ta-tiers.service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createTaTierService inserts a new tier + activity log", async () => {
    dbMock.taTier.findFirst.mockResolvedValue(null);
    dbMock.taTier.create.mockResolvedValue({
      id: "tt-1",
      tier: 3,
      rentalMin: "3001.00",
      companyMinimum: "450.00",
    });

    const res = await createTaTierService(session, {
      tier: 3,
      rentalMin: "3001.00",
      companyMinimum: "450.00",
    });
    expect(res.ok).toBe(true);
    expect(dbMock.activityLog.create).toHaveBeenCalled();
  });

  it("createTaTierService rejects duplicate tier number (409)", async () => {
    dbMock.taTier.findFirst.mockResolvedValue({ id: "existing" });
    const res = await createTaTierService(session, {
      tier: 1,
      rentalMin: "0",
      companyMinimum: "216",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("updateTaTierService updates with optimistic-concurrency check", async () => {
    dbMock.taTier.updateMany.mockResolvedValue({ count: 1 });
    dbMock.taTier.findFirst.mockResolvedValue({
      id: "tt-1",
      tier: 1,
      rentalMin: "0.00",
      companyMinimum: "250.00",
      updatedAt: new Date(),
    });

    const res = await updateTaTierService(session, "tt-1", {
      companyMinimum: "250.00",
      updatedAt: new Date().toISOString(),
    });
    expect(res.ok).toBe(true);
  });

  it("updateTaTierService returns 409 on stale updatedAt", async () => {
    dbMock.taTier.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateTaTierService(session, "tt-1", {
      companyMinimum: "250.00",
      updatedAt: new Date().toISOString(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("deleteTaTierService removes the row + activity log", async () => {
    dbMock.taTier.findFirst.mockResolvedValue({ id: "tt-1", tier: 3 });
    dbMock.taTier.delete.mockResolvedValue({ id: "tt-1" });

    const res = await deleteTaTierService(session, "tt-1");
    expect(res.ok).toBe(true);
    expect(dbMock.taTier.delete).toHaveBeenCalled();
    expect(dbMock.activityLog.create).toHaveBeenCalled();
  });
});
