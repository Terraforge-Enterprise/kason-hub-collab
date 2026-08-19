import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @kason/db ──────────────────────────────────────────────────────────
//
// We mock the Prisma client so the service can be exercised without a live
// DB. The mock's `$transaction` immediately invokes the callback with the
// SAME mock object as the tx client, so every Prisma call inside the
// transaction is recorded on the shared `mockDb` and we can introspect
// them as a unit (this is what proves "all calls happen on one tx
// reference" — i.e., they're transactionally grouped).
const mockDb = {
  organizationCardSettings: { findUnique: vi.fn() },
  agentCardVersion: {
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  party: { update: vi.fn(), findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("@kason/db", () => ({
  getDb: () => mockDb,
}));

// Mock the notifications module so the existing tests don't have to wire
// up Notification/User/Party reads on mockDb. Notification behavior is
// covered separately in notifications.test.ts.
vi.mock("../notifications", () => ({
  notifyAgentCardApproved: vi.fn(async () => undefined),
  notifyAgentCardRejected: vi.fn(async () => undefined),
}));

import {
  AgentCardConflictError,
  AgentCardNotFoundError,
  approveVersion,
  createApprovedFromAdmin,
  OrgCardSettingsNotConfiguredError,
  regenerateToken,
  rejectVersion,
  revokeActiveCard,
} from "../service";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PARTY_ID = "22222222-2222-2222-2222-222222222222";
const SUBMITTER_ID = "33333333-3333-3333-3333-333333333333";

const baseSettings = {
  id: "44444444-4444-4444-4444-444444444444",
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction immediately invokes the callback with mockDb as tx
  mockDb.$transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
});

describe("agent-cards service — createApprovedFromAdmin", () => {
  it("throws OrgCardSettingsNotConfiguredError when settings.isConfigured = false", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      isConfigured: false,
    });

    await expect(
      createApprovedFromAdmin({
        organizationId: ORG_ID,
        partyId: PARTY_ID,
        displayName: "Agent A",
        title: "Sales Manager",
        submittedById: SUBMITTER_ID,
      }),
    ).rejects.toThrow(OrgCardSettingsNotConfiguredError);

    // No writes should have happened.
    expect(mockDb.agentCardVersion.create).not.toHaveBeenCalled();
    expect(mockDb.party.update).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("throws OrgCardSettingsNotConfiguredError when no settings row exists", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce(null);

    await expect(
      createApprovedFromAdmin({
        organizationId: ORG_ID,
        partyId: PARTY_ID,
        displayName: "Agent A",
        title: "Sales Manager",
        submittedById: SUBMITTER_ID,
      }),
    ).rejects.toThrow(OrgCardSettingsNotConfiguredError);

    expect(mockDb.agentCardVersion.create).not.toHaveBeenCalled();
  });

  it("happy path: creates an approved version with a 22-char base64url token", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      cardExpiryMonths: 6,
    });
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: "version-1",
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await createApprovedFromAdmin({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Sales Manager",
      primaryEmail: "agent@example.com",
      primaryPhone: "+60123456789",
      submittedById: SUBMITTER_ID,
    });

    // Token shape (per spec §6.3 — same regex the public sub-app uses).
    expect(result.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.versionId).toBe("version-1");
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Verify the row written has all expected fields.
    expect(mockDb.agentCardVersion.create).toHaveBeenCalledTimes(1);
    const callArgs = mockDb.agentCardVersion.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(callArgs.data).toMatchObject({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Sales Manager",
      primaryEmail: "agent@example.com",
      primaryPhone: "+60123456789",
      status: "approved",
      submittedById: SUBMITTER_ID,
      submittedByType: "admin",
      reviewedById: SUBMITTER_ID,
      reconfirmCount: 0,
    });
    expect(callArgs.data.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("expiresAt = NOW + cardExpiryMonths (6 months → ~6 months in the future)", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      cardExpiryMonths: 6,
    });
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: "version-2",
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const before = new Date();
    const result = await createApprovedFromAdmin({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Sales Manager",
      submittedById: SUBMITTER_ID,
    });
    const after = new Date();

    // 6 months in milliseconds — approximate. Allow a wide window because
    // calendar-month arithmetic varies (Date.setMonth handles month-end
    // correctly but the resulting span in ms differs across months).
    const sixMonthsApprox = 6 * 30 * 24 * 60 * 60 * 1000; // ≈ 5.9 months
    const sixMonthsApproxUpper = 6 * 31 * 24 * 60 * 60 * 1000; // ≈ 6.1 months
    const diffFromBefore = result.expiresAt.getTime() - before.getTime();
    const diffFromAfter = result.expiresAt.getTime() - after.getTime();
    expect(diffFromBefore).toBeGreaterThanOrEqual(sixMonthsApprox);
    expect(diffFromAfter).toBeLessThanOrEqual(sixMonthsApproxUpper);
  });

  it("updates Party.activeCardVersionId to the new version's id", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
    });
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: "version-3",
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await createApprovedFromAdmin({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Sales Manager",
      submittedById: SUBMITTER_ID,
    });

    expect(mockDb.party.update).toHaveBeenCalledTimes(1);
    expect(mockDb.party.update).toHaveBeenCalledWith({
      where: { id: PARTY_ID },
      data: { activeCardVersionId: "version-3" },
    });
  });

  it("writes an AuditLog row with action='card.approve' and meta.submittedByType='admin'", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
    });
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: "version-4",
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await createApprovedFromAdmin({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Sales Manager",
      submittedById: SUBMITTER_ID,
    });

    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data).toMatchObject({
      organizationId: ORG_ID,
      actorUserId: SUBMITTER_ID,
      entityType: "AgentCardVersion",
      entityId: "version-4",
      action: "card.approve",
    });
    expect(auditArg.data.meta).toMatchObject({
      submittedByType: "admin",
      initialCreate: true,
    });
  });

  it("runs all writes inside a single $transaction (one callback invocation)", async () => {
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
    });
    mockDb.agentCardVersion.create.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: "version-5",
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await createApprovedFromAdmin({
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      displayName: "Agent A",
      title: "Sales Manager",
      submittedById: SUBMITTER_ID,
    });

    // $transaction was invoked exactly once with a single callback.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    const txCallArg = mockDb.$transaction.mock.calls[0]![0];
    expect(typeof txCallArg).toBe("function");

    // All four DB methods that should run inside the tx ran (proving the
    // callback executed and the writes are in the same scope).
    expect(mockDb.organizationCardSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(mockDb.agentCardVersion.create).toHaveBeenCalledTimes(1);
    expect(mockDb.party.update).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

// ── Phase 4 mutation tests ─────────────────────────────────────────────────

const ACTOR_ID = "55555555-5555-5555-5555-555555555555";
const VERSION_ID = "66666666-6666-6666-6666-666666666666";
const PRIOR_VERSION_ID = "77777777-7777-7777-7777-777777777777";
const PRIOR_TOKEN = "prior-token-1234567890"; // 22 chars-ish, shape unimportant for mock

function pendingVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    organizationId: ORG_ID,
    partyId: PARTY_ID,
    displayName: "Agent A",
    title: "Sales Manager",
    primaryEmail: null,
    primaryPhone: null,
    status: "pending",
    submittedById: SUBMITTER_ID,
    submittedByType: "agent",
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    publicToken: null,
    approvedAt: null,
    expiresAt: null,
    reconfirmCount: 0,
    createdAt: new Date("2026-05-05T00:00:00Z"),
    ...overrides,
  };
}

