import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterSectionProps = {
  title: string;
  /** when true, no toggle, body always rendered */
  alwaysOpen?: boolean;
  /** for collapsible sections, initial open state */
  defaultOpen?: boolean;
  /** number of active selections in the section — rendered as a badge when > 0 */
  activeCount: number;
  /** when true the section is removed from the DOM entirely */
  hidden?: boolean;
  children: React.ReactNode;
};

export function FilterSection({
  title, alwaysOpen, defaultOpen = false, activeCount, hidden, children,
}: FilterSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (hidden) return null;

  const showTitle = title !== "";

  const titleRow = (
    <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{title}</span>
      <div className="flex items-center gap-2">
        {activeCount > 0 && (
          <span aria-hidden className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--gold)]/15 px-1.5 text-[10px] font-medium text-foreground">
            {activeCount}
          </span>
        )}
        {!alwaysOpen && (
          <ChevronDown className={cn("h-4 w-4 transition", open && "rotate-180")} aria-hidden />
        )}
      </div>
    </div>
  );

  if (alwaysOpen) {
    return (
      <div className="space-y-2">
        {showTitle && titleRow}
        <div>{children}</div>
      </div>
    );
  }

  // When title is empty, no toggle button — always render children.
  if (!showTitle) {
    return <div className="space-y-2"><div>{children}</div></div>;
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="w-full text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {titleRow}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}
