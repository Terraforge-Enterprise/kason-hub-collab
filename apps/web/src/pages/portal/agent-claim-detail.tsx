import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { portalApiFetch, PortalApiError, portalApiUrl } from "@/lib/portal-api";
import { formatRM, formatDate, getStatusTone } from "@/components/format";
import { StatusPill } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { ArrowLeft, Download as DownloadIcon } from "lucide-react";
import { exportClaimAsKaenTemplate } from "@/lib/xlsx-export";

type ClaimLineItem = {
  id: string;
  condoName: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  tenantEmail: string | null;
  tenantPhone: string | null;
  /** API-pre-formatted display variant of `tenantPhone`. */
  formattedTenantPhone: string | null;
  tenantLinkedinUrl: string | null;
  tenantInstagramHandle: string | null;
  tenantJobPosition: string | null;
  tenantIcFrontKey: string | null;
  tenantIcBackKey: string | null;
  salesDate: string;
  moveInDate: string;
  moveOutDate: string | null;
  monthlyRental: number;
  agentTierPercentage: number | null;
  commissionPercentage: number;
  tenancyChargesByAgent: number;
  tenancyChargesByKaen: number;
  numberOfPax: number | null;
  nettPayout: number;
  shortfallApplied?: number | null;
  outstandingBalance?: number | null;
  taSharePercent?: string | null;
};

type ClaimDetail = {
  id: string;
  claimNumber: string;
  status: string;
  claimType: string;
  totalNettPayout: number;
  rejectionReason: string | null;
  amendmentNote: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  agentPartyId: string;
  agentName: string;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  items: ClaimLineItem[];
};

function humanizeClaimType(type: string): string {
  const map: Record<string, string> = {
    tenant_portion: "Tenant Portion",
    listing_portion: "Listing Portion",
    tenant_listing_portion: "Tenant + Listing Portion",
  };
  return map[type] ?? type;
}