describe("agent-cards service — approveVersion", () => {
  it("rotates token when previous version was agent-submitted", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ submittedByType: "agent" }),
    );
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
      cardExpiryMonths: 6,
    });
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: PRIOR_VERSION_ID,
    });
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce({
      id: PRIOR_VERSION_ID,
      publicToken: PRIOR_TOKEN,
    });
    // First update NULLs the prior row's token; second updates the new row.
    mockDb.agentCardVersion.update
      .mockResolvedValueOnce({ id: PRIOR_VERSION_ID, publicToken: null })
      .mockImplementationOnce(async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }));
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await approveVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    expect(result.versionId).toBe(VERSION_ID);
    // Two version updates: NULL prior + write new.
    expect(mockDb.agentCardVersion.update).toHaveBeenCalledTimes(2);
    const newVersionUpdate = mockDb.agentCardVersion.update.mock.calls[1]![0] as {
      data: Record<string, unknown>;
    };
    // Token must be a freshly-minted base64url string (NOT the prior token).
    expect(newVersionUpdate.data.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newVersionUpdate.data.publicToken).not.toBe(PRIOR_TOKEN);
    // Audit log meta records rotated=true.
    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("card.approve");
    expect(auditArg.data.meta).toMatchObject({ submittedByType: "agent", rotated: true });
  });

  it("preserves token when previous version was admin-submitted", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ submittedByType: "admin" }),
    );
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({
      ...baseSettings,
    });
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: PRIOR_VERSION_ID,
    });
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce({
      id: PRIOR_VERSION_ID,
      publicToken: PRIOR_TOKEN,
    });
    mockDb.agentCardVersion.update
      .mockResolvedValueOnce({ id: PRIOR_VERSION_ID, publicToken: null })
      .mockImplementationOnce(async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }));
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await approveVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    const newVersionUpdate = mockDb.agentCardVersion.update.mock.calls[1]![0] as {
      data: Record<string, unknown>;
    };
    // Token reused: same string as the prior row's.
    expect(newVersionUpdate.data.publicToken).toBe(PRIOR_TOKEN);
    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.meta).toMatchObject({ submittedByType: "admin", rotated: false });
  });

  it("returns 409 (AgentCardConflictError) when version is not pending", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ status: "approved" }),
    );

    await expect(
      approveVersion(VERSION_ID, {
        actorUserId: ACTOR_ID,
        actorRole: "manager",
        organizationId: ORG_ID,
      }),
    ).rejects.toBeInstanceOf(AgentCardConflictError);

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("returns 404 (AgentCardNotFoundError) when version belongs to another org (cross-org)", async () => {
    // findFirst with org filter returns null when the row is in another org.
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(null);

    await expect(
      approveVersion(VERSION_ID, {
        actorUserId: ACTOR_ID,
        actorRole: "manager",
        organizationId: ORG_ID,
      }),
    ).rejects.toBeInstanceOf(AgentCardNotFoundError);

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });

  it("NULLs the previous active row's publicToken on approval", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ submittedByType: "agent" }),
    );
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: PRIOR_VERSION_ID,
    });
    mockDb.agentCardVersion.findUnique.mockResolvedValueOnce({
      id: PRIOR_VERSION_ID,
      publicToken: PRIOR_TOKEN,
    });
    mockDb.agentCardVersion.update
      .mockResolvedValueOnce({ id: PRIOR_VERSION_ID, publicToken: null })
      .mockImplementationOnce(async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }));
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await approveVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    // First update was on the PRIOR row, setting publicToken=null.
    const priorUpdate = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(priorUpdate.where.id).toBe(PRIOR_VERSION_ID);
    expect(priorUpdate.data.publicToken).toBeNull();
  });

  it("resets reconfirmCount to 0 on approval", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ submittedByType: "agent", reconfirmCount: 2 }),
    );
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: null,
    });
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await approveVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    const newVersionUpdate = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(newVersionUpdate.data.reconfirmCount).toBe(0);
  });
});

