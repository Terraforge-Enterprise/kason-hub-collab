// Shared due-date classification for the Tasks board + sprint pills.
// The four classification helpers (DAY_MS/todayStart/classifyDue/isOverdue)
// mirror the in-file copies in tasks-board-page.tsx verbatim, so behaviour is
// identical; `daysUntil` is the addition consumed by the sprint selector's
// "ends in N days" pill. (The board's own copies are lifted into this module
// by the gated board-integration task; this file is additive on its own.)

export type DueBucket = "overdue" | "today" | "week";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the local calendar day. */
export function todayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Classify a dueOn timestamp against the local calendar: overdue / today / next-7-days. */
export function classifyDue(dueOn: string): DueBucket | null {
  const t = new Date(dueOn).getTime();
  const start = todayStart();
  if (t < start) return "overdue";
  if (t < start + DAY_MS) return "today";
  if (t < start + 7 * DAY_MS) return "week";
  return null;
}

export function isOverdue(dueOn: string | null): boolean {
  return !!dueOn && classifyDue(dueOn) === "overdue";
}

/**
 * Whole calendar days from today's start to `dateIso` (floored).
 * 0 = ends today, positive = future, negative = past. Powers the sprint
 * selector's "ends in N days" pill.
 */
export function daysUntil(dateIso: string): number {
  return Math.floor((new Date(dateIso).getTime() - todayStart()) / DAY_MS);
}
