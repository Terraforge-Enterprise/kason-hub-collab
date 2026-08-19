import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { ActionButton, FeedbackMessage } from "@/components/form-ui";
import { NotificationTable, NotificationQueueTable } from "./notifications-table";
import { NotificationForms } from "./notifications-forms";
import type { NotificationListItem, NotificationQueueItem } from "./notifications-table";

type ProcessQueueResult = { data: { processed: number; sent: number; failed: number } };
type FeedbackState = { status: "idle" | "success" | "error"; message: string };

export default function NotificationsPage() {
  const queryClient = useQueryClient();
  const [processFeedback, setProcessFeedback] = useState<FeedbackState>({ status: "idle", message: "" });

  const processQueue = useMutation({
    mutationFn: () =>
      apiFetch<ProcessQueueResult>("/communications/process-queue", { method: "POST" }),
    onSuccess: (res) => {
      const { processed, sent, failed } = res.data;
      setProcessFeedback({
        status: "success",
        message: `Processed ${processed}: ${sent} sent, ${failed} failed`,
      });
      queryClient.invalidateQueries({ queryKey: ["communications", "notification-queue"] });
    },
    onError: (err: Error) => {
      setProcessFeedback({ status: "error", message: err.message });
    },
  });

  const notifications = useQuery({
    queryKey: ["communications", "notifications"],
    queryFn: () => apiFetch<{ data: NotificationListItem[] }>("/communications/notifications"),
  });

  const queue = useQuery({
    queryKey: ["communications", "notification-queue"],
    queryFn: () => apiFetch<{ data: NotificationQueueItem[] }>("/communications/notification-queue"),
  });

  const isLoading = notifications.isLoading || queue.isLoading;
  const hasError = notifications.isError || queue.isError;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (hasError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load notifications data. Please refresh.
      </p>
    );
  }

  const notificationList = notifications.data!.data;
  const queueList = queue.data!.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications control room"
        description="Manage in-app notification visibility and the outbound queue from one communications surface."
        metrics={[
          { label: "In-app", value: String(notificationList.length), hint: "Notification records" },
          {
            label: "Unread",
            value: String(notificationList.filter((item) => !item.read).length),
            hint: "Still awaiting attention",
          },
          { label: "Outbound queue", value: String(queueList.length), hint: "Queued or sent messages" },
          {
            label: "Pending send",
            value: String(queueList.filter((item) => item.status === "pending").length),
            hint: "Awaiting delivery",
          },
        ]}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <Surface
          title="In-app notifications"
          description="What users have already received inside the product."
        >
          <NotificationTable notifications={notificationList} />
        </Surface>
        <Surface
          title="Outbound queue"
          description="Email or channel delivery records waiting, sent, or failed."
        >
          <div className="mb-4 flex items-center gap-3">
            <ActionButton
              variant="primary"
              disabled={processQueue.isPending}
              onClick={() => {
                setProcessFeedback({ status: "idle", message: "" });
                processQueue.mutate();
              }}
            >
              {processQueue.isPending ? "Processing…" : "Process email queue"}
            </ActionButton>
            <FeedbackMessage status={processFeedback.status} message={processFeedback.message} />
          </div>
          <NotificationQueueTable queue={queueList} />
        </Surface>
      </div>
      <NotificationForms />
    </div>
  );
}
