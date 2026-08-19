import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import type { CommissionSettingsResponse } from "@kason/shared";
import { Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "@/components/ui/alert-dialog";
import { formatDate, formatRM } from "@/components/format";
import { humanizeAgentLevel } from "@/lib/commission-labels";
import {
  useUpdateLevelThreshold,
  usePreviewLevelThreshold,
} from "@/hooks/use-commission-settings";

type LevelThreshold = CommissionSettingsResponse["levelThresholds"][number];

const DECIMAL_REGEX = /^\d{1,10}(\.\d{1,2})?$/;

// Always render all three levels in this fixed order, even if the backend
// only returns two (new_agent is a floor and may be absent).
const LEVEL_ORDER: Array<LevelThreshold["agentLevel"]> = [
  "new_agent",
  "pre_leader",
  "leader",
];

type PendingSave = {
  row: LevelThreshold;
  newAmount: string;
  bumpedAgentCount: number;
};

/**
 * Section 4 — Agent level auto-promotion thresholds.
 *
 * Three fixed rows; `new_agent` is the floor (no configurable threshold).
 * Changing a threshold can promote multiple agents at once — we now preview
 * the impact and require a confirm dialog before saving, so admins don't
 * silently bump 50 agents with a typo.
 */
export function LevelThresholdsSection({
  thresholds,
  canWrite,
}: {
  thresholds: LevelThreshold[];
  canWrite: boolean;
}) {
  const update = useUpdateLevelThreshold();
  const preview = usePreviewLevelThreshold();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);

  const byLevel = new Map(thresholds.map((t) => [t.agentLevel, t]));

  function getDraft(row: LevelThreshold): string {
    return drafts[row.id] ?? row.minCumulativeCommission;
  }

  function handleSaveClick(row: LevelThreshold) {
    if (row.agentLevel === "new_agent") return;
    const draft = getDraft(row);
    if (!DECIMAL_REGEX.test(draft)) {
      toast.error("Amount must be a positive decimal with up to 2 decimals.");
      return;
    }
    if (!row.updatedAt) {
      toast.error("Cannot save — stale record. Refresh the page.");
      return;
    }
    // Step 1 — dry-run preview to find out how many agents would be bumped.
    preview.mutate(
      {
        agentLevel: row.agentLevel as "pre_leader" | "leader",
        minCumulativeCommission: draft,
      },
      {
        onSuccess: (res) => {
          const count = res.data.bumpedAgentCount;
          if (count > 0) {
            setPendingSave({ row, newAmount: draft, bumpedAgentCount: count });
          } else {
            doSave(row, draft);
          }
        },
        onError: (err) => toast.error(err.message || "Failed to preview"),
      },
    );
  }

  function doSave(row: LevelThreshold, amount: string) {
    if (!row.updatedAt) return;
    update.mutate(
      {
        agentLevel: row.agentLevel as "pre_leader" | "leader",
        minCumulativeCommission: amount,
        updatedAt: row.updatedAt,
      },
      {
        onSuccess: (res) => {
          setDrafts((d) => {
            const next = { ...d };
            delete next[row.id];
            return next;
          });
          toast.success(
            res.data.bumpedAgentCount > 0
              ? `Threshold saved. ${res.data.bumpedAgentCount} agent(s) auto-promoted.`
              : "Threshold saved.",
          );
        },
        onError: (err) => toast.error(err.message || "Failed to save"),
      },
    );
  }

  return (
    <>
      <Surface
        title="Agent Level Auto-Promotion"
        description="Cumulative commission thresholds (RM) that auto-promote agents to the next level."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">3 levels</Badge>
          <Badge variant="gold">Auto-promote on paid claims</Badge>
        </div>
        {canWrite && (
          <Callout variant="warning" title="Saving runs the promotion backfill">
            Every save sweeps existing agents and promotes anyone whose cumulative paid
            commission now meets the new threshold. Double-check the numbers before saving.
          </Callout>
        )}
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3 font-semibold">Agent Level</th>
                <th className="px-4 py-3 font-semibold">Minimum Cumulative Commission (RM)</th>
                <th className="px-4 py-3 font-semibold w-36">Last Updated</th>
                {canWrite && <th className="px-4 py-3 font-semibold w-28 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {LEVEL_ORDER.map((level) => {
                const row = byLevel.get(level);
                if (level === "new_agent") {
                  return (
                    <tr
                      key="new_agent"
                      className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                    >
                      <td className="px-4 py-3.5 text-sm text-[var(--text-primary)] flex items-center gap-2">
                        <Badge variant="sky">{humanizeAgentLevel("new_agent")}</Badge>
                        <span className="text-xs text-[var(--text-muted)]">Starting level</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="text-[var(--text-muted)]">— (floor)</span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">—</td>
                      {canWrite && <td className="px-4 py-3.5">{null}</td>}
                    </tr>
                  );
                }
                if (!row) {
                  return (
                    <tr key={level} className="border-b border-[var(--border)]">
                      <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">{humanizeAgentLevel(level)}</td>
                      <td className="px-4 py-3.5">
                        <span className="text-rose-500">Not configured</span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">—</td>
                      {canWrite && <td className="px-4 py-3.5">{null}</td>}
                    </tr>
                  );
                }
                const draft = getDraft(row);
                const dirty = draft !== row.minCumulativeCommission;
                return (
                  <tr
                    key={row.id}
                    className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                  >
                    <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                      <Badge variant={level === "leader" ? "gold" : "emerald"}>
                        {humanizeAgentLevel(row.agentLevel)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-[var(--text-muted)]">RM</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          disabled={!canWrite}
                          value={draft}
                          onChange={(e) =>
                            setDrafts({ ...drafts, [row.id]: e.target.value })
                          }
                          className="w-40 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">
                      {row.updatedAt ? formatDate(row.updatedAt) : "-"}
                    </td>
                    {canWrite && (
                      <td className="px-4 py-3.5 text-right">
                        <Button
                          size="sm"
                          disabled={!dirty || update.isPending || preview.isPending}
                          onClick={() => handleSaveClick(row)}
                        >
                          {preview.isPending
                            ? "Checking…"
                            : update.isPending
                              ? "Saving…"
                              : "Save"}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Surface>

      {/* Confirm dialog — shows impact preview before saving */}
      <AlertDialog
        open={!!pendingSave}
        onOpenChange={(o) => !o && setPendingSave(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <AlertDialogTitle>Promote {pendingSave?.bumpedAgentCount} agent(s)?</AlertDialogTitle>
            </div>
            <AlertDialogDescription>
              {pendingSave ? (
                <>
                  Changing the <strong>{humanizeAgentLevel(pendingSave.row.agentLevel)}</strong> threshold to{" "}
                  <strong>{formatRM(Number(pendingSave.newAmount))}</strong> will immediately auto-promote{" "}
                  <strong>{pendingSave.bumpedAgentCount}</strong> agent(s) across your organisation whose paid commissions already clear this bar.
                  <div className="mt-3">
                    <Callout variant="warning">
                      This action is irreversible by this page — agents would need to be manually demoted if you change your mind.
                    </Callout>
                  </div>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => {
                if (pendingSave) {
                  doSave(pendingSave.row, pendingSave.newAmount);
                  setPendingSave(null);
                }
              }}
            >
              {update.isPending ? "Saving…" : "Save & promote"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingSave(null)}
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
