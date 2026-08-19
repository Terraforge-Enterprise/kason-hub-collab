import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentHierarchyService, getAncestorsService, getDownlinesService } from "../parties.service";
import * as repo from "../parties.repository";

vi.mock("../parties.repository", () => ({
  getAgentHierarchy: vi.fn(),
  getAncestors: vi.fn(),
  getDirectDownlines: vi.fn(),
  getSubtree: vi.fn(),
}));

describe("getAgentHierarchyService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns flat list with direct downline counts scoped to org", async () => {
    (repo.getAgentHierarchy as any).mockResolvedValueOnce([
      { id: "a1", displayName: "Alice", agentLevel: "leader", status: "active",
        uplineId: null, directDownlineCount: 2 },
      { id: "b1", displayName: "Bob", agentLevel: "pre_leader", status: "active",
        uplineId: "a1", directDownlineCount: 1 },
    ]);

    const result = await getAgentHierarchyService({ orgId: "org1", userId: "u1" } as any);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "a1", directDownlineCount: 2 });
    expect(repo.getAgentHierarchy).toHaveBeenCalledWith("org1", false);
  });

  it("forwards includeDeactivated=true to the repository", async () => {
    (repo.getAgentHierarchy as any).mockResolvedValueOnce([]);
    await getAgentHierarchyService(
      { orgId: "org1", userId: "u1" } as any,
      { includeDeactivated: true },
    );
    expect(repo.getAgentHierarchy).toHaveBeenCalledWith("org1", true);
  });
});

describe("getAncestorsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns root-first chain up to and including the agent", async () => {
    (repo.getAncestors as any).mockResolvedValueOnce([
      { id: "a1", displayName: "Alice", agentLevel: "leader", uplineId: null },
      { id: "b1", displayName: "Bob", agentLevel: "pre_leader", uplineId: "a1" },
    ]);

    const result = await getAncestorsService({ orgId: "org1" } as any, "b1");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a1");
    expect(result[1].id).toBe("b1");
  });

  it("returns just the agent when upline is null", async () => {
    (repo.getAncestors as any).mockResolvedValueOnce([
      { id: "a1", displayName: "Alice", agentLevel: "leader", uplineId: null },
    ]);

    const result = await getAncestorsService({ orgId: "org1" } as any, "a1");
    expect(result).toHaveLength(1);
  });
});

describe("getDownlinesService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("depth=1 returns direct downlines only", async () => {
    (repo.getDirectDownlines as any).mockResolvedValueOnce([
      { id: "b1", displayName: "Bob", agentLevel: "pre_leader", status: "active", uplineId: "a1" },
    ]);
    const result = await getDownlinesService({ orgId: "org1" } as any, "a1", "1");
    expect(result).toHaveLength(1);
    expect(repo.getDirectDownlines).toHaveBeenCalledWith("org1", "a1");
  });

  it("depth=all returns transitive subtree", async () => {
    (repo.getSubtree as any).mockResolvedValueOnce([
      { id: "b1", displayName: "Bob", agentLevel: "pre_leader", status: "active", uplineId: "a1" },
      { id: "e1", displayName: "Eve", agentLevel: "new_agent", status: "active", uplineId: "b1" },
    ]);
    const result = await getDownlinesService({ orgId: "org1" } as any, "a1", "all");
    expect(result).toHaveLength(2);
    expect(repo.getSubtree).toHaveBeenCalledWith("org1", "a1");
  });
});
