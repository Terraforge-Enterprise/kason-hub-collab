// Tests for agent-cards notification templates + dispatch helpers (spec
// §11, §11.1). Same mock pattern as service.test.ts: a single mockDb that
// also acts as the tx client.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
  notification: { create: vi.fn() },
  party: { findUnique: vi.fn() },
  user: { findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock("@kason/db", () => ({
  getDb: () => mockDb,
}));

import {
  notifyAgentCardApproved,
  notifyAgentCardRejected,
  notifyAgentReconfirmCapReached,
  notifyAgentReconfirmT1,
  notifyAgentReconfirmT7,
  notifyAgentReconfirmT30,
  notifyAllManagersInOrg,
  notifyManagersOfPendingCard,
  renderApprovalBody,
  renderPendingSubmissionBody,
  renderReconfirmCapBody,
  renderReconfirmT1Body,
  renderReconfirmT30Body,
  renderReconfirmT7Body,
  renderRejectionBody,
} from "../notifications";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PARTY_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const VERSION_ID = "44444444-4444-4444-4444-444444444444";
const PUBLIC_TOKEN = "abcdefghijklmnopqrstu1"; // 22-char base64url

const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(() => {
  vi.clearAllMocks();
  // Pin APP_URL so {publicUrl}/{portalUrl} bodies are deterministic.
  process.env.APP_URL = "https://app.kason-hub.test";
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

// ── Template renderers (spec §11.1 verbatim) ───────────────────────────────

describe("agent-card notification templates — verbatim per spec §11.1", () => {
  it("renderPendingSubmissionBody matches spec exactly", () => {
    expect(
      renderPendingSubmissionBody({ agentName: "Alice", newTitle: "Sales Manager" }),
    ).toBe('Alice submitted card changes (title: "Sales Manager"). Review.');
  });

  it("renderApprovalBody matches spec exactly", () => {
    expect(renderApprovalBody({ publicUrl: "https://x.test/card/T" })).toBe(
      "Your e-namecard was approved. View: https://x.test/card/T",
    );
  });

  it("renderRejectionBody matches spec exactly (interpolates reason + portalUrl)", () => {
    expect(
      renderRejectionBody({ reason: "Photo missing", portalUrl: "https://x.test/portal/my-card" }),
    ).toBe(
      "Your e-namecard update was rejected. Reason: Photo missing. Edit & re-submit: https://x.test/portal/my-card",
    );
  });

  it("renderReconfirmT30Body matches spec exactly", () => {
    expect(renderReconfirmT30Body({ months: 3 })).toBe(
      "Your e-namecard expires in 30 days. Re-confirm to extend by 3 months.",
    );
  });

  it("renderReconfirmT7Body matches spec exactly", () => {
    expect(renderReconfirmT7Body({ portalUrl: "https://x.test/portal/my-card" })).toBe(
      "Your e-namecard expires in 7 days. Re-confirm now to keep your public link active: https://x.test/portal/my-card",
    );
  });

  it("renderReconfirmT1Body matches spec exactly", () => {
    expect(renderReconfirmT1Body({ portalUrl: "https://x.test/portal/my-card" })).toBe(
      "Your e-namecard expires tomorrow. Re-confirm now: https://x.test/portal/my-card",
    );
  });

  it("renderReconfirmCapBody matches spec exactly", () => {
    expect(renderReconfirmCapBody({ portalUrl: "https://x.test/portal/my-card" })).toBe(
      "Your e-namecard has been re-confirmed 4 times. Submit fresh details for manager re-approval to keep your public link active: https://x.test/portal/my-card",
    );
  });
});

// ── notifyAllManagersInOrg ──────────────────────────────────────────────────

describe("notifyAllManagersInOrg (manager fan-out)", () => {
  it("selects ONLY operator users with manager/admin role in the org and writes one row each", async () => {
    mockDb.user.findMany.mockResolvedValueOnce([
      { id: "u-mgr-1" },
      { id: "u-admin-1" },
    ]);
    mockDb.notification.create
      .mockResolvedValueOnce({ id: "n1" })
      .mockResolvedValueOnce({ id: "n2" });

    await notifyAllManagersInOrg({
      organizationId: ORG_ID,
      title: "Card approval pending",
      body: "Alice submitted...",
      actionUrl: "/organization/agents/card-approvals?versionId=v1",
    });

    // The selector enforces: orgId, role IN (manager, admin), userType=operator,
    // status=active. This is the contract callers (notification triggers) rely
    // on — drift here would silently spam agents or skip suspended users.
    expect(mockDb.user.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        role: { in: ["manager", "admin"] },
        userType: "operator",
        status: "active",
      },
      select: { id: true },
    });

    expect(mockDb.notification.create).toHaveBeenCalledTimes(2);
    const firstCall = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(firstCall.data).toMatchObject({
      organizationId: ORG_ID,
      userId: "u-mgr-1",
      domain: "agent-card",
      title: "Card approval pending",
      body: "Alice submitted...",
      actionUrl: "/organization/agents/card-approvals?versionId=v1",
      read: false,
    });
  });

  it("writes nothing when no managers exist (does not throw)", async () => {
    mockDb.user.findMany.mockResolvedValueOnce([]);
    await notifyAllManagersInOrg({
      organizationId: ORG_ID,
      title: "x",
      body: "y",
      actionUrl: null,
    });
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("swallows DB errors so a notification failure cannot break the surrounding mutation", async () => {
    mockDb.user.findMany.mockRejectedValueOnce(new Error("connection lost"));
    // Must not throw.
    await expect(
      notifyAllManagersInOrg({
        organizationId: ORG_ID,
        title: "x",
        body: "y",
        actionUrl: null,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── notifyManagersOfPendingCard ─────────────────────────────────────────────

describe("notifyManagersOfPendingCard", () => {
  it("renders the verbatim spec body and stores RELATIVE actionUrl with versionId query", async () => {
    mockDb.user.findMany.mockResolvedValueOnce([{ id: "u-mgr" }]);
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });

    await notifyManagersOfPendingCard({
      organizationId: ORG_ID,
      versionId: VERSION_ID,
      agentName: "Alice",
      newTitle: "Senior Sales Manager",
    });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    // Body is the verbatim spec §11.1 string.
    expect(call.data.body).toBe(
      'Alice submitted card changes (title: "Senior Sales Manager"). Review.',
    );
    // Deeplink is RELATIVE — render-time prepends the SPA origin.
    expect(call.data.actionUrl).toBe(
      `/organization/agents/card-approvals?versionId=${VERSION_ID}`,
    );
    expect(call.data.domain).toBe("agent-card");
  });
});

// ── notifyAgentCardApproved ─────────────────────────────────────────────────

describe("notifyAgentCardApproved", () => {
  it("writes in-app to the user linked to the agent party, body includes the public URL", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });
    mockDb.party.findUnique.mockResolvedValueOnce({ whatsappPhone: null });

    await notifyAgentCardApproved({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
      publicToken: PUBLIC_TOKEN,
    });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.userId).toBe(USER_ID);
    expect(call.data.body).toBe(
      `Your e-namecard was approved. View: https://app.kason-hub.test/card/${PUBLIC_TOKEN}`,
    );
    expect(call.data.actionUrl).toBe("/portal/my-card");
  });

  it("writes in-app even when the agent has no linked portal user (userId=null)", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce(null); // no portal user yet
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });
    mockDb.party.findUnique.mockResolvedValueOnce({ whatsappPhone: null });

    await notifyAgentCardApproved({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
      publicToken: PUBLIC_TOKEN,
    });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.userId).toBeNull();
  });
});