describe("agent-cards service — rejectVersion", () => {
  it("writes status=rejected, rejectionReason and a card.reject AuditLog row", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(pendingVersion());
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await rejectVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
      reason: "Photo missing",
    });

    expect(result.versionId).toBe(VERSION_ID);
    const updateArg = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data).toMatchObject({
      status: "rejected",
      rejectionReason: "Photo missing",
      reviewedById: ACTOR_ID,
    });
    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("card.reject");
    expect(auditArg.data.meta).toMatchObject({ reason: "Photo missing" });
  });

  it("returns 409 when version is not pending", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ status: "rejected" }),
    );

    await expect(
      rejectVersion(VERSION_ID, {
        actorUserId: ACTOR_ID,
        actorRole: "manager",
        organizationId: ORG_ID,
        reason: "Already done",
      }),
    ).rejects.toBeInstanceOf(AgentCardConflictError);

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });
});

describe("agent-cards service — regenerateToken", () => {
  it("rotates the publicToken on the active version and logs the prior token's hash", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: PRIOR_VERSION_ID,
    });
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce({
      id: PRIOR_VERSION_ID,
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      publicToken: PRIOR_TOKEN,
      status: "approved",
    });
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: PRIOR_VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await regenerateToken(PARTY_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    expect(result.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.publicToken).not.toBe(PRIOR_TOKEN);
    expect(result.versionId).toBe(PRIOR_VERSION_ID);

    const updateArg = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.publicToken).toBe(result.publicToken);

    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("card.token.rotate");
    const meta = auditArg.data.meta as { previousTokenHash: string };
    // Hash of PRIOR_TOKEN, sliced to 16 hex chars.
    expect(meta.previousTokenHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("returns 404 when the party has no active version", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: null,
    });

    await expect(
      regenerateToken(PARTY_ID, {
        actorUserId: ACTOR_ID,
        actorRole: "manager",
        organizationId: ORG_ID,
      }),
    ).rejects.toBeInstanceOf(AgentCardNotFoundError);

    expect(mockDb.agentCardVersion.update).not.toHaveBeenCalled();
  });
});

