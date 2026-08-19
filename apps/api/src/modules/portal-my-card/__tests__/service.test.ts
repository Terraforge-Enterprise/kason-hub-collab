// Unit tests for the portal-my-card service. Mirrors the agent-cards
// service test pattern (vi.mock @kason/db, single shared mockDb that
// also acts as the tx client so all writes within $transaction are
// recorded for inspection).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
  organizationCardSettings: { findUnique: vi.fn() },
  agentCardVersion: {
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  party: { findUnique: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: () => mockDb,
}));

// Mock the agent-cards notifications module so the existing tests don't
// have to wire up Notification/User/Party reads. Notification behavior is
// covered separately in agent-cards/notifications.test.ts and in the
// dedicated wiring test below ("submitMyCard fires manager fan-out").
vi.mock("../../agent-cards/notifications", () => ({
  notifyManagersOfPendingCard: vi.fn(async () => undefined),
  notifyAgentReconfirmCapReached: vi.fn(async () => undefined),
}));

import {
  getMyCard,
  submitMyCard,
  reconfirmMyCard,
  withdrawMyCard,
  MyCardNotFoundError,
  MyCardPendingExistsError,
  OrgCardSettingsNotConfiguredError,
  ReconfirmCapReachedError,
  ReconfirmNotInWindowError,
  ReconfirmRateLimitedError,
} from "../service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PARTY_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const ACTIVE_VERSION_ID = "44444444-4444-4444-4444-444444444444";
const PENDING_VERSION_ID = "55555555-5555-5555-5555-555555555555";

const ACTOR_OPTS = {
  actorUserId: USER_ID,
  actorRole: "agent",
  organizationId: ORG_ID,
};

const baseSettings = {
  id: "66666666-6666-6666-6666-666666666666",
  organizationId: ORG_ID,
  agencyName: "Agency",
  agencyLicense: "LIC123",
  agencyPhone: null,
  agencyFax: null,
  addressLine1: "Line 1",
  addressLine2: null,
  addressLine3: null,
  addressLine4: null,
  cardExpiryMonths: 3,
  isConfigured: true,
  logoKey: null,
  updatedAt: new Date("2026-05-05T00:00:00Z"),
};

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVE_VERSION_ID,
    organizationId: ORG_ID,
    partyId: PARTY_ID,
    displayName: "Agent A",
    title: "Sales Manager",
    primaryEmail: "agent@example.com",
    primaryPhone: "+60123456789",
    status: "approved",
    submittedById: USER_ID,
    submittedByType: "agent",
    reviewedById: USER_ID,
    reviewedAt: new Date("2026-04-01T00:00:00Z"),
    rejectionReason: null,
    publicToken: "active-public-token-22ch",
    approvedAt: new Date("2026-04-01T00:00:00Z"),
    expiresAt: new Date("2026-07-01T00:00:00Z"),
    reconfirmCount: 0,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PENDING_VERSION_ID,
    organizationId: ORG_ID,
    partyId: PARTY_ID,
    displayName: "Agent A New",
    title: "Senior Sales Manager",
    primaryEmail: "agent@example.com",
    primaryPhone: "+60123456789",
    status: "pending",
    submittedById: USER_ID,
    submittedByType: "agent",
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    publicToken: null,
    approvedAt: null,
    expiresAt: null,
    reconfirmCount: 0,
    createdAt: new Date("2026-05-04T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction immediately invokes the callback with mockDb as tx.
  mockDb.$transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
});

// ── getMyCard ──────────────────────────────────────────────────────────────

