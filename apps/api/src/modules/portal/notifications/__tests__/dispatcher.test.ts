import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchClaimNotification } from "../dispatcher";
import { StubSender } from "../../../../lib/whatsapp/stub-sender";

describe("dispatchClaimNotification", () => {
  let prisma: any;
  let sender: StubSender;
  beforeEach(() => {
    sender = new StubSender();
    prisma = {
      commissionClaim: {
        findUnique: vi.fn(async () => ({
          id: "claim-1",
          claimNumber: "NX-2026-0042",
          organizationId: "org-1",
          agentPartyId: "filer",
          totalNettPayout: { toString: () => "1234.50" },
          agent: { displayName: "Ahmad" },
        })),
      },
      party: {
        findUnique: vi.fn(async () => ({ uplineId: "u1" })),
        findMany: vi.fn(async () => [
          { id: "u1", whatsappPhone: "+60111", notifyOnNewClaim: true, status: "active", displayName: "U1" },
        ]),
      },
      user: { findMany: vi.fn(async () => []) },
      notificationLog: { create: vi.fn(async () => ({ id: "log-1" })) },
    };
  });

  it("sends to each resolved recipient and writes a NotificationLog row per send", async () => {
    await dispatchClaimNotification("claim-1", { prisma, sender, baseUrl: "https://x" });
    expect(sender.lastCall).toBeTruthy();
    expect(sender.lastCall!.to).toBe("+60111");
    expect(sender.lastCall!.templateName).toBe("new_claim_v1");
    expect(sender.lastCall!.variables).toEqual([
      "NX-2026-0042",
      "Ahmad",
      "1,234.50",
      "https://x/portal/claims/claim-1",
    ]);
    expect(prisma.notificationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          claimId: "claim-1",
          recipientPartyId: "u1",
          channel: "whatsapp",
          templateName: "new_claim_v1",
          status: "sent",
        }),
      }),
    );
  });

  it("logs failed when the sender returns ok=false; does not throw", async () => {
    const failing = {
      sendTemplate: vi.fn(async () => ({ ok: false as const, error: "invalid recipient", retriable: false })),
    };
    await dispatchClaimNotification("claim-1", { prisma, sender: failing, baseUrl: "https://x" });
    expect(prisma.notificationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          errorReason: "invalid recipient",
        }),
      }),
    );
  });

  it("is a no-op (does NOT throw) when claim doesn't exist", async () => {
    prisma.commissionClaim.findUnique.mockResolvedValueOnce(null);
    await expect(
      dispatchClaimNotification("missing", { prisma, sender, baseUrl: "https://x" }),
    ).resolves.toBeUndefined();
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
  });
});
