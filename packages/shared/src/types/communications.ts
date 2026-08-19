export type NotificationListItem = {
  id: string;
  domain: string;
  title: string;
  body: string;
  read: boolean;
  actionUrl: string | null;
  createdAt: string;
};

export type NotificationQueueItem = {
  id: string;
  type: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  channel: string;
  status: string;
  sentAt: string | null;
  errorMessage: string | null;
  createdAt: string;
};
