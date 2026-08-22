// MOCK page — admin sales pipeline review UI. No backend, no persistence.
// Each ambiguous decision is wrapped in a <DecisionPill> with Keep / Alt / Drop.
import { useMemo, useState } from "react";
import { Building2, Calendar, Hammer, Home, Package, Sparkles, X } from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Callout } from "@/components/ui/callout";
import { DecisionPill } from "./decision-pill";
import {
  MOCK_PROJECTS,
  MOCK_SALES_UNITS,
  RENOVATION_STATUS_LABELS,
  formatRMShort,
  projectFor,
  type RenovationStatus,
} from "./_mock-data";

const STATUS_COLORS: Record<RenovationStatus, string> = {
  not_started: "rose",
  on_going: "amber",
  completed: "emerald",
};

export default function SalesPipelinePage() {
  const [filterProjectId, setFilterProjectId] = useState<string | "all">("all");
  const [filterStatus, setFilterStatus] = useState<RenovationStatus | "all">("all");
  const [drawerUnitId, setDrawerUnitId] = useState<string | null>(null);
  const [promoteUnitId, setPromoteUnitId] = useState<string | null>(null);

  const visible = useMemo(() => {
    return MOCK_SALES_UNITS.filter((u) => {
      if (filterProjectId !== "all" && u.projectId !== filterProjectId) return false;
      if (filterStatus !== "all" && u.renovation.status !== filterStatus) return false;
      return true;
    });
  }, [filterProjectId, filterStatus]);

  const counts = useMemo(() => {
    const total = MOCK_SALES_UNITS.length;
    const not_started = MOCK_SALES_UNITS.filter((u) => u.renovation.status === "not_started").length;
    const on_going = MOCK_SALES_UNITS.filter((u) => u.renovation.status === "on_going").length;
    const completed = MOCK_SALES_UNITS.filter((u) => u.renovation.status === "completed").length;
    const ready_move_in = MOCK_SALES_UNITS.filter(
      (u) => u.renovation.status === "completed" && u.purpose === "rent",
    ).length;
    return { total, not_started, on_going, completed, ready_move_in };
  }, []);

  const drawerUnit = drawerUnitId ? MOCK_SALES_UNITS.find((u) => u.id === drawerUnitId) ?? null : null;
  const promoteUnit = promoteUnitId ? MOCK_SALES_UNITS.find((u) => u.id === promoteUnitId) ?? null : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <Sparkles className="h-8 w-8 text-primary" />
          Sales Pipeline (MOCK)
        </h1>
        <p className="text-muted-foreground mt-1">
          Off-plan units agents have secured. Sits between project sale and the rental inventory.
        </p>
      </div>

      <Callout variant="warning" title="Mockup for client review">
        Every section marked <strong>MOCK — decide</strong> is a question I'd otherwise have to ask in
        an email. Click <em>Keep / Alt / Drop</em> on each one as you walk through. No data persists;
        a fresh page reload resets everything.
      </Callout>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <GlowCard glowColor="blue" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total secured</p>
              <p className="text-3xl font-bold text-foreground">{counts.total}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3" />
                <span>across {MOCK_PROJECTS.length} projects</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-blue-500/10">
              <Building2 className="h-6 w-6 text-blue-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="red" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Not started</p>
              <p className="text-3xl font-bold text-foreground">{counts.not_started}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>renovation pending</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-red-500/10">
              <Calendar className="h-6 w-6 text-red-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">On going</p>
              <p className="text-3xl font-bold text-foreground">{counts.on_going}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Hammer className="h-3 w-3" />
                <span>under renovation</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <Hammer className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="green" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Completed</p>
              <p className="text-3xl font-bold text-foreground">{counts.completed}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                <span>reno done</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <Sparkles className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Ready Move In</p>
              <p className="text-3xl font-bold text-foreground">{counts.ready_move_in}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Home className="h-3 w-3" />
                <span>rentable today</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-amber-500/10">
              <Home className="h-6 w-6 text-amber-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      <DecisionPill
        id="dashboard-financial-row"
        scope="Sales Pipeline — top of page"
        question="Should the admin dashboard also show a Financial row here (renovation sales, profit, outstanding) — or keep that on the Renovation Claims page only?"
        options={{ keep: "Show here too", alt: "Claims page only", drop: "Drop entirely" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          The 5 status counts above are operational. A financial row would add: total renovation revenue this
          month, profit margin, outstanding balance, monthly rental-offset collection. Heavy if both pages
          show it; useful if you want one-glance visibility from the pipeline.
        </p>
      </DecisionPill>

      {/* Filters */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project</span>
            <select
              value={filterProjectId}
              onChange={(e) => setFilterProjectId(e.target.value as typeof filterProjectId)}
              className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
            >
              <option value="all">All projects</option>
              {MOCK_PROJECTS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
            <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5">
              {(["all", "not_started", "on_going", "completed"] as const).map((s) => (
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
                  {s === "all" ? "All" : RENOVATION_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">
            {visible.length} of {MOCK_SALES_UNITS.length} shown
          </div>
        </CardContent>
      </Card>

      <DecisionPill
        id="status-edit-permission"
        scope="Renovation status — who edits"
        question="Who can change renovation status (Not Started → On Going → Completed)? Just admin, or do you want a separate Operations role?"
        options={{ keep: "Admin only", alt: "New 'Ops' role", drop: "Anyone with access" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          Today the system has admin/manager (operator) and agent (viewer). If renovation managers
          should update status without touching financials, we'd add a new role. Otherwise admin handles it.
        </p>
      </DecisionPill>

      {/* Kanban columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(["not_started", "on_going", "completed"] as const).map((status) => {
          const items = visible.filter((u) => u.renovation.status === status);
          return (
            <Card
              key={status}
              className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
            >
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span className={`inline-block h-2 w-2 rounded-full bg-${STATUS_COLORS[status]}-500`} />
                    {RENOVATION_STATUS_LABELS[status]}
                  </span>
                  <Badge variant="outline">{items.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-4 text-center">No units</p>
                ) : (
                  items.map((u) => {
                    const project = projectFor(u);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => setDrawerUnitId(u.id)}
                        className="w-full text-left rounded-lg border border-border/50 bg-background/40 p-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground truncate">
                              {project?.name} · {u.unitNumber}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {u.ownerName} · {u.bedrooms}BR/{u.bathrooms}BA
                            </p>
                          </div>
                          <Badge
                            variant={u.purpose === "rent" ? "sky" : "outline"}
                            className="shrink-0 text-[10px] uppercase"
                          >
                            {u.purpose}
                          </Badge>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            Sold {u.salesDate}
                          </span>
                          <span className="font-medium text-foreground">
                            {formatRMShort(u.expectedRental)}/month
                          </span>
                        </div>
                        {status === "completed" && u.purpose === "rent" && (
                          <div className="mt-2 pt-2 border-t border-border/50">
                            <Button
                              variant="gold"
                              size="sm"
                              className="w-full"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPromoteUnitId(u.id);
                              }}
                            >
                              Promote to Rental Inventory
                            </Button>
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <DecisionPill
        id="kanban-vs-table"
        scope="Sales Pipeline — main view"
        question="Kanban (3 columns by status) vs traditional table view. Which works better for your team?"
        options={{ keep: "Kanban", alt: "Table view", drop: "Both / toggle" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          Kanban makes status flow visible at a glance. Table view fits more rows + columns
          (sales date, expected rental, etc.) and supports sorting. We can also offer a toggle.
        </p>
      </DecisionPill>

      <DecisionPill
        id="auto-promote"
        scope="Renovation Completed → Rental Inventory"
        question="When renovation is marked Completed for a Rent-purpose unit, promote to rental inventory automatically OR require admin to click 'Promote' button (as shown above)?"
        options={{ keep: "Admin click", alt: "Auto-promote", drop: "Don't promote at all" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          The button gates bad data crossing into the rental side (admin reviews/edits before
          promotion). Auto would be faster but if anything's wrong on the SalesUnit, it propagates.
        </p>
      </DecisionPill>

      <DecisionPill
        id="document-upload-sales-entry"
        scope="Sales Entry submission"
        question="Should agents upload documents at Sales Entry stage (sales agreement, booking form, payment receipt)? Or only at Renovation Claim stage?"
        options={{ keep: "Both stages", alt: "Sales only", drop: "Claim only" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          You explicitly listed document upload (Quotation/Invoices/Agreement) on the Renovation
          Claim. Off-plan sales also generate documents (sales agreement with developer, buyer's
          booking form). Capture them at submission time?
        </p>
      </DecisionPill>

      {/* Detail drawer */}
      <Sheet open={drawerUnit !== null} onOpenChange={(o) => !o && setDrawerUnitId(null)}>
        <SheetContent size="md" className="overflow-y-auto">
          {drawerUnit && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5 text-primary" />
                  {projectFor(drawerUnit)?.name} · {drawerUnit.unitNumber}
                </SheetTitle>
                <SheetDescription>
                  Sales entry detail — submitted by {drawerUnit.agentName} on {drawerUnit.salesDate}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-4">
                <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Owner</p>
                      <p className="font-medium text-foreground">{drawerUnit.ownerName}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Purpose</p>
                      <Badge variant={drawerUnit.purpose === "rent" ? "sky" : "outline"}>
                        {drawerUnit.purpose}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Bedrooms / Bathrooms</p>
                      <p className="font-medium">{drawerUnit.bedrooms}BR · {drawerUnit.bathrooms}BA</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Parking lots</p>
                      <p className="font-medium">{drawerUnit.parkingLots}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Owner expected rental</p>
                      <p className="font-medium">{formatRMShort(drawerUnit.expectedRental)}/month</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Purchase price</p>
                      <p className="font-medium">{formatRMShort(drawerUnit.purchasePrice)}</p>
                    </div>
                  </div>
                </div>

                <DecisionPill
                  id="purchase-price-field"
                  scope="Sales Entry — fields"
                  question="Capture Purchase Price on the Sales Entry? (Not in your spec but seems essential for off-plan sales — off-plan claim commissions might be based on it.)"
                  options={{ keep: "Capture it", alt: "Optional", drop: "Don't capture" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    Purchase price = what the buyer pays the developer. Different from rental
                    rate. Probably needed for the agent's sales commission calculation.
                  </p>
                </DecisionPill>

                <DecisionPill
                  id="sales-commission-claim"
                  scope="Sales Entry → Sales Commission"
                  question="Is the agent's commission for the SALE itself a separate claim, or rolled into the Renovation Claim?"
                  options={{ keep: "Rolled into reno", alt: "Separate sale claim", drop: "No sale commission" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    Off-plan deals usually pay 1-3% of purchase price as agent commission, separate
                    from any renovation profit. Your spec only mentions Renovation Claim — clarify
                    whether sales commission is captured there or needs its own flow.
                  </p>
                </DecisionPill>

                <Card className="bg-background/40">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Renovation</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <Badge variant={drawerUnit.renovation.status === "completed" ? "emerald" : drawerUnit.renovation.status === "on_going" ? "amber" : "rose"}>
                        {RENOVATION_STATUS_LABELS[drawerUnit.renovation.status]}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Start date</span>
                      <span>{drawerUnit.renovation.startDate ?? "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Expected completion</span>
                      <span>{drawerUnit.renovation.expectedCompletion ?? "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Actual completion</span>
                      <span>{drawerUnit.renovation.actualCompletion ?? "—"}</span>
                    </div>
                  </CardContent>
                </Card>

                <DecisionPill
                  id="renovation-history"
                  scope="Renovation status tracking"
                  question="Should renovation status changes be auditable (every transition logged with who/when), or just show the latest state?"
                  options={{ keep: "Audit trail", alt: "Latest only", drop: "Don't track" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    If renovation pauses/resumes or someone reopens a Completed unit, an audit
                    trail explains why a unit's "Ready Move In" badge disappeared.
                  </p>
                </DecisionPill>

                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => setDrawerUnitId(null)}
                >
                  <X className="h-4 w-4" /> Close
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Promote modal */}
      <Sheet open={promoteUnit !== null} onOpenChange={(o) => !o && setPromoteUnitId(null)}>
        <SheetContent size="md" className="overflow-y-auto">
          {promoteUnit && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-primary" />
                  Promote to Rental Inventory
                </SheetTitle>
                <SheetDescription>
                  Preview of fields that will copy from this Sales Entry into a new rental Unit + auto-published Listing.
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-4">
                <Callout variant="info">
                  This is the bridge moment between off-plan sales and the existing rental
                  inventory. The new Unit + Listing become visible to agents in /portal/inventory.
                </Callout>

                <div className="rounded-lg border border-border/50 bg-background/40 p-4 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Project → Property</span><span>{projectFor(promoteUnit)?.name}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Unit code</span><span className="font-mono">{promoteUnit.unitNumber}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Bedrooms</span><span>{promoteUnit.bedrooms}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Bathrooms</span><span>{promoteUnit.bathrooms}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Parking lots</span><span>{promoteUnit.parkingLots}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Rental rate</span><span>{formatRMShort(promoteUnit.expectedRental)}/month</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Owner</span><span>{promoteUnit.ownerName}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">readyNow</span><Badge variant="emerald">true</Badge></div>
                </div>

                <DecisionPill
                  id="project-becomes-property"
                  scope="Promotion event"
                  question="Should each Project automatically map to a Property record on first promotion, or do you create the Property manually?"
                  options={{ keep: "Auto-create Property", alt: "Manual create", drop: "Project = Property always" }}
                >
                  <p className="text-xs text-muted-foreground italic px-2">
                    First time a unit is promoted from a Project, the system can auto-create a
                    Property row to host it. Subsequent units use the existing Property.
                  </p>
                </DecisionPill>

                <div className="flex gap-2">
                  <Button variant="gold" className="flex-1">Confirm Promote</Button>
                  <Button variant="ghost" onClick={() => setPromoteUnitId(null)}>Cancel</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
