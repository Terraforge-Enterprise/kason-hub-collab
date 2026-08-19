import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, ArrowUp, ArrowDown, Archive, ArchiveRestore } from "lucide-react";
import { Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import {
  listRenovationStages,
  createRenovationStage,
  updateRenovationStage,
  reorderRenovationStages,
  type AdminRenovationStage,
} from "@/api/renovation-stages";

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

const STAGE_CAP = 25;

type Props = { canWrite: boolean };

/**
 * Section 5 — Renovation Stages.
 *
 * Super-admin CRUD for the org's RenovationStage catalogue used by the
 * construction tracker on the agent's pipeline. Supports inline-rename,
 * up/down reorder, archive/restore toggle, and "+ Add stage" input.
 *
 * Backed by /api/renovation-stages (Tasks 7-9).
 */
export function RenovationStagesSection({ canWrite }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["renovation-stages", "all"],
    queryFn: () => listRenovationStages(true),
  });

  const [draftLabel, setDraftLabel] = useState("");

  const create = useMutation({
    mutationFn: createRenovationStage,
    onSuccess: () => {
      toast.success("Stage added");
      setDraftLabel("");
      qc.invalidateQueries({ queryKey: ["renovation-stages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateRenovationStage>[1] }) =>
      updateRenovationStage(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["renovation-stages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reorder = useMutation({
    mutationFn: reorderRenovationStages,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["renovation-stages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const stages = (data?.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const activeCount = stages.filter((s) => !s.archived).length;
  const atCap = activeCount >= STAGE_CAP;

  const move = (id: string, dir: -1 | 1) => {
    const visible = stages.filter((s) => !s.archived);
    const idx = visible.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= visible.length) return;
    const a = visible[idx];
    const b = visible[swap];
    const items = visible.map((s, i) => {
      if (s.id === a.id) return { id: s.id, sortOrder: i === idx ? b.sortOrder : s.sortOrder };
      if (s.id === b.id) return { id: s.id, sortOrder: i === swap ? a.sortOrder : s.sortOrder };
      return { id: s.id, sortOrder: s.sortOrder };
    });
    reorder.mutate(items);
  };

  return (
    <Surface>
      <div className="border-b border-[var(--card-border)] px-6 py-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Construction Pipeline Stages
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Stage catalogue for the construction tracker on the agent's sales
          pipeline. Each renovation claim moves through these stages.
          Active count: <strong>{activeCount}</strong> / {STAGE_CAP}.
        </p>
      </div>
      <div className="px-6 py-4 space-y-2">
        {isLoading ? (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        ) : stages.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)]">No stages yet.</div>
        ) : (
          stages.map((s) => (
            <StageRow
              key={s.id}
              stage={s}
              canWrite={canWrite}
              isFirstActive={s.id === stages.filter((x) => !x.archived)[0]?.id}
              isLastActive={
                s.id === stages.filter((x) => !x.archived).slice(-1)[0]?.id
              }
              onMoveUp={() => move(s.id, -1)}
              onMoveDown={() => move(s.id, 1)}
              onRename={(label) => update.mutate({ id: s.id, input: { label } })}
              onArchiveToggle={() =>
                update.mutate({ id: s.id, input: { archived: !s.archived } })
              }
            />
          ))
        )}
        {canWrite && (
          <div className="flex gap-2 pt-2 border-t border-[var(--card-border)] mt-4">
            <input
              type="text"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="Stage label (e.g. Demolition)"
              maxLength={80}
              className={`flex-1 ${INPUT_BASE}`}
              disabled={atCap}
            />
            <Button
              variant="gold"
              size="sm"
              disabled={!draftLabel.trim() || create.isPending || atCap}
              onClick={() =>
                create.mutate({ label: draftLabel.trim() })
              }
            >
              <Plus className="h-4 w-4" />
              Add stage
            </Button>
          </div>
        )}
        {atCap && canWrite && (
          <p className="text-xs text-amber-600">
            Stage cap of {STAGE_CAP} reached. Archive an existing stage before adding more.
          </p>
        )}
      </div>
    </Surface>
  );
}

function StageRow({
  stage,
  canWrite,
  isFirstActive,
  isLastActive,
  onMoveUp,
  onMoveDown,
  onRename,
  onArchiveToggle,
}: {
  stage: AdminRenovationStage;
  canWrite: boolean;
  isFirstActive: boolean;
  isLastActive: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: (label: string) => void;
  onArchiveToggle: () => void;
}) {
  const [editingLabel, setEditingLabel] = useState(stage.label);
  const dirty = editingLabel.trim() !== stage.label;

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 ${
        stage.archived
          ? "border-[var(--card-border)] bg-[var(--card-bg)] opacity-60"
          : "border-[var(--card-border)] bg-[var(--card-bg)]"
      }`}
    >
      {canWrite && !stage.archived ? (
        <input
          type="text"
          value={editingLabel}
          onChange={(e) => setEditingLabel(e.target.value)}
          onBlur={() => {
            if (dirty && editingLabel.trim().length > 0) onRename(editingLabel.trim());
            else setEditingLabel(stage.label);
          }}
          maxLength={80}
          className={`flex-1 ${INPUT_BASE}`}
        />
      ) : (
        <span className="flex-1 text-sm text-[var(--text-primary)]">
          {stage.label}
          {stage.archived && (
            <span className="ml-2 text-xs italic text-[var(--text-muted)]">archived</span>
          )}
        </span>
      )}
      <span className="text-xs text-[var(--text-muted)] font-mono">{stage.key}</span>
      {canWrite && !stage.archived && (
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={isFirstActive}
            onClick={onMoveUp}
            aria-label="Move up"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLastActive}
            onClick={onMoveDown}
            aria-label="Move down"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </>
      )}
      {canWrite && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onArchiveToggle}
          aria-label={stage.archived ? "Restore" : "Archive"}
        >
          {stage.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </Button>
      )}
    </div>
  );
}