export default function AgentClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Confirm dialog state for destructive actions (delete draft, cancel submitted).
  const [confirm, setConfirm] = useState<"delete" | "cancel" | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agent-commission-claim", id],
    queryFn: () => portalApiFetch<{ data: ClaimDetail }>(`/commissions/claims/${id}`),
  });

  const invalidateClaim = () => {
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claim", id] });
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claims"] });
    queryClient.invalidateQueries({ queryKey: ["agent-commission-claims-recent"] });
  };

  const submitMutation = useMutation({
    mutationFn: () =>
      portalApiFetch(`/commissions/claims/${id}/submit`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Claim submitted");
      invalidateClaim();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to submit claim"),
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      portalApiFetch(`/commissions/claims/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Claim cancelled");
      invalidateClaim();
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to cancel claim"),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      portalApiFetch(`/commissions/claims/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Draft deleted");
      queryClient.invalidateQueries({ queryKey: ["agent-commission-claims"] });
      navigate("/portal/claims");
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Failed to delete claim"),
  });

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-12 w-64 bg-muted rounded" />
        <div className="h-48 bg-muted rounded-xl" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  // Distinguish a real GET failure from an actual 404 — otherwise a network
  // error or 500 shows up as "Claim not found" which misleads the user.
  if (isError) {
    const notFound = error instanceof PortalApiError && error.status === 404;
    if (notFound) {
      return <p className="p-6 text-sm text-rose-600">Claim not found.</p>;
    }
    const message =
      error instanceof Error ? error.message : "Couldn't load claim. Please try again.";
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm text-rose-600">Couldn't load claim.</p>
        <p className="text-xs text-muted-foreground">{message}</p>
      </div>
    );
  }

  const claim = data?.data;
  if (!claim) return <p className="p-6 text-sm text-rose-600">Claim not found.</p>;

  const isDraft = claim.status === "draft";
  const isSubmitted = claim.status === "submitted";
  const isNeedsAmendment = claim.status === "needs_amendment";
  const isAmendable = claim.status === "approved" || claim.status === "amended";

  const outstandingTotal = claim.items.reduce((sum, item) => {
    const bal = item.outstandingBalance != null ? Number(item.outstandingBalance) : 0;
    return sum + (bal > 0 ? bal : 0);
  }, 0);

  const mutating =
    submitMutation.isPending ||
    cancelMutation.isPending ||
    deleteMutation.isPending;

  return (
    <div className="space-y-6">
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <button
                type="button"
                onClick={() => navigate("/portal/claims")}
                className="text-sm text-muted-foreground hover:text-foreground transition flex items-center gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Claims
              </button>
              <h1 className="text-2xl font-bold text-foreground mt-2">Claim {claim.claimNumber}</h1>
              <div className="mt-1 flex items-center gap-2">
                <StatusPill tone={getStatusTone(claim.status)}>{claim.status}</StatusPill>
                <span className="text-xs text-muted-foreground">
                  {humanizeClaimType(claim.claimType)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {claim.submittedAt
                    ? `Submitted ${formatDate(claim.submittedAt)}`
                    : `Created ${formatDate(claim.createdAt)}`}
                </span>
              </div>
            </div>

            {isDraft && (
              <div className="flex flex-shrink-0 gap-2">
                <Button
                  variant="outline"
                  onClick={() => navigate(`/portal/claims/new?editDraft=${claim.id}`)}
                  disabled={mutating}
                >
                  Edit Draft
                </Button>
                <Button
                  variant="gold"
                  onClick={() => submitMutation.mutate()}
                  disabled={mutating}
                >
                  {submitMutation.isPending ? "Submitting..." : "Submit"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirm("delete")}
                  disabled={mutating}
                >
                  Delete
                </Button>
              </div>
            )}
            {isSubmitted && (
              <div className="flex flex-shrink-0 gap-2">
                <Button
                  variant="outline"
                  onClick={() => navigate(`/portal/claims/new?editDraft=${claim.id}`)}
                  disabled={mutating}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirm("cancel")}
                  disabled={mutating}
                >
                  Cancel claim
                </Button>
              </div>
            )}
            {isNeedsAmendment && (
              <div className="flex flex-shrink-0 gap-2">
                <Button
                  variant="gold"
                  onClick={() => navigate(`/portal/claims/new?resubmit=${claim.id}`)}
                  disabled={mutating}
                >
                  Re-edit &amp; resubmit
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirm("cancel")}
                  disabled={mutating}
                >
                  Cancel claim
                </Button>
              </div>
            )}
            {isAmendable && (
              <div className="flex flex-shrink-0 gap-2">
                <Button
                  variant="outline"
                  onClick={() => navigate(`/portal/claims/new?amend=${claim.id}`)}
                  disabled={mutating}
                >
                  Edit (requires re-approval)
                </Button>
              </div>
            )}
          </div>
          {/* Export row — always visible for parity with admin claim-detail */}
          <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-border/40">
            <Button variant="ghost" onClick={() => downloadClaimPdf(claim)}>
              <DownloadIcon className="mr-1.5 h-4 w-4" /> Export PDF
            </Button>
            <Button variant="ghost" onClick={() => downloadClaimExcel(claim)}>
              <DownloadIcon className="mr-1.5 h-4 w-4" /> Export Excel
            </Button>
          </div>
        </CardContent>
      </Card>

      {claim.status === "rejected" && claim.rejectionReason && (
        <Callout variant="danger" title="Claim Rejected">
          {claim.rejectionReason}
        </Callout>
      )}

      {isNeedsAmendment && (
        <Callout variant="warning" title="Admin requested changes">
          {claim.amendmentNote
            ? claim.amendmentNote
            : "Admin sent this claim back without a note — please review and re-submit."}
        </Callout>
      )}

      {isSubmitted && (
        <Callout variant="warning">
          This claim is awaiting admin review. You can still edit it here — your changes save in place and do not require re-approval until the admin acts.
        </Callout>
      )}
      {isAmendable && (
        <Callout variant="warning">
          <span className="font-semibold">
            {claim.status === "approved" ? "Editing this approved claim" : "This claim is amended and"}
          </span>{" "}
          {claim.status === "approved"
            ? 'will flip it back to "Amended" and require admin re-approval.'
            : "awaits admin re-approval. Further edits are still allowed."}
        </Callout>
      )}

      {outstandingTotal > 0 && (
        <Callout variant="danger">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span>
              <span className="font-semibold">Warning: {formatRM(outstandingTotal)} outstanding.</span>{" "}
              This will be owed to KAEN. You can amend to reduce or leave as-is — approval proceeds at manager discretion.
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => navigate(`/portal/claims/new?amend=${claim.id}`)}
              className="flex-shrink-0"
            >
              Amend claim
            </Button>
          </div>
        </Callout>
      )}

      {/* Line Items Table */}
      <div className="rounded-xl border border-border/50 bg-background/60 backdrop-blur-xl shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border/50">
          <h2 className="text-lg font-semibold text-foreground">Line Items</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 960 }}>
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-3 py-2.5 whitespace-nowrap"></th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Condo</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Unit</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Room</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Tenant</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Sales Date</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Move-in</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Move-out</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Rental</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Agent Tier %</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Commission %</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Agent Charges</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">KAEN Charges</th>
                <th title="Occupants" className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Pax</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-widest text-muted-foreground font-semibold whitespace-nowrap">Nett Payout</th>
              </tr>
            </thead>
            <tbody>
              {claim.items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
              <tr className="bg-[var(--gold)]/5">
                <td colSpan={14} className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Nett Payout
                </td>
                <td className="px-3 py-3 text-right text-base font-bold text-[var(--gold)]">
                  {formatRM(claim.totalNettPayout)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "delete" ? "Delete draft claim?" : "Cancel claim?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? `Draft "${claim.claimNumber}" will be permanently removed. This cannot be undone.`
                : `Claim "${claim.claimNumber}" (${formatRM(claim.totalNettPayout)}) will be cancelled and removed from the admin review queue. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending || cancelMutation.isPending}>
              Keep
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm === "delete") deleteMutation.mutate();
                else if (confirm === "cancel") cancelMutation.mutate();
                setConfirm(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {confirm === "delete" ? "Delete draft" : "Cancel claim"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ItemRow({ item }: { item: ClaimLineItem }) {
  const [expanded, setExpanded] = useState(false);

  const rental = item.monthlyRental;
  const paxDeduction = (item.numberOfPax ?? 0) > 0 ? (item.numberOfPax ?? 0) * 50 : 0;
  const adjustedRental = rental - paxDeduction;
  const commissionBase = adjustedRental * ((item.agentTierPercentage ?? 0) / 100) * (item.commissionPercentage / 100);
  const tenancyDiff = item.tenancyChargesByAgent - item.tenancyChargesByKaen;

  return (
    <>
      <tr className="border-b border-border/50 transition hover:bg-muted/20 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <td className="px-3 py-2.5">
          <span className={`text-xs text-muted-foreground transition-transform inline-block ${expanded ? "rotate-90 text-[var(--gold)]" : ""}`}>&#9654;</span>
        </td>
        <td className="px-3 py-2.5 font-medium text-foreground truncate" title={item.condoName}>{item.condoName}</td>
        <td className="px-3 py-2.5 text-foreground whitespace-nowrap">{item.unitCode}</td>
        <td className="px-3 py-2.5 text-muted-foreground">{item.roomType}</td>
        <td className="px-3 py-2.5 text-muted-foreground truncate" title={item.tenantName}>{item.tenantName}</td>
        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{formatDate(item.salesDate)}</td>
        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{formatDate(item.moveInDate)}</td>
        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{item.moveOutDate ? formatDate(item.moveOutDate) : "—"}</td>
        <td className="px-3 py-2.5 text-right text-foreground whitespace-nowrap">{formatRM(item.monthlyRental)}</td>
        <td className="px-3 py-2.5 text-right text-muted-foreground">{item.agentTierPercentage}%</td>
        <td className="px-3 py-2.5 text-right text-muted-foreground">{item.commissionPercentage}%</td>
        <td className="px-3 py-2.5 text-right text-foreground whitespace-nowrap">{formatRM(item.tenancyChargesByAgent)}</td>
        <td className="px-3 py-2.5 text-right text-foreground whitespace-nowrap">{formatRM(item.tenancyChargesByKaen)}</td>
        <td className="px-3 py-2.5 text-right text-muted-foreground">{item.numberOfPax ?? "\u2014"}</td>
        <td className="px-3 py-2.5 text-right font-semibold text-foreground whitespace-nowrap">{formatRM(item.nettPayout)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={15} className="p-0 border-b border-border">
            <div className="bg-muted/20 px-6 py-3 flex items-center gap-6 flex-wrap text-sm">
              <CalcStep label="Monthly Rental" value={formatRM(rental)} />
              {paxDeduction > 0 && (
                <>
                  <CalcStep label={`Pax Deduction (${item.numberOfPax} pax)`} value={`- ${formatRM(paxDeduction)}`} variant="deduct" />
                  <CalcStep label="Adjusted Rental" value={formatRM(adjustedRental)} />
                  <div className="w-px h-8 bg-border self-stretch" />
                </>
              )}
              <CalcStep label={`\u00d7 Tier ${item.agentTierPercentage}% \u00d7 Comm ${item.commissionPercentage}%`} value={formatRM(commissionBase)} />
              <CalcStep label={`+ Charges Diff (${formatRM(item.tenancyChargesByAgent)} - ${formatRM(item.tenancyChargesByKaen)})`} value={tenancyDiff >= 0 ? `+ ${formatRM(tenancyDiff)}` : `- ${formatRM(Math.abs(tenancyDiff))}`} />
              <div className="w-px h-8 bg-border self-stretch" />
              <CalcStep label="Nett Payout" value={`= ${formatRM(item.nettPayout)}`} variant="gold" />
            </div>
            {(
              (item.shortfallApplied != null && Number(item.shortfallApplied) > 0) ||
              (item.outstandingBalance != null && Number(item.outstandingBalance) > 0) ||
              (item.taSharePercent != null)
            ) && (
              <div className="bg-muted/20 px-6 pb-3 border-t border-border/30 flex items-center gap-6 flex-wrap text-sm pt-3">
                {item.shortfallApplied != null && Number(item.shortfallApplied) > 0 && (
                  <CalcStep
                    label="Shortfall Deducted"
                    value={`- ${formatRM(Number(item.shortfallApplied))}`}
                    variant="deduct"
                  />
                )}
                {item.outstandingBalance != null && Number(item.outstandingBalance) > 0 && (
                  <CalcStep
                    label="Outstanding Balance (exceeds deductible)"
                    value={formatRM(Number(item.outstandingBalance))}
                    variant="outstanding"
                  />
                )}
                {item.taSharePercent != null && (
                  <CalcStep
                    label="TA Share"
                    value={`${item.taSharePercent}%`}
                  />
                )}
              </div>
            )}
            {(item.tenantEmail || item.tenantPhone || item.tenantLinkedinUrl || item.tenantInstagramHandle || item.tenantJobPosition) && (
              <div className="px-6 pb-4 mt-2">
                <div className="mt-3 rounded-lg border border-border/40 bg-background/40 p-3 space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Tenant Profile</p>
                  {item.tenantJobPosition && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Job:</span> {item.tenantJobPosition}
                    </p>
                  )}
                  {item.tenantEmail && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Email:</span>{" "}
                      <a href={`mailto:${item.tenantEmail}`} className="text-primary hover:underline">{item.tenantEmail}</a>
                    </p>
                  )}
                  {item.tenantPhone && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Phone:</span>{" "}
                      <a href={`tel:${item.tenantPhone}`} className="text-primary hover:underline">
                        {item.formattedTenantPhone ?? item.tenantPhone}
                      </a>
                    </p>
                  )}
                  {item.tenantLinkedinUrl && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">LinkedIn:</span>{" "}
                      <a href={item.tenantLinkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        View profile ↗
                      </a>
                    </p>
                  )}
                  {item.tenantInstagramHandle && (
                    <p className="text-sm">
                      <span className="text-muted-foreground">Instagram:</span>{" "}
                      <a href={`https://www.instagram.com/${item.tenantInstagramHandle}/`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        @{item.tenantInstagramHandle} ↗
                      </a>
                    </p>
                  )}
                </div>
                {(item.tenantIcFrontKey || item.tenantIcBackKey) && (
                  <div className="mt-3 rounded-lg border border-border/40 bg-background/40 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">IC Images</p>
                    <div className="flex gap-2">
                      {item.tenantIcFrontKey && (
                        <IcViewButtonPortal storageKey={item.tenantIcFrontKey} label="View IC Front" />
                      )}
                      {item.tenantIcBackKey && (
                        <IcViewButtonPortal storageKey={item.tenantIcBackKey} label="View IC Back" />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function IcViewButtonPortal({ storageKey, label }: { storageKey: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchUrl = async () => {
    setOpen(true);
    setError(null);
    setViewUrl(null);
    try {
      const r = await portalApiFetch<{ data: { viewUrl: string } }>(
        `/tenant-ic/view-url?storageKey=${encodeURIComponent(storageKey)}`,
      );
      setViewUrl(r.data.viewUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={fetchUrl}>
        👁 {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          {viewUrl && <img src={viewUrl} alt={label} className="w-full rounded" />}
          {!viewUrl && !error && <div className="h-64 rounded bg-muted animate-pulse" />}
          {error && <p role="alert" className="text-rose-600">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CalcStep({ label, value, variant }: { label: string; value: string; variant?: "deduct" | "gold" | "outstanding" }) {
  const valueClass =
    variant === "deduct"
      ? "text-red-500"
      : variant === "gold"
        ? "text-[var(--gold)] font-bold"
        : variant === "outstanding"
          ? "text-rose-600 font-semibold"
          : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-[11px] ${variant === "outstanding" ? "text-rose-500" : "text-muted-foreground"}`}>{label}</span>
      <span className={`font-medium ${valueClass}`}>{value}</span>
    </div>
  );
}

async function downloadClaimPdf(claim: ClaimDetail): Promise<void> {
  try {
    const res = await fetch(portalApiUrl(`/commissions/claims/${claim.id}/pdf`), {
      credentials: "include",
    });
    if (!res.ok) {
      toast.error(`PDF export failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${claim.claimNumber}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    toast.error(`PDF export failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

async function downloadClaimExcel(claim: ClaimDetail): Promise<void> {
  try {
    await exportClaimAsKaenTemplate({
      claimNumber: claim.claimNumber,
      submittedAt: claim.submittedAt,
      agentName: claim.agentName,
      bankAccountHolder: claim.bankAccountHolder,
      bankName: claim.bankName,
      bankAccountNumber: claim.bankAccountNumber,
      items: claim.items.map((it) => ({
        condoName: it.condoName,
        unitCode: it.unitCode,
        roomType: it.roomType,
        tenantName: it.tenantName,
        salesDate: it.salesDate,
        moveInDate: it.moveInDate,
        monthlyRental: it.monthlyRental,
        tenancyChargesByAgent: it.tenancyChargesByAgent,
        tenancyChargesByKaen: it.tenancyChargesByKaen,
        numberOfPax: it.numberOfPax,
        agentTierPercentage: it.agentTierPercentage,
        commissionPercentage: it.commissionPercentage,
        nettPayout: it.nettPayout,
      })),
    });
  } catch (err) {
    toast.error(`Excel export failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

