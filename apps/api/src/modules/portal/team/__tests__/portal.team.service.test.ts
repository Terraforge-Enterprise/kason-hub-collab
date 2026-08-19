import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@kason/db";
import {
  getPortalTeam,
  getPortalUplineChain,
  getPortalDownlineSubtree,
  maskEmail,
  maskPhone,
} from "../portal.team.repository";

vi.mock("@kason/db", () => ({ getDb: vi.fn() }));

describe("masking helpers", () => {
  it("masks email preserving local part", () => {
    expect(maskEmail("alice@example.com")).toBe("alice@***");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
    expect(maskEmail("@foo.com")).toBe("***");
    expect(maskEmail("noat")).toBe("***");
  });

  it("masks phone showing last 4 digits only when >= 10 digits", () => {
    expect(maskPhone("+60 12-345 6789")).toBe("·· 6789");
    expect(maskPhone(null)).toBeNull();
  });

  it("drops all digits when phone is < 10 digits (no leak)", () => {
    expect(maskPhone("123")).toBe("··");
    expect(maskPhone("12345")).toBe("··");
  });
});

describe("getPortalTeam (single-query)", () => {
  const mockDb = { party: { findFirst: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDb as any);
  });

  it("returns null upline + empty downlines when I'm rootless with no direct downlines", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: "me", uplineId: null, upline: null, downlines: [],
    });
    const result = await getPortalTeam("me", "org1");
    expect(result.upline).toBeNull();
    expect(result.directDownlines).toHaveLength(0);
  });

  it("hides blacklisted upline from portal response", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: "me", uplineId: "up1",
      upline: { id: "up1", displayName: "Alice", agentLevel: "leader",
                primaryEmail: "alice@example.com", primaryPhone: "+60 12-345 6789",
                status: "blacklisted" },
      downlines: [],
    });
    const result = await getPortalTeam("me", "org1");
    expect(result.upline).toBeNull();
  });

  it("returns upline + direct downlines, masked", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: "me", uplineId: "up1",
      upline: { id: "up1", displayName: "Alice", agentLevel: "leader",
                primaryEmail: "alice@example.com", primaryPhone: "+60 12-345 6789",
                status: "active" },
      downlines: [
        { id: "d1", displayName: "Bob", agentLevel: "pre_leader",
          primaryEmail: "bob@e.com", primaryPhone: "+60 11-111 2222" },
      ],
    });
    const result = await getPortalTeam("me", "org1");
    expect(result.upline).toMatchObject({ id: "up1", emailMasked: "alice@***", phoneMasked: "·· 6789" });
    expect(result.directDownlines[0].emailMasked).toBe("bob@***");

    // Assert the Prisma call excludes blacklisted downlines in the nested select.
    expect(mockDb.party.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "me", organizationId: "org1" },
        select: expect.objectContaining({
          downlines: expect.objectContaining({
            where: { status: { not: "blacklisted" }, partyType: "agent" },
          }),
        }),
      })
    );
  });
});

