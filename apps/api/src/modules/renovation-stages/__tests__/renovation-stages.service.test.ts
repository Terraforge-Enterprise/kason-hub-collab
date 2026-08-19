import { describe, it, expect, beforeEach, vi } from "vitest";

const repo = {
  list: vi.fn(),
  count: vi.fn(),
  findByKey: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
};

vi.mock("../renovation-stages.repository", () => ({
  renovationStagesRepository: () => repo,
}));

import {
  listStagesService,
  createStageService,
  updateStageService,
  reorderStagesService,
} from "../renovation-stages.service";

beforeEach(() => Object.values(repo).forEach((fn: any) => fn.mockReset()));

describe("listStagesService", () => {
  it("returns rows scoped to org", async () => {
    repo.list.mockResolvedValue([{ id: "s1", key: "demo", label: "Demolition" }]);
    const result = await listStagesService({ orgId: "org-1", includeArchived: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
    expect(repo.list).toHaveBeenCalledWith("org-1", false);
  });

  it("passes includeArchived through", async () => {
    repo.list.mockResolvedValue([]);
    await listStagesService({ orgId: "org-1", includeArchived: true });
    expect(repo.list).toHaveBeenCalledWith("org-1", true);
  });
});

describe("createStageService", () => {
  it("rejects when at the 25-stage cap", async () => {
    repo.count.mockResolvedValue(25);
    const result = await createStageService(
      { label: "New Stage" },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stage_cap_exceeded");
  });

  it("rejects on duplicate key (case-insensitive)", async () => {
    repo.count.mockResolvedValue(5);
    repo.findByKey.mockResolvedValue({ id: "existing", key: "demo", label: "Demolition" });
    const result = await createStageService(
      { label: "DEMO" },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_key");
    expect(repo.findByKey).toHaveBeenCalledWith("org-1", "demo");
  });

  it("creates with derived key", async () => {
    repo.count.mockResolvedValue(5);
    repo.findByKey.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: "new", key: "wiring_electrical", label: "Wiring & Electrical" });
    const result = await createStageService(
      { label: "Wiring & Electrical" },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", key: "wiring_electrical", label: "Wiring & Electrical" }),
    );
  });

  it("uses provided sortOrder if given, else falls back to current count", async () => {
    repo.count.mockResolvedValue(7);
    repo.findByKey.mockResolvedValue(null);
    repo.create.mockResolvedValue({ id: "x" });
    await createStageService({ label: "Foo" }, { orgId: "org-1", actorUserId: "u1" });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 7 }));

    repo.create.mockClear();
    await createStageService({ label: "Bar", sortOrder: 3 }, { orgId: "org-1", actorUserId: "u1" });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 3 }));
  });
});

describe("updateStageService", () => {
  it("404s if stage not in org", async () => {
    repo.findById.mockResolvedValue(null);
    const result = await updateStageService(
      "missing-id",
      { label: "x" },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stage_not_found");
  });

  it("updates when found", async () => {
    repo.findById.mockResolvedValue({ id: "s1" });
    repo.update.mockResolvedValue({ count: 1 });
    const result = await updateStageService(
      "s1",
      { label: "Renamed", archived: true },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    expect(repo.update).toHaveBeenCalledWith("org-1", "s1", { label: "Renamed", archived: true });
  });
});

describe("reorderStagesService", () => {
  it("rewrites every sortOrder in one batch", async () => {
    repo.reorder.mockResolvedValue({ count: 3 });
    const result = await reorderStagesService(
      { items: [{ id: "s1", sortOrder: 0 }, { id: "s2", sortOrder: 1 }, { id: "s3", sortOrder: 2 }] },
      { orgId: "org-1", actorUserId: "u1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.count).toBe(3);
    expect(repo.reorder).toHaveBeenCalledOnce();
  });
});
