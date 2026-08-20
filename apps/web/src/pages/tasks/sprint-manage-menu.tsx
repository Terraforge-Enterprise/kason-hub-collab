// Manager-only sprint controls: New / Start / Close / Edit. Start enables only
// for a selected planned sprint; Close only for the **selected** active sprint
// (multiple sprints may be active at once) and gates on a committed/completed/carried
// preview (close carries undone work to Backlog, which is irreversible). Editors see nothing (RoleGate min="manager").
import { useState } from "react";
import { toast } from "sonner";
import { RoleGate } from "@/components/role-gate";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import { useCloseSprint, useDeleteSprint, useStartSprint, type SprintRow } from "@/api/tasks";

export function SprintManageMenu({
  sprints,
  selected,
  onNew,
  onEdit,
  onDeleted,
}: {
  sprints: SprintRow[];
  selected: "backlog" | string;
  onNew: () => void;
  onEdit: (sprint: SprintRow) => void;
  onDeleted: () => void;
}) {
  const startSprint = useStartSprint();
  const closeSprint = useCloseSprint();
  const deleteSprint = useDeleteSprint();
  const [confirmClose, setConfirmClose] = useState<SprintRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SprintRow | null>(null);

  const selectedSprint =
    selected !== "backlog" ? sprints.find((s) => s.id === selected) ?? null : null;
  const canStart = selectedSprint?.status === "planned";
  const canClose = selectedSprint?.status === "active";
  const canDelete = !!selectedSprint && selectedSprint.status !== "completed";

  return (
    <RoleGate min="manager">
      <DropdownMenu>
        {/* VERIFIED row-parts.tsx shape: base-ui DropdownMenuTrigger renders a
            real <button>; style via className={buttonVariants(...)} + aria-label
            directly — NOT a render/asChild prop. */}
        <DropdownMenuTrigger
          data-testid="sprint-manage-menu"
          aria-label="Manage sprint"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Manage
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="sprint-action-new" onClick={onNew}>
            New Sprint
          </DropdownMenuItem>
          {selectedSprint && (
            <DropdownMenuItem
              data-testid="sprint-action-edit"
              onClick={() => onEdit(selectedSprint)}
            >
              Edit sprint
            </DropdownMenuItem>
          )}
          {canDelete && selectedSprint && (
            <DropdownMenuItem
              data-testid="sprint-action-delete"
              onClick={() => {
                const n = selectedSprint.summary.committed;
                if (n > 0) {
                  const noun = n === 1 ? "task" : "tasks";
                  const them = n === 1 ? "it" : "them";
                  toast.error(
                    `This sprint has ${n} ${noun} assigned. Move ${them} to another sprint or the Backlog before deleting.`,
                  );
                  return;
                }
                setConfirmDelete(selectedSprint);
              }}
            >
              Delete sprint
            </DropdownMenuItem>
          )}
          {canStart && selectedSprint && (
            <DropdownMenuItem
              data-testid="sprint-action-start"
              onClick={() =>
                startSprint.mutate(
                  { sprintId: selectedSprint.id, updatedAt: selectedSprint.updatedAt },
                  { onError: (err) => toast.error(err.message) },
                )
              }
            >
              Start sprint
            </DropdownMenuItem>
          )}
          {canClose && selectedSprint && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="sprint-action-close"
                onClick={() => setConfirmClose(selectedSprint)}
              >
                Close sprint
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmAlert
        open={confirmClose !== null}
        onCancel={() => setConfirmClose(null)}
        onConfirm={() => {
          const target = confirmClose;
          setConfirmClose(null);
          if (!target) return;
          closeSprint.mutate(
            { sprintId: target.id, updatedAt: target.updatedAt },
            { onError: (err) => toast.error(err.message) },
          );
        }}
        title="Close this sprint?"
        body={
          confirmClose ? (
            <span>
              {confirmClose.summary.committed} committed · {confirmClose.summary.completed}{" "}
              completed · {confirmClose.summary.carried} carried. The{" "}
              {confirmClose.summary.carried} unfinished{" "}
              {confirmClose.summary.carried === 1 ? "task" : "tasks"} return to the Backlog; Done
              tasks stay on this sprint's report.
            </span>
          ) : (
            ""
          )
        }
        confirmLabel="Close sprint"
      />

      <ConfirmAlert
        open={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (!target) return;
          deleteSprint.mutate(
            { sprintId: target.id, updatedAt: target.updatedAt },
            {
              onSuccess: () => {
                toast.success("Sprint deleted");
                onDeleted();
              },
              onError: (err) => toast.error(err.message),
            },
          );
        }}
        title="Delete this sprint?"
        body="This can't be undone."
        confirmLabel="Delete sprint"
        destructive
      />
    </RoleGate>
  );
}
