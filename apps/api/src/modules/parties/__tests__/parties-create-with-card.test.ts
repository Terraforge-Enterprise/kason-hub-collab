/**
 * Integration test for parties.createAgentService when a `title` is supplied.
 *
 * Boundary under test: the parties layer must, in ONE atomic transaction,
 * create the Party (via createAgentTx) AND mint an approved AgentCardVersion
 * (via createApprovedFromAdminTx). Both writes share the same `tx` client;
 * if either fails, the whole thing rolls back.
 *
 * We mock the repository's createAgentTx and the agent-cards module's
 * createApprovedFromAdminTx so we can assert call ordering + tx threading
 * without touching Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: vi.fn(() => mockDb),
}));

vi.mock("../parties.repository", () => ({
  // Only the calls actually exercised by createAgentService on the title
  // path need real mocks; everything else is unused here.
  createAgent: vi.fn(),
  createAgentTx: vi.fn(),
  // Stubs needed because parties.service imports the whole barrel.
  listOwners: vi.fn(),
  listTenants: vi.fn(),
  findRole: vi.fn(),
  findPartyByIdNumber: vi.fn(),
  createOwner: vi.fn(),
  createTenant: vi.fn(),
  updateParty: vi.fn(),
  listAgents: vi.fn(),
  listAssignableMembers: vi.fn(),
  blacklistAgentTx: vi.fn(),
  reactivateAgentTx: vi.fn(),
  deactivateAgentTx: vi.fn(),
  activateAgentTx: vi.fn(),
  getAgentDetail: vi.fn(),
  revokePortalAccessTx: vi.fn(),
  getAgentHierarchy: vi.fn(),
  getAncestors: vi.fn(),
  getDirectDownlines: vi.fn(),
  getSubtree: vi.fn(),
  setUplineTx: vi.fn(),
  validateUplineChange: vi.fn(),
}));

vi.mock("../../../lib/storage", () => ({
  createSignedDownloadUrl: vi.fn(),
}));

vi.mock("../../../lib/auth", () => ({
  hashPassword: vi.fn(),
}));

vi.mock("../../../lib/auth-status-cache", () => ({
  authStatusCache: { delete: vi.fn() },
}));

// Mock the agent-cards module — keep the real OrgCardSettingsNotConfiguredError
// so the service's `instanceof` check still works.
vi.mock("../../agent-cards", async () => {
  const actual = await vi.importActual<typeof import("../../agent-cards")>(
    "../../agent-cards",
  );
  return {
    ...actual,
    createApprovedFromAdminTx: vi.fn(),
  };
});

import { createAgentService } from "../parties.service";
import * as repo from "../parties.repository";
import * as agentCards from "../../agent-cards";

const session = { userId: "user-1", orgId: "org-1", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction immediately invokes the callback with mockDb as tx
  mockDb.$transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
});

describe("createAgentService — with title (E-Namecard integration)", () => {
  it("creating an agent with a title also creates an approved card in the SAME transaction", async () => {
    vi.mocked(repo.createAgentTx).mockResolvedValueOnce({
      id: "party-1",
      displayName: "Agent A",
      primaryEmail: "agent@example.com",
      primaryPhone: "+60123456789",
    } as never);
    vi.mocked(agentCards.createApprovedFromAdminTx).mockResolvedValueOnce({
      versionId: "version-1",
      publicToken: "abcdefghijABCDEFGHIJaa", // 22 chars, shape-valid
      expiresAt: new Date("2026-08-05T00:00:00Z"),
    });

    const res = await createAgentService(session, {
      displayName: "Agent A",
      primaryEmail: "agent@example.com",
      primaryPhone: "+60123456789",
      title: "Sales Manager",
    } as never);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBe("party-1");

    // ONE outer transaction.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);

    // createAgentTx ran with the SAME tx client we handed to the callback,
    // and crucially WITHOUT the `title` field (which is a card-only field
    // not on the Party schema).
    expect(repo.createAgentTx).toHaveBeenCalledTimes(1);
    const [agentTxArg, agentOrgArg, agentDataArg] = vi.mocked(
      repo.createAgentTx,
    ).mock.calls[0]!;
    expect(agentTxArg).toBe(mockDb);
    expect(agentOrgArg).toBe("org-1");
    expect(agentDataArg).not.toHaveProperty("title");
    expect(agentDataArg.displayName).toBe("Agent A");

    // createApprovedFromAdminTx ran on the SAME tx with the right shape.
    expect(agentCards.createApprovedFromAdminTx).toHaveBeenCalledTimes(1);
    const [cardTxArg, cardOpts] = vi.mocked(
      agentCards.createApprovedFromAdminTx,
    ).mock.calls[0]!;
    expect(cardTxArg).toBe(mockDb);
    expect(cardOpts).toMatchObject({
      organizationId: "org-1",
      partyId: "party-1",
      displayName: "Agent A",
      title: "Sales Manager",
      primaryEmail: "agent@example.com",
      primaryPhone: "+60123456789",
      submittedById: "user-1",
      actorRole: "admin",
    });
  });

  it("trims the title and treats whitespace-only as no-title (no card created)", async () => {
    vi.mocked(repo.createAgent).mockResolvedValueOnce({ id: "party-2" } as never);

    const res = await createAgentService(session, {
      displayName: "Agent B",
      title: "   ",
    } as never);

    expect(res.ok).toBe(true);
    // Falls through to the no-title path (uses repo.createAgent, NOT createAgentTx).
    expect(repo.createAgent).toHaveBeenCalledTimes(1);
    expect(repo.createAgentTx).not.toHaveBeenCalled();
    expect(agentCards.createApprovedFromAdminTx).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("when title is omitted, falls through to the legacy single-write path", async () => {
    vi.mocked(repo.createAgent).mockResolvedValueOnce({ id: "party-3" } as never);

    const res = await createAgentService(session, {
      displayName: "Agent C",
    } as never);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBe("party-3");
    expect(repo.createAgent).toHaveBeenCalledTimes(1);
    expect(agentCards.createApprovedFromAdminTx).not.toHaveBeenCalled();
  });

  it("returns 409 when the org's card settings are not configured", async () => {
    vi.mocked(repo.createAgentTx).mockResolvedValueOnce({
      id: "party-4",
      displayName: "Agent D",
      primaryEmail: null,
      primaryPhone: null,
    } as never);
    vi.mocked(agentCards.createApprovedFromAdminTx).mockRejectedValueOnce(
      new agentCards.OrgCardSettingsNotConfiguredError(),
    );

    const res = await createAgentService(session, {
      displayName: "Agent D",
      title: "Realtor",
    } as never);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error).toMatch(/not configured/i);
    }
  });

  it("propagates non-business errors from inside the transaction", async () => {
    vi.mocked(repo.createAgentTx).mockRejectedValueOnce(
      new Error("db connection lost"),
    );

    await expect(
      createAgentService(session, {
        displayName: "Agent E",
        title: "Realtor",
      } as never),
    ).rejects.toThrow("db connection lost");
  });
});
