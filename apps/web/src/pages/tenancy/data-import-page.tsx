/**
 * Data Import (M9) — admin ImportRun review + dry-run trigger.
 *
 * Spec: docs/superpowers/specs/2026-06-09-phase2-data-import.md
 * Plan: docs/superpowers/plans/2026-06-09-phase2-data-import.md (Task 13).
 *
 * Commit is intentionally CLI-only (honours the Yannie sign-off gate).
 * This surface gives admins: dry-run trigger, run list, and a detail drawer
 * with a report download link. No commit button is ever shown here.
 */

import { useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet, Loader2, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/empty-state";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  useImportRuns,
  useImportRun,
  useRunDryRun,
  type ImportRun,
} from "@/api/data-import";

// ── Status / mode helpers ────────────────────────────────────────────────────

type StatusVariant = "sky" | "emerald" | "rose" | "secondary";

function statusVariant(status: ImportRun["status"]): StatusVariant {
  switch (status) {
    case "running":
      return "sky";
    case "completed":
      return "emerald";
    case "failed":
      return "rose";
    default:
      return "secondary";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-MY", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function ImportRunSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-16 rounded-xl bg-muted" />
      ))}
    </div>
  );
}

// ── Run row ──────────────────────────────────────────────────────────────────

function RunRow({
  run,
  onClick,
}: {
  run: ImportRun;
  onClick: (run: ImportRun) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(run)}
      className="group flex w-full items-center gap-4 rounded-xl border border-border/50 bg-background/60 px-4 py-3 text-left transition hover:bg-background/80 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`import-run-row-${run.id}`}
    >
      {/* Date */}
      <span className="w-40 shrink-0 text-sm text-muted-foreground">
        {formatDate(run.createdAt)}
      </span>

      {/* Mode badge */}
      <Badge variant={run.dryRun ? "amber" : "emerald"}>
        {run.dryRun ? "Dry run" : "Commit"}
      </Badge>

      {/* Status badge */}
      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>

      {/* Compact counts */}
      <span className="flex-1 truncate text-xs text-muted-foreground">
        parsed {run.rowsParsed} &middot; created {run.partiesCreated} &middot; matched{" "}
        {run.partiesMatched} &middot; skipped {run.rowsSkipped} &middot; conflicts{" "}
        {run.conflicts}
      </span>

      {/* Arrow */}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

function RunDetailDrawer({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useImportRun(runId);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }} lockProgress={false}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Import Run Detail</SheetTitle>
          <SheetDescription>
            {data ? formatDate(data.createdAt) : "Loading…"}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {isLoading && (
            <div className="animate-pulse space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-muted" />
              ))}
            </div>
          )}

          {isError && (
            <Callout variant="danger" title="Failed to load">
              {error instanceof Error ? error.message : "Could not load run detail."}
            </Callout>
          )}

          {data && (
            <div className="space-y-4 text-sm">
              {/* Mode + status */}
              <div className="flex items-center gap-2">
                <Badge variant={data.dryRun ? "amber" : "emerald"}>
                  {data.dryRun ? "Dry run" : "Commit"}
                </Badge>
                <Badge variant={statusVariant(data.status)}>{data.status}</Badge>
              </div>

              {/* Meta */}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="font-medium text-muted-foreground">Source file</dt>
                <dd className="truncate text-foreground">{data.sourceFile ?? "—"}</dd>

                <dt className="font-medium text-muted-foreground">Triggered by</dt>
                <dd className="text-foreground">{data.triggeredBy ?? "—"}</dd>
              </dl>

              {/* Counts */}
              <div className="rounded-xl border border-border/50 bg-background/40 p-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                  Counts
                </p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
                  <dt className="text-muted-foreground">Rows parsed</dt>
                  <dd className="font-medium tabular-nums">{data.rowsParsed}</dd>

                  <dt className="text-muted-foreground">Parties created</dt>
                  <dd className="font-medium tabular-nums">{data.partiesCreated}</dd>

                  <dt className="text-muted-foreground">Parties matched</dt>
                  <dd className="font-medium tabular-nums">{data.partiesMatched}</dd>

                  <dt className="text-muted-foreground">Tenancies created</dt>
                  <dd className="font-medium tabular-nums">{data.tenanciesCreated}</dd>

                  <dt className="text-muted-foreground">Rows skipped</dt>
                  <dd className="font-medium tabular-nums">{data.rowsSkipped}</dd>

                  <dt className="text-muted-foreground">Conflicts</dt>
                  <dd className="font-medium tabular-nums">{data.conflicts}</dd>
                </dl>
              </div>

              {/* Report download (§16 guard: null is a legitimately-optional field) */}
              {data.reportUrl ? (
                <a
                  href={data.reportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background/60 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-background/80"
                >
                  <FileSpreadsheet className="h-4 w-4 text-primary" />
                  Download report
                </a>
              ) : (
                <p className="text-sm text-muted-foreground">No report</p>
              )}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DataImportPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runs, isLoading, isError, error, refetch } = useImportRuns();
  const dryRunMutation = useRunDryRun();

  async function handleDryRun() {
    try {
      const result = await dryRunMutation.mutateAsync();
      toast.success(
        `Dry run complete — ${result.counts.rowsParsed} rows parsed, ${result.counts.conflicts} conflicts.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dry run failed");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data Import"
        description="Import existing tenants from the Excel master list. Dry-run first; commit is run via CLI after review."
        icon={FileSpreadsheet}
        actions={
          <Button
            variant="gold"
            onClick={() => void handleDryRun()}
            disabled={dryRunMutation.isPending}
            data-testid="run-dry-run"
          >
            {dryRunMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="mr-2 h-4 w-4" />
            )}
            {dryRunMutation.isPending ? "Running…" : "Run dry-run"}
          </Button>
        }
      />

      {/* CLI-only commit notice */}
      <Callout variant="info">
        Committing an import is intentionally CLI-only and requires explicit sign-off before
        running against the production database.
      </Callout>

      {/* Error state */}
      {isError && (
        <Callout variant="danger" title="Failed to load">
          {error instanceof Error ? error.message : "Could not load import runs."}{" "}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </Callout>
      )}

      {/* Run list */}
      <Card className="border-border/50 bg-background/60 shadow-xl backdrop-blur-xl">
        <CardContent className="p-4">
          {isLoading ? (
            <ImportRunSkeleton />
          ) : !runs || runs.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="No import runs yet"
              description="Trigger a dry-run above to start importing tenants from the Excel master list."
            />
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onClick={(r) => setSelectedRunId(r.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail drawer */}
      {selectedRunId && (
        <RunDetailDrawer
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
        />
      )}
    </div>
  );
}
