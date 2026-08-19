import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, API_BASE } from "@/lib/api-client";
import { StatusPill } from "@/components/ui";
import { formatDate, formatRM, getStatusTone } from "@/components/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import {
  Building2,
  User,
  ClipboardList,
  ArrowLeft,
  DownloadIcon,
} from "lucide-react";
import { humanizeClaimType } from "@/lib/commission-labels";
import { ClaimDrawer, type ClaimForDrawer, type ClaimDrawerMode } from "./claim-drawer";
import { useClaimActions } from "./use-claim-actions";
import { RequestAmendmentModal } from "@/components/amendment/request-amendment-modal";
import { exportClaimAsKaenTemplate } from "@/lib/xlsx-export";
import { RoleGate } from "@/components/role-gate";
import { useAuth } from "@/lib/auth";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type ClaimItem = {
  id: string;
  condoName: string;
  unitCode: string;
  roomType: string;
  tenantName: string;
  tenantEmail: string | null;
  tenantPhone: string | null;
  /** API-pre-formatted display variant of `tenantPhone`. See portal claim DTO. */
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
  remark?: string | null;
  shortfallApplied?: number | null;
  outstandingBalance?: number | null;
  isCobroke?: boolean | null;
  taSharePercent?: string | null;
};

type ClaimDetail = {
  id: string;
  claimNumber: string;
  status: string;
  currency: string;
  claimType: string;
  totalNettPayout: number;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  agentName: string;
  agentEmail: string | null;
  agentPhone: string | null;
  /** API-pre-formatted display variant of `agentPhone`. See claim detail DTO. */
  formattedAgentPhone: string | null;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  items: ClaimItem[];
};

