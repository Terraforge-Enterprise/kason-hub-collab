import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import type { CommissionSettingsResponse } from "@kason/shared";
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
  useCreateRoomType,
  useDeleteRoomType,
  useUpdateRoomType,
} from "@/hooks/use-commission-settings";

type RoomType = CommissionSettingsResponse["roomTypes"][number];
type Draft = { name: string; sortOrder: number; isActive: boolean };

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

/**
 * Section 3 — Room types.
 *
 * Global dropdown list shown on the portal claim form. Super Admin can
 * add, edit (name, sortOrder, isActive), and delete. Deactivating hides
 * the row from the portal dropdown but leaves existing claims untouched.
 */
export function RoomTypesSection({
  roomTypes,
  canWrite,
}: {
  roomTypes: RoomType[];
  canWrite: boolean;
}) {
  const create = useCreateRoomType();
  const update = useUpdateRoomType();
  const remove = useDeleteRoomType();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [deleteTarget, setDeleteTarget] = useState<RoomType | null>(null);

  const sorted = [...roomTypes].sort((a, b) => a.sortOrder - b.sortOrder);
  const activeCount = roomTypes.filter((r) => r.isActive).length;
  const inactiveCount = roomTypes.length - activeCount;

  const getDraft = (r: RoomType): Draft =>
    drafts[r.id] ?? { name: r.name, sortOrder: r.sortOrder, isActive: r.isActive };

  function save(r: RoomType) {
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
        onError: (err) => toast.error(err.message || "Failed to save"),
      },
    );
  }

  function handleDelete(target: RoomType) {
    remove.mutate(target.id, {
      onSuccess: () => {
        toast.success(`Room type "${target.name}" deleted.`);
        setDeleteTarget(null);
      },
      onError: (err) => toast.error(err.message || "Failed to delete"),
    });
  }

  return (
    <>
      <Surface
        title="Room Types"
        description="Global list of room-type options shown on the portal claim form."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total: {roomTypes.length}</Badge>
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
                      No room types configured.
                    </td>
                  </tr>
                ) : (
                  sorted.map((r) => {
                    const d = getDraft(r);
                    const dirty =
                      d.name !== r.name ||
                      d.isActive !== r.isActive;
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
                                setDrafts({
                                  ...drafts,
                                  [r.id]: { ...d, isActive: !d.isActive },
                                })
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
                          {r.updatedAt ? formatDate(r.updatedAt) : "-"}
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
            <AddRoomTypeForm
              nextSortOrder={(sorted[sorted.length - 1]?.sortOrder ?? 0) + 1}
              onAdd={(input) =>
                create.mutate(input, {
                  onSuccess: () => toast.success("Room type created"),
                  onError: (err) => toast.error(err.message || "Failed to create"),
                })
              }
              isPending={create.isPending}
            />
          )}
        </div>
      </Surface>

      {/* Delete confirm dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the room type. Existing claims that already reference it are unaffected, but the portal claim form will no longer offer it as an option.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AddRoomTypeForm({
  nextSortOrder,
  onAdd,
  isPending,
}: {
  nextSortOrder: number;
  onAdd: (input: { name: string; sortOrder?: number; isActive?: boolean }) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Plus className="h-4 w-4 text-[var(--text-muted)]" />
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">Add new room type</h4>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid flex-1 gap-1 min-w-[16rem]">
          <span className="text-xs font-medium text-[var(--text-muted)]">Room type name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Private (with bathroom)"
            className={`min-h-9 w-full ${INPUT_BASE} px-3 py-2`}
          />
        </div>
        <Button
          size="sm"
          disabled={!name.trim() || isPending}
          onClick={() => {
            onAdd({ name: name.trim(), sortOrder: nextSortOrder, isActive: true });
            setName("");
          }}
        >
          {isPending ? "Adding…" : "Add room type"}
        </Button>
      </div>
    </div>
  );
}
