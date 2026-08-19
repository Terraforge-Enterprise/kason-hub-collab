import { describe, it, expect, beforeEach, vi } from "vitest";

const txMock = {
  project: { findFirst: vi.fn(), updateMany: vi.fn() },
  projectVerificationTransition: { create: vi.fn() },
};

const dbMock = {
  $transaction: (fn: (tx: any) => Promise<any>) => fn(txMock),
  project: { findMany: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => dbMock,
}));

import {
  verifyProjectService,
  rejectProjectService,
  listPendingVerificationService,
} from "../projects.verification.service";

beforeEach(() => {
  Object.values(txMock).forEach((m: any) => Object.values(m).forEach((fn: any) => fn.mockReset()));
  dbMock.project.findMany.mockReset();
});

describe("verifyProjectService", () => {
  it("flips unverified -> active and appends transition", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", status: "unverified" });
    txMock.project.updateMany.mockResolvedValue({ count: 1 });
    txMock.projectVerificationTransition.create.mockResolvedValue({ id: "t1" });
    const result = await verifyProjectService("p1", { orgId: "o1", actorUserId: "u1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("active");
    expect(txMock.project.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", organizationId: "o1", status: "unverified" },
      data: expect.objectContaining({ status: "active", verifiedById: "u1" }),
    });
    expect(txMock.projectVerificationTransition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "o1",
        projectId: "p1",
        fromStatus: "unverified",
        toStatus: "active",
        changedById: "u1",
      }),
    });
  });

  it("404s if project not in org", async () => {
    txMock.project.findFirst.mockResolvedValue(null);
    const result = await verifyProjectService("p1", { orgId: "o1", actorUserId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("project_not_found");
  });

  it("409s if project not in unverified state", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", status: "active" });
    const result = await verifyProjectService("p1", { orgId: "o1", actorUserId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("project_not_unverified");
  });
});

describe("rejectProjectService", () => {
  it("archives + appends note transition", async () => {
    txMock.project.findFirst.mockResolvedValue({ id: "p1", status: "unverified" });
    txMock.project.updateMany.mockResolvedValue({ count: 1 });
    txMock.projectVerificationTransition.create.mockResolvedValue({ id: "t1" });
    const result = await rejectProjectService("p1", "Duplicate of existing project", { orgId: "o1", actorUserId: "u1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("archived");
    expect(txMock.project.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", organizationId: "o1", status: "unverified" },
      data: { status: "archived" },
    });
    expect(txMock.projectVerificationTransition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toStatus: "archived",
        note: "Duplicate of existing project",
      }),
    });
  });

  it("404s if project not in org", async () => {
    txMock.project.findFirst.mockResolvedValue(null);
    const result = await rejectProjectService("p1", "x", { orgId: "o1", actorUserId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("project_not_found");
  });
});

describe("listPendingVerificationService", () => {
  it("returns rows with status='unverified' for the org", async () => {
    dbMock.project.findMany.mockResolvedValue([
      { id: "p1", name: "Tower X", developer: "Dev Y", status: "unverified" },
    ]);
    const result = await listPendingVerificationService("o1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
    expect(dbMock.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "o1", status: "unverified" } }),
    );
  });
});
