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
  useCreateTaTier,
  useUpdateTaTier,
  useDeleteTaTier,
} from "@/hooks/use-commission-settings";

type TaTier = CommissionSettingsResponse["taTiers"][number];
type Draft = {
  rentalMin: string;
  rentalMax: string; // "" = open-ended
  companyMinimum: string;
};

const DECIMAL = /^\d{1,10}(\.\d{1,2})?$/;
const INPUT_BASE =
  "rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";

/**
 * Section 2 — Tenancy Agreement tiers.
 *
 * Rental brackets map to a KAEN company-minimum amount. The portal claim
 * form uses this to auto-derive the "Charges by KAEN" on new claims.
 * Super Admin can add, edit (rentalMin, rentalMax, companyMinimum), and
 * delete rows. An empty rentalMax means "open-ended" (highest band catches
 * everything above its rentalMin).
 */
export function TaTiersSection({
  tiers,
  canWrite,
}: {
  tiers: TaTier[];
  canWrite: boolean;
}) {
  const create = useCreateTaTier();
  const update = useUpdateTaTier();
  const remove = useDeleteTaTier();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [deleteTarget, setDeleteTarget] = useState<TaTier | null>(null);

  const sorted = [...tiers].sort((a, b) => a.tier - b.tier);

  const getDraft = (t: TaTier): Draft =>
    drafts[t.id] ?? {
      rentalMin: t.rentalMin,
      rentalMax: t.rentalMax ?? "",
      companyMinimum: t.companyMinimum,
    };

  function save(t: TaTier) {
    const d = getDraft(t);
    if (!DECIMAL.test(d.rentalMin) || !DECIMAL.test(d.companyMinimum)) {
      toast.error("Rental min and company min must be positive decimals.");
      return;
    }
    if (d.rentalMax && !DECIMAL.test(d.rentalMax)) {
      toast.error("Rental max must be a positive decimal or blank.");
      return;
    }
    if (!t.updatedAt) {
      toast.error("Cannot save — stale record. Refresh the page.");
      return;
    }
    update.mutate(
      {
        id: t.id,
        rentalMin: d.rentalMin,
        rentalMax: d.rentalMax || null,
        companyMinimum: d.companyMinimum,
        updatedAt: t.updatedAt,
      },
      {
        onSuccess: () => {
          setDrafts((prev) => {
            const n = { ...prev };
            delete n[t.id];
            return n;
          });
          toast.success("Saved");
        },
        onError: (err) => toast.error(err.message || "Failed to save"),
      },
    );
  }

  function handleDelete(target: TaTier) {
    remove.mutate(target.id, {
      onSuccess: () => {
        toast.success(`Tier ${target.tier} deleted.`);
        setDeleteTarget(null);
      },
      onError: (err) => toast.error(err.message || "Failed to delete"),
    });
  }

  return (
    <>
      <Surface
        title="Tenancy Agreement Tiers"
        description="Rental band → KAEN's minimum tenancy-agreement charge. The portal claim form uses this to auto-derive the TA charge per submission."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total: {tiers.length}</Badge>
          {tiers.some((t) => !t.rentalMax) && (
            <Badge variant="gold">Open-ended top band</Badge>
          )}
        </div>
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--page-bg)] text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold w-20">Tier</th>
                  <th className="px-4 py-3 font-semibold">Rental Min (RM)</th>
                  <th className="px-4 py-3 font-semibold">Rental Max (RM)</th>
                  <th className="px-4 py-3 font-semibold">Company Min (RM)</th>
                  <th className="px-4 py-3 font-semibold w-36">Last Updated</th>
                  {canWrite && <th className="px-4 py-3 font-semibold w-40 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canWrite ? 6 : 5}
                      className="px-4 py-10 text-center text-sm text-[var(--text-muted)]"
                    >
                      No TA tiers configured.
                    </td>
                  </tr>
                ) : (
                  sorted.map((t) => {
                    const d = getDraft(t);
                    const dirty =
                      d.rentalMin !== t.rentalMin ||
                      d.rentalMax !== (t.rentalMax ?? "") ||
                      d.companyMinimum !== t.companyMinimum;
                    return (
                      <tr
                        key={t.id}
                        className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                      >
                        <td className="px-4 py-3.5 text-sm font-semibold text-[var(--text-primary)]">
                          Tier {t.tier}
                        </td>
                        <td className="px-4 py-3.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            disabled={!canWrite}
                            value={d.rentalMin}
                            onChange={(e) =>
                              setDrafts({ ...drafts, [t.id]: { ...d, rentalMin: e.target.value } })
                            }
                            className={`w-32 ${INPUT_BASE}`}
                          />
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              inputMode="decimal"
                              disabled={!canWrite}
                              placeholder="—"
                              value={d.rentalMax}
                              onChange={(e) =>
                                setDrafts({ ...drafts, [t.id]: { ...d, rentalMax: e.target.value } })
                              }
                              className={`w-32 ${INPUT_BASE}`}
                            />
                            {!d.rentalMax && (
                              <span className="text-[10px] uppercase text-amber-500 font-semibold tracking-wider">
                                Open-ended
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            disabled={!canWrite}
                            value={d.companyMinimum}
                            onChange={(e) =>
                              setDrafts({ ...drafts, [t.id]: { ...d, companyMinimum: e.target.value } })
                            }
                            className={`w-32 ${INPUT_BASE}`}
                          />
                        </td>
                        <td className="px-4 py-3.5 text-xs text-[var(--text-muted)]">
                          {t.updatedAt ? formatDate(t.updatedAt) : "-"}
                        </td>
                        {canWrite && (
                          <td className="px-4 py-3.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                disabled={!dirty || update.isPending}
                                onClick={() => save(t)}
                              >
                                {update.isPending ? "Saving…" : "Save"}
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={remove.isPending}
                                onClick={() => setDeleteTarget(t)}
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
            <AddTaTierForm
              onAdd={(input) =>
                create.mutate(input, {
                  onSuccess: () => toast.success("Tier created"),
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
            <AlertDialogTitle>Delete Tier {deleteTarget?.tier}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the rental band{" "}
              <strong>
                RM {deleteTarget?.rentalMin}
                {deleteTarget?.rentalMax ? ` – RM ${deleteTarget.rentalMax}` : "+"}
              </strong>
              {" "}→ company minimum <strong>RM {deleteTarget?.companyMinimum}</strong>. Existing claims are unaffected, but the portal will no longer auto-fill this value on new rentals within the band.
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

function AddTaTierForm({
  onAdd,
  isPending,
}: {
  onAdd: (input: {
    tier: number;
    rentalMin: string;
    rentalMax?: string | null;
    companyMinimum: string;
  }) => void;
  isPending: boolean;
}) {
  const [tier, setTier] = useState("");
  const [rentalMin, setRentalMin] = useState("");
  const [rentalMax, setRentalMax] = useState("");
  const [companyMinimum, setCompanyMinimum] = useState("");

  const canAdd =
    /^\d+$/.test(tier.trim()) &&
    Number(tier) >= 1 &&
    DECIMAL.test(rentalMin) &&
    DECIMAL.test(companyMinimum) &&
    (rentalMax === "" || DECIMAL.test(rentalMax));

  return (
    <div className="rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Plus className="h-4 w-4 text-[var(--text-muted)]" />
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">Add new TA tier</h4>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Tier">
          <input
            type="text"
            inputMode="numeric"
            value={tier}
            placeholder="e.g. 5"
            onChange={(e) => setTier(e.target.value)}
            className={`w-20 ${INPUT_BASE}`}
          />
        </Field>
        <Field label="Rental Min (RM)">
          <input
            type="text"
            inputMode="decimal"
            value={rentalMin}
            placeholder="0.00"
            onChange={(e) => setRentalMin(e.target.value)}
            className={`w-32 ${INPUT_BASE}`}
          />
        </Field>
        <Field label="Rental Max (RM)">
          <input
            type="text"
            inputMode="decimal"
            value={rentalMax}
            placeholder="Blank = open"
            onChange={(e) => setRentalMax(e.target.value)}
            className={`w-36 ${INPUT_BASE}`}
          />
        </Field>
        <Field label="Company Min (RM)">
          <input
            type="text"
            inputMode="decimal"
            value={companyMinimum}
            placeholder="0.00"
            onChange={(e) => setCompanyMinimum(e.target.value)}
            className={`w-32 ${INPUT_BASE}`}
          />
        </Field>
        <Button
          size="sm"
          disabled={!canAdd || isPending}
          onClick={() => {
            onAdd({
              tier: Number(tier),
              rentalMin,
              rentalMax: rentalMax || null,
              companyMinimum,
            });
            setTier("");
            setRentalMin("");
            setRentalMax("");
            setCompanyMinimum("");
          }}
        >
          {isPending ? "Adding…" : "Add tier"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      {children}
    </div>
  );
}
