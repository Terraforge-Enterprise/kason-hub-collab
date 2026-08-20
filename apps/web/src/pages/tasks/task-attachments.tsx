// Task attachments — thin wrapper over the shared AttachmentsPanel
// (@/components/attachments-panel, extracted from this file when the ticket
// drawer needed the identical UI). Owns the task-scoped hooks: signed-url
// query, remove mutation, and the upload queue against the tasks
// mint/complete endpoints.
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AttachmentsPanel } from "@/components/attachments-panel";
import {
  TASKS_KEY,
  taskAttachmentsKey,
  useRemoveTaskAttachment,
  useTaskAttachmentUrls,
} from "@/api/tasks";
import { usePhase2AttachmentUpload } from "@/hooks/use-phase2-attachment-upload";

export function TaskAttachments({
  taskId,
  attachmentKeys,
}: {
  taskId: string;
  attachmentKeys: string[];
}) {
  const qc = useQueryClient();
  const urlsQuery = useTaskAttachmentUrls(taskId);
  const removeAttachment = useRemoveTaskAttachment();

  const upload = usePhase2AttachmentUpload({
    mintPath: `/tasks/${taskId}/attachments/upload-url`,
    completePath: `/tasks/${taskId}/attachments/complete`,
    onUploaded: () => {},
    onCompleted: () => {
      qc.invalidateQueries({ queryKey: taskAttachmentsKey(taskId) });
      qc.invalidateQueries({ queryKey: TASKS_KEY });
    },
  });

  return (
    <AttachmentsPanel
      entries={urlsQuery.data?.data}
      fallbackKeys={attachmentKeys}
      upload={upload}
      noun="task"
      onRemove={(key) =>
        removeAttachment.mutate(
          { taskId, key },
          { onError: (err) => toast.error(err.message) },
        )
      }
    />
  );
}