function RemarkText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > 240;
  return (
    <p className="whitespace-pre-wrap text-sm">
      {truncated && !expanded ? text.slice(0, 240) + "…" : text}
      {truncated && (
        <button
          className="ml-2 underline text-xs text-primary"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </p>
  );
}

function CalcStep({ label, value, variant }: { label: string; value: string; variant?: "deduct" | "gold" }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-medium ${
        variant === "deduct" ? "text-red-500" :
        variant === "gold" ? "text-[var(--gold)] font-bold" :
        "text-foreground"
      }`}>{value}</span>
    </div>
  );
}

function ItemRow({ item }: { item: ClaimItem; currency: string }) {
  const [expanded, setExpanded] = useState(false);
  const { user } = useAuth();
  const isManagerOrAdmin = user?.role === "admin" || user?.role === "manager";

  const rental = item.monthlyRental;
  const paxDeduction = (item.numberOfPax ?? 0) > 0 ? (item.numberOfPax ?? 0) * 50 : 0;
  const adjustedRental = rental - paxDeduction;
  const commissionBase = adjustedRental * ((item.agentTierPercentage ?? 0) / 100) * (item.commissionPercentage / 100);
  const tenancyDiff = item.tenancyChargesByAgent - item.tenancyChargesByKaen;

  return (
    <>
      <tr
        className="border-b border-border/50 transition hover:bg-muted/20 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-3 py-2.5">
          <button className={`text-xs text-muted-foreground transition-transform ${expanded ? "rotate-90 text-[var(--gold)]" : ""}`}>
            &#9654;
          </button>
        </td>
        <td className="px-3 py-2.5 font-medium text-foreground truncate" title={item.condoName}>
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="truncate">{item.condoName}</span>
            {item.commissionPercentage < 100 ? (
              <Badge variant="amber">Joint {item.commissionPercentage}%</Badge>
            ) : (
              <Badge variant="emerald">Solo</Badge>
            )}
          </span>
        </td>
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
              {item.shortfallApplied != null && Number(item.shortfallApplied) > 0 && (
                <CalcStep label="Shortfall Deducted" value={`- ${formatRM(Number(item.shortfallApplied))}`} variant="deduct" />
              )}
              {item.outstandingBalance != null && Number(item.outstandingBalance) > 0 && (
                <CalcStep label="Outstanding Balance" value={`${formatRM(Number(item.outstandingBalance))} \u2014 agent must amend`} variant="deduct" />
              )}
            </div>
            {item.remark && (
              <div className="px-6 pb-4 mt-2">
                <div className="p-3 rounded bg-muted/40">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Remark</div>
                  <RemarkText text={item.remark} />
                </div>
              </div>
            )}
            {item.shortfallApplied != null && Number(item.shortfallApplied) > 0 && (
              <div className="px-6 pb-3 mt-1 space-y-2">
                <Callout variant="warning">
                  TA Shortfall deducted: {formatRM(Number(item.shortfallApplied))}
                  {item.outstandingBalance != null && Number(item.outstandingBalance) > 0 && (
                    <span className="ml-1 font-semibold">
                      &mdash; Outstanding: {formatRM(Number(item.outstandingBalance))}
                    </span>
                  )}
                </Callout>
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
                {isManagerOrAdmin && (item.tenantIcFrontKey || item.tenantIcBackKey) && (
                  <div className="mt-3 rounded-lg border border-border/40 bg-background/40 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">IC Images</p>
                    <div className="flex gap-2">
                      {item.tenantIcFrontKey && (
                        <IcViewButtonAdmin claimItemId={item.id} side="front" label="View IC Front" />
                      )}
                      {item.tenantIcBackKey && (
                        <IcViewButtonAdmin claimItemId={item.id} side="back" label="View IC Back" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">&#x24D8; Views are logged for compliance audit.</p>
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

function IcViewButtonAdmin({ claimItemId, side, label }: { claimItemId: string; side: "front" | "back"; label: string }) {
  const [open, setOpen] = useState(false);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchUrl = async () => {
    setOpen(true);
    setError(null);
    setViewUrl(null);
    try {
      const r = await apiFetch<{ data: { viewUrl: string } }>(
        `/tenant-ic/view-url?claimItemId=${claimItemId}&side=${side}`,
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

export default function ClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const claim = useQuery({
    queryKey: ["commissions", "claims", id],
    queryFn: () => apiFetch<{ data: ClaimDetail }>(`/commissions/claims/${id}`),
    enabled: !!id,
  });

  const [drawerMode, setDrawerMode] = useState<ClaimDrawerMode>(null);
  const [amendmentModalOpen, setAmendmentModalOpen] = useState(false);
  const { approve, reApprove, needsAmendment } = useClaimActions();

  if (claim.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-24 bg-muted rounded-xl" />
        <div className="h-48 bg-muted rounded-xl" />
        <div className="h-64 bg-muted rounded-xl" />
      </div>
    );
  }

  if (claim.isError || !claim.data?.data) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load claim. Please refresh.
      </p>
    );
  }

  const c = claim.data.data;
  const canApprove = c.status === "submitted";
  // Reject is broader than Approve: admin can reject a freshly-submitted claim
  // OR an amended re-submission outright (instead of re-approving / sending
  // back again).
  const canReject = c.status === "submitted" || c.status === "amended";
  const canPay = c.status === "approved";
  const canReApprove = c.status === "amended";
  // Admin can send back for amendment from any of {submitted, approved, amended}.
  // The server reverses any Bill side-effect when source is approved/amended.
  const canSendBackForAmendment = ["submitted", "approved", "amended"].includes(c.status);

  const outstandingTotal = c.items.reduce(
    (sum, item) => sum + (item.outstandingBalance != null ? Number(item.outstandingBalance) : 0),
    0,
  );
  const outstandingItemCount = c.items.filter(
    (item) => item.outstandingBalance != null && Number(item.outstandingBalance) > 0,
  ).length;

  const drawerClaim: ClaimForDrawer = {
    id: c.id,
    claimNumber: c.claimNumber,
    status: c.status,
    agentName: c.agentName,
    totalNettPayout: Number(c.totalNettPayout),
    claimDate: c.submittedAt ?? "",
  };

  return (
    <div className="space-y-6">
      {/* Outstanding balance banner */}
      {outstandingTotal > 0 && (
        <Callout variant="danger">
          Warning: {formatRM(outstandingTotal)} outstanding across {outstandingItemCount} item{outstandingItemCount !== 1 ? "s" : ""}. The agent owes KAEN this amount. Approve at manager discretion.
        </Callout>
      )}

      {/* Header */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => navigate("/commissions/claims")}
                className="text-sm text-muted-foreground hover:text-foreground transition flex items-center gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Claims
              </button>
              <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                <ClipboardList className="h-6 w-6 text-primary" />
                {c.claimNumber}
              </h1>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Agent: <span className="font-medium text-foreground">{c.agentName}</span></span>
                <span>&middot;</span>
                <Badge variant="outline">{humanizeClaimType(c.claimType)}</Badge>
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <StatusPill tone={getStatusTone(c.status)}>{c.status}</StatusPill>
              <div className="text-xs text-muted-foreground space-y-0.5">
                {c.submittedAt && <p>Submitted: {formatDate(c.submittedAt)}</p>}
                {c.approvedAt && <p>Approved: {formatDate(c.approvedAt)}</p>}
                {c.paidAt && <p>Paid: {formatDate(c.paidAt)}</p>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Agent info */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <User className="h-5 w-5 text-primary" />
            Agent Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Name</dt>
              <dd className="mt-1 text-sm text-foreground">{c.agentName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email</dt>
              <dd className="mt-1 text-sm text-foreground">{c.agentEmail ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone</dt>
              <dd className="mt-1 text-sm text-foreground">{c.formattedAgentPhone ?? c.agentPhone ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bank name</dt>
              <dd className="mt-1 text-sm text-foreground">{c.bankName ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account holder</dt>
              <dd className="mt-1 text-sm text-foreground">{c.bankAccountHolder ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Account number</dt>
              <dd className="mt-1 text-sm text-foreground">{c.bankAccountNumber ?? "-"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Line Items Table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Line Items
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {c.items.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No line items on this claim.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: 960 }}>
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-3 py-2.5"></th>
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
                  {c.items.map((item) => (
                    <ItemRow key={item.id} item={item} currency={c.currency} />
                  ))}
                  {/* Totals row */}
                  <tr className="bg-[var(--gold)]/5">
                    <td colSpan={14} className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Total Nett Payout
                    </td>
                    <td className="px-3 py-3 text-right text-base font-bold text-[var(--gold)]">
                      {formatRM(c.totalNettPayout)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-3">
        <RoleGate min="manager">
          {canApprove && (
            <>
              <Button
                variant="gold"
                onClick={() => approve.mutate({ claim: drawerClaim })}
                disabled={approve.isPending}
              >
                Approve
              </Button>
              <Button
                variant="outline"
                onClick={() => setDrawerMode("pay-due")}
              >
                Approve with due date&hellip;
              </Button>
            </>
          )}
          {canReApprove && (
            <Button
              variant="gold"
              onClick={() => reApprove.mutate(drawerClaim)}
              disabled={reApprove.isPending}
            >
              {reApprove.isPending ? "Re-approving..." : "Re-approve"}
            </Button>
          )}
          {canReject && (
            <Button variant="destructive" onClick={() => setDrawerMode("reject")}>
              Reject
            </Button>
          )}
          {canSendBackForAmendment && (
            <Button
              variant="outline"
              onClick={() => setAmendmentModalOpen(true)}
              disabled={needsAmendment.isPending}
            >
              Send back for amendment
            </Button>
          )}
          {canPay && (
            <Button
              variant="gold"
              onClick={() => setDrawerMode("pay")}
            >
              Mark as Paid
            </Button>
          )}
        </RoleGate>
        <Button variant="ghost" onClick={() => exportClaimExcel(c)}>
          <DownloadIcon className="mr-1.5 h-4 w-4" /> Export Excel
        </Button>
        <Button variant="ghost" onClick={() => downloadClaimPdf(c)}>
          <DownloadIcon className="mr-1.5 h-4 w-4" /> Export PDF
        </Button>
      </div>

      {canReApprove && <AmendDiffPanel claimId={c.id} />}

      <ClaimDrawer claim={drawerClaim} mode={drawerMode} onClose={() => setDrawerMode(null)} hideDetailLink />

      <RequestAmendmentModal
        open={amendmentModalOpen}
        onClose={() => setAmendmentModalOpen(false)}
        entityLabel="claim"
        busy={needsAmendment.isPending}
        onSubmit={async (note) => {
          await needsAmendment.mutateAsync({ claim: drawerClaim, note });
          setAmendmentModalOpen(false);
        }}
      />
    </div>
  );
}

// Small v1 diff panel — renders the most recent `claim.amend` audit row's
// before/after as JSON inside a collapsible <details>. Manager+ only, since
// the audit-log endpoint itself is gated at that level (403 otherwise).
// Deliberately no fancy side-by-side UI; keys that changed are visible by
// comparing the two `<pre>` blocks. A future pass can add field-level
// highlighting if demand arises.
type AmendAuditRow = {
  id: string;
  createdAt: string;
  actorRole: string;
  diff: { before?: unknown; after?: unknown } | null;
};

function AmendDiffPanel({ claimId }: { claimId: string }) {
  const params = new URLSearchParams({
    entityType: "CommissionClaim",
    entityId: claimId,
    action: "claim.amend",
    pageSize: "1",
  });
  const { data, isLoading, isError } = useQuery({
    queryKey: ["claim-amend-diff", claimId],
    queryFn: () =>
      apiFetch<{ rows: AmendAuditRow[] }>(`/audit-log?${params.toString()}`),
    staleTime: 30_000,
  });
  const latest = data?.rows?.[0];

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold">Recent amendment</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {isLoading && <p className="text-muted-foreground">Loading&hellip;</p>}
        {isError && (
          <p className="text-muted-foreground">
            Unable to load the amendment history. You may not have access, or
            the audit row has been purged (10-day retention).
          </p>
        )}
        {!isLoading && !isError && !latest && (
          <p className="text-muted-foreground">No amend events recorded.</p>
        )}
        {!isLoading && latest && (
          <details className="group">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition">
              Latest amend by {latest.actorRole} ({formatDate(latest.createdAt)})
              &mdash; click to view before/after
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Before
                </div>
                <pre className="text-xs whitespace-pre-wrap rounded-md border border-border/50 bg-muted/30 p-3 overflow-auto max-h-80">
                  {JSON.stringify(latest.diff?.before ?? null, null, 2)}
                </pre>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  After
                </div>
                <pre className="text-xs whitespace-pre-wrap rounded-md border border-border/50 bg-muted/30 p-3 overflow-auto max-h-80">
                  {JSON.stringify(latest.diff?.after ?? null, null, 2)}
                </pre>
              </div>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

async function exportClaimExcel(claim: ClaimDetail) {
  try {
    await exportClaimAsKaenTemplate({
      claimNumber: claim.claimNumber,
      submittedAt: claim.submittedAt,
      agentName: claim.agentName,
      bankAccountHolder: claim.bankAccountHolder,
      bankName: claim.bankName,
      bankAccountNumber: claim.bankAccountNumber,
      items: claim.items,
    });
  } catch (err) {
    toast.error(`Export failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

async function downloadClaimPdf(claim: ClaimDetail) {
  try {
    const res = await fetch(`${API_BASE}/commissions/claims/${claim.id}/pdf`, {
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
