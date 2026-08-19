import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateAgentService } from "../parties.service";

type FakeNode = {
  id: string;
  uplineId: string | null;
  agentLevel: string | null;
  status: string;
  displayName: string;
  organizationId: string;
};

function nodesById(...rows: FakeNode[]): Record<string, FakeNode> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

function makeTx(store: Record<string, FakeNode>) {
  return {
    party: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store[where.id] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: { uplineId: string; status: string } }) => {
        return Object.values(store).filter(
          (n) => n.uplineId === where.uplineId && n.status === where.status,
        );
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { uplineId: string | null } }) => {
        const cur = store[where.id];
        store[where.id] = { ...cur, uplineId: data.uplineId };
        return store[where.id];
      }),
    },
    activityLog: { create: vi.fn(async () => undefined) },
  };
}

vi.mock("@kason/db", () => {
  const db = {
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db.__tx)),
    __tx: null as unknown,
    activityLog: { create: vi.fn() },
  };
  return { getDb: () => db };
});

vi.mock("../parties.repository", () => ({
  findRole: vi.fn(async () => ({ id: "role-1" })),
  updateParty: vi.fn(async () => ({ updatedAt: new Date("2026-05-24T00:00:00Z") })),
  updatePartyTx: vi.fn(async () => ({ updatedAt: new Date("2026-05-24T00:00:00Z") })),
  validateUplineChange: vi.fn(async () => ({ ok: true })),
}));

const session = { userId: "u1", orgId: "o1", role: "admin" as const };

describe("updateAgentService — promotion bubbles past lower-rank upline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bubbles Priya (newly leader) past Farah (pre_leader) to Sarah (leader)", async () => {
    const store = nodesById(
      { id: "priya", uplineId: "farah", agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "farah", uplineId: "sarah", agentLevel: "pre_leader", status: "active", displayName: "Farah", organizationId: "o1" },
      { id: "sarah", uplineId: null, agentLevel: "leader", status: "active", displayName: "Sarah", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as unknown as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "priya",
      agentLevel: "leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.priya.uplineId).toBe("sarah");
    expect(result.restructured).toEqual([
      expect.objectContaining({
        agentId: "priya",
        oldUplineId: "farah",
        newUplineId: "sarah",
      }),
    ]);
  });
});

describe("updateAgentService — promotion edge cases", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bubbles two hops when both ancestors are lower rank", async () => {
    const store = nodesById(
      { id: "p", uplineId: "b", agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "b", uplineId: "a", agentLevel: "pre_leader", status: "active", displayName: "Beth", organizationId: "o1" },
      { id: "a", uplineId: "s", agentLevel: "pre_leader", status: "active", displayName: "Aliya", organizationId: "o1" },
      { id: "s", uplineId: null, agentLevel: null, status: "active", displayName: "Sarah", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "p",
      agentLevel: "leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.p.uplineId).toBe("s");
    expect(result.restructured?.[0]).toEqual(
      expect.objectContaining({ agentId: "p", oldUplineId: "b", newUplineId: "s", newUplineLevel: null }),
    );
  });

  it("terminates at staff (agentLevel=null) without bubbling further", async () => {
    const store = nodesById(
      { id: "p", uplineId: "b", agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "b", uplineId: "s", agentLevel: "pre_leader", status: "active", displayName: "Beth", organizationId: "o1" },
      { id: "s", uplineId: null, agentLevel: null, status: "active", displayName: "Sarah", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    await updateAgentService(session as never, {
      partyId: "p",
      agentLevel: "leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(store.p.uplineId).toBe("s");
  });

  it("no restructure when current upline is already at-or-above new rank", async () => {
    const store = nodesById(
      { id: "p", uplineId: "a", agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "a", uplineId: null, agentLevel: "leader", status: "active", displayName: "Aliya", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "p",
      agentLevel: "leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restructured).toBeUndefined();
    expect(store.p.uplineId).toBe("a");
  });

  it("no restructure when agent has no upline", async () => {
    const store = nodesById(
      { id: "p", uplineId: null, agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "p",
      agentLevel: "leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restructured).toBeUndefined();
  });
});

describe("updateAgentService — demotion symmetric", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bubbles inverted downlines past the demoted agent", async () => {
    // Farah demoted leader → pre_leader; Priya is leader under Farah.
    // Sarah is staff (above). Priya should bubble to Sarah.
    const store = nodesById(
      { id: "farah", uplineId: "sarah", agentLevel: "pre_leader", status: "active", displayName: "Farah", organizationId: "o1" },
      { id: "priya", uplineId: "farah", agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "sarah", uplineId: null, agentLevel: null, status: "active", displayName: "Sarah", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "farah",
      agentLevel: "pre_leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.priya.uplineId).toBe("sarah");
    expect(result.restructured).toEqual([
      expect.objectContaining({ agentId: "priya", oldUplineId: "farah", newUplineId: "sarah" }),
    ]);
  });

  it("reassigns multiple inverted downlines on a single demotion", async () => {
    const store = nodesById(
      { id: "farah", uplineId: "sarah", agentLevel: "pre_leader", status: "active", displayName: "Farah", organizationId: "o1" },
      { id: "priya", uplineId: "farah", agentLevel: "leader", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "aliya", uplineId: "farah", agentLevel: "leader", status: "active", displayName: "Aliya", organizationId: "o1" },
      { id: "sarah", uplineId: null, agentLevel: null, status: "active", displayName: "Sarah", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "farah",
      agentLevel: "pre_leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restructured).toHaveLength(2);
    expect(store.priya.uplineId).toBe("sarah");
    expect(store.aliya.uplineId).toBe("sarah");
  });

  it("no restructure when no downlines are inverted", async () => {
    const store = nodesById(
      { id: "farah", uplineId: "sarah", agentLevel: "pre_leader", status: "active", displayName: "Farah", organizationId: "o1" },
      { id: "priya", uplineId: "farah", agentLevel: "new_agent", status: "active", displayName: "Priya", organizationId: "o1" },
      { id: "sarah", uplineId: null, agentLevel: null, status: "active", displayName: "Sarah", organizationId: "o1" },
    );
    const { getDb } = await import("@kason/db");
    const db = getDb() as never as { __tx: unknown };
    db.__tx = makeTx(store);

    const result = await updateAgentService(session as never, {
      partyId: "farah",
      agentLevel: "pre_leader",
      updatedAt: "2026-05-24T00:00:00Z",
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restructured).toBeUndefined();
    expect(store.priya.uplineId).toBe("farah");
  });
});
