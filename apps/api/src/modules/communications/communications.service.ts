import type { z } from "zod";
import type { CommunicationsSession } from "./communications.types";
import {
  createNotification,
  enqueueNotification,
  listNotificationQueue,
  listNotifications,
} from "./communications.repository";
import {
  createNotificationSchema,
  enqueueNotificationSchema,
} from "./communications.validation";

export async function getNotificationsService(session: CommunicationsSession) {
  return listNotifications(session.orgId);
}

export async function getNotificationQueueService(session: CommunicationsSession) {
  return listNotificationQueue(session.orgId);
}

export async function createNotificationService(session: CommunicationsSession, input: z.infer<typeof createNotificationSchema>) {
  const notification = await createNotification({
    organizationId: session.orgId,
    userId: input.userId || null,
    domain: input.domain,
    title: input.title,
    body: input.body,
    actionUrl: input.actionUrl || null,
  });
  return { ok: true as const, status: 201, data: notification };
}

export async function enqueueNotificationService(session: CommunicationsSession, input: z.infer<typeof enqueueNotificationSchema>) {
  const row = await enqueueNotification({
    organizationId: session.orgId,
    type: input.type || "general",
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName || null,
    subject: input.subject,
    body: input.body,
    channel: input.channel || "email",
  });
  return { ok: true as const, status: 201, data: row };
}
