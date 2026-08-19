import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  useCreateRoomType,
  useDeleteRoomType,
  useUpdateRoomType,
  COMMISSION_SETTINGS_KEY,
} from "@/hooks/use-commission-settings";

// ── Types ───────────────────────────────────────────────────────────────────

type RoomTypeRow = {
  id: string;
  name: string;
  kind: "WHOLE" | "PARTITION";
  sortOrder: number;
  isActive: boolean;
  updatedAt?: string;
};

type Draft = { name: string; sortOrder: number; isActive: boolean; kind: "WHOLE" | "PARTITION" };

type FlipConfirmState = {
  row: RoomTypeRow;
  draft: Draft;
  activeUnitCount: number;
};

// ── Query key ────────────────────────────────────────────────────────────────

export const UNIT_TYPES_QUERY_KEY = ["inventory-settings", "unit-types"] as const;

// ── Data hook ────────────────────────────────────────────────────────────────

function useUnitTypes() {
  return useQuery({
    queryKey: UNIT_TYPES_QUERY_KEY,
    queryFn: () =>
      apiFetch<{ data: RoomTypeRow[] }>("/commissions/room-types").then((res) => res.data),
    staleTime: 30_000,
  });
}

// ── Styles ───────────────────────────────────────────────────────────────────

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

// ── Main section component ───────────────────────────────────────────────────

/**
 * Unit Types section for Inventory Settings.
 *
 * Global list of unit-type options shown on the Create Unit form and the
 * commission claim form. Kind controls whether the type rents the whole
 * unit or just one partition.
 *
 * Reads from /commissions/room-types independently (does not couple to the
 * commission-settings aggregate query). Mutations reuse the commission hooks
 * and invalidate both query keys so the Commission Settings page stays
 * consistent until T15 removes its Room Types section.
 */
