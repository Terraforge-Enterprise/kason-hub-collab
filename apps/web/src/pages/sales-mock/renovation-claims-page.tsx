// MOCK page — admin renovation claims review UI. No backend.
import { useMemo, useState } from "react";
import { Briefcase, ClipboardList, FileText, Package, Plus, Receipt, TrendingUp, Wallet } from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Callout } from "@/components/ui/callout";
import { DecisionPill } from "./decision-pill";
import {
  CLAIM_STATUS_LABELS,
  MOCK_PACKAGE_TYPES,
  MOCK_RENOVATION_CLAIMS,
  PAYMENT_TYPE_LABELS,
  formatRMShort,
  projectFor,
  salesUnitFor,
  type ClaimStatus,
} from "./_mock-data";

const CLAIM_STATUS_VARIANT: Record<ClaimStatus, "amber" | "sky" | "emerald"> = {
  submitted: "sky",
  pending_approval: "amber",
  approved: "emerald",
};

export default function RenovationClaimsPage() {
  const [filterStatus, setFilterStatus] = useState<ClaimStatus | "all">("all");
  const [drawerClaimId, setDrawerClaimId] = useState<string | null>(null);
  const [packageManagerOpen, setPackageManagerOpen] = useState(false);

  const visible = useMemo(() => {
    return MOCK_RENOVATION_CLAIMS.filter((c) =>
      filterStatus === "all" ? true : c.status === filterStatus,
    );
  }, [filterStatus]);

  const stats = useMemo(() => {
    const totalRevenue = MOCK_RENOVATION_CLAIMS
      .filter((c) => c.status === "approved")
      .reduce((sum, c) => sum + c.packagePrice, 0);
    const totalProfit = MOCK_RENOVATION_CLAIMS
      .filter((c) => c.status === "approved")
      .reduce((sum, c) => {
        const houseKeep = c.splits.find((s) => /house keep/i.test(s.role));
        if (!houseKeep) return sum;
        if (houseKeep.type === "fixed") return sum + houseKeep.value;
        return sum + (c.packagePrice * houseKeep.value) / 100;
      }, 0);
    const monthlyOffset = MOCK_RENOVATION_CLAIMS
      .filter((c) => c.paymentType === "offset_from_rental")
      .reduce((sum, c) => sum + (c.monthlyOffsetAmount ?? 0), 0);
    const outstanding = MOCK_RENOVATION_CLAIMS
      .filter((c) => c.paymentType === "partial" || c.paymentType === "offset_from_rental")
      .reduce((sum, c) => sum + c.packagePrice * 0.5, 0); // mock 50% outstanding heuristic
    return { totalRevenue, totalProfit, monthlyOffset, outstanding };
  }, []);

  const drawerClaim = drawerClaimId ? MOCK_RENOVATION_CLAIMS.find((c) => c.id === drawerClaimId) ?? null : null;
  const drawerSalesUnit = drawerClaim ? salesUnitFor(drawerClaim) : null;
  const drawerProject = drawerSalesUnit ? projectFor(drawerSalesUnit) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Briefcase className="h-8 w-8 text-primary" />
          Renovation Claims (MOCK)
        </h1>
        <p className="text-muted-foreground mt-1">
          Renovation cost claims linked to Sales Entries. Approve workflow, splits, payments, and documents.
        </p>
      </div>

      <Callout variant="warning" title="Mockup for client review">
        Click <strong>Keep / Alt / Drop</strong> on every <em>MOCK — decide</em> section to settle
        ambiguities. Fresh page reload resets everything; nothing is saved.
      </Callout>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard glowColor="green" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total renovation sales</p>
              <p className="text-3xl font-bold text-foreground">{formatRMShort(stats.totalRevenue)}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Receipt className="h-3 w-3" />
                <span>approved claims only</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <Receipt className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total profit (House Keep)</p>
              <p className="text-3xl font-bold text-foreground">{formatRMShort(Math.round(stats.totalProfit))}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                <span>{Math.round((stats.totalProfit / Math.max(stats.totalRevenue, 1)) * 100)}% margin</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <TrendingUp className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="purple" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Monthly rental offset</p>
              <p className="text-3xl font-bold text-foreground">{formatRMShort(stats.monthlyOffset)}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Wallet className="h-3 w-3" />
                <span>per month inflow</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-purple-500/10">
              <Wallet className="h-6 w-6 text-purple-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Outstanding balance</p>
              <p className="text-3xl font-bold text-foreground">{formatRMShort(Math.round(stats.outstanding))}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ClipboardList className="h-3 w-3" />
                <span>partial + offset claims</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <ClipboardList className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      <DecisionPill
        id="profit-definition"
        scope="Financial dashboard — profit"
        question="How do we calculate 'Total profit'? The mock uses the line item labelled 'House Keep' inside each claim's split. Is that right?"
        options={{ keep: "House Keep line", alt: "Package - splits", drop: "Don't show profit" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          Alternative: profit = packagePrice − Σ all commission splits. Confirm which definition
          your accounting uses so the dashboard matches reality.
        </p>
      </DecisionPill>

      {/* Filter + actions */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5">
            {(["all", "submitted", "pending_approval", "approved"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilterStatus(s)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  filterStatus === s
                    ? "bg-[var(--gold)]/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "all" ? "All" : CLAIM_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPackageManagerOpen(true)}>
              <Package className="h-4 w-4" /> Manage Packages
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Claims table */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
                <tr>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Project · Unit</th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Package</th>
                  <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Price</th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Payment</th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Submitted</th>
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const su = salesUnitFor(c);
                  const proj = su ? projectFor(su) : undefined;
                  return (
                    <tr
                      key={c.id}
                      className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)] cursor-pointer"
                      onClick={() => setDrawerClaimId(c.id)}
                    >
                      <td className="px-4 py-3.5 text-sm">
                        <div className="font-medium text-foreground">{proj?.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">{su?.unitNumber}</div>
                      </td>
                      <td className="px-4 py-3.5 text-sm capitalize">{c.packageType.replace("_", " ")}</td>
                      <td className="px-4 py-3.5 text-sm text-right font-medium">{formatRMShort(c.packagePrice)}</td>
                      <td className="px-4 py-3.5 text-sm">{PAYMENT_TYPE_LABELS[c.paymentType]}</td>
                      <td className="px-4 py-3.5 text-sm">
                        <div>{c.submittedAt}</div>
                        <div className="text-xs text-muted-foreground">{c.submittedBy}</div>
                      </td>
                      <td className="px-4 py-3.5 text-sm">
                        <Badge variant={CLAIM_STATUS_VARIANT[c.status]}>{CLAIM_STATUS_LABELS[c.status]}</Badge>
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <Button variant="ghost" size="sm">View</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <DecisionPill
        id="approval-workflow-states"
        scope="Claim approval workflow"
        question="Three states (Submitted → Pending Approval → Approved) — is there a 4th state for Rejected / Needs Amendment? Or is rejection 'send back to agent'?"
        options={{ keep: "3 states only", alt: "Add Rejected", drop: "Add Rejected + Amend" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          Existing commission claim flow has Amended (admin asks agent to fix things). If
          renovation claims work the same way, we'd add Rejected/Amended.
        </p>
      </DecisionPill>

      <DecisionPill
        id="merge-with-commission-claim"
        scope="Renovation Claim vs Commission Claim"
        question="Today you have a Commission Claim flow (tenancy commissions). Is Renovation Claim a NEW system, or a new claim type inside the existing system (sharing tables, audit log, approvals)?"
        options={{ keep: "Separate module", alt: "Same as commission, new type", drop: "Merge into one" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          Reusing the commission claim infrastructure (claimType: "renovation") gives you free
          audit log, approval flow, document storage. Separate gives flexibility but doubles
          the codebase. Recommendation: same table, new claimType.
        </p>
      </DecisionPill>

      {/* Detail drawer */}
      <Sheet open={drawerClaim !== null} onOpenChange={(o) => !o && setDrawerClaimId(null)}>
        <SheetContent size="lg" className="overflow-y-auto">
          {drawerClaim && (
            <>
              <SheetHeader>
                <SheetTitle>
                  Renovation Claim · {drawerProject?.name} · {drawerSalesUnit?.unitNumber}
                </SheetTitle>
                <SheetDescription>
                  {CLAIM_STATUS_LABELS[drawerClaim.status]} · submitted by {drawerClaim.submittedBy} on {drawerClaim.submittedAt}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-4">
                {/* Package */}
                <Card className="bg-background/40">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4" /> Package</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Type</span>
                      <span className="capitalize">{drawerClaim.packageType.replace("_", " ")}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Price</span>
                      <span className="font-bold">{formatRMShort(drawerClaim.packagePrice)}</span>
                    </div>
                  </CardContent>
                </Card>

                {/* Splits */}
                <Card className="bg-background/40">
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Claim Breakdown ({drawerClaim.splits.length} parties)</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {drawerClaim.splits.map((s, i) => {
                      const computed = s.type === "percent"
                        ? (drawerClaim.packagePrice * s.value) / 100
                        : s.value;
                      return (
                        <div key={i} className="flex items-center justify-between rounded border border-border/50 bg-background/40 px-3 py-2 text-sm">
                          <div>
                            <div className="font-medium text-foreground">{s.partyName}</div>
                            <div className="text-xs text-muted-foreground">{s.role}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-muted-foreground">
                              {s.type === "percent" ? `${s.value}%` : "Fixed"}
                            </div>
                            <div className="font-medium">{formatRMShort(Math.round(computed))}</div>
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                <DecisionPill
                  id="split-rules"
                  scope="Claim Breakdown — split rules"
                  question="Should split percentages enforce 100% total? Or allow flexible (e.g. 60% to agent, 40% to house = 100%, but also 50/30 = 80% with rest implicit)?"
                  options={{ keep: "Enforce 100%", alt: "Warn but allow", drop: "No validation" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    Existing commission claim enforces 100% across TA splits. Renovation might
                    have different conventions (e.g. some splits are commissions, others are
                    cost categories that don't need to sum).
                  </p>
                </DecisionPill>

                {/* Payment */}
                <Card className="bg-background/40">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Wallet className="h-4 w-4" /> Payment</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Type</span>
                      <Badge variant="outline">{PAYMENT_TYPE_LABELS[drawerClaim.paymentType]}</Badge>
                    </div>
                    {drawerClaim.paymentType === "offset_from_rental" && drawerClaim.monthlyOffsetAmount && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Monthly offset</span>
                        <span className="font-medium">{formatRMShort(drawerClaim.monthlyOffsetAmount)}/month</span>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <DecisionPill
                  id="offset-from-rental-mechanism"
                  scope="Payment Type — Offset from Rental"
                  question="When 'Offset from Rental' is chosen, should the system AUTO-deduct from incoming rental payments each month, or just track the intended offset (manual deduction by ops)?"
                  options={{ keep: "Track only (MVP)", alt: "Auto-deduct", drop: "Don't support offset" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    Auto-deduct requires integration with rental payment system (currently no
                    auto-payment system exists). MVP: capture intent, ops manually applies. Later:
                    automate when rental management ships.
                  </p>
                </DecisionPill>

                {/* Documents */}
                <Card className="bg-background/40">
                  <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><FileText className="h-4 w-4" /> Documents ({drawerClaim.documents.length})</CardTitle></CardHeader>
                  <CardContent className="space-y-1">
                    {drawerClaim.documents.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic">No documents uploaded.</p>
                    ) : (
                      drawerClaim.documents.map((d, i) => (
                        <div key={i} className="flex items-center justify-between rounded border border-border/50 bg-background/40 px-3 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <div className="font-medium">{d.filename}</div>
                              <div className="text-xs text-muted-foreground capitalize">{d.kind}</div>
                            </div>
                          </div>
                          <Button variant="ghost" size="sm">View</Button>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                <DecisionPill
                  id="document-types-required"
                  scope="Documents — what's required vs optional"
                  question="You listed Quotation / Invoices / Agreement (optional). Should Quotation be required at submit, or only Invoice required at approval?"
                  options={{ keep: "Quote at submit", alt: "Quote OR Invoice", drop: "Nothing required" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    Stricter requirements catch bad data earlier; looser ones move faster but
                    let claims sit in "Pending" because docs are missing.
                  </p>
                </DecisionPill>

                {/* Notes */}
                {drawerClaim.notes && (
                  <Card className="bg-background/40">
                    <CardHeader className="pb-2"><CardTitle className="text-sm">Notes / Special Terms</CardTitle></CardHeader>
                    <CardContent>
                      <p className="text-sm italic text-muted-foreground">"{drawerClaim.notes}"</p>
                    </CardContent>
                  </Card>
                )}

                {/* Actions */}
                <div className="flex gap-2">
                  {drawerClaim.status !== "approved" && (
                    <Button variant="gold" className="flex-1">
                      {drawerClaim.status === "submitted" ? "Move to Pending" : "Approve"}
                    </Button>
                  )}
                  <Button variant="outline">Reject</Button>
                  <Button variant="ghost" onClick={() => setDrawerClaimId(null)}>Close</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Package manager (super-admin) */}
      <Sheet open={packageManagerOpen} onOpenChange={setPackageManagerOpen}>
        <SheetContent size="sm" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Manage Renovation Packages</SheetTitle>
            <SheetDescription>Super-admin only — add/edit/archive package types.</SheetDescription>
          </SheetHeader>
          <div className="space-y-3 mt-4">
            {MOCK_PACKAGE_TYPES.map((p) => (
              <Card key={p.key} className="bg-background/40">
                <CardContent className="p-3 flex items-start justify-between">
                  <div>
                    <p className="font-semibold text-foreground">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.description}</p>
                    <p className="text-xs text-muted-foreground mt-1">Default: {formatRMShort(p.defaultPrice)}</p>
                  </div>
                  <Button variant="ghost" size="sm">Edit</Button>
                </CardContent>
              </Card>
            ))}
            <Button variant="gold" className="w-full">
              <Plus className="h-4 w-4" /> Add new package type
            </Button>
            <DecisionPill
              id="package-flexibility"
              scope="Package Types — admin tool"
              question="Should packages have a default price (per row above) that pre-fills the claim form, or always require manual entry?"
              options={{ keep: "Default price", alt: "No default", drop: "Hardcoded fixed" }}
            >
              <p className="text-xs text-muted-foreground italic px-2">
                Default speeds up claim entry; manual prevents stale prices when costs change.
              </p>
            </DecisionPill>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

