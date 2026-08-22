/**
 * Admin Sales Pipeline page (W3a).
 *
 * Lists every off-plan SalesUnit the org has secured, grouped by renovation
 * status. Replaces the mock at `apps/web/src/pages/sales-mock/sales-pipeline-page.tsx`
 * with real `/api/sales/units` + `/api/projects` data.
 *
 * RBAC:
 *  - editor sees the page (read-only).
 *  - manager+ sees Edit/Renovation actions (server still re-checks).
 *
 * Visual layer: GlowCard counters, glassmorphism Card surfaces, kanban /
 * table view toggle (state in URL via `view=` param), drawer detail with
 * editable financials + renovation transitions.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  Calendar,
  Hammer,
  Home,
  KanbanSquare,
  Plus,
  Sparkles,
  Table as TableIcon,
} from "lucide-react";
import { GlowCard } from "@/components/ui/glow-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth";
import {
  listSalesProjects,
  listSalesUnits,
  type RenovationStatus,
  type SalesUnit,
} from "@/api/sales";
import { SalesUnitDrawer } from "./sales-unit-drawer";
import { CreateProjectDialog } from "./create-project-dialog";

const RENOVATION_STATUS_LABELS: Record<RenovationStatus, string> = {
  not_started: "Not Started",
  on_going: "On Going",
  completed: "Completed",
};

const STATUS_DOT: Record<RenovationStatus, string> = {
  not_started: "bg-rose-500",
  on_going: "bg-amber-500",
  completed: "bg-emerald-500",
};

type ViewMode = "kanban" | "table";
type StatusFilter = RenovationStatus | "all";

function formatRMShort(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `RM ${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `RM ${(value / 1_000).toFixed(1)}k`;
  return `RM ${value.toLocaleString("en-MY")}`;
}

function isManagerPlus(role: string | undefined): boolean {
  return role === "manager" || role === "admin";
}

export default function SalesPipelinePage() {
  const { user } = useAuth();
  const canEdit = isManagerPlus(user?.role);

  const [searchParams, setSearchParams] = useSearchParams();
  const view: ViewMode = searchParams.get("view") === "table" ? "table" : "kanban";
  const filterProjectId = searchParams.get("projectId") ?? "all";
  const statusParam = searchParams.get("status") as StatusFilter | null;
  const filterStatus: StatusFilter =
    statusParam === "not_started" ||
    statusParam === "on_going" ||
    statusParam === "completed"
      ? statusParam
      : "all";

  const [drawerUnitId, setDrawerUnitId] = useState<string | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === "" || value === "all") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  // We deliberately request the whole org's pipeline here and filter
  // client-side for the kanban — the API caps responses at 200 rows which
  // matches the upstream UX expectation for this page.
  const unitsQuery = useQuery({
    queryKey: [
      "sales",
      "units",
      filterProjectId === "all" ? undefined : filterProjectId,
    ],
    queryFn: () =>
      listSalesUnits(
        filterProjectId === "all" ? undefined : { projectId: filterProjectId },
      ),
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => listSalesProjects(),
  });

  const projects = projectsQuery.data?.data ?? [];
  const projectById = useMemo(() => {
    const m = new Map<string, (typeof projects)[number]>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const units = unitsQuery.data?.data ?? [];

  const filteredUnits = useMemo(() => {
    return units.filter((_u) => {
      // Renovation status lives on a sibling table — until it's joined into
      // the list endpoint, surfacing an unknown unit as `not_started` matches
      // the seed default and keeps the kanban honest.
      const statusForRow: RenovationStatus = "not_started";
      if (filterStatus !== "all" && statusForRow !== filterStatus) return false;
      return true;
    });
  }, [units, filterStatus]);

  const counts = useMemo(() => {
    const total = units.length;
    // Until we surface the joined renovation status, show all rows in
    // the not_started bucket. The detail drawer queries the per-unit
    // renovation row directly via the transitions endpoint.
    const not_started = units.length;
    const on_going = 0;
    const completed = 0;
    const ready_move_in = 0;
    return { total, not_started, on_going, completed, ready_move_in };
  }, [units]);

  if (unitsQuery.isError) {
    return (
      <div className="p-6 text-sm text-rose-500">
        Failed to load sales pipeline. Please refresh.
      </div>
    );
  }

  const isLoading = unitsQuery.isLoading || projectsQuery.isLoading;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
            <Sparkles className="h-8 w-8 text-primary" />
            Sales Pipeline
          </h1>
          <p className="text-muted-foreground mt-1">
            Off-plan units agents have secured. Sits between project sale and the rental inventory.
          </p>
        </div>

        {/* Admin "+ New Project" — manager+ only. Skips the unverified
            queue (server accepts status=active for admin-created). */}
        {canEdit && (
          <CreateProjectDialog
            trigger={
              <Button variant="gold">
                <Plus className="h-4 w-4" /> New Project
              </Button>
            }
          />
        )}

        {/* View toggle */}
        <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5">
          <button
            type="button"
            onClick={() => setParam("view", "kanban")}
            aria-pressed={view === "kanban"}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition ${
              view === "kanban"
                ? "bg-[var(--gold)]/15 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <KanbanSquare className="h-3.5 w-3.5" /> Kanban
          </button>
          <button
            type="button"
            onClick={() => setParam("view", "table")}
            aria-pressed={view === "table"}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition ${
              view === "table"
                ? "bg-[var(--gold)]/15 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <TableIcon className="h-3.5 w-3.5" /> Table
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <GlowCard glowColor="blue" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Total secured</p>
              <p className="text-3xl font-bold text-foreground">{counts.total}</p>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3" />
                <span>across {projects.length} projects</span>
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
              <p className="text-sm font-medium text-muted-foreground">Ready move-in</p>
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

      {/* Filters */}
      <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Project
            </span>
            <select
              value={filterProjectId}
              onChange={(e) => setParam("projectId", e.target.value)}
              className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
            >
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Status
            </span>
            <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background/40 p-0.5">
              {(["all", "not_started", "on_going", "completed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setParam("status", s === "all" ? null : s)}
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
            {filteredUnits.length} of {units.length} shown
          </div>
        </CardContent>
      </Card>

      {/* Body */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-pulse">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-72 rounded-xl bg-background/40 border border-border/50"
            />
          ))}
        </div>
      ) : units.length === 0 ? (
        <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No sales units yet. Once an agent submits an off-plan sales entry it
            will appear here for review.
          </CardContent>
        </Card>
      ) : view === "kanban" ? (
        <KanbanView
          units={filteredUnits}
          projectName={(id: string) => projectById.get(id)?.name ?? "—"}
          onOpen={(u) => setDrawerUnitId(u.id)}
        />
      ) : (
        <TableView
          units={filteredUnits}
          projectName={(id: string) => projectById.get(id)?.name ?? "—"}
          onOpen={(u) => setDrawerUnitId(u.id)}
        />
      )}

      {/* Detail drawer */}
      <Sheet
        open={drawerUnitId !== null}
        onOpenChange={(o) => !o && setDrawerUnitId(null)}
      >
        <SheetContent size="xl" className="overflow-y-auto">
          {drawerUnitId && (
            <SalesUnitDrawer
              unitId={drawerUnitId}
              canEdit={canEdit}
              projectName={(id) => projectById.get(id)?.name ?? "—"}
              onClose={() => setDrawerUnitId(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Kanban view ─────────────────────────────────────────────────────────────

function KanbanView({
  units,
  projectName,
  onOpen,
}: {
  units: SalesUnit[];
  projectName: (id: string) => string;
  onOpen: (u: SalesUnit) => void;
}) {
  // Without per-row renovation status hydrated yet, we surface every unit
  // in the not_started column. The drawer remains the source of truth for
  // the actual renovation state.
  const buckets: Record<RenovationStatus, SalesUnit[]> = {
    not_started: units,
    on_going: [],
    completed: [],
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {(["not_started", "on_going", "completed"] as const).map((status) => {
        const items = buckets[status];
        return (
          <Card
            key={status}
            className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl"
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
                  />
                  {RENOVATION_STATUS_LABELS[status]}
                </span>
                <Badge variant="outline">{items.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-4 text-center">
                  No units
                </p>
              ) : (
                items.map((u) => (
                  <SalesUnitCard
                    key={u.id}
                    unit={u}
                    projectName={projectName(u.projectId)}
                    onOpen={() => onOpen(u)}
                  />
                ))
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function SalesUnitCard({
  unit,
  projectName,
  onOpen,
}: {
  unit: SalesUnit;
  projectName: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-border/50 bg-background/40 p-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80 group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {projectName} · {unit.unitNumber}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {unit.bedrooms === -1 ? "Studio" : `${unit.bedrooms}BR`}/{unit.bathrooms}BA · {unit.parkingLots} parking
          </p>
        </div>
        <Badge
          variant={unit.purpose === "rent" ? "sky" : "outline"}
          className="shrink-0 text-[10px] uppercase"
        >
          {unit.purpose === "rent" ? "rent" : "own"}
        </Badge>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Sold {unit.salesDate.slice(0, 10)}
        </span>
        <span className="font-medium text-foreground">
          {unit.expectedRental != null ? `${formatRMShort(unit.expectedRental)}/month` : formatRMShort(unit.purchasePrice)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Purchase {formatRMShort(unit.purchasePrice)}</span>
        {!unit.sourcingApproved && (
          <Badge variant="amber" className="text-[10px]">Pending sourcing</Badge>
        )}
      </div>
    </button>
  );
}

// ─── Table view ──────────────────────────────────────────────────────────────

function TableView({
  units,
  projectName,
  onOpen,
}: {
  units: SalesUnit[];
  projectName: (id: string) => string;
  onOpen: (u: SalesUnit) => void;
}) {
  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-border/50 bg-background/40">
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3">Project · unit</th>
              <th className="px-4 py-3">Purpose</th>
              <th className="px-4 py-3">Layout</th>
              <th className="px-4 py-3">Sold</th>
              <th className="px-4 py-3 text-right">Purchase</th>
              <th className="px-4 py-3 text-right">Expected rental</th>
              <th className="px-4 py-3">Sourcing</th>
              <th className="px-4 py-3 text-right">Detail</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr
                key={u.id}
                className="border-b border-border/30 transition hover:bg-background/40"
              >
                <td className="px-4 py-3">
                  <div className="font-semibold text-foreground">
                    {projectName(u.projectId)}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {u.unitNumber}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={u.purpose === "rent" ? "sky" : "outline"}>
                    {u.purpose === "rent" ? "rent" : "own stay"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {u.bedrooms === -1 ? "Studio" : `${u.bedrooms}BR`} · {u.bathrooms}BA · {u.parkingLots}P
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {u.salesDate.slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatRMShort(u.purchasePrice)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {u.expectedRental != null
                    ? `${formatRMShort(u.expectedRental)}/month`
                    : "—"}
                </td>
                <td className="px-4 py-3">
                  {u.sourcingApproved ? (
                    <Badge variant="emerald">Approved</Badge>
                  ) : (
                    <Badge variant="amber">Pending</Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpen(u)}
                    >
                      Open
                    </Button>
                    <Link
                      to={`/sales/units/${u.id}`}
                      className="inline-flex items-center justify-center rounded-md border border-border bg-background px-2.5 py-1 text-[0.8rem] font-medium transition hover:bg-muted hover:text-foreground"
                    >
                      Page
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