// ── notifyAgentCardRejected ─────────────────────────────────────────────────

describe("notifyAgentCardRejected", () => {
  it("interpolates the reason text into the body verbatim", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });
    mockDb.party.findUnique.mockResolvedValueOnce({ whatsappPhone: null });

    await notifyAgentCardRejected({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
      reason: "Photo missing",
    });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.body).toBe(
      "Your e-namecard update was rejected. Reason: Photo missing. Edit & re-submit: https://app.kason-hub.test/portal/my-card",
    );
  });
});

// ── Reconfirm reminders (T-30, T-7, T-1) + cap reached ──────────────────────

describe("reconfirm reminders (spec §11 row 4)", () => {
  it("T-30 writes in-app with months interpolated", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });

    await notifyAgentReconfirmT30({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
      cardExpiryMonths: 6,
    });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.body).toBe(
      "Your e-namecard expires in 30 days. Re-confirm to extend by 6 months.",
    );
    // T-30 is in-app only; party.findUnique should NEVER be hit (no WhatsApp).
    expect(mockDb.party.findUnique).not.toHaveBeenCalled();
  });

  it("T-7 writes in-app + invokes WhatsApp resolution", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });
    mockDb.party.findUnique.mockResolvedValueOnce({ whatsappPhone: "+60123456789" });

    await notifyAgentReconfirmT7({ organizationId: ORG_ID, agentPartyId: PARTY_ID });

    expect(mockDb.notification.create).toHaveBeenCalled();
    expect(mockDb.party.findUnique).toHaveBeenCalledWith({
      where: { id: PARTY_ID },
      select: { whatsappPhone: true },
    });
  });

  it("T-1 writes in-app + invokes WhatsApp resolution", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });
    mockDb.party.findUnique.mockResolvedValueOnce({ whatsappPhone: "+60123456789" });

    await notifyAgentReconfirmT1({ organizationId: ORG_ID, agentPartyId: PARTY_ID });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.body).toBe(
      "Your e-namecard expires tomorrow. Re-confirm now: https://app.kason-hub.test/portal/my-card",
    );
    expect(mockDb.party.findUnique).toHaveBeenCalled();
  });

  it("cap-reached writes in-app + invokes WhatsApp resolution", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce({ id: USER_ID });
    mockDb.notification.create.mockResolvedValueOnce({ id: "n1" });
    mockDb.party.findUnique.mockResolvedValueOnce({ whatsappPhone: "+60123456789" });

    await notifyAgentReconfirmCapReached({
      organizationId: ORG_ID,
      agentPartyId: PARTY_ID,
    });

    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.body).toBe(
      "Your e-namecard has been re-confirmed 4 times. Submit fresh details for manager re-approval to keep your public link active: https://app.kason-hub.test/portal/my-card",
    );
    expect(mockDb.party.findUnique).toHaveBeenCalled();
  });
});
