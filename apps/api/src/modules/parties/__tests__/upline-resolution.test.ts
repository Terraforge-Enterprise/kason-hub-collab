import { describe, expect, it, vi } from "vitest";
import { findValidUpline, rankOf } from "../upline-resolution";

describe("rankOf", () => {
  it("returns 1 for new_agent", () => {
    expect(rankOf("new_agent")).toBe(1);
  });
  it("returns 2 for pre_leader", () => {
    expect(rankOf("pre_leader")).toBe(2);
  });
  it("returns 3 for leader", () => {
    expect(rankOf("leader")).toBe(3);
  });
  it("returns POSITIVE_INFINITY for null (staff)", () => {
    expect(rankOf(null)).toBe(Number.POSITIVE_INFINITY);
  });
  it("returns 0 for unknown level strings (defensive)", () => {
    expect(rankOf("super_leader_galactic")).toBe(0);
  });
});

type FakeNode = {
  id: string;
  uplineId: string | null;
  agentLevel: string | null;
  status: string;
};

function makeTx(nodesById: Record<string, FakeNode>) {
  return {
    party: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return nodesById[where.id] ?? null;
      }),
    },
  } as never;
}

describe("findValidUpline", () => {
  it("returns null when startUplineId is null", async () => {
    const tx = makeTx({});
    expect(await findValidUpline(tx, "o1", null, 2)).toBe(null);
  });

  it("returns the first ancestor whose rank >= target", async () => {
    const tx = makeTx({
      B: { id: "B", uplineId: "A", agentLevel: "pre_leader", status: "active" },
      A: { id: "A", uplineId: null, agentLevel: "leader", status: "active" },
    });
    expect(await findValidUpline(tx, "o1", "B", 3)).toBe("A");
  });

  it("walks past inactive ancestors", async () => {
    const tx = makeTx({
      B: { id: "B", uplineId: "A", agentLevel: "leader", status: "inactive" },
      A: { id: "A", uplineId: null, agentLevel: "leader", status: "active" },
    });
    expect(await findValidUpline(tx, "o1", "B", 3)).toBe("A");
  });

  it("walks past blacklisted ancestors", async () => {
    const tx = makeTx({
      B: { id: "B", uplineId: "A", agentLevel: "leader", status: "blacklisted" },
      A: { id: "A", uplineId: null, agentLevel: "leader", status: "active" },
    });
    expect(await findValidUpline(tx, "o1", "B", 3)).toBe("A");
  });

  it("terminates at staff (agentLevel = null) as natural ceiling", async () => {
    const tx = makeTx({
      B: { id: "B", uplineId: "S", agentLevel: "pre_leader", status: "active" },
      S: { id: "S", uplineId: null, agentLevel: null, status: "active" },
    });
    expect(await findValidUpline(tx, "o1", "B", 3)).toBe("S");
  });

  it("returns null when no eligible ancestor exists (walks to root)", async () => {
    const tx = makeTx({
      B: { id: "B", uplineId: "A", agentLevel: "new_agent", status: "active" },
      A: { id: "A", uplineId: null, agentLevel: "new_agent", status: "active" },
    });
    expect(await findValidUpline(tx, "o1", "B", 3)).toBe(null);
  });

  it("defends against cycles by returning null instead of looping", async () => {
    const tx = makeTx({
      B: { id: "B", uplineId: "A", agentLevel: "pre_leader", status: "active" },
      A: { id: "A", uplineId: "B", agentLevel: "pre_leader", status: "active" },
    });
    expect(await findValidUpline(tx, "o1", "B", 3)).toBe(null);
  });

  it("returns null when the ID cannot be resolved (broken FK)", async () => {
    const tx = makeTx({});
    expect(await findValidUpline(tx, "o1", "ghost-id", 2)).toBe(null);
  });
});
