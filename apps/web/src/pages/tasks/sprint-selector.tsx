// Sprint selector: [Backlog][active ●][Sprint ▾][Manage ▾].
// Fixed-size header — planned + completed sprints live inside the "Sprint ▾"
// dropdown, so the row never wraps at 100+ sprints.
// Controlled — `selected` is "backlog" or a sprint id; clicks emit onSelect.
import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { PHASE2_STATUS_TONES } from "@kason/shared";
import { StatusPill } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { daysUntil } from "./tasks-due";
import type { SprintRow } from "@/api/tasks";

export type SprintTab = "backlog" | string;

function sprintLabel(s: SprintRow): string {
  return `SP-${s.seq}${s.name ? ` · ${s.name}` : ""}`;
}

/** Active first, then planned (seq asc), then completed (seq desc). */
function orderSprints(sprints: SprintRow[]): SprintRow[] {
  const active = sprints.filter((s) => s.status === "active");
  const planned = sprints
    .filter((s) => s.status === "planned")
    .sort((a, b) => a.seq - b.seq);
  const completed = sprints
    .filter((s) => s.status === "completed")
    .sort((a, b) => b.seq - a.seq);
  return [...active, ...planned, ...completed];
}

/** Persistent tab button (Backlog or active sprint). */
function Tab({
  testId,
  status,
  label,
  selected,
  onClick,
  accessory,
}: {
  testId: string;
  status: "backlog" | "planned" | "active" | "completed";
  label: string;
  selected: boolean;
  onClick: () => void;
  accessory?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      data-testid={testId}
      data-status={status}
      aria-selected={selected}
      onClick={onClick}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        selected
          ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text-primary)]"
          : "border-border/60 text-muted-foreground hover:bg-background/60 hover:text-foreground"
      }`}
    >
      <span>{label}</span>
      {accessory}
    </button>
  );
}

export function SprintSelector({
  sprints,
  selected,
  onSelect,
  manageMenu,
}: {
  sprints: SprintRow[];
  selected: SprintTab;
  onSelect: (tab: SprintTab) => void;
  manageMenu?: React.ReactNode;
}) {
  const ordered = useMemo(() => orderSprints(sprints), [sprints]);

  const activeSprints = ordered.filter((s) => s.status === "active");
  const plannedSprints = ordered.filter((s) => s.status === "planned");
  const completedSprints = ordered.filter((s) => s.status === "completed");

  // Sprints that live inside the dropdown (planned + completed).
  const dropdownSprints = [...plannedSprints, ...completedSprints];

  // If the current selection is a planned/completed sprint, show its name on the trigger.
  const selectedDropdownSprint =
    selected !== "backlog"
      ? dropdownSprints.find((s) => s.id === selected) ?? null
      : null;

  const triggerLabel = selectedDropdownSprint
    ? sprintLabel(selectedDropdownSprint)
    : "Sprint";

  // The "Sprint ▾" trigger is visually highlighted when a planned/completed sprint is selected.
  const pickerSelected = !!selectedDropdownSprint;

  return (
    <div
      role="tablist"
      aria-label="Sprint"
      data-testid="sprint-selector"
      className="flex flex-wrap items-center gap-2"
    >
      {/* ── Persistent: Backlog ─────────────────────────────────────────── */}
      <Tab
        testId="sprint-tab-backlog"
        status="backlog"
        label="Backlog"
        selected={selected === "backlog"}
        onClick={() => onSelect("backlog")}
      />

      {/* ── Persistent: Active sprint (when one exists) ─────────────────── */}
      {activeSprints.map((s) => {
        const days = s.endsOn ? daysUntil(s.endsOn) : null;
        return (
          <Tab
            key={s.id}
            testId={`sprint-tab-${s.id}`}
            status="active"
            label={sprintLabel(s)}
            selected={selected === s.id}
            onClick={() => onSelect(s.id)}
            accessory={
              <span className="flex items-center gap-1.5">
                {/* Tone read from the central §1.12 map, never a local literal. */}
                <StatusPill tone={PHASE2_STATUS_TONES.sprint.active}>active</StatusPill>
                {days !== null && (
                  <span className="text-[10px] font-normal text-muted-foreground">
                    {days <= 0 ? "ends today" : `ends in ${days}d`}
                  </span>
                )}
              </span>
            }
          />
        );
      })}

      {/* ── Sprint ▾ picker (planned + completed) ───────────────────────── */}
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="sprint-picker-trigger"
          role="tab"
          aria-selected={pickerSelected}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition ${
            pickerSelected
              ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--text-primary)]"
              : "border-border/60 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          }`}
        >
          {triggerLabel}
          <ChevronDown className="size-3.5 opacity-70" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          <DropdownMenuRadioGroup
            value={selected !== "backlog" ? selected : ""}
            onValueChange={(value) => {
              if (typeof value === "string" && value) onSelect(value);
            }}
          >
            {/* Planned group. The active sprint is NOT here — its canonical home
                is the persistent pill, so there is one selection path per sprint. */}
            {plannedSprints.length > 0 && (
              <DropdownMenuGroup data-testid="sprint-group-planned">
                <DropdownMenuLabel>Planned</DropdownMenuLabel>
                {plannedSprints.map((s) => (
                  <DropdownMenuRadioItem
                    key={s.id}
                    value={s.id}
                    data-testid={`sprint-picker-item-${s.id}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate">{sprintLabel(s)}</span>
                      <StatusPill tone={PHASE2_STATUS_TONES.sprint.planned}>planned</StatusPill>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            )}

            {/* Completed group */}
            {completedSprints.length > 0 && (
              <>
                {plannedSprints.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuGroup data-testid="sprint-group-completed">
                  <DropdownMenuLabel>Completed</DropdownMenuLabel>
                  {completedSprints.map((s) => (
                    <DropdownMenuRadioItem
                      key={s.id}
                      value={s.id}
                      data-testid={`sprint-picker-item-${s.id}`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate">{sprintLabel(s)}</span>
                        <StatusPill tone={PHASE2_STATUS_TONES.sprint.completed}>done</StatusPill>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── Manage ▾ — stays on the right, unchanged ────────────────────── */}
      {manageMenu ? <div className="ml-auto">{manageMenu}</div> : null}
    </div>
  );
}
