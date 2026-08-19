// apps/api/src/modules/reservations/email.ts

import type { Prisma } from "@kason/db";

export function buildSignLinkUrl(token: string): string {
  const base = process.env.WEB_BASE_URL ?? "https://kason-uat.example.com";
  return `${base}/reserve/${token}`;
}

export async function queueSignLinkEmailTx(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    recipientEmail: string;
    referenceCode: string;
    token: string;
    expiresAt: Date;
  },
) {
  const link = buildSignLinkUrl(args.token);
  const subject = `Action required: Sign your Unit Reservation Form (${args.referenceCode})`;
  const body = [
    `A Unit Reservation Form has been prepared for you.`,
    ``,
    `Reference: ${args.referenceCode}`,
    `Link expires: ${args.expiresAt.toUTCString()}`,
    ``,
    `Review and sign here:`,
    link,
    ``,
    `If the link does not work, copy and paste it into your browser.`,
  ].join("\n");

  await tx.notificationQueue.create({
    data: {
      organizationId: args.orgId,
      type: "reservation_sign_link",
      recipientEmail: args.recipientEmail,
      subject,
      body,
      channel: "email",
      status: "pending",
    },
  });
}

export async function queueSignedConfirmationEmailTx(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    recipientEmail: string;
    referenceCode: string;
    signedPdfDownloadUrl: string;
  },
) {
  await tx.notificationQueue.create({
    data: {
      organizationId: args.orgId,
      type: "reservation_signed_confirmation",
      recipientEmail: args.recipientEmail,
      subject: `Your reservation ${args.referenceCode} is signed`,
      body: [
        `Thank you for signing your Unit Reservation Form (${args.referenceCode}).`,
        ``,
        `Download your signed copy:`,
        args.signedPdfDownloadUrl,
        ``,
        `The link is valid for 24 hours. Reply to this email if you need a fresh copy.`,
      ].join("\n"),
      channel: "email",
      status: "pending",
    },
  });
}

export async function queueAgentNotifyEmailTx(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    recipientEmail: string;
    referenceCode: string;
  },
) {
  await tx.notificationQueue.create({
    data: {
      organizationId: args.orgId,
      type: "reservation_signed_agent_notify",
      recipientEmail: args.recipientEmail,
      subject: `Customer signed reservation ${args.referenceCode}`,
      body: `The applicant for reservation ${args.referenceCode} has completed signing.`,
      channel: "email",
      status: "pending",
    },
  });
}
