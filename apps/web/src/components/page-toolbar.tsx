import type { ReactNode } from "react";
import { Search, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageToolbar({
  searchPlaceholder = "Search...",
  actions,
  className,
}: {
  searchPlaceholder?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder={searchPlaceholder}
            className="h-9 w-64 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
          />
        </div>
        <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--page-bg)]">
          <Filter className="h-3.5 w-3.5" />
          Filter
        </button>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
