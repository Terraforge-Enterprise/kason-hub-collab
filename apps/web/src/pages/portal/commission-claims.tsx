import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardList, MoreHorizontal, Plus } from "lucide-react";
import { portalApiFetch } from "@/lib/portal-api";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { humanizeClaimStatus } from "@/lib/commission-labels";

type ClaimItem = {
  id: string;
  claimNumber: string;
  status: string;
  claimType: string;
  totalNettPayout: number;
  submittedAt: string | null;
  createdAt: string;
};

type PaginatedResponse = {
  data: ClaimItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

const STATUS_FILTERS = ["all", "draft", "submitted", "needs_amendment", "approved", "amended", "rejected", "paid"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const TONE_TO_VARIANT: Record<string, "emerald" | "amber" | "rose" | "sky" | "outline"> = {
  emerald: "emerald",
  amber: "amber",
  rose: "rose",
  sky: "sky",
  slate: "outline",
};

export default function CommissionClaimsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [confirm, setConfirm] = useState<
    | { kind: "delete" | "cancel"; claim: ClaimItem }
    | null
  >(null);

  const queryParams = new URLSearchParams({ page: String(page), limit: "20" });
  if (statusFilter !== "all") queryParams.set("status", statusFilter);

  const { data, isLoading } = useQuery({
    queryKey: ["agent-commission-claims", page, statusFilter],
    queryFn: () => portalApiFetch<PaginatedResponse>(`/commissions/claims?${queryParams}`),
  });

  const claims = data?.data ?? [];
  const pagination = data?.pagination;

  const invalidateLists = () => {
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claims"] });
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claims-recent"] });
  };

  const submit = useMutation({
    mutationFn: (id: string) =>
      portalApiFetch(`/commissions/claims/${id}/submit`, { method: "POST" }),
    onSuccess: (_d, id) => {
      const c = claims.find((x) => x.id === id);
      toast.success(`Claim ${c?.claimNumber ?? ""} submitted`);
      invalidateLists();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to submit claim"),
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      portalApiFetch(`/commissions/claims/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Claim cancelled");
      invalidateLists();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to cancel claim"),
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      portalApiFetch(`/commissions/claims/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Draft deleted");
      invalidateLists();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to delete draft"),
  });

  const mutating = submit.isPending || cancel.isPending || del.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
            <ClipboardList className="h-8 w-8 shrink-0 text-primary" />
            <span className="min-w-0">Commission Claims</span>
          </h1>
          <p className="mt-1 text-muted-foreground">
            File new claims, track approval status, and resume drafts.
          </p>
        </div>
        <Link
          to="/portal/claims/new"
          className={cn(buttonVariants({ variant: "gold" }), "shrink-0")}
        >
          <Plus className="mr-1 h-4 w-4" /> New Claim
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              statusFilter === s
                ? "bg-[var(--gold)] text-[var(--gold-fg)]"
                : "border border-border/50 bg-background/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "all" ? "All" : humanizeClaimStatus(s).replace(/^\w/, (c) => c.toUpperCase())}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-12 rounded-lg bg-muted" />
          <div className="h-12 rounded-lg bg-muted" />
          <div className="h-12 rounded-lg bg-muted" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/50 bg-background/60 shadow-xl backdrop-blur-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50">
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Claim #</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Date</th>
                <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Nett Payout</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Status</th>
                <th className="w-[60px] px-4 py-3 text-right" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {claims.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {statusFilter === "all" ? "No claims yet" : `No ${humanizeClaimStatus(statusFilter)} claims`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {statusFilter === "all"
                            ? "Start by filing your first commission claim."
                            : "Try a different status filter."}
                        </p>
                      </div>
                      {statusFilter === "all" && (
                        <Link
                          to="/portal/claims/new"
                          className={cn(buttonVariants({ variant: "gold", size: "sm" }))}
                        >
                          <Plus className="mr-1 h-4 w-4" /> New Claim
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                claims.map((c) => {
                  const tone = getStatusTone(c.status);
                  const variant = TONE_TO_VARIANT[tone] ?? "outline";
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-border/40 transition last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-4 py-3">
                        <Link
                          to={`/portal/claims/${c.id}`}
                          className="font-medium text-[var(--gold)] hover:underline"
                        >
                          {c.claimNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(c.submittedAt ?? c.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-foreground">
                        {formatRM(c.totalNettPayout)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={c.status === "needs_amendment" ? "amber" : variant}>
                          {humanizeClaimStatus(c.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <ClaimRowMenu
                          claim={c}
                          onView={() => navigate(`/portal/claims/${c.id}`)}
                          onEditDraft={() => navigate(`/portal/claims/new?editDraft=${c.id}`)}
                          onAmend={() => navigate(`/portal/claims/new?amend=${c.id}`)}
                          onResubmit={() => navigate(`/portal/claims/new?resubmit=${c.id}`)}
                          onSubmit={() => submit.mutate(c.id)}
                          onDelete={() => setConfirm({ kind: "delete", claim: c })}
                          onCancel={() => setConfirm({ kind: "cancel", claim: c })}
                          disabled={mutating}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "delete" ? "Delete draft claim?" : "Cancel submitted claim?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "delete"
                ? `Draft "${confirm?.claim.claimNumber}" will be permanently removed. This cannot be undone.`
                : `Claim "${confirm?.claim.claimNumber}" (${formatRM(confirm?.claim.totalNettPayout ?? 0)}) will be cancelled and removed from the admin review queue. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending || cancel.isPending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "delete") del.mutate(confirm.claim.id);
                else cancel.mutate(confirm.claim.id);
                setConfirm(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {confirm?.kind === "delete" ? "Delete draft" : "Cancel claim"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ClaimRowMenu({
  claim,
  onView,
  onEditDraft,
  onAmend,
  onResubmit,
  onSubmit,
  onDelete,
  onCancel,
  disabled,
}: {
  claim: ClaimItem;
  onView: () => void;
  onEditDraft: () => void;
  onAmend: () => void;
  onResubmit: () => void;
  onSubmit: () => void;
  onDelete: () => void;
  onCancel: () => void;
  disabled: boolean;
}) {
  const isDraft = claim.status === "draft";
  const isSubmitted = claim.status === "submitted";
  const isApproved = claim.status === "approved" || claim.status === "amended";
  const isNeedsAmendment = claim.status === "needs_amendment";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for claim ${claim.claimNumber}`}
        disabled={disabled}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onView}>View detail</DropdownMenuItem>
        {isDraft && (
          <>
            <DropdownMenuItem onClick={onEditDraft}>Edit draft</DropdownMenuItem>
            <DropdownMenuItem onClick={onSubmit}>Submit</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-rose-600 data-highlighted:bg-rose-500/10"
            >
              Delete draft
            </DropdownMenuItem>
          </>
        )}
        {isSubmitted && (
          <>
            <DropdownMenuItem onClick={onEditDraft}>Edit (status preserved)</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onCancel}
              className="text-rose-600 data-highlighted:bg-rose-500/10"
            >
              Cancel claim
            </DropdownMenuItem>
          </>
        )}
        {isApproved && (
          <DropdownMenuItem onClick={onAmend}>Amend (re-approval)</DropdownMenuItem>
        )}
        {isNeedsAmendment && (
          <>
            <DropdownMenuItem onClick={onResubmit}>Re-edit &amp; resubmit</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onCancel}
              className="text-rose-600 data-highlighted:bg-rose-500/10"
            >
              Cancel claim
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
