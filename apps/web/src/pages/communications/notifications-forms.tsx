import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import {
  ActionButton,
  FeedbackMessage,
  Field,
  FormCard,
  FormGrid,
  SelectInput,
  TextAreaInput,
  TextInput,
} from "@/components/form-ui";

type FeedbackState = { status: "idle" | "success" | "error"; message: string };

const idle: FeedbackState = { status: "idle", message: "" };

function getFormData(e: React.FormEvent<HTMLFormElement>): Record<string, string> {
  const fd = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

export function NotificationForms() {
  const queryClient = useQueryClient();

  // ── Create In-App Notification ────────────────────────────────────────────
  const [createFeedback, setCreateFeedback] = useState<FeedbackState>(idle);
  const createNotification = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch("/communications/notifications", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCreateFeedback({ status: "success", message: "Notification created." });
      queryClient.invalidateQueries({ queryKey: ["communications"] });
    },
    onError: (err: Error) => {
      setCreateFeedback({ status: "error", message: err.message });
    },
  });

  // ── Enqueue Outbound Notification ─────────────────────────────────────────
  const [queueFeedback, setQueueFeedback] = useState<FeedbackState>(idle);
  const enqueueNotification = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch("/communications/notification-queue", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setQueueFeedback({ status: "success", message: "Notification enqueued." });
      queryClient.invalidateQueries({ queryKey: ["communications"] });
    },
    onError: (err: Error) => {
      setQueueFeedback({ status: "error", message: err.message });
    },
  });

  return (
    <FormGrid className="xl:grid-cols-2">
      {/* Create In-App Notification */}
      <FormCard
        title="Create in-app notification"
        description="Notify a specific user or broadcast an operational update inside the product."
        onSubmit={(e) => {
          e.preventDefault();
          setCreateFeedback(idle);
          createNotification.mutate(getFormData(e));
        }}
      >
        <Field label="Target userId" hint="Optional. Leave blank for organization-level notifications.">
          <TextInput name="userId" placeholder="Target userId (optional)" />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Domain">
            <TextInput name="domain" placeholder="general" required defaultValue="general" />
          </Field>
          <Field label="Title">
            <TextInput name="title" placeholder="Title" required />
          </Field>
        </div>
        <Field label="Body">
          <TextAreaInput name="body" placeholder="Body" required />
        </Field>
        <Field label="Action URL" hint="Optional destination when the user clicks the notification.">
          <TextInput name="actionUrl" placeholder="Action URL (optional)" />
        </Field>
        <ActionButton type="submit" variant="primary" disabled={createNotification.isPending}>
          {createNotification.isPending ? "Creating…" : "Create notification"}
        </ActionButton>
        <FeedbackMessage status={createFeedback.status} message={createFeedback.message} />
      </FormCard>

      {/* Enqueue Outbound Notification */}
      <FormCard
        title="Enqueue outbound notification"
        description="Build the outgoing message queue record for delivery channels like email."
        onSubmit={(e) => {
          e.preventDefault();
          setQueueFeedback(idle);
          enqueueNotification.mutate(getFormData(e));
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Type">
            <TextInput name="type" placeholder="general" required defaultValue="general" />
          </Field>
          <Field label="Channel">
            <SelectInput name="channel" required defaultValue="email">
              <option value="email">email</option>
              <option value="sms">sms</option>
              <option value="push">push</option>
              <option value="whatsapp">whatsapp</option>
            </SelectInput>
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Recipient email">
            <TextInput name="recipientEmail" type="email" placeholder="Recipient email" required />
          </Field>
          <Field label="Recipient name">
            <TextInput name="recipientName" placeholder="Recipient name (optional)" />
          </Field>
        </div>
        <Field label="Subject">
          <TextInput name="subject" placeholder="Subject" required />
        </Field>
        <Field label="Body">
          <TextAreaInput name="body" placeholder="Body" required />
        </Field>
        <ActionButton type="submit" variant="secondary" disabled={enqueueNotification.isPending}>
          {enqueueNotification.isPending ? "Enqueueing…" : "Enqueue notification"}
        </ActionButton>
        <FeedbackMessage status={queueFeedback.status} message={queueFeedback.message} />
      </FormCard>
    </FormGrid>
  );
}