describe("portal-my-card service — getMyCard", () => {
  it("returns active, pending, and history with correct partitioning", async () => {
    const active = activeRow();
    const pending = pendingRow();
    const olderRejected = {
      ...pendingRow({
        id: "77777777-7777-7777-7777-777777777777",
        status: "rejected",
        rejectionReason: "Title too long",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      }),
    };

    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    // findMany returns rows newest-first; order is independent of partitioning.
    mockDb.agentCardVersion.findMany.mockResolvedValueOnce([pending, active, olderRejected]);

    const result = await getMyCard(PARTY_ID);

    expect(result.active?.id).toBe(ACTIVE_VERSION_ID);
    expect(result.pending?.id).toBe(PENDING_VERSION_ID);
    expect(result.history.map((r) => r.id)).toEqual([
      PENDING_VERSION_ID,
      ACTIVE_VERSION_ID,
      olderRejected.id,
    ]);
  });

  it("strips publicToken from pending and history rows; preserves on active", async () => {
    const active = activeRow();
    const pending = pendingRow();

    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    mockDb.agentCardVersion.findMany.mockResolvedValueOnce([pending, active]);

    const result = await getMyCard(PARTY_ID);

    // Active keeps its token (the agent needs it to share their public link).
    expect(result.active?.publicToken).toBe("active-public-token-22ch");
    // Pending row never has a token in the first place, but the DTO must
    // explicitly null it (defensive in case the DB shape ever changes).
    expect(result.pending?.publicToken).toBeNull();
    // History rows: token stripped even on the active entry that's mirrored
    // into history. The shared component only needs token from `active`.
    for (const row of result.history) {
      expect(row.publicToken).toBeNull();
    }
  });

  it("returns nulls when party has no active card and no pending", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: null,
    });
    mockDb.agentCardVersion.findMany.mockResolvedValueOnce([]);

    const result = await getMyCard(PARTY_ID);
    expect(result).toEqual({ active: null, pending: null, history: [] });
  });
});

// ── submitMyCard ───────────────────────────────────────────────────────────

describe("portal-my-card service — submitMyCard", () => {
  it("rejects when OrganizationCardSettings.isConfigured = false", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      isConfigured: false,
    });

    await expect(
      submitMyCard(
        PARTY_ID,
        { displayName: "A", title: "T" },
        ACTOR_OPTS,
      ),
    ).rejects.toBeInstanceOf(OrgCardSettingsNotConfiguredError);

    expect(mockDb.agentCardVersion.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects when a pending row already exists (pre-check)", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce({ id: PENDING_VERSION_ID });

    await expect(
      submitMyCard(
        PARTY_ID,
        { displayName: "A", title: "T" },
        ACTOR_OPTS,
      ),
    ).rejects.toBeInstanceOf(MyCardPendingExistsError);

    expect(mockDb.agentCardVersion.create).not.toHaveBeenCalled();
  });

  it("happy path: creates pending row + writes card.submit AuditLog", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(null); // no pending
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: PENDING_VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await submitMyCard(
      PARTY_ID,
      {
        displayName: "Agent A",
        title: "Senior Manager",
        primaryEmail: "a@example.com",
        primaryPhone: "+60123456789",
      },
      ACTOR_OPTS,
    );

    expect(result.versionId).toBe(PENDING_VERSION_ID);

    const createArg = mockDb.agentCardVersion.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data).toMatchObject({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Senior Manager",
      primaryEmail: "a@example.com",
      primaryPhone: "+60123456789",
      status: "pending",
      submittedById: USER_ID,
      submittedByType: "agent",
      reconfirmCount: 0,
    });
    // Pending row carries no token / approvedAt / expiresAt.
    expect(createArg.data.publicToken).toBeUndefined();
    expect(createArg.data.approvedAt).toBeUndefined();
    expect(createArg.data.expiresAt).toBeUndefined();

    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data).toMatchObject({
      organizationId: ORG_ID,
      actorUserId: USER_ID,
      actorRole: "agent",
      entityType: "AgentCardVersion",
      entityId: PENDING_VERSION_ID,
      action: "card.submit",
    });
    expect(auditArg.data.meta).toMatchObject({ submittedByType: "agent" });
  });

  it("translates Prisma P2002 (race-condition double-submit) → MyCardPendingExistsError", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(null); // pre-check passes
    // The DB partial unique index rejects the INSERT during the race window.
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mockDb.agentCardVersion.create.mockRejectedValueOnce(p2002);

    await expect(
      submitMyCard(
        PARTY_ID,
        { displayName: "A", title: "T" },
        ACTOR_OPTS,
      ),
    ).rejects.toBeInstanceOf(MyCardPendingExistsError);
  });
});

