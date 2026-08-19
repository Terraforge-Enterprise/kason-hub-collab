import { cn } from "@/lib/utils";

export type PillOption<T extends string | number> = {
  value: T;
  label: React.ReactNode;
};

export type PillBarProps<T extends string | number> = {
  value: T[];
  onChange: (next: T[]) => void;
  options: PillOption<T>[];
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
  /**
   * How a click composes with the current selection.
   *
   * "multi" (default) toggles each pill independently — the behaviour every
   * existing PillBar relies on, so this prop can be added without touching them.
   *
   * "single" is for a filter whose BACKEND accepts exactly one value: picking a
   * second pill REPLACES the first rather than producing a two-value selection
   * the query string cannot express. Without it the caller is left apologising
   * for a state it offered ("multiple values selected — showing all"), which is
   * a worse answer than not letting the conflict happen. Clicking the selected
   * pill clears it, so "no filter" stays reachable — which is why these remain
   * aria-pressed toggle buttons in a `group` and not a `radiogroup`, whose
   * semantics have no empty state.
   */
  mode?: "multi" | "single";
};

export function PillBar<T extends string | number>({
  value, onChange, options, ariaLabel, size = "md", className, mode = "multi",
}: PillBarProps<T>) {
  const padding = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const toggle = (v: T) => {
    const has = value.includes(v);
    if (mode === "single") {
      onChange(has ? [] : [v]);
      return;
    }
    onChange(has ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <div role="group" aria-label={ariaLabel} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((opt) => {
        const selected = value.includes(opt.value);
        return (
          <button
            key={String(opt.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => toggle(opt.value)}
            className={cn(
              "rounded-md border transition",
              padding,
              selected
                ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground"
                : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground hover:border-border",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
