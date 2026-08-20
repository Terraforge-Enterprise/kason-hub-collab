// Shared "⋯" overflow menu for a single task — reused by the backlog row and the
// sprint Kanban card. Edit + Move-to-Backlog are available to everyone; Archive +
// Delete are manager/admin only (useAuth, mirroring task-drawer.tsx:103–104).
// Delete's confirm NAMES the linked ticket it will also destroy, because a
// unit-linked task's delete cascades to its ticket + history (Task.ticketId).
//
// The whole thing is wrapped in a stopPropagation container: the menu and its
// confirm dialogs are React-children of a clickable/draggable card, and React
// bubbles portal events through the component tree — without this, clicking the
// trigger or a dialog button would also open the drawer / start a drag.
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { useArchiveTask, useDeleteTask, type TaskRow } from "@/api/tasks";

export function TaskActionMenu({
  task,
  onEdit,
  onMoveToBacklog,
}: {
  task: TaskRow;
  onEdit: () => void;
  onMoveToBacklog?: () => void;
}) {
  const { user } = useAuth();
  const canManage = user?.role === "manager" || user?.role === "admin";
  const archiveTask = useArchiveTask();
  const deleteTask = useDeleteTask();
  const [confirm, setConfirm] = useState<null | "archive" | "delete">(null);

  const linkedUnit = task.ticketId && task.relatedUnit ? task.relatedUnit : null;

  return (
    <div
      className="shrink-0"
      draggable={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`task-menu-${task.id}`}
          aria-label="Task actions"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid={`task-action-edit-${task.id}`} onClick={onEdit}>
            Edit
          </DropdownMenuItem>
          {onMoveToBacklog && (
            <DropdownMenuItem
              data-testid={`task-action-move-backlog-${task.id}`}
              onClick={onMoveToBacklog}
            >
              Move to Backlog
            </DropdownMenuItem>
          )}
          {canManage && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid={`task-action-archive-${task.id}`}
                onClick={() => setConfirm("archive")}
              >
                Archive
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`task-action-delete-${task.id}`}
                onClick={() => setConfirm("delete")}
              >
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmAlert
        open={confirm === "archive"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          archiveTask.mutate(
            { taskId: task.id, updatedAt: task.updatedAt },
            {
              onSuccess: () => toast.success("Task archived"),
              onError: (err) => toast.error(err.message),
            },
          );
        }}
        title="Archive this task?"
        body="It leaves the board and moves to the Archived view. A manager can restore it later."
        confirmLabel="Archive"
      />

      <ConfirmAlert
        open={confirm === "delete"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          deleteTask.mutate(task.id, {
            onSuccess: () => toast.success("Task deleted"),
            onError: (err) => toast.error(err.message),
          });
        }}
        title="Permanently delete this task?"
        body={
          linkedUnit
            ? `This also deletes the ticket for ${linkedUnit.unitCode} · ${linkedUnit.propertyName} and its ticket history. This can't be undone.`
            : task.ticketId
              ? "This also deletes the linked ticket and its history. This can't be undone."
              : "This can't be undone."
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}