// ── reconfirmMyCard ────────────────────────────────────────────────────────

describe("portal-my-card service — reconfirmMyCard", () => {
  it("rejects when active.expiresAt is more than 30 days away", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    // expiresAt 90 days out — outside the 30-day window.
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce(
      activeRow({ expiresAt: farFuture, reconfirmCount: 0 }),
    );

    await expect(reconfirmMyCard(PARTY_ID, ACTOR_OPTS)).rejects.toBeInstanceOf(
      ReconfirmNotInWindowError,
    );

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });

  it("rejects when reconfirmCount is already 4 (cap reached)", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    // expiresAt 7 days out (in window); count at cap.
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce(
      activeRow({ expiresAt: sevenDaysOut, reconfirmCount: 4 }),
    );

    await expect(reconfirmMyCard(PARTY_ID, ACTOR_OPTS)).rejects.toBeInstanceOf(
      ReconfirmCapReachedError,
    );

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });

  it("rejects when last reconfirm was less than 24 hours ago", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce(
      activeRow({ expiresAt: sevenDaysOut, reconfirmCount: 1 }),
    );
    // Last reconfirm 6 hours ago — well inside the 24h window.
    mockDb.auditLog.findFirst.mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await expect(reconfirmMyCard(PARTY_ID, ACTOR_OPTS)).rejects.toBeInstanceOf(
      ReconfirmRateLimitedError,
    );

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });

  it("happy path: bumps expiresAt by cardExpiryMonths and increments reconfirmCount", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    const expiresAt = new Date("2026-05-20T00:00:00Z"); // ~15 days from a 2026-05-05 NOW
    // The actual NOW the service computes will use Date.now() at call
    // time; we keep the row's expiresAt close to NOW so the 30-day
    // window check passes regardless of when the test runs.
    const closeFuture = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce(
      activeRow({ expiresAt: closeFuture, reconfirmCount: 1 }),
    );
    mockDb.auditLog.findFirst.mockResolvedValueOnce(null); // no prior reconfirm
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      cardExpiryMonths: 3,
    });
    mockDb.agentCardVersion.update.mockResolvedValueOnce({ id: ACTIVE_VERSION_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    void expiresAt; // silence unused
    const result = await reconfirmMyCard(PARTY_ID, ACTOR_OPTS);

    expect(result.versionId).toBe(ACTIVE_VERSION_ID);

    const updateArg = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      where: { id: string };
      data: { expiresAt: Date; reconfirmCount: number };
    };
    expect(updateArg.where.id).toBe(ACTIVE_VERSION_ID);
    expect(updateArg.data.reconfirmCount).toBe(2); // 1 → 2

    // New expiresAt = old expiresAt + 3 months. Bump from CURRENT
    // expiresAt (not NOW) — verify the year/month math.
    const expectedExpiresAt = new Date(closeFuture);
    expectedExpiresAt.setMonth(expectedExpiresAt.getMonth() + 3);
    expect(updateArg.data.expiresAt.getTime()).toBe(expectedExpiresAt.getTime());

    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("card.reconfirm");
    expect(auditArg.data.meta).toMatchObject({
      reconfirmCount: 2,
    });
  });

  it("returns 404 (MyCardNotFoundError) when party has no active card version", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: null,
    });

    await expect(reconfirmMyCard(PARTY_ID, ACTOR_OPTS)).rejects.toBeInstanceOf(
      MyCardNotFoundError,
    );
  });
});

// ── withdrawMyCard ─────────────────────────────────────────────────────────

