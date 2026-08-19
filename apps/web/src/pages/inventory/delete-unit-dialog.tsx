import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, AlertTriangle, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch, ApiError } from "@/lib/api-client";

type BlockerKind =
  | "any-reservations"
  | "any-tenancy"
  | "non-zero-charges"
  | "any-deposit";

type CascadeKind = "unit-attributes" | "listing-visibility-grants";

interface DeletionBlocker {
  kind: BlockerKind;
  count: number;
  sampleIds: string[];
  resolveHref: string;
  resolveLabel: string;
}

interface DeletionCascade {
  kind: CascadeKind;
  count: number;
}

interface DeletionReport {
  unitId: string;
  unitCode: string;
  unitLabel: string;
  canDelete: boolean;
  blockers: DeletionBlocker[];
  cascades: DeletionCascade[];
}

const CASCADE_LABEL: Record<CascadeKind, string> = {
  "unit-attributes": "unit attributes",
  "listing-visibility-grants": "listing visibility grants",
};

interface DeleteUnitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  onDeleted: () => void;
}

export function DeleteUnitDialog({
  open,
  onOpenChange,
  unitId,
  onDeleted,
}: DeleteUnitDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const [report, setReport] = useState<DeletionReport | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (!open) setConfirmText("");
  }, [open]);

  const previewQuery = useQuery<DeletionReport>({
    queryKey: ["listing-deletion-preview", unitId],
    queryFn: () =>
      apiFetch<{ data: DeletionReport }>(
        `/listings/${unitId}/deletion-preview`,
      ).then((res) => res.data),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    if (previewQuery.data) setReport(previewQuery.data);
  }, [previewQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: async (confirmCode: string) =>
      apiFetch<{ data: { id: string } }>(`/listings/${unitId}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmCode }),
      }),
    onSuccess: () => {
      toast.success(`Unit ${report?.unitCode ?? ""} deleted`);
      onOpenChange(false);
      onDeleted();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        const body = (err.data as { error?: DeletionReport })?.error;
        if (body && typeof body === "object" && "blockers" in body) {
          setReport(body as DeletionReport);
          toast.error(
            "Unit status changed while you were confirming. New blockers appeared.",
          );
          setConfirmText("");
          return;
        }
      }
      if (err instanceof ApiError) {
        toast.error(err.message);
        return;
      }
      toast.error("Failed to delete unit");
    },
  });

  const current = report ?? previewQuery.data ?? null;
  const isLoading = previewQuery.isLoading && !report;
  const codeMatches = !!current && confirmText === current.unitCode;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (deleteMutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {current && !current.canDelete
              ? `Cannot delete unit ${current.unitCode}`
              : current
                ? `Delete unit ${current.unitCode} — permanent`
                : "Delete unit"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {current && !current.canDelete
              ? "This unit has business activity and can't be deleted."
              : "This action is permanent and cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="text-sm">
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking unit
              state…
            </div>
          )}
          {!isLoading && previewQuery.isError && (
            <p className="text-destructive">
              Could not load deletion preview. Try again.
            </p>
          )}
          {current && current.canDelete && <SafeState report={current} />}
          {current && !current.canDelete && (
            <BlockedState report={current} />
          )}
        </div>

        {current && current.canDelete && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">
              Type{" "}
              <span className="font-mono text-foreground">
                {current.unitCode}
              </span>{" "}
              to confirm:
            </label>
            <Input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={current.unitCode}
              disabled={deleteMutation.isPending}
            />
          </div>
        )}

        <AlertDialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            {current && !current.canDelete ? "Close" : "Cancel"}
          </Button>
          {current && current.canDelete && (
            <Button
              variant="destructive"
              disabled={!codeMatches || deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(confirmText)}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Deleting…
                </>
              ) : (
                "Delete unit"
              )}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SafeState({ report }: { report: DeletionReport }) {
  const nonZeroCascades = report.cascades.filter((c) => c.count > 0);
  return (
    <div className="space-y-3">
      <div>
        This will permanently delete:
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li className="font-mono">{report.unitLabel}</li>
          {nonZeroCascades.map((c) => (
            <li key={c.kind}>
              {c.count} {CASCADE_LABEL[c.kind]} (auto)
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground">
        No reservations, tenancies, charges, or deposits exist. Safe to
        delete.
      </p>
    </div>
  );
}

function BlockedState({ report }: { report: DeletionReport }) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        Resolve the items below first, then try again.
      </p>
      <ul className="space-y-2">
        {report.blockers.map((b) => (
          <li
            key={b.kind}
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">
                {b.count}{" "}
                {b.kind === "any-reservations"
                  ? `reservation${b.count === 1 ? "" : "s"}`
                  : b.kind === "any-tenancy"
                    ? `tenancy record${b.count === 1 ? "" : "s"}`
                    : b.kind === "non-zero-charges"
                      ? `charge${b.count === 1 ? "" : "s"}`
                      : `deposit${b.count === 1 ? "" : "s"}`}
              </span>
              <Link
                to={b.resolveHref}
                className="text-xs inline-flex items-center gap-1 text-foreground hover:underline"
              >
                {b.resolveLabel} <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
