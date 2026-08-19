import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import {
  getSalesClaimDefault,
  upsertSalesClaimDefault,
} from "@/api/sales-claim-defaults";

const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

type Props = { canWrite: boolean };

type SplitDraft = { roleLabel: string; splitType: "percent" | "fixed"; splitValue: string };

/**
 * Section 6 — Sales Claim Defaults.
 *
 * Single-form admin UI for the org's auto-derived SalesClaim defaults. Drives
 * the auto-derived SalesClaim every time an agent files a Sales Entry.
 *
 * Backed by /api/sales-claim-defaults (Tasks 17-18).
 */
export function SalesClaimDefaultsSection({ canWrite }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["sales-claim-defaults", "__catchall__"],
    queryFn: getSalesClaimDefault,
  });

  const [commissionType, setCommissionType] = useState<"percent_of_purchase" | "fixed">("percent_of_purchase");
  const [commissionValue, setCommissionValue] = useState("0");
  const [paymentType, setPaymentType] = useState<"full" | "partial">("full");
  const [splits, setSplits] = useState<SplitDraft[]>([]);

  useEffect(() => {
    if (!data?.data) return;
    const d = data.data;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    setCommissionType(d.commissionType);
    setCommissionValue(String(Number(d.commissionValue)));
    setPaymentType(d.paymentType);
    setSplits(
      d.defaultSplits.map((s) => ({
        roleLabel: s.roleLabel,
        splitType: s.splitType,
        splitValue: String(Number(s.splitValue)),
      })),
    );
  }, [data?.data?.id]);

  const upsert = useMutation({
    mutationFn: upsertSalesClaimDefault,
    onSuccess: () => {
      toast.success("Defaults saved");
      qc.invalidateQueries({ queryKey: ["sales-claim-defaults"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function save() {
    const valueNum = Number(commissionValue);
    if (!isFinite(valueNum) || valueNum < 0) {
      toast.error("Commission value must be a non-negative number.");
      return;
    }
    if (splits.length === 0) {
      toast.error("Add at least one split.");
      return;
    }
    const splitsPayload = splits.map((s, i) => ({
      roleLabel: s.roleLabel.trim(),
      splitType: s.splitType,
      splitValue: isFinite(Number(s.splitValue)) ? Number(s.splitValue) : 0,
      sortOrder: i,
    }));
    if (splitsPayload.some((s) => s.roleLabel.length === 0)) {
      toast.error("Every split needs a role label.");
      return;
    }
    upsert.mutate({
      appliesTo: "__catchall__",
      commissionType,
      commissionValue: valueNum,
      paymentType,
      splits: splitsPayload,
    });
  }

  function addSplit() {
    setSplits((prev) => [...prev, { roleLabel: "", splitType: "percent", splitValue: "0" }]);
  }
  function updateSplit(idx: number, patch: Partial<SplitDraft>) {
    setSplits((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function removeSplit(idx: number) {
    setSplits((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <Surface>
      <div className="border-b border-[var(--card-border)] px-6 py-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Sales Claim Defaults</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Drives the auto-derived SalesClaim every time an agent files a Sales
          Entry. Splits must sum to 100% if all rows are percent type.
        </p>
      </div>
      <div className="px-6 py-4 space-y-4">
        {isLoading ? (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">
                  Commission Type
                </label>
                <select
                  value={commissionType}
                  onChange={(e) => setCommissionType(e.target.value as "percent_of_purchase" | "fixed")}
                  disabled={!canWrite}
                  className={`w-full ${INPUT_BASE}`}
                >
                  <option value="percent_of_purchase">% of Purchase</option>
                  <option value="fixed">Fixed RM</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">
                  {commissionType === "percent_of_purchase" ? "Commission %" : "Commission RM"}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={commissionValue}
                  onChange={(e) => setCommissionValue(e.target.value)}
                  disabled={!canWrite}
                  className={`w-full ${INPUT_BASE}`}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">
                Payment Type
              </label>
              <select
                value={paymentType}
                onChange={(e) => setPaymentType(e.target.value as "full" | "partial")}
                disabled={!canWrite}
                className={`w-full ${INPUT_BASE}`}
              >
                <option value="full">Full</option>
                <option value="partial">Partial</option>
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Splits</span>
                {canWrite && (
                  <Button variant="ghost" size="sm" onClick={addSplit}>
                    <Plus className="h-3 w-3" /> Add row
                  </Button>
                )}
              </div>
              <div className="space-y-2">
                {splits.map((s, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2">
                    <input
                      type="text"
                      value={s.roleLabel}
                      onChange={(e) => updateSplit(idx, { roleLabel: e.target.value })}
                      placeholder="Role label (e.g. Sales Commission)"
                      maxLength={100}
                      disabled={!canWrite}
                      className={`flex-1 ${INPUT_BASE}`}
                    />
                    <select
                      value={s.splitType}
                      onChange={(e) => updateSplit(idx, { splitType: e.target.value as "percent" | "fixed" })}
                      disabled={!canWrite}
                      className={INPUT_BASE}
                    >
                      <option value="percent">%</option>
                      <option value="fixed">RM</option>
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={s.splitValue}
                      onChange={(e) => updateSplit(idx, { splitValue: e.target.value })}
                      disabled={!canWrite}
                      className={`w-24 ${INPUT_BASE}`}
                    />
                    {canWrite && (
                      <Button variant="ghost" size="sm" onClick={() => removeSplit(idx)} aria-label="Remove split">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {splits.length === 0 && (
                  <p className="text-xs text-[var(--text-muted)]">No splits configured. Add at least one before saving.</p>
                )}
              </div>
            </div>
            {canWrite && (
              <div className="flex justify-end pt-2 border-t border-[var(--card-border)]">
                <Button variant="gold" disabled={upsert.isPending} onClick={save}>
                  {upsert.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Surface>
  );
}
