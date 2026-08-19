import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatDate } from "@/components/format";
import {
  AGENT_LEVEL_OPTIONS,
  CLAIM_TYPE_OPTIONS,
  humanizeAgentLevel,
  humanizeClaimType,
  type AgentLevel,
} from "@/lib/commission-labels";
import {
  useUpdateTierMapping,
  useCreateTierMapping,
} from "@/hooks/use-commission-settings";

type TierMapping = CommissionSettingsResponse["tierMappings"][number];
type Draft = { percentage: string; isActive: boolean };

type ActiveToggleRequest = {
  mapping: TierMapping;
  nextActive: boolean;
  draft: Draft;
};

const INPUT_CLASS =
  "w-24 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

/**
 * Section 1 — Agent Tier Mappings.
 *
 * Two claim types × three agent levels = 6 fixed rows. Super Admin can
 * toggle isActive (with a confirm dialog) and edit the percentage inline.
 * "New Tier Mapping" button opens a dialog to create additional rows if
 * the taxonomy ever extends.
 */
export function TierMappingsSection({
  mappings,
  canWrite,
}: {
  mappings: TierMapping[];
  canWrite: boolean;
}) {
  const update = useUpdateTierMapping();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [toggleRequest, setToggleRequest] = useState<ActiveToggleRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const sorted = useMemo(
    () =>
      [...mappings].sort((a, b) => {
        const typeOrder = a.claimType.localeCompare(b.claimType);
        if (typeOrder !== 0) return typeOrder;
        const levelRank = { new_agent: 1, pre_leader: 2, leader: 3 } as const;
        return levelRank[a.agentLevel] - levelRank[b.agentLevel];
      }),
    [mappings],
  );

  const activeCount = mappings.filter((m) => m.isActive).length;
  const inactiveCount = mappings.length - activeCount;

  const getDraft = (m: TierMapping): Draft =>
    drafts[m.id] ?? { percentage: m.percentage, isActive: m.isActive };

  function save(m: TierMapping, override?: Draft) {
    const draft = override ?? getDraft(m);
    const num = parseFloat(draft.percentage);
    if (isNaN(num) || num <= 0 || num > 100) {
      toast.error("Percentage must be between 0 (exclusive) and 100.");
      return;
    }
    if (!m.updatedAt) {
      toast.error("Cannot save — stale record. Refresh the page.");
      return;
    }
    update.mutate(
      {
        id: m.id,
        updatedAt: m.updatedAt,
        percentage: draft.percentage,
        isActive: draft.isActive,
      },
      {
        onSuccess: () => {
          setDrafts((d) => {
            const next = { ...d };
            delete next[m.id];
            return next;
          });
          toast.success("Saved");
        },
        onError: (err) => toast.error(err.message || "Failed to save"),
      },
    );
  }

  function handleActiveToggle(m: TierMapping, nextActive: boolean) {
    const draft = { ...getDraft(m), isActive: nextActive };
    setToggleRequest({ mapping: m, nextActive, draft });
  }

  function confirmActiveToggle() {
    if (!toggleRequest) return;
    setDrafts({ ...drafts, [toggleRequest.mapping.id]: toggleRequest.draft });
    save(toggleRequest.mapping, toggleRequest.draft);
    setToggleRequest(null);
  }

  return (
    <>
      <Surface
        title="Commission % by Agent Level"
        description="Commission percentage for each (claim type × agent level) combination. The portal claim form looks this up at submit time to compute the agent's nett payout."
        actions={
          canWrite ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(true)}
              className="shrink-0 gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              New Tier Mapping
            </Button>
          ) : undefined
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total: {mappings.length}</Badge>
          <Badge variant="emerald">Active: {activeCount}</Badge>
          {inactiveCount > 0 && <Badge variant="rose">Inactive: {inactiveCount}</Badge>}
        </div>
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="min-w-full border-collapse text-left text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-3 font-semibold">Claim Type</th>
                <th className="px-4 py-3 font-semibold">Agent Level</th>
                <th className="px-4 py-3 font-semibold w-40">Percentage</th>
                <th className="px-4 py-3 font-semibold w-32">Status</th>
                <th className="px-4 py-3 font-semibold w-40">Last Updated</th>
                {canWrite && <th className="px-4 py-3 font-semibold w-28 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={canWrite ? 6 : 5}
                    className="px-4 py-10 text-center text-sm text-[var(--text-muted)]"
                  >
                    No tier mappings configured.
                  </td>
                </tr>
              ) : (
                sorted.map((m) => {
                  const draft = getDraft(m);
                  const dirty =
                    draft.percentage !== m.percentage;
                  return (
                    <tr
                      key={m.id}
                      className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                    >
                      <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">{humanizeClaimType(m.claimType)}</td>
                      <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">{humanizeAgentLevel(m.agentLevel)}</td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            inputMode="decimal"
                            disabled={!canWrite}
                            value={draft.percentage}
                            onChange={(e) =>
                              setDrafts({
                                ...drafts,
                                [m.id]: { ...draft, percentage: e.target.value },
                              })
                            }
                            className={INPUT_CLASS}
                          />
                          <span className="text-sm text-[var(--text-muted)]">%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        {canWrite ? (
                          <button
                            type="button"
                            onClick={() => handleActiveToggle(m, !m.isActive)}
                            className="cursor-pointer"
                          >
                            {m.isActive ? (
                              <Badge variant="emerald">Active</Badge>
                            ) : (
                              <Badge variant="rose">Inactive</Badge>
                            )}
                          </button>
                        ) : m.isActive ? (
                          <Badge variant="emerald">Active</Badge>
                        ) : (
                          <Badge variant="rose">Inactive</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">
                        {m.updatedAt ? formatDate(m.updatedAt) : "-"}
                      </td>
                      {canWrite && (
                        <td className="px-4 py-3.5 text-right">
                          <Button
                            size="sm"
                            disabled={!dirty || update.isPending}
                            onClick={() => save(m)}
                          >
                            {update.isPending ? "Saving…" : "Save"}
                          </Button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Surface>

      {/* Deactivate / reactivate confirm dialog — restored from prior UI */}
      <AlertDialog
        open={!!toggleRequest}
        onOpenChange={(o) => !o && setToggleRequest(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleRequest?.nextActive ? "Reactivate" : "Deactivate"} tier mapping?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggleRequest ? (
                toggleRequest.nextActive ? (
                  <>
                    Reactivate at <strong>{toggleRequest.mapping.percentage}%</strong>? New claims for{" "}
                    <strong>{humanizeClaimType(toggleRequest.mapping.claimType)}</strong> ·{" "}
                    <strong>{humanizeAgentLevel(toggleRequest.mapping.agentLevel)}</strong> will start using this rate.
                  </>
                ) : (
                  <>
                    Deactivate this tier mapping? New claims for{" "}
                    <strong>{humanizeClaimType(toggleRequest.mapping.claimType)}</strong> ·{" "}
                    <strong>{humanizeAgentLevel(toggleRequest.mapping.agentLevel)}</strong>{" "}
                    will no longer be assignable this rate. Existing claims are unaffected (rates are snapshotted at claim creation).
                  </>
                )
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant={toggleRequest?.nextActive ? "default" : "destructive"}
              size="sm"
              onClick={confirmActiveToggle}
              disabled={update.isPending}
            >
              {toggleRequest?.nextActive ? "Reactivate" : "Deactivate"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setToggleRequest(null)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create new tier mapping */}
      {canWrite && (
        <CreateTierMappingDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </>
  );
}

// ── Create dialog ───────────────────────────────────────────────────────────

function CreateTierMappingDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateTierMapping();
  const [claimType, setClaimType] = useState<"tenant_portion" | "listing_portion">("tenant_portion");
  const [agentLevel, setAgentLevel] = useState<"new_agent" | "pre_leader" | "leader">("new_agent");
  const [percentage, setPercentage] = useState("");

  function reset() {
    setClaimType("tenant_portion");
    setAgentLevel("new_agent");
    setPercentage("");
  }

  function submit() {
    const num = parseFloat(percentage);
    if (isNaN(num) || num <= 0 || num > 100) {
      toast.error("Percentage must be between 0 (exclusive) and 100.");
      return;
    }
    create.mutate(
      { claimType, agentLevel, percentage },
      {
        onSuccess: () => {
          toast.success("Tier mapping created.");
          reset();
          onClose();
        },
        onError: (err) => toast.error(err.message || "Failed to create"),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Tier Mapping</DialogTitle>
          <DialogDescription>
            Add a commission-rate mapping for a new (claim type × agent level) combination.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Claim Type</label>
            <select
              value={claimType}
              onChange={(e) => setClaimType(e.target.value as "tenant_portion" | "listing_portion")}
              className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            >
              {CLAIM_TYPE_OPTIONS.filter((o) => o.value !== "tenant_listing_portion").map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Agent Level</label>
            <select
              value={agentLevel}
              onChange={(e) => setAgentLevel(e.target.value as AgentLevel)}
              className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            >
              {AGENT_LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Percentage</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={percentage}
                placeholder="e.g. 25"
                onChange={(e) => setPercentage(e.target.value)}
                className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
              />
              <span className="text-sm text-[var(--text-muted)]">%</span>
            </div>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Duplicate (claim type, agent level) combinations are rejected. Edit the existing row instead.
          </p>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={submit}
            disabled={!percentage || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={create.isPending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
