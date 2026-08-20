import type { SprintStatus } from "@kason/shared";

/** Live counts for planned/active sprints; snapshot columns for completed (§1.4 / §1.10). */
export interface SprintSummary {
  committed: number; // completed + carried
  completed: number;
  carried: number; // incomplete still attached (live) OR carriedOverCount (snapshot)
  completionPct: number; // Math.round(completed / committed * 100); 0 when committed === 0
}

export interface SprintRow {
  id: string;
  seq: number;
  name: string | null; // null => UI renders `Sprint ${seq}`
  goal: string | null;
  status: SprintStatus;
  startsOn: string | null; // ISO Z
  endsOn: string | null; // ISO Z
  startedAt: string | null;
  completedAt: string | null;
  summary: SprintSummary; // live counts for planned/active; snapshot columns for completed
  createdAt: string;
  updatedAt: string; // concurrency token the client echoes back on mutate
}

/** One cross-sprint trend bar (Spec 3 §5/§7) — from the close-snapshot columns. */
export interface SprintTrendPoint {
  seq: number;
  name: string | null; // null => UI renders `Sprint ${seq}`
  completed: number; // completedCount ?? 0
  carried: number; // carriedOverCount ?? 0
  completionRate: number; // Math.round(completed / (completed+carried) * 100); 0 when committed === 0
}

/** One day-sample on a burndown line (Spec 3 §4). `date` is ISO `YYYY-MM-DD`. */
export interface BurndownPoint {
  date: string; // YYYY-MM-DD (UTC day)
  remaining: number;
}

/**
 * Derived within-sprint burndown (Spec 3 §4). `scope` = live task count (active)
 * or completedCount+carriedOverCount (completed). `ideal` is the linear scope→0
 * pace; `actual` steps down at each done task's completedAt. Empty ideal/actual
 * when the sprint was never dated (startsOn/endsOn null).
 */
export interface SprintBurndown {
  scope: number;
  ideal: BurndownPoint[];
  actual: BurndownPoint[];
}