export function UnitTypesSection({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const { data: unitTypes = [], isLoading } = useUnitTypes();

  const create = useCreateRoomType();
  const update = useUpdateRoomType();
  const remove = useDeleteRoomType();

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [deleteTarget, setDeleteTarget] = useState<RoomTypeRow | null>(null);
  const [flipConfirm, setFlipConfirm] = useState<FlipConfirmState | null>(null);

  const sorted = [...unitTypes].sort((a, b) => a.sortOrder - b.sortOrder);
  const activeCount = unitTypes.filter((r) => r.isActive).length;
  const inactiveCount = unitTypes.length - activeCount;

  const getDraft = (r: RoomTypeRow): Draft =>
    drafts[r.id] ?? {
      name: r.name,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      kind: r.kind,
    };

  // Invalidate both query keys so Commission Settings (until T15) stays fresh
  function invalidateAll() {
    qc.invalidateQueries({ queryKey: UNIT_TYPES_QUERY_KEY });
    qc.invalidateQueries({ queryKey: COMMISSION_SETTINGS_KEY });
    qc.invalidateQueries({ queryKey: ["commissions", "room-types"] });
    qc.invalidateQueries({ queryKey: ["portal", "room-types"] });
  }

  function clearDraft(id: string) {
    setDrafts((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
  }

  // Perform the actual update mutation (called both directly and from flip-confirm dialog)
  function commitUpdate(r: RoomTypeRow, d: Draft) {
    update.mutate(
      { id: r.id, name: d.name.trim(), sortOrder: d.sortOrder, isActive: d.isActive, kind: d.kind },
      {
        onSuccess: () => {
          clearDraft(r.id);
          invalidateAll();
          toast.success("Saved");
        },
        onError: (err) => toast.error((err as Error).message || "Failed to save"),
      },
    );
  }

  async function save(r: RoomTypeRow) {
    const d = getDraft(r);
    if (!d.name.trim()) {
      toast.error("Name is required.");
      return;
    }

    // Guard kind-flip: check active unit count before allowing the change
    if (d.kind !== r.kind) {
      try {
        const usage = await apiFetch<{ activeUnitCount: number }>(
          `/commissions/room-types/${r.id}/usage`,
        );
        if (usage.activeUnitCount > 0) {
          setFlipConfirm({ row: r, draft: d, activeUnitCount: usage.activeUnitCount });
          return;
        }
      } catch {
        // If usage check fails, still allow the save (best-effort guard)
      }
    }

    commitUpdate(r, d);
  }

  function handleDelete(target: RoomTypeRow) {
    remove.mutate(target.id, {
      onSuccess: () => {
        invalidateAll();
        toast.success(`Unit type "${target.name}" deleted.`);
        setDeleteTarget(null);
      },
      onError: (err) => {
        const apiErr = err as ApiError;
        if (apiErr.code === "ROOMTYPE_IN_USE") {
          // The 409 body is { code, activeUnitCount, suggestion } (flat, no wrapper).
          const count = (apiErr.data as { activeUnitCount?: number } | null)?.activeUnitCount;
          const msg =
            count != null
              ? `Cannot delete: ${count} active unit${count !== 1 ? "s" : ""} use this type. Deactivate (set Inactive) instead.`
              : "Cannot delete: active units use this type. Deactivate (set Inactive) instead.";
          toast.error(msg);
        } else {
          toast.error((err as Error).message || "Failed to delete");
        }
        setDeleteTarget(null);
      },
    });
  }

  if (isLoading) {
    return (
      <Surface title="Unit Types" description="Loading…">
        <div className="py-10 text-center text-sm text-[var(--text-muted)]">Loading unit types…</div>
      </Surface>
    );
  }

  return (
    <>
      <Surface
        title="Unit Types"
        description="Global list of unit-type options shown on the Create Unit form and the commission claim form. Kind controls whether the type rents the whole unit or just one partition."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total: {unitTypes.length}</Badge>
          <Badge variant="emerald">Active: {activeCount}</Badge>
          {inactiveCount > 0 && <Badge variant="rose">Inactive: {inactiveCount}</Badge>}
        </div>
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold w-32">Kind</th>
                  <th className="px-4 py-3 font-semibold w-32">Status</th>
                  <th className="px-4 py-3 font-semibold w-36">Last Updated</th>
                  {canWrite && <th className="px-4 py-3 font-semibold w-40 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canWrite ? 5 : 4}
                      className="px-4 py-10 text-center text-sm text-[var(--text-muted)]"
                    >
                      No unit types configured.
                    </td>
                  </tr>
                ) : (
                  sorted.map((r) => {
                    const d = getDraft(r);
                    const dirty =
                      d.name !== r.name ||
                      d.isActive !== r.isActive ||
                      d.kind !== r.kind;
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                      >
                        {/* Name */}
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
                        {/* Kind */}
                        <td className="px-4 py-3.5">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() =>
                                setDrafts({
                                  ...drafts,
                                  [r.id]: {
                                    ...d,
                                    kind: d.kind === "WHOLE" ? "PARTITION" : "WHOLE",
                                  },
                                })
                              }
                              className="cursor-pointer"
                            >
                              <Badge variant={d.kind === "WHOLE" ? "emerald" : "amber"}>
                                {d.kind === "WHOLE" ? "Whole" : "Partitioned"}
                              </Badge>
                            </button>
                          ) : (
                            <Badge variant={d.kind === "WHOLE" ? "emerald" : "amber"}>
                              {d.kind === "WHOLE" ? "Whole" : "Partitioned"}
                            </Badge>
                          )}
                        </td>
                        {/* Status */}
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
                        {/* Last Updated */}
                        <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">
                          {r.updatedAt ? formatDate(r.updatedAt) : "-"}
                        </td>
                        {/* Actions */}
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
            <AddUnitTypeForm
              nextSortOrder={(sorted[sorted.length - 1]?.sortOrder ?? 0) + 1}
              onAdd={(input) =>
                create.mutate(input, {
                  onSuccess: () => {
                    invalidateAll();
                    toast.success("Unit type created");
                  },
                  onError: (err) => toast.error((err as Error).message || "Failed to create"),
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
              This will permanently remove the unit type. Existing claims and units that already
              reference it are unaffected, but the Create Unit form and commission claim form will
              no longer offer it as an option.
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

      {/* Kind-flip confirm dialog */}
      <AlertDialog
        open={!!flipConfirm}
        onOpenChange={(o) => !o && setFlipConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change listing kind?</AlertDialogTitle>
            <AlertDialogDescription>
              {flipConfirm?.activeUnitCount} active unit
              {flipConfirm && flipConfirm.activeUnitCount !== 1 ? "s" : ""} use this type.
              Changing the kind will change those units' listing modes. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => {
                if (flipConfirm) {
                  commitUpdate(flipConfirm.row, flipConfirm.draft);
                  setFlipConfirm(null);
                }
              }}
            >
              {update.isPending ? "Saving…" : "Continue"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFlipConfirm(null)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Add form ─────────────────────────────────────────────────────────────────

function AddUnitTypeForm({
  nextSortOrder,
  onAdd,
  isPending,
}: {
  nextSortOrder: number;
  onAdd: (input: { name: string; kind: "WHOLE" | "PARTITION"; sortOrder?: number; isActive?: boolean }) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"WHOLE" | "PARTITION">("PARTITION");

  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Plus className="h-4 w-4 text-[var(--text-muted)]" />
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">Add new unit type</h4>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid flex-1 gap-1 min-w-[16rem]">
          <span className="text-xs font-medium text-[var(--text-muted)]">Unit type name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Private (with bathroom)"
            className={`min-h-9 w-full ${INPUT_BASE} px-3 py-2`}
          />
        </div>
        <div className="grid gap-1 w-40">
          <span className="text-xs font-medium text-[var(--text-muted)]">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "WHOLE" | "PARTITION")}
            className={`min-h-9 ${INPUT_BASE} px-3 py-2`}
          >
            <option value="PARTITION">Partitioned</option>
            <option value="WHOLE">Whole</option>
          </select>
        </div>
        <Button
          size="sm"
          disabled={!name.trim() || isPending}
          onClick={() => {
            onAdd({ name: name.trim(), kind, sortOrder: nextSortOrder, isActive: true });
            setName("");
            setKind("PARTITION");
          }}
        >
          {isPending ? "Adding…" : "Add unit type"}
        </Button>
      </div>
    </div>
  );
}
