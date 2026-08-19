import { FormDrawer } from "@/components/ui/form-drawer";
import { useDeactivateUser, useActivateUser } from "@/api/users";
import type { OperatorUser } from "@/api/users";

export type DeactivateMode = "deactivate" | "activate";

type Props = {
  open: boolean;
  mode: DeactivateMode;
  user: OperatorUser;
  onClose: () => void;
};

export function AdminDeactivateDrawer({ open, mode, user, onClose }: Props) {
  const deactivate = useDeactivateUser();
  const activate = useActivateUser();

  const isPending = deactivate.isPending || activate.isPending;

  function handleSubmit() {
    if (mode === "deactivate") {
      deactivate.mutate(user.id, { onSuccess: onClose });
    } else {
      activate.mutate(user.id, { onSuccess: onClose });
    }
  }

  const isDeactivate = mode === "deactivate";

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title={isDeactivate ? `Deactivate ${user.fullName}?` : `Activate ${user.fullName}?`}
      description={
        isDeactivate
          ? "The user will immediately lose the ability to log in."
          : "The user will be able to log in again."
      }
      onSubmit={handleSubmit}
      submit={{
        label: isDeactivate ? "Deactivate" : "Activate",
        pendingLabel: isDeactivate ? "Deactivating…" : "Activating…",
        variant: isDeactivate ? "destructive" : "gold",
        pending: isPending,
      }}
    >
      <div className="rounded-lg border border-border/50 bg-background/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground truncate">{user.fullName}</p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
          <span
            className={
              user.status === "active"
                ? "inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
            }
          >
            {user.status === "active" ? "Active" : "Disabled"}
          </span>
        </div>
      </div>
    </FormDrawer>
  );
}
