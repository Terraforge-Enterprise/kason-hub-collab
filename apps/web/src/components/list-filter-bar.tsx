import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortOption = { value: string; label: string };
export type DateFieldOption = { value: string; label: string };

export type ListFilterState = {
  search: string;
  sort: string;
  order: "asc" | "desc";
  dateField?: string;
  from?: string;
  to?: string;
  extras: Record<string, string | boolean | undefined>;
};

/** Shared class for selects/inputs rendered inside ListFilterBar's `extras` slot. */
export const filterControlClass =
  "rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]";

const iconButtonClass =
  "inline-flex items-center justify-center rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-2 text-sm text-[var(--text-primary)] transition hover:border-[var(--primary)] hover:text-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]";

export function ListFilterBar(props: {
  value: ListFilterState;
  onChange: (next: ListFilterState) => void;
  searchPlaceholder?: string;
  /** Omit to hide the sort dropdown entirely (column headers can handle sort instead). */
  sortOptions?: SortOption[];
  dateFields?: DateFieldOption[];
  /** Primary filter controls (status, type, etc.). Rendered inline after search. */
  extras?: React.ReactNode;
  /** Hide the date range + "More filters" toggle. Use for static data (e.g. tier mappings). */
  hideDateRange?: boolean;
}) {
  const {
    value,
    onChange,
    searchPlaceholder = "Search...",
    sortOptions,
    dateFields,
    extras,
    hideDateRange = false,
  } = props;

  const [local, setLocal] = useState(value);
  const advancedActive = Boolean(local.from || local.to);
  // Auto-expand advanced panel when we mount with date filters pre-applied (URL state).
  const [advancedOpen, setAdvancedOpen] = useState(advancedActive);

  // Keep local in sync when parent resets (e.g., URL state).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- external state reset pattern
  useEffect(() => setLocal(value), [value]);

  // Debounce search — commit to parent 300ms after last keystroke.
  useEffect(() => {
    if (local.search === value.search) return;
    const h = setTimeout(() => onChange(local), 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.search]);

  function commit(next: Partial<ListFilterState>) {
    const merged = { ...local, ...next };
    setLocal(merged);
    onChange(merged);
  }

  function resetAdvanced() {
    commit({ from: undefined, to: undefined });
  }

  const showSort = Boolean(sortOptions && sortOptions.length > 0);
  const showAdvancedToggle = !hideDateRange;

  return (
    <div className="space-y-3">
      {/* Primary row: search + consumer extras + sort + more-filters toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={local.search}
            onChange={(e) => setLocal({ ...local, search: e.target.value })}
            className={cn(filterControlClass, "w-full pl-9", local.search ? "pr-9" : "")}
            aria-label="Search"
          />
          {local.search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setLocal({ ...local, search: "" });
                onChange({ ...local, search: "" });
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-primary)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {extras}

        {showSort && (
          <div className="flex items-center gap-1.5">
            <select
              value={local.sort}
              onChange={(e) => commit({ sort: e.target.value })}
              className={filterControlClass}
              aria-label="Sort by"
            >
              {sortOptions!.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={local.order === "asc" ? "Ascending — click to flip" : "Descending — click to flip"}
              onClick={() => commit({ order: local.order === "asc" ? "desc" : "asc" })}
              className={iconButtonClass}
            >
              {local.order === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
            </button>
          </div>
        )}

        {showAdvancedToggle && (
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition focus:outline-none focus:ring-2 focus:ring-[var(--ring)]",
              advancedActive
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                : "border-[var(--input-border)] bg-[var(--card-bg)] text-[var(--text-primary)] hover:border-[var(--primary)] hover:text-[var(--primary)]",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>More filters</span>
            {advancedActive && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-bold text-white">
                •
              </span>
            )}
          </button>
        )}
      </div>

      {/* Advanced panel — date range + date field selector */}
      {showAdvancedToggle && advancedOpen && (
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--border)] bg-[var(--page-bg)] p-3">
          {dateFields && dateFields.length > 1 && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Date field
              </span>
              <select
                value={local.dateField ?? dateFields[0].value}
                onChange={(e) => commit({ dateField: e.target.value })}
                className={filterControlClass}
              >
                {dateFields.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              From
            </span>
            <input
              type="date"
              value={local.from ?? ""}
              onChange={(e) => commit({ from: e.target.value || undefined })}
              className={filterControlClass}
            />
          </label>

          <span className="pb-2 text-[var(--text-muted)]">–</span>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              To
            </span>
            <input
              type="date"
              value={local.to ?? ""}
              onChange={(e) => commit({ to: e.target.value || undefined })}
              className={filterControlClass}
            />
          </label>

          {advancedActive && (
            <button
              type="button"
              onClick={resetAdvanced}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--card-bg)] hover:text-[var(--text-primary)]"
            >
              <RotateCcw className="h-3 w-3" />
              Reset dates
            </button>
          )}
        </div>
      )}
    </div>
  );
}
