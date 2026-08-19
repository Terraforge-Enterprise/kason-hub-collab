import type { PrismaClient } from "@prisma/client";
import type { WhatsAppSender } from "../../../lib/whatsapp";
import { resolveRecipients } from "./recipients";

const TEMPLATE_NAME = "new_claim_v1";
const TEMPLATE_LANG = "en";

type Deps = {
  prisma: PrismaClient | any;
  sender: WhatsAppSender;
  baseUrl: string;
};

function formatRM(decimalish: { toString: () => string } | string): string {
  const n = Number(typeof decimalish === "string" ? decimalish : decimalish.toString());
  return n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Side-effecting worker. Loads the claim, resolves recipients, sends one
 * WhatsApp template per recipient, logs each result. Never throws — caller
 * fires this and forgets.
 */
export async function dispatchClaimNotification(claimId: string, deps: Deps): Promise<void> {
  const { prisma, sender, baseUrl } = deps;
  try {
    const claim = await prisma.commissionClaim.findUnique({
      where: { id: claimId },
      select: {
        id: true,
        claimNumber: true,
        organizationId: true,
        agentPartyId: true,
        totalNettPayout: true,
        agent: { select: { displayName: true } },
      },
    });
    if (!claim) return;

    const recipients = await resolveRecipients(claim.agentPartyId, claim.organizationId, prisma);
    if (recipients.length === 0) return;

    const link = `${baseUrl.replace(/\/$/, "")}/portal/claims/${claim.id}`;
    const variables = [
      claim.claimNumber,
      claim.agent?.displayName ?? "An agent",
      formatRM(claim.totalNettPayout),
      link,
    ];

    for (const recipient of recipients) {
      const result = await sender.sendTemplate({
        to: recipient.whatsappPhone,
        templateName: TEMPLATE_NAME,
        languageCode: TEMPLATE_LANG,
        variables,
      });
      try {
        await prisma.notificationLog.create({
          data: {
            organizationId: claim.organizationId,
            claimId: claim.id,
            recipientPartyId: recipient.id,
            channel: "whatsapp",
            templateName: TEMPLATE_NAME,
            status: result.ok ? "sent" : "failed",
            providerMessageId: result.ok ? result.providerMessageId : null,
            errorReason: result.ok ? null : result.error,
          },
        });
      } catch (logErr) {
        console.error("[notifications] failed to write NotificationLog:", logErr);
      }
    }
  } catch (err) {
    console.error("[notifications] dispatcher error:", err);
  }
}

/**
 * Fire-and-forget wrapper. Called from submitClaimService after tx commit.
 * Returns immediately; the actual send happens in the background.
 */
export function enqueueClaimNotification(claimId: string, deps: Deps): void {
  void dispatchClaimNotification(claimId, deps);
}
