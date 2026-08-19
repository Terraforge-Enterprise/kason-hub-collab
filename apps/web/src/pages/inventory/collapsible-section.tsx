// CollapsibleSection — presentational fold for secondary form sections.
//
// Progressive-disclosure wrapper used by the Edit-apartment surfaces to fold
// away rarely-touched sections (Pax deduction, Listing mode, Carparks) behind a
// one-line summary so the everyday fields aren't buried in a wall of controls.
//
// IMPORTANT — nothing is unmounted. Collapsing only toggles `display` on the
// body (the closed state applies Tailwind's `hidden`, i.e. display:none), so
// every control inside keeps its React state, change handlers, validation and
// form-submit wiring exactly as if it were always open. This is deliberately
// NOT conditional rendering: a folded section still submits its values.
//
// The toggle is `type="button"` — load-bearing, because these sections render
// inside the Edit <form>; a default-type button would submit the form on click.
//
// Visually mirrors FormSection (rounded border, tinted surface, tone bar +
// uppercase label) so a folded section reads as a peer of the open ones.

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function CollapsibleSection({
  title,
  summary,
  tone = "muted",
  defaultOpen = false,
  icon,
  children,
}: {
  title: string;
  /** One-line status shown next to the title while folded (and open). */
  summary?: ReactNode;
  tone?: "gold" | "blue" | "muted" | "rose";
  defaultOpen?: boolean;
  /** Optional leading glyph, rendered in the tone colour before the title. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  const barClass =
    tone === "gold"
      ? "bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]"
      : tone === "blue"
        ? "bg-blue-500/80"
        : tone === "rose"
          ? "bg-rose-500/80"
          : "bg-muted-foreground/60";
  const textClass =
    tone === "gold"
      ? "text-[#D4AF37]"
      : tone === "blue"
        ? "text-blue-400"
        : tone === "rose"
          ? "text-rose-400"
          : "text-muted-foreground";

  return (
    <div className="rounded-xl border border-border/50 bg-background/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3.5 text-left transition-colors hover:bg-muted/20"
      >
        <div className={cn("h-[16px] w-[3px] shrink-0 rounded-sm", barClass)} />
        {icon && <span className={cn("flex shrink-0 items-center", textClass)}>{icon}</span>}
        <span className={cn("text-[10px] font-bold uppercase tracking-[0.14em]", textClass)}>
          {title}
        </span>
        {summary != null && (
          <span className="min-w-0 truncate text-xs font-normal normal-case tracking-normal text-muted-foreground">
            {summary}
          </span>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {/* Body is always mounted; `hidden` (display:none) folds it without losing
          state. Tailwind's `grid`/`hidden` are mutually exclusive so the closed
          state can't be overridden by a lingering display utility. */}
      <div id={bodyId} className={cn("gap-4 px-4 pb-4", open ? "grid" : "hidden")}>
        {children}
      </div>
    </div>
  );
}
