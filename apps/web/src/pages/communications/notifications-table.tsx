import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { formatDateTime, getStatusTone } from "@/components/format";

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

export function NotificationTable({ notifications }: { notifications: NotificationListItem[] }) {
  const columns = [
    {
      key: "domain",
      label: "Domain",
      sortable: true,
      sortValue: (row: NotificationListItem) => row.domain,
      render: (row: NotificationListItem) => row.domain,
    },
    {
      key: "title",
      label: "Title",
      sortable: true,
      sortValue: (row: NotificationListItem) => row.title,
      render: (row: NotificationListItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.title}</span>
      ),
    },
    {
      key: "read",
      label: "Read",
      sortable: true,
      sortValue: (row: NotificationListItem) => (row.read ? 1 : 0),
      render: (row: NotificationListItem) => (
        <StatusPill tone={row.read ? "emerald" : "amber"}>{row.read ? "yes" : "no"}</StatusPill>
      ),
    },
    {
      key: "createdAt",
      label: "Created",
      sortable: true,
      sortValue: (row: NotificationListItem) => row.createdAt,
      render: (row: NotificationListItem) => formatDateTime(row.createdAt),
    },
  ];

  return (
    <EnhancedDataTable
      data={notifications}
      columns={columns}
      searchPlaceholder="Search notifications..."
      searchKeys={["domain", "title"]}
      emptyMessage="No notifications yet."
    />
  );
}

export function NotificationQueueTable({ queue }: { queue: NotificationQueueItem[] }) {
  const columns = [
    {
      key: "recipientEmail",
      label: "Recipient",
      sortable: true,
      sortValue: (row: NotificationQueueItem) => row.recipientEmail,
      render: (row: NotificationQueueItem) => row.recipientEmail,
    },
    {
      key: "subject",
      label: "Subject",
      sortable: true,
      sortValue: (row: NotificationQueueItem) => row.subject,
      render: (row: NotificationQueueItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.subject}</span>
      ),
    },
    {
      key: "channel",
      label: "Channel",
      sortable: true,
      sortValue: (row: NotificationQueueItem) => row.channel,
      render: (row: NotificationQueueItem) => row.channel,
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: NotificationQueueItem) => row.status,
      render: (row: NotificationQueueItem) => (
        <StatusPill tone={getStatusTone(row.status)}>{row.status}</StatusPill>
      ),
    },
    {
      key: "createdAt",
      label: "Created",
      sortable: true,
      sortValue: (row: NotificationQueueItem) => row.createdAt,
      render: (row: NotificationQueueItem) => formatDateTime(row.createdAt),
    },
  ];

  return (
    <EnhancedDataTable
      data={queue}
      columns={columns}
      searchPlaceholder="Search queue..."
      searchKeys={["recipientEmail", "subject", "channel"]}
      emptyMessage="No queued notifications yet."
    />
  );
}
