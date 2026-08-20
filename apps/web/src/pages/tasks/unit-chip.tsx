// Shared unit identity chip for task cards (backlog rows + sprint board). The
// circle mirrors the assignee Avatar (a rounded-full initial), tinted by a
// deterministic property→tone hash so every unit on a property shares a color.
// Pure/presentational: no data fetching.
import { cn } from "@/lib/utils";

type UnitLike = { unitCode: string; propertyName: string };

// The 4 tinted Badge variants (border/bg/text, light + dark) copied so the chip
// reuses the exact design-system palette without depending on the Badge variant API.
const TONES = [
  "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
] as const;

/** Deterministic property→tone: all units on a property share one color. */
export function unitTone(propertyName: string): string {
  let h = 0;
  for (let i = 0; i < propertyName.length; i++) h = (h * 31 + propertyName.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length];
}

/** Block letter from a unit code: "A-08-02" → "A"; "" → "#". */
export function unitInitial(unitCode: string): string {
  return unitCode.split(/[-\s/]/)[0]?.[0]?.toUpperCase() ?? "#";
}

export function UnitChip({ unit, className }: { unit: UnitLike; className?: string }) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
          unitTone(unit.propertyName),
        )}
      >
        {unitInitial(unit.unitCode)}
      </span>
      <span className="min-w-0 truncate">
        {unit.unitCode} · {unit.propertyName}
      </span>
    </span>
  );
}
