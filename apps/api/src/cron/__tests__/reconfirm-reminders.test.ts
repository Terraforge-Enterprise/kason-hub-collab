// Tests for the reconfirm-reminder cron (spec §11.2).
//
// Verified behaviours:
//   1. T-30 window fires the T-30 helper for one fresh candidate.
//   2. T-7 window fires the T-7 helper.
//   3. Idempotency — pre-existing Notification with the matching title
//      blocks the helper from being called.
//   4. Catch-up — a version 7 days from expiry that never got T-30 still
//      receives T-7 (T-30 query no longer fires for it; T-7 query does).
//   5. Multi-window single run — three different versions, one per
//      window, all three helpers called.
//   6. One window erroring does not block the others.
//   7. Heartbeat console line is emitted on every successful run.
//   8. Skip when agent has no portal user account (cannot dedup).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDb = {
  agentCardVersion: { findMany: vi.fn() },
  notification: { findFirst: vi.fn() },
  organizationCardSettings: { findUnique: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => mockDb,
}));

vi.mock("../../modules/agent-cards/notifications", () => ({
  notifyAgentReconfirmT30: vi.fn(async () => undefined),
  notifyAgentReconfirmT7: vi.fn(async () => undefined),
  notifyAgentReconfirmT1: vi.fn(async () => undefined),
}));

import {
  notifyAgentReconfirmT1,
  notifyAgentReconfirmT30,
  notifyAgentReconfirmT7,
} from "../../modules/agent-cards/notifications";
import { runReconfirmRemindersOnce } from "../reconfirm-reminders";

// ── Helpers ─────────────────────────────────────────────────────────────────

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PARTY_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

function inDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function makeCandidate(opts: {
  id: string;
  expiresInDays: number;
  hasUser?: boolean;
  approvedAt?: Date;
}) {
  return {
    id: opts.id,
    organizationId: ORG_ID,
    partyId: PARTY_ID,
    approvedAt: opts.approvedAt ?? new Date(Date.now() - 60_000),
    expiresAt: inDays(opts.expiresInDays),
    party: {
      userAccount: opts.hasUser === false ? null : { id: USER_ID },
    },
  };
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no candidates in any window.
  mockDb.agentCardVersion.findMany.mockResolvedValue([]);
  // Default: no prior notification (idempotency check passes through).
  mockDb.notification.findFirst.mockResolvedValue(null);
  // Default org card settings — needed for T-30 body interpolation.
  mockDb.organizationCardSettings.findUnique.mockResolvedValue({
    cardExpiryMonths: 6,
  });
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ── 1. T-30 firing ──────────────────────────────────────────────────────────

describe("runReconfirmRemindersOnce — T-30 window", () => {
  it("fires the T-30 helper for an approved version inside (T-7, T-30] with no prior reminder", async () => {
    // T-30 window query is the FIRST findMany call — return one candidate
    // ~25 days out (inside (7, 30]), all later windows return [].
    mockDb.agentCardVersion.findMany
      .mockResolvedValueOnce([makeCandidate({ id: "v1", expiresInDays: 25 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runReconfirmRemindersOnce();

    expect(notifyAgentReconfirmT30).toHaveBeenCalledTimes(1);
    expect(notifyAgentReconfirmT30).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
      cardExpiryMonths: 6,
    });
    expect(notifyAgentReconfirmT7).not.toHaveBeenCalled();
    expect(notifyAgentReconfirmT1).not.toHaveBeenCalled();

    const t30 = result.windows.find((w) => w.kind === "T30")!;
    expect(t30.candidatesFound).toBe(1);
    expect(t30.notificationsSent).toBe(1);
  });
});

// ── 2. T-7 firing ───────────────────────────────────────────────────────────

describe("runReconfirmRemindersOnce — T-7 window", () => {
  it("fires the T-7 helper for an approved version inside (T-1, T-7]", async () => {
    mockDb.agentCardVersion.findMany
      .mockResolvedValueOnce([]) // T-30 window: empty
      .mockResolvedValueOnce([makeCandidate({ id: "v2", expiresInDays: 5 })]) // T-7
      .mockResolvedValueOnce([]); // T-1: empty

    await runReconfirmRemindersOnce();

    expect(notifyAgentReconfirmT7).toHaveBeenCalledTimes(1);
    expect(notifyAgentReconfirmT7).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
    });
    expect(notifyAgentReconfirmT30).not.toHaveBeenCalled();
    expect(notifyAgentReconfirmT1).not.toHaveBeenCalled();
  });
});

// ── 3. Idempotency — skip if Notification already exists ────────────────────

describe("runReconfirmRemindersOnce — idempotency", () => {
  it("skips the helper when a matching Notification row already exists for this version's lifetime", async () => {
    mockDb.agentCardVersion.findMany
      .mockResolvedValueOnce([makeCandidate({ id: "v1", expiresInDays: 25 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    // Pretend a prior T-30 notification already exists.
    mockDb.notification.findFirst.mockResolvedValueOnce({ id: "n-prior" });

    const result = await runReconfirmRemindersOnce();

    expect(notifyAgentReconfirmT30).not.toHaveBeenCalled();
    const t30 = result.windows.find((w) => w.kind === "T30")!;
    expect(t30.candidatesFound).toBe(1);
    expect(t30.notificationsSent).toBe(0);
    expect(t30.skippedAlreadyNotified).toBe(1);

    // Confirm the dedup query targeted the right notification title.
    const callArg = mockDb.notification.findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(callArg.where.title).toBe("E-namecard expires in 30 days");
    expect(callArg.where.userId).toBe(USER_ID);
    expect(callArg.where.domain).toBe("agent-card");
  });
});

// ── 4. Catch-up — missed T-30 still gets T-7 ────────────────────────────────

describe("runReconfirmRemindersOnce — catch-up behaviour", () => {
  it("a version 5 days from expiry hits the T-7 query (not T-30) so the agent still receives a reminder", async () => {
    // Version is 5 days out — it's INSIDE the T-7 window (1, 7] but
    // OUTSIDE the T-30 window (7, 30]. The T-30 query returns [], the
    // T-7 query returns the candidate. Net result: T-7 fires, T-30
    // does not (and never will for this version, by design).
    mockDb.agentCardVersion.findMany
      .mockResolvedValueOnce([]) // T-30: outside its window now
      .mockResolvedValueOnce([makeCandidate({ id: "v-late", expiresInDays: 5 })])
      .mockResolvedValueOnce([]);

    await runReconfirmRemindersOnce();

    expect(notifyAgentReconfirmT30).not.toHaveBeenCalled();
    expect(notifyAgentReconfirmT7).toHaveBeenCalledTimes(1);
    expect(notifyAgentReconfirmT1).not.toHaveBeenCalled();
  });
});

// ── 5. Multi-window single run ──────────────────────────────────────────────

describe("runReconfirmRemindersOnce — multi-window pass", () => {
  it("calls all three helpers when each window has a candidate", async () => {
    mockDb.agentCardVersion.findMany
      .mockResolvedValueOnce([makeCandidate({ id: "v30", expiresInDays: 25 })])
      .mockResolvedValueOnce([makeCandidate({ id: "v7", expiresInDays: 5 })])
      .mockResolvedValueOnce([makeCandidate({ id: "v1", expiresInDays: 0.5 })]);

    const result = await runReconfirmRemindersOnce();

    expect(notifyAgentReconfirmT30).toHaveBeenCalledTimes(1);
    expect(notifyAgentReconfirmT7).toHaveBeenCalledTimes(1);
    expect(notifyAgentReconfirmT1).toHaveBeenCalledTimes(1);

    expect(result.windows.map((w) => w.notificationsSent)).toEqual([1, 1, 1]);
  });
});

// ── 6. Error in one window does not block the others ────────────────────────

describe("runReconfirmRemindersOnce — error isolation", () => {
  it("a thrown query in the T-30 window still allows T-7 and T-1 to run", async () => {
    mockDb.agentCardVersion.findMany
      .mockRejectedValueOnce(new Error("simulated DB failure"))
      .mockResolvedValueOnce([makeCandidate({ id: "v7", expiresInDays: 5 })])
      .mockResolvedValueOnce([makeCandidate({ id: "v1", expiresInDays: 0.5 })]);

    const result = await runReconfirmRemindersOnce();

    const t30 = result.windows.find((w) => w.kind === "T30")!;
    expect(t30.errors).toBe(1);
    expect(t30.notificationsSent).toBe(0);

    expect(notifyAgentReconfirmT7).toHaveBeenCalledTimes(1);
    expect(notifyAgentReconfirmT1).toHaveBeenCalledTimes(1);
  });
});

// ── 7. Heartbeat console line ───────────────────────────────────────────────

describe("runReconfirmRemindersOnce — heartbeat", () => {
  it("emits a [cron:heartbeat] console.log line on every successful run", async () => {
    await runReconfirmRemindersOnce();

    const heartbeatCalls = consoleLogSpy.mock.calls.filter(
      (c) => c[0] === "[cron:heartbeat]",
    );
    expect(heartbeatCalls).toHaveLength(1);
    // Payload is JSON-stringified and includes startedAt + finishedAt.
    const payload = JSON.parse(heartbeatCalls[0]![1] as string);
    expect(payload).toMatchObject({
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      windows: expect.any(Array),
    });
    expect(payload.windows).toHaveLength(3);
  });
});

// ── 8. Skip when agent has no portal user account ───────────────────────────

describe("runReconfirmRemindersOnce — agent without portal account", () => {
  it("skips a candidate whose Party has no userAccount (cannot dedup) and counts the skip", async () => {
    mockDb.agentCardVersion.findMany
      .mockResolvedValueOnce([
        makeCandidate({ id: "v-orphan", expiresInDays: 25, hasUser: false }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await runReconfirmRemindersOnce();

    expect(notifyAgentReconfirmT30).not.toHaveBeenCalled();
    const t30 = result.windows.find((w) => w.kind === "T30")!;
    expect(t30.skippedNoUserAccount).toBe(1);
    expect(t30.notificationsSent).toBe(0);
    // Idempotency lookup must NOT have been attempted for this candidate.
    expect(mockDb.notification.findFirst).not.toHaveBeenCalled();
  });
});