describe("getPortalUplineChain", () => {
  const mockDb = {
    $queryRawUnsafe: vi.fn(),
    organization: { findUnique: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDb as any);
  });

  it("returns root-first chain with self flagged for a 4-deep new_agent", async () => {
    // Recursive CTE returns root-first (ORDER BY depth DESC). Simulate the
    // shape Postgres would produce for a chain:
    //   manager (depth 3) → leader (2) → pre_leader (1) → me/new_agent (0)
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([
      { id: "mgr",  displayName: "Farah",  agentLevel: "leader",     uplineId: null,     depth: 3 },
      { id: "ldr",  displayName: "Lina",   agentLevel: "leader",     uplineId: "mgr",    depth: 2 },
      { id: "pre",  displayName: "Priya",  agentLevel: "pre_leader", uplineId: "ldr",    depth: 1 },
      { id: "me",   displayName: "Rizal",  agentLevel: "new_agent",  uplineId: "pre",    depth: 0 },
    ]);
    mockDb.organization.findUnique.mockResolvedValueOnce({ id: "org1", name: "KAEN Properties" });

    const result = await getPortalUplineChain("me", "org1");
    expect(result).not.toBeNull();
    expect(result!.organization).toEqual({ id: "org1", name: "KAEN Properties" });
    expect(result!.chain).toHaveLength(4);
    // Root first → leaf last.
    expect(result!.chain.map((n) => n.id)).toEqual(["mgr", "ldr", "pre", "me"]);
    // Only the self leaf is flagged.
    expect(result!.chain.map((n) => n.isSelf)).toEqual([false, false, false, true]);
    // Levels preserved.
    expect(result!.chain[0].agentLevel).toBe("leader");
    expect(result!.chain[3].agentLevel).toBe("new_agent");
  });

  it("returns single-node chain (just self) when caller has no upline", async () => {
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([
      { id: "me", displayName: "Top", agentLevel: "leader", uplineId: null, depth: 0 },
    ]);
    mockDb.organization.findUnique.mockResolvedValueOnce({ id: "org1", name: "KAEN Properties" });

    const result = await getPortalUplineChain("me", "org1");
    expect(result!.chain).toHaveLength(1);
    expect(result!.chain[0]).toMatchObject({ id: "me", isSelf: true });
  });

  it("returns null when the party doesn't exist as an agent in this org", async () => {
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([]);
    const result = await getPortalUplineChain("ghost", "org1");
    expect(result).toBeNull();
    // Should not have bothered loading the org if the chain is empty.
    expect(mockDb.organization.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when org has been deleted (defensive — should never happen)", async () => {
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([
      { id: "me", displayName: "Me", agentLevel: "new_agent", uplineId: null, depth: 0 },
    ]);
    mockDb.organization.findUnique.mockResolvedValueOnce(null);
    const result = await getPortalUplineChain("me", "org1");
    expect(result).toBeNull();
  });
});

describe("getPortalDownlineSubtree", () => {
  const mockDb = { $queryRawUnsafe: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDb as any);
  });

  it("returns empty array for a new_agent with no team", async () => {
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([]);
    const res = await getPortalDownlineSubtree("me", "org1");
    expect(res.downlines).toHaveLength(0);
  });

  it("returns full subtree with depth + uplineId + full contact info", async () => {
    // Simulate a leader with two direct reports (depth 1), one of which
    // has a downline of its own (depth 2). Recursive CTE returns them
    // ordered by depth ASC then displayName ASC.
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([
      { id: "d1", displayName: "Alice", agentLevel: "pre_leader",
        primaryEmail: "alice@e.com", primaryPhone: "+60 11-111 1111",
        uplineId: "me", depth: 1 },
      { id: "d2", displayName: "Bob", agentLevel: "new_agent",
        primaryEmail: "bob@e.com", primaryPhone: "+60 22-222 2222",
        uplineId: "me", depth: 1 },
      { id: "d3", displayName: "Charlie", agentLevel: "new_agent",
        primaryEmail: "charlie@e.com", primaryPhone: "+60 33-333 3333",
        uplineId: "d1", depth: 2 },
    ]);

    const res = await getPortalDownlineSubtree("me", "org1");
    expect(res.downlines).toHaveLength(3);
    // Indirect downline (Charlie under Alice) is present — proves the
    // recursive CTE walked past depth 1.
    const charlie = res.downlines.find((n) => n.id === "d3");
    expect(charlie).toBeDefined();
    expect(charlie!.depth).toBe(2);
    expect(charlie!.uplineId).toBe("d1");
    // Full contact info preserved — Leaders need to actually call their team.
    expect(charlie!.primaryEmail).toBe("charlie@e.com");
    expect(charlie!.primaryPhone).toBe("+60 33-333 3333");
  });

  it("calls the recursive CTE with orgId then partyId in that order", async () => {
    mockDb.$queryRawUnsafe.mockResolvedValueOnce([]);
    await getPortalDownlineSubtree("me", "org1");
    const [, ...args] = mockDb.$queryRawUnsafe.mock.calls[0];
    expect(args).toEqual(["org1", "me"]);
  });
});
