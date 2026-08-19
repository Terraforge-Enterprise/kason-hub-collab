// MOCK page — agent (portal) Sales Entry submission UI. No backend.
import { useMemo, useState } from "react";
import { Building2, FileText, ListTodo, PlusCircle, Send, Sparkles, Upload } from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Callout } from "@/components/ui/callout";
import { DecisionPill } from "./decision-pill";
import {
  MOCK_PROJECTS,
  MOCK_SALES_UNITS,
  RENOVATION_STATUS_LABELS,
  projectFor,
  type Purpose,
  type RenovationStatus,
} from "./_mock-data";

// Mock the logged-in agent for the demo.
const MOCK_AGENT_NAME = "Ahmad Rizal";

const STATUS_VARIANT: Record<RenovationStatus, "rose" | "amber" | "emerald"> = {
  not_started: "rose",
  on_going: "amber",
  completed: "emerald",
};

export default function PortalSalesEntryPage() {
  const [submitOpen, setSubmitOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimSalesUnitId, setClaimSalesUnitId] = useState<string | null>(null);

  // Form state for the new submission drawer.
  const [form, setForm] = useState({
    projectId: "",
    unitNumber: "",
    ownerName: "",
    salesDate: "",
    purpose: "rent" as Purpose,
    bedrooms: "",
    bathrooms: "",
    parkingLots: "",
    expectedRental: "",
  });

  // My units = those submitted by this mock agent.
  const myUnits = useMemo(
    () => MOCK_SALES_UNITS.filter((u) => u.agentName === MOCK_AGENT_NAME),
    [],
  );

  const stats = useMemo(() => {
    const total = myUnits.length;
    const not_started = myUnits.filter((u) => u.renovation.status === "not_started").length;
    const on_going = myUnits.filter((u) => u.renovation.status === "on_going").length;
    const completed = myUnits.filter((u) => u.renovation.status === "completed").length;
    return { total, not_started, on_going, completed };
  }, [myUnits]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Sparkles className="h-8 w-8 text-primary" />
            Sales Entry (MOCK)
          </h1>
          <p className="text-muted-foreground mt-1">
            Submit a new off-plan deal the moment it's secured. Track renovation progress here.
          </p>
        </div>
        <Button variant="gold" onClick={() => setSubmitOpen(true)}>
          <PlusCircle className="h-4 w-4" /> New Sales Entry
        </Button>
      </div>

      <Callout variant="warning" title="Mockup for client review">
        Click <strong>Keep / Alt / Drop</strong> on every <em>MOCK — decide</em> section to settle
        ambiguities. No data persists; reload resets the page.
      </Callout>

      {/* Personal stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <GlowCard glowColor="blue" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">My units</p>
              <p className="text-3xl font-bold text-foreground">{stats.total}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3" />
                <span>secured by you</span>
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
              <p className="text-3xl font-bold text-foreground">{stats.not_started}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ListTodo className="h-3 w-3" />
                <span>renovation pending</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-red-500/10">
              <ListTodo className="h-6 w-6 text-red-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">On going</p>
              <p className="text-3xl font-bold text-foreground">{stats.on_going}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" />
                <span>can submit reno claim</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-orange-500/10">
              <FileText className="h-6 w-6 text-orange-600" />
            </div>
          </div>
        </GlowCard>
        <GlowCard glowColor="green" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Completed</p>
              <p className="text-3xl font-bold text-foreground">{stats.completed}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                <span>ready for tenant</span>
              </div>
            </div>
            <div className="p-3 rounded-xl bg-green-500/10">
              <Sparkles className="h-6 w-6 text-green-600" />
            </div>
          </div>
        </GlowCard>
      </div>

      <DecisionPill
        id="agent-sees-others-units"
        scope="Portal — visibility scope"
        question="Should agents see only their OWN sales entries, or their team's, or all org-wide?"
        options={{ keep: "Own only", alt: "Team", drop: "All org" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          Existing claim portal is "own claims only". For pipeline visibility, team-level might
          be useful (e.g. project leader sees team's pipeline). Default: own only.
        </p>
      </DecisionPill>

      {/* My units list */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            My Sales Entries
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {myUnits.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4 text-center">
              No sales entries yet. Click "New Sales Entry" to add your first.
            </p>
          ) : (
            myUnits.map((u) => {
              const proj = projectFor(u);
              const canClaim = u.renovation.status !== "not_started";
              return (
                <div
                  key={u.id}
                  className="flex items-center justify-between rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-foreground block">
                        {proj?.name} · {u.unitNumber}
                      </span>
                      <span className="text-xs text-muted-foreground block">
                        {u.ownerName} · sold {u.salesDate} · {u.purpose}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={STATUS_VARIANT[u.renovation.status]}>
                      {RENOVATION_STATUS_LABELS[u.renovation.status]}
                    </Badge>
                    {canClaim && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setClaimSalesUnitId(u.id);
                          setClaimOpen(true);
                        }}
                      >
                        Renovation Claim
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <DecisionPill
        id="claim-button-availability"
        scope="Portal — when can agent submit claim"
        question="Renovation Claim button — show ONLY when status is 'On Going' or 'Completed' (current mock)? Or also when 'Not Started' for early claims?"
        options={{ keep: "On Going+", alt: "Any status", drop: "Completed only" }}
      >
        <p className="text-xs text-muted-foreground italic px-2">
          One mock claim (rc-6) was filed when renovation hadn't started — finance asked the
          agent to lock the package. Strict rule: must have started. Loose: any time.
        </p>
      </DecisionPill>

      {/* New Sales Entry drawer */}
      <Sheet open={submitOpen} onOpenChange={setSubmitOpen}>
        <SheetContent size="md" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>New Sales Entry</SheetTitle>
            <SheetDescription>Submit immediately once the deal is secured.</SheetDescription>
          </SheetHeader>

          <div className="space-y-4 mt-4">
            <DecisionPill
              id="project-picker-vs-text"
              scope="Sales Entry — Project field"
              question="Pick from existing Projects (admin pre-creates) OR free-text type a new Project name (agent creates on-the-fly)?"
              options={{ keep: "Pick existing", alt: "Free text", drop: "Both" }}
            >
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Project
                </label>
                <select
                  value={form.projectId}
                  onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                  className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-2 text-sm"
                >
                  <option value="">Select a project…</option>
                  {MOCK_PROJECTS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.developer}
                    </option>
                  ))}
                </select>
              </div>
            </DecisionPill>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Unit Number
              </label>
              <Input
                value={form.unitNumber}
                onChange={(e) => setForm({ ...form, unitNumber: e.target.value })}
                placeholder="e.g. A-12-01"
                className="mt-1"
              />
            </div>

            <DecisionPill
              id="owner-picker-vs-text"
              scope="Sales Entry — Owner field"
              question="Owner Name — free text (current mock) OR pick from existing Owners list (with 'add new' option)?"
              options={{ keep: "Free text", alt: "Picker + add", drop: "Always picker" }}
            >
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Owner Name
                </label>
                <Input
                  value={form.ownerName}
                  onChange={(e) => setForm({ ...form, ownerName: e.target.value })}
                  placeholder="e.g. Tan Wei Liang"
                  className="mt-1"
                />
              </div>
            </DecisionPill>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sales Date
              </label>
              <Input
                type="date"
                value={form.salesDate}
                onChange={(e) => setForm({ ...form, salesDate: e.target.value })}
                className="mt-1"
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Purpose
              </label>
              <div className="mt-1 flex gap-2">
                {(["rent", "own_stay"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm({ ...form, purpose: p })}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm capitalize transition ${
                      form.purpose === p
                        ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground"
                        : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p === "own_stay" ? "Own Stay" : "Rent"}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Bedrooms
                </label>
                <Input type="number" value={form.bedrooms} onChange={(e) => setForm({ ...form, bedrooms: e.target.value })} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Bathrooms
                </label>
                <Input type="number" value={form.bathrooms} onChange={(e) => setForm({ ...form, bathrooms: e.target.value })} className="mt-1" />
              </div>
              <DecisionPill
                id="parking-lots-field"
                scope="Sales Entry — Parking Lots"
                question="New schema field 'parkingLots' on the SalesUnit? (Existing Unit table has none — would need migration when promoted.)"
                options={{ keep: "Add field", alt: "Optional", drop: "Drop entirely" }}
              >
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Parking Lots
                  </label>
                  <Input type="number" value={form.parkingLots} onChange={(e) => setForm({ ...form, parkingLots: e.target.value })} className="mt-1" />
                </div>
              </DecisionPill>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Owner Expected Rental (RM/month)
              </label>
              <Input
                type="number"
                value={form.expectedRental}
                onChange={(e) => setForm({ ...form, expectedRental: e.target.value })}
                placeholder="e.g. 3200"
                className="mt-1"
              />
            </div>

            <DecisionPill
              id="purchase-price-on-form"
              scope="Sales Entry — Purchase Price"
              question="Capture purchase price (what buyer paid developer) on this form too? Needed for sales commission calc later."
              options={{ keep: "Add it", alt: "Optional", drop: "Don't add" }}
            >
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Purchase Price (RM)
                </label>
                <Input type="number" placeholder="e.g. 850000" className="mt-1" />
              </div>
            </DecisionPill>

            <DecisionPill
              id="documents-on-sales-entry"
              scope="Sales Entry — Documents"
              question="Allow document upload at submission (sales agreement, booking form, payment receipt)?"
              options={{ keep: "Allow upload", alt: "Optional later", drop: "Renovation Claim only" }}
            >
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Supporting documents
                </label>
                <div className="mt-1 rounded-md border border-dashed border-border/50 bg-background/40 p-4 text-center">
                  <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">Drag &amp; drop, or click to browse</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Sales agreement, booking form, receipt</p>
                </div>
              </div>
            </DecisionPill>

            <DecisionPill
              id="agent-edits-after-submit"
              scope="Sales Entry — post-submit edits"
              question="Once submitted, can the agent edit fields (e.g. owner expected rental went up)? Or lock until admin opens it?"
              options={{ keep: "Agent can edit", alt: "Edit until admin acts", drop: "Locked after submit" }}
            >
              <p className="text-xs text-muted-foreground italic px-2">
                Existing commission claim system locks on submit (must request amendment).
                Sales Entry might want lighter rules since renovation status changes a lot.
              </p>
            </DecisionPill>

            <div className="flex gap-2 pt-2">
              <Button variant="gold" className="flex-1">
                <Send className="h-4 w-4" /> Submit
              </Button>
              <Button variant="ghost" onClick={() => setSubmitOpen(false)}>Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Renovation Claim form drawer (agent side) */}
      <Sheet open={claimOpen} onOpenChange={setClaimOpen}>
        <SheetContent size="md" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>New Renovation Claim</SheetTitle>
            <SheetDescription>
              {claimSalesUnitId
                ? `For ${MOCK_SALES_UNITS.find((u) => u.id === claimSalesUnitId)?.unitNumber}`
                : "Select a sales entry above first"}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 mt-4">
            <Callout variant="info">
              Mock-only form. The full version mirrors the admin claim drawer (package, splits,
              payment type, documents, notes). Showing it here so you can see the agent's
              submission flow.
            </Callout>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Package Type
              </label>
              <select className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-2 text-sm">
                <option>Standard — RM 25,000 default</option>
                <option>Premium — RM 45,000 default</option>
                <option>Premium Plus — RM 75,000 default</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Package Price (RM)
              </label>
              <Input type="number" placeholder="30000" className="mt-1" />
            </div>

            <DecisionPill
              id="claim-splits-default"
              scope="Renovation Claim — split rows"
              question="Should the form pre-fill standard split rows (Sales Commission / Project Leader Override / House Keep) for the agent to adjust, or start blank?"
              options={{ keep: "Pre-fill 3 rows", alt: "1 row + add", drop: "Blank" }}
            >
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Claim breakdown
                </label>
                <div className="rounded border border-border/50 bg-background/40 p-2 text-xs">
                  <div className="flex items-center gap-2"><span className="flex-1">Sales Commission · You</span><span>60%</span></div>
                </div>
                <div className="rounded border border-border/50 bg-background/40 p-2 text-xs">
                  <div className="flex items-center gap-2"><span className="flex-1">Project Leader Override</span><span>15%</span></div>
                </div>
                <div className="rounded border border-border/50 bg-background/40 p-2 text-xs">
                  <div className="flex items-center gap-2"><span className="flex-1">Kaen House Keep</span><span>25%</span></div>
                </div>
                <Button variant="outline" size="sm" className="w-full">
                  <PlusCircle className="h-3 w-3" /> Add split row
                </Button>
              </div>
            </DecisionPill>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Payment Type
              </label>
              <div className="mt-1 grid grid-cols-3 gap-1.5">
                {(["full", "partial", "offset_from_rental"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="rounded-md border border-border/50 bg-background/40 px-2 py-2 text-xs hover:border-[var(--gold)] capitalize"
                  >
                    {p.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Notes / Special Terms
              </label>
              <textarea
                rows={3}
                placeholder="e.g. balance to be offset after tenant secured"
                className="mt-1 w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="gold" className="flex-1">
                <Send className="h-4 w-4" /> Submit Claim
              </Button>
              <Button variant="ghost" onClick={() => setClaimOpen(false)}>Cancel</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
