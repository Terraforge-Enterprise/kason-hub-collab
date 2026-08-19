import { useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  icon?: LucideIcon;
};

export type SegmentedProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: "sm" | "md";
  ariaLabel: string;
  className?: string;
  /**
   * When true, the control is read-only:
   *   - clicks short-circuit before onChange fires
   *   - arrow / Home / End keyboard navigation does not flip selection
   *   - each option exposes aria-disabled="true" and tabIndex=-1
   *
   * The current selection still renders as `aria-checked="true"` so screen
   * readers convey state. We deliberately don't set the `disabled` HTML
   * attribute — that would prevent focus and break the radiogroup semantics
   * for assistive tech reading the locked-in choice.
   */
  disabled?: boolean;
};

/**
 * Segmented — gold-tinted segmented control. Replaces hand-rolled toggle
 * button-pair groups (commission type, payment type, split type, …).
 *
 * Generic over the value type so call sites stay type-safe — `value` and
 * `onChange` flow through as a literal union rather than `string`.
 */
export function Segmented<T extends string>({
  value, onChange, options, size = "md", ariaLabel, className, disabled = false,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const padding = size === "sm" ? "px-2 py-1.5 text-xs" : "px-3 py-2 text-sm";

  function focusIndex(i: number) {
    const wrapped = (i + options.length) % options.length;
    const el = refs.current[wrapped];
    if (el) {
      el.focus();
      const next = options[wrapped].value;
      if (next !== value) onChange(next);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent, currentIndex: number) {
    if (disabled) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); focusIndex(currentIndex + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); focusIndex(currentIndex - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusIndex(0); }
    else if (e.key === "End") { e.preventDefault(); focusIndex(options.length - 1); }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn("grid gap-2", className, disabled && "opacity-60")}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : selected ? 0 : -1}
            onClick={() => {
              if (disabled) return;
              if (opt.value !== value) onChange(opt.value);
            }}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={cn(
              "rounded-md border transition inline-flex items-center justify-center gap-1.5",
              padding,
              selected
                ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground"
                : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed",
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