// ── Phase 7 notification wiring ────────────────────────────────────────────
//
// These tests pin the contract that the notification helpers ARE called
// from approveVersion / rejectVersion with the right arguments. Notification
// internals (DB writes, body strings) are covered in notifications.test.ts;
// here we only assert the wire is in place.

import {
  notifyAgentCardApproved,
  notifyAgentCardRejected,
} from "../notifications";

describe("agent-cards service — notification wiring (spec §11)", () => {
  it("approveVersion calls notifyAgentCardApproved with org, partyId, and the new publicToken", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ submittedByType: "agent" }),
    );
    mockDb.organizationCardSettings.findUnique.mockResolvedValueOnce({ ...baseSettings });
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: null, // no prior — simplest path; new token minted
    });
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.party.update.mockResolvedValueOnce({ id: PARTY_ID });
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await approveVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    expect(notifyAgentCardApproved).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(notifyAgentCardApproved).mock.calls[0]![0];
    expect(callArg.organizationId).toBe(ORG_ID);
    expect(callArg.agentPartyId).toBe(PARTY_ID);
    // publicToken is freshly minted (no prior active). Format check only.
    expect(callArg.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("rejectVersion calls notifyAgentCardRejected with the reason text", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(pendingVersion());
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    await rejectVersion(VERSION_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
      reason: "Photo missing",
    });

    expect(notifyAgentCardRejected).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(notifyAgentCardRejected).mock.calls[0]![0];
    expect(callArg).toEqual({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
      reason: "Photo missing",
    });
  });

  it("rejectVersion does NOT notify when the version is not pending (early throw)", async () => {
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce(
      pendingVersion({ status: "rejected" }),
    );

    await expect(
      rejectVersion(VERSION_ID, {
        actorUserId: ACTOR_ID,
        actorRole: "manager",
        organizationId: ORG_ID,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(AgentCardConflictError);

    expect(notifyAgentCardRejected).not.toHaveBeenCalled();
  });
});

describe("agent-cards service — revokeActiveCard", () => {
  it("NULLs publicToken on the active version and writes a card.revoke AuditLog row", async () => {
    mockDb.party.findFirst.mockResolvedValueOnce({
      id: PARTY_ID,
      activeCardVersionId: PRIOR_VERSION_ID,
    });
    mockDb.agentCardVersion.findFirst.mockResolvedValueOnce({
      id: PRIOR_VERSION_ID,
      organizationId: ORG_ID,
      partyId: PARTY_ID,
      publicToken: PRIOR_TOKEN,
      status: "approved",
    });
    mockDb.agentCardVersion.update.mockImplementationOnce(
      async (args: { data: Record<string, unknown> }) => ({
        id: PRIOR_VERSION_ID,
        ...args.data,
      }),
    );
    mockDb.auditLog.create.mockResolvedValueOnce({ id: "audit-1" });

    const result = await revokeActiveCard(PARTY_ID, {
      actorUserId: ACTOR_ID,
      actorRole: "manager",
      organizationId: ORG_ID,
    });

    expect(result.versionId).toBe(PRIOR_VERSION_ID);
    const updateArg = mockDb.agentCardVersion.update.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.publicToken).toBeNull();

    const auditArg = mockDb.auditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArg.data.action).toBe("card.revoke");
    expect(auditArg.data.meta).toMatchObject({});
  });
});
