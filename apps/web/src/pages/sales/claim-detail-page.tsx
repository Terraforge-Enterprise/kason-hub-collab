// Admin page — Sales Claim detail. Editor+ access (server enforces).
// Editors see metadata only; manager+ see commission amounts, splits, and the
// approve / reject / needs-amendment buttons. Reject and needs-amendment
// require a note (plain text) which is written to the transition row.
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ClipboardList, Receipt, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { ConfirmAlert } from "@/components/ui/confirm-alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RoleGate } from "@/components/role-gate";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api-client";
import { formatRM } from "@/components/format";
import {
  approveSalesClaim,
  cancelSalesClaim,
  getSalesClaim,
  listSalesClaimTransitions,
  needsAmendmentSalesClaim,
  rejectSalesClaim,
  type SalesClaim,
} from "@/api/sales-claims";
import { ClaimTransitionTimeline } from "@/components/claim-transition-timeline";
import { statusBadgeVariant, statusLabel } from "./status-helpers";

type ReviewerAction = "reject" | "needs_amendment";

export default function SalesClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isEditor = user?.role === "editor";

  const [reviewerOpen, setReviewerOpen] = useState<ReviewerAction | null>(null);
  const [note, setNote] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const claim = useQuery({
    queryKey: ["sales", "claims", id],
    queryFn: () => getSalesClaim(id!),
    enabled: !!id,
  });

  // Audit timeline — every approve/reject/needs-amendment writes a row
  // server-side; this surfaces the full review history beyond the latest
  // reviewerNote that lives on the claim itself.
  const transitions = useQuery({
    queryKey: ["sales", "claims", id, "transitions"],
    queryFn: () => listSalesClaimTransitions(id!),
    enabled: !!id,
  });

  const invalidate = () => {
    // Covers the list, the detail, and the transitions sub-key (all start
    // with ["sales", "claims"]). After approve/reject/needs-amendment the
    // timeline must show the new row.
    queryClient.invalidateQueries({ queryKey: ["sales", "claims"] });
  };

  const approve = useMutation({
    mutationFn: () => approveSalesClaim(id!),
    onSuccess: () => {
      toast.success("Claim approved");
      invalidate();
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Failed to approve claim";
      toast.error(msg);
    },
  });

  const reject = useMutation({
    mutationFn: (n: string) => rejectSalesClaim(id!, n),
    onSuccess: () => {
      toast.success("Claim rejected — agent notified");
      setReviewerOpen(null);
      setNote("");
      invalidate();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Failed to reject";
      toast.error(msg);
    },
  });

  const needsAmend = useMutation({
    mutationFn: (n: string) => needsAmendmentSalesClaim(id!, n),
    onSuccess: () => {
      toast.success("Claim flagged for amendment — agent notified");
      setReviewerOpen(null);
      setNote("");
      invalidate();
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Failed to flag for amendment";
      toast.error(msg);
    },
  });

  // Cancel — manager+ tidies up duplicates / mis-submitted claims. No
  // dialog: a confirm() is enough; the rejection flow already handles the
  // "I want to bounce this with a note" use case.
  const cancel = useMutation({
    mutationFn: () => cancelSalesClaim(id!),
    onSuccess: () => {
      toast.success("Claim cancelled");
      invalidate();
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? err.message : "Failed to cancel claim";
      toast.error(msg);
    },
  });

  if (claim.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-24 bg-muted rounded-xl" />
        <div className="h-48 bg-muted rounded-xl" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  if (claim.isError || !claim.data) {
    return (
      <Callout variant="danger" title="Failed to load claim">
        The claim could not be loaded. It may have been deleted or you may not
        have access.
      </Callout>
    );
  }

  const c = claim.data;
  const isTerminal = c.status === "approved" || c.status === "rejected";
  const showReviewerActions = !isEditor && !isTerminal;

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate("/sales/claims")}
        className="text-sm text-muted-foreground hover:text-foreground transition flex items-center gap-1"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to sales claims
      </button>

      {/* Header */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <h1 className="text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
                <Receipt className="h-6 w-6 text-primary" />
                Sales claim
              </h1>
              <p className="text-xs font-mono text-muted-foreground">{c.id}</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>
                  Sales unit:{" "}
                  <span className="font-mono text-xs text-foreground">
                    {c.salesUnitId}
                  </span>
                </span>
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <Badge variant={statusBadgeVariant(c.status)}>
                {statusLabel(c.status)}
              </Badge>
              <div className="text-xs text-muted-foreground space-y-0.5 sm:text-right">
                <p>Submitted: {fmtDateTime(c.submittedAt)}</p>
                <p className="font-mono">By: {c.submittedById.slice(0, 8)}…</p>
                {c.reviewedAt && <p>Reviewed: {fmtDateTime(c.reviewedAt)}</p>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {isEditor && (
        <Callout variant="info" title="Editor view">
          Commission amounts and splits are hidden. Approve and reject controls
          are limited to managers and admins.
        </Callout>
      )}

      {c.reviewerNote && (
        <Callout
          variant={c.status === "rejected" ? "danger" : "warning"}
          title={c.status === "rejected" ? "Rejected" : "Reviewer note"}
        >
          {c.reviewerNote}
        </Callout>
      )}

      {/* Commission */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            Commission &amp; payment
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DetailField
              label="Commission type"
              value={
                c.commissionType === "percent_of_purchase"
                  ? "% of purchase"
                  : "Fixed amount"
              }
            />
            <DetailField
              label="Payment type"
              value={<span className="capitalize">{c.paymentType}</span>}
            />
            {!isEditor && (
              <>
                <DetailField
                  label="Commission value"
                  value={
                    c.commissionValue != null
                      ? c.commissionType === "percent_of_purchase"
                        ? `${c.commissionValue}%`
                        : formatRM(c.commissionValue)
                      : "—"
                  }
                />
                <DetailField
                  label="Computed amount"
                  value={
                    c.computedAmount != null ? (
                      <span className="font-bold">
                        {formatRM(c.computedAmount)}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </>
            )}
          </dl>
          {c.notes && (
            <div className="mt-4 rounded-lg border border-border/40 bg-background/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                Notes
              </p>
              <p className="text-sm whitespace-pre-wrap text-foreground">
                {c.notes}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Splits */}
      {!isEditor && (
        <SplitsCard
          splits={c.splits}
          computedAmount={c.computedAmount}
          commissionType={c.commissionType}
        />
      )}

      {/* Audit timeline — every status change with reviewer + note. */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold">Status history</CardTitle>
        </CardHeader>
        <CardContent>
          <ClaimTransitionTimeline
            transitions={transitions.data ?? []}
            isLoading={transitions.isLoading}
            isError={transitions.isError}
          />
        </CardContent>
      </Card>

      {/* Reviewer actions */}
      {showReviewerActions && (
        <RoleGate min="manager">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="gold"
              onClick={() => approve.mutate()}
              disabled={approve.isPending}
            >
              {approve.isPending ? "Approving…" : "Approve"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setReviewerOpen("needs_amendment");
                setNote("");
              }}
            >
              Needs amendment
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setReviewerOpen("reject");
                setNote("");
              }}
            >
              Reject
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          </div>
        </RoleGate>
      )}

      {/* Note dialog */}
      <Dialog
        open={reviewerOpen !== null}
        onOpenChange={(o) => {
          if (!o) {
            setReviewerOpen(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewerOpen === "reject"
                ? "Reject claim"
                : "Flag for amendment"}
            </DialogTitle>
            <DialogDescription>
              {reviewerOpen === "reject"
                ? "Permanently reject this claim. The agent will see this note in their portal."
                : "Send this claim back to the agent. They will see your note in their portal and can re-submit after fixing."}
            </DialogDescription>
          </DialogHeader>
          <label className="block text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Note for the agent
            </span>
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              maxLength={2000}
              className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
              placeholder={
                reviewerOpen === "reject"
                  ? "Explain why this claim is being rejected…"
                  : "Describe what the agent needs to amend…"
              }
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {note.length}/2000 — required
            </span>
          </label>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setReviewerOpen(null);
                setNote("");
              }}
              disabled={reject.isPending || needsAmend.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={reviewerOpen === "reject" ? "destructive" : "gold"}
              disabled={
                note.trim().length === 0 ||
                reject.isPending ||
                needsAmend.isPending
              }
              onClick={() => {
                const n = note.trim();
                if (n.length === 0) return;
                if (reviewerOpen === "reject") reject.mutate(n);
                else needsAmend.mutate(n);
              }}
            >
              {reviewerOpen === "reject"
                ? reject.isPending
                  ? "Rejecting…"
                  : "Reject claim"
                : needsAmend.isPending
                  ? "Sending…"
                  : "Send back to agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmAlert
        open={confirmCancel}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          cancel.mutate();
        }}
        title="Cancel this claim?"
        body="This is terminal — the agent will need to submit a new claim if they want to retry."
        confirmLabel="Cancel claim"
        destructive
      />
    </div>
  );
}

function SplitsCard({
  splits,
  computedAmount,
  commissionType,
}: {
  splits: SalesClaim["splits"];
  computedAmount: number | null;
  commissionType: SalesClaim["commissionType"];
}) {
  const list = splits ?? [];
  const base = computedAmount ?? 0;
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Wallet className="h-5 w-5 text-primary" />
          Claim breakdown
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            ({list.length} {list.length === 1 ? "party" : "parties"})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No splits recorded.</p>
        ) : (
          list.map((s) => {
            const computed =
              s.splitType === "percent" ? (base * s.splitValue) / 100 : s.splitValue;
            return (
              <div
                key={s.id}
                className="flex items-center justify-between rounded border border-border/50 bg-background/40 px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium text-foreground">
                    {s.partyDisplayName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.roleLabel}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">
                    {s.splitType === "percent"
                      ? `${s.splitValue}%`
                      : "Fixed"}
                  </div>
                  <div className="font-medium">{formatRM(Math.round(computed))}</div>
                </div>
              </div>
            );
          })
        )}
        {commissionType === "fixed" && base > 0 && (
          <p className="text-[11px] text-muted-foreground italic mt-2">
            Percent splits are computed against the fixed commission amount.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-MY")} ${d.toLocaleTimeString("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
