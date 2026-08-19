import { getDb } from "@kason/db";

export async function listNotifications(orgId: string) {
  const db = getDb();
  const rows = await db.notification.findMany({ where: { organizationId: orgId }, orderBy: [{ createdAt: "desc" }], take: 100 });
  return rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    title: row.title,
    body: row.body,
    read: row.read,
    actionUrl: row.actionUrl,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listNotificationQueue(orgId: string) {
  const db = getDb();
  const rows = await db.notificationQueue.findMany({ where: { organizationId: orgId }, orderBy: [{ createdAt: "desc" }], take: 100 });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    subject: row.subject,
    channel: row.channel,
    status: row.status,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createNotification(params: {
  organizationId: string;
  userId: string | null;
  domain: string;
  title: string;
  body: string;
  actionUrl: string | null;
}) {
  const db = getDb();
  return db.notification.create({
    data: {
      ...params,
      read: false,
    },
    select: { id: true },
  });
}

export async function enqueueNotification(params: {
  organizationId: string;
  type: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  body: string;
  channel: string;
}) {
  const db = getDb();
  return db.notificationQueue.create({
    data: {
      ...params,
      status: "pending",
    },
    select: { id: true },
  });
}