describe("portal-my-card service — withdrawMyCard", () => {
  it("happy path: marks pending row as rejected with 'Withdrawn by agent' reason + AuditLog", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(pendingRow());
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: args.where.id,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await withdrawMyCard(PARTY_ID, ACTOR_OPTS);

    expect(result.versionId).toBe(PENDING_VERSION_ID);

    const updateArg = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArg.where.id).toBe(PENDING_VERSION_ID);
    expect(updateArg.data).toMatchObject({
      status: "rejected",
      rejectionReason: "Withdrawn by agent",
      reviewedById: USER_ID,
    });

    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("card.withdraw");
    expect(auditArg.data.meta).toMatchObject({ withdrawnBy: "agent" });
  });

  it("returns 404 when there is no pending row to withdraw", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(null);

    await expect(withdrawMyCard(PARTY_ID, ACTOR_OPTS)).rejects.toBeInstanceOf(
      MyCardNotFoundError,
    );

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });
});

// ── Phase 7 notification wiring (spec §11) ─────────────────────────────────
//
// We pin that submitMyCard fires the manager fan-out and reconfirmMyCard
// fires the cap-reached helper at exactly count=4. The notification
// internals are covered in agent-cards/__tests__/notifications.test.ts;
// here we only assert the wire is in place with the right args.

import {
  notifyAgentReconfirmCapReached,
  notifyManagersOfPendingCard,
} from "../../agent-cards/notifications";

describe("portal-my-card service — notification wiring (spec §11)", () => {
  it("submitMyCard calls notifyManagersOfPendingCard with org, versionId, agentName, newTitle", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(null);
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: PENDING_VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await submitMyCard(
      PARTY_ID,
      {
        displayName: "Alice",
        title: "Senior Manager",
      },
      ACTOR_OPTS,
    );

    expect(notifyManagersOfPendingCard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyManagersOfPendingCard).mock.calls[0]![0]).toEqual({
      organizationId: ORG_ID,
      versionId: PENDING_VERSION_ID,
      agentName: "Alice",
      newTitle: "Senior Manager",
    });
  });

  it("submitMyCard does NOT notify when validation fails (e.g. settings unconfigured)", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      isConfigured: false,
    });

    await expect(
      submitMyCard(PARTY_ID, { displayName: "A", title: "T" }, ACTOR_OPTS),
    ).rejects.toBeInstanceOf(OrgCardSettingsNotConfiguredError);

    expect(notifyManagersOfPendingCard).not.toHaveBeenCalled();
  });

  it("reconfirmMyCard fires cap-reached notification when newReconfirmCount hits 4", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    const closeFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // reconfirmCount=3 → after this reconfirm becomes 4 (cap reached).
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce(
      activeRow({ expiresAt: closeFuture, reconfirmCount: 3 }),
    );
    mockDb.auditLog.findFirst.mockResolvedValueOnce(null);
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.agentCardVersion.update.mockResolvedValueOnce({ id: ACTIVE_VERSION_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await reconfirmMyCard(PARTY_ID, ACTOR_OPTS);

    expect(notifyAgentReconfirmCapReached).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAgentReconfirmCapReached).mock.calls[0]![0]).toEqual({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
    });
  });

  it("reconfirmMyCard does NOT fire cap-reached when newReconfirmCount is below 4", async () => {
    mockDb.party.findUnique.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: ACTIVE_VERSION_ID,
    });
    const closeFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // reconfirmCount=1 → after this becomes 2 (no cap).
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce(
      activeRow({ expiresAt: closeFuture, reconfirmCount: 1 }),
    );
    mockDb.auditLog.findFirst.mockResolvedValueOnce(null);
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.agentCardVersion.update.mockResolvedValueOnce({ id: ACTIVE_VERSION_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await reconfirmMyCard(PARTY_ID, ACTOR_OPTS);

    expect(notifyAgentReconfirmCapReached).not.toHaveBeenCalled();
  });
});
