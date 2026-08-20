// Header shown above the board lanes when a sprint tab is selected. Surfaces
// the sprint identity (SP-{seq} · name), status, date range, and the GOAL —
// none of which were rendered on the board before (#6, #7).
import { StatusPill } from "@/components/ui";
import { PHASE2_STATUS_TONES, type SprintStatus } from "@kason/shared";
import type { SprintRow } from "@/api/tasks";

function fmt(d: string | null): string | null {
  return d ? d.slice(0, 10) : null;
}

export function SprintHeader({ sprint }: { sprint: SprintRow }) {
  const range = [fmt(sprint.startsOn), fmt(sprint.endsOn)].filter(Boolean).join(" → ");
  return (
    <div
      data-testid="sprint-header"
      className="rounded-xl border border-border/50 bg-background/60 px-4 py-3 backdrop-blur-xl shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-[var(--gold)]/15 px-2 py-0.5 text-xs font-bold tracking-wide text-[var(--gold)]">
          SP-{sprint.seq}
        </span>
        <h2 className="text-sm font-semibold text-foreground">
          {sprint.name ?? `Sprint ${sprint.seq}`}
        </h2>
        <StatusPill tone={PHASE2_STATUS_TONES.sprint[sprint.status as SprintStatus]}>
          {sprint.status}
        </StatusPill>
        {range && <span className="text-xs text-muted-foreground">{range}</span>}
      </div>
      {sprint.goal && (
        <p className="mt-1.5 text-sm text-muted-foreground">{sprint.goal}</p>
      )}
    </div>
  );
}
