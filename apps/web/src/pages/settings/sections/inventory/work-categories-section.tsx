import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { formatDate } from "@/components/format";
import {
  useWorkCategories,
  useWorkCategoryUsage,
  useCreateWorkCategory,
  useDeleteWorkCategory,
  useUpdateWorkCategory,
} from "@/hooks/use-work-categories";
import type { WorkCategory } from "@/api/inventory-work-categories";

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

type Draft = { name: string; sortOrder: number; isActive: boolean };

export function WorkCategoriesSection({ canWrite }: { canWrite: boolean }) {
  const { data: rows = [], isLoading, isError } = useWorkCategories();
  const create = useCreateWorkCategory();
  const update = useUpdateWorkCategory();
  const remove = useDeleteWorkCategory();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [deleteTarget, setDeleteTarget] = useState<WorkCategory | null>(null);

  const usage = useWorkCategoryUsage(deleteTarget?.id ?? null, !!deleteTarget);

  const sorted = [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const activeCount = rows.filter((r) => r.isActive).length;
  const inactiveCount = rows.length - activeCount;

  const getDraft = (r: WorkCategory): Draft =>
    drafts[r.id] ?? { name: r.name, sortOrder: r.sortOrder, isActive: r.isActive };

  function save(r: WorkCategory) {
    const d = getDraft(r);
    if (!d.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    update.mutate(
      { id: r.id, name: d.name.trim(), sortOrder: d.sortOrder, isActive: d.isActive },
      {
        onSuccess: () => {
          setDrafts((prev) => {
            const n = { ...prev };
            delete n[r.id];
            return n;
          });
          toast.success("Saved");
        },
        onError: (err: Error) => toast.error(err.message || "Failed to save"),
      },
    );
  }

  function deactivate(r: WorkCategory) {
    update.mutate(
      { id: r.id, isActive: false },
      {
        onSuccess: () => {
          toast.success(`Category "${r.name}" deactivated.`);
          setDeleteTarget(null);
        },
        onError: (err: Error) => toast.error(err.message || "Failed to deactivate"),
      },
    );
  }

  function handleDelete(target: WorkCategory) {
    remove.mutate(target.id, {
      onSuccess: () => {
        toast.success(`Category "${target.name}" deleted.`);
        setDeleteTarget(null);
      },
      onError: (err: Error) => toast.error(err.message || "Failed to delete"),
    });
  }

  if (isLoading) {
    return (
      <Surface title="Work Categories" description="Loading...">
        <div className="p-6 text-sm text-muted-foreground">Loading category catalog…</div>
      </Surface>
    );
  }
  if (isError) {
    return (
      <Surface title="Work Categories" description="Error">
        <div className="p-6 text-sm text-rose-500">Failed to load categories. Refresh.</div>
      </Surface>
    );
  }

  return (
    <>
      <Surface
        title="Work Categories"
        description="Shared category list for tickets and board tasks."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total: {rows.length}</Badge>
          <Badge variant="emerald">Active: {activeCount}</Badge>
          {inactiveCount > 0 && <Badge variant="rose">Inactive: {inactiveCount}</Badge>}
        </div>
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold w-32">Status</th>
                  <th className="px-4 py-3 font-semibold w-36">Last Updated</th>
                  {canWrite && <th className="px-4 py-3 font-semibold w-40 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canWrite ? 4 : 3}
                      className="px-4 py-10 text-center text-sm text-[var(--text-muted)]"
                    >
                      No categories defined yet.
                    </td>
                  </tr>
                ) : (
                  sorted.map((r) => {
                    const d = getDraft(r);
                    const dirty =
                      d.name !== r.name || d.sortOrder !== r.sortOrder || d.isActive !== r.isActive;
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                      >
                        <td className="px-4 py-3.5">
                          <input
                            type="text"
                            disabled={!canWrite}
                            value={d.name}
                            onChange={(e) =>
                              setDrafts({ ...drafts, [r.id]: { ...d, name: e.target.value } })
                            }
                            className={`w-full max-w-xs ${INPUT_BASE}`}
                          />
                        </td>
                        <td className="px-4 py-3.5">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() =>
                                setDrafts({ ...drafts, [r.id]: { ...d, isActive: !d.isActive } })
                              }
                              className="cursor-pointer"
                            >
                              {d.isActive ? (
                                <Badge variant="emerald">Active</Badge>
                              ) : (
                                <Badge variant="rose">Inactive</Badge>
                              )}
                            </button>
                          ) : d.isActive ? (
                            <Badge variant="emerald">Active</Badge>
                          ) : (
                            <Badge variant="rose">Inactive</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">
                          {formatDate(r.updatedAt)}
                        </td>
                        {canWrite && (
                          <td className="px-4 py-3.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                disabled={!dirty || update.isPending}
                                onClick={() => save(r)}
                              >
                                {update.isPending ? "Saving…" : "Save"}
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={remove.isPending}
                                onClick={() => setDeleteTarget(r)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {canWrite && (
            <AddWorkCategoryForm
              nextSortOrder={(sorted[sorted.length - 1]?.sortOrder ?? 0) + 1}
              onAdd={(input) =>
                create.mutate(input, {
                  onSuccess: () => toast.success("Category created"),
                  onError: (err: Error) => toast.error(err.message || "Failed to create"),
                })
              }
              isPending={create.isPending}
            />
          )}
        </div>
      </Surface>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <div className="space-y-3">
                {usage.isLoading && <p>Counting affected tickets and tasks…</p>}
                {usage.data && (
                  <>
                    <p>
                      <strong>
                        This category is referenced by {usage.data.ticketCount} ticket
                        {usage.data.ticketCount === 1 ? "" : "s"} and {usage.data.taskCount} task
                        {usage.data.taskCount === 1 ? "" : "s"}.
                      </strong>
                    </p>
                    <p>
                      Deleting it will remove the category from each one. To hide the category
                      without losing existing data, deactivate it instead.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={update.isPending || !deleteTarget}
              onClick={() => deleteTarget && deactivate(deleteTarget)}
            >
              {update.isPending ? "Deactivating…" : "Deactivate instead"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending || !deleteTarget}
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AddWorkCategoryForm({
  nextSortOrder,
  onAdd,
  isPending,
}: {
  nextSortOrder: number;
  onAdd: (input: { name: string; sortOrder?: number }) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Plus className="h-4 w-4 text-[var(--text-muted)]" />
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">Add new category</h4>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid flex-1 gap-1 min-w-[16rem]">
          <span className="text-xs font-medium text-[var(--text-muted)]">Category name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Plumbing"
            className={`min-h-9 w-full ${INPUT_BASE} px-3 py-2`}
          />
        </div>
        <Button
          size="sm"
          disabled={!name.trim() || isPending}
          onClick={() => {
            onAdd({ name: name.trim(), sortOrder: nextSortOrder });
            setName("");
          }}
        >
          {isPending ? "Adding…" : "Add category"}
        </Button>
      </div>
    </div>
  );
}
