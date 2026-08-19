// Shared async "pick by label, submit the id" picker for admin drawers.
// Generalised from pages/tasks/unit-typeahead.tsx (which now re-exports
// UnitPicker) so the meter + owner surfaces stop asking admins to type a UUID
// (frontend §15: pick from context, never re-type an id). The label is resolved
// by the API search endpoints, so the UI never invents or truncates an id.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { apiFetch } from "@/lib/api-client";

type SlimRow = {
  id: string;
  unitCode: string;
  propertyName: string;
  // Present on /inventory/units (the listing type, e.g. "master"/"studio") so
  // the dropdown can disambiguate rooms that share an apartment code. Absent on
  // /inventory/apartments.
  unitType?: string | null;
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export type LabelPickerProps = {
  value: string | null;
  displayName: string;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
  placeholder?: string;
  disabled?: boolean;
};

function AsyncLabelPicker({
  value,
  displayName,
  onSelect,
  onClear,
  placeholder,
  disabled,
  endpoint,
  queryKey,
}: LabelPickerProps & { endpoint: string; queryKey: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 250);

  const results = useQuery({
    queryKey: [queryKey, debouncedQ],
    queryFn: () => apiFetch<{ data: SlimRow[] }>(`${endpoint}?q=${encodeURIComponent(debouncedQ)}`),
    enabled: open && debouncedQ.length >= 1,
    staleTime: 30_000,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const options = results.data?.data ?? [];

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={value ? displayName : q}
            readOnly={!!value}
            disabled={disabled}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (!value) setOpen(true);
            }}
            placeholder={placeholder ?? "Search by code or property…"}
            className="min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
          />
        </div>
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onClear();
            }}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {open && !value && debouncedQ.length >= 1 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          {results.isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!results.isLoading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matches found.</div>
          )}
          {options.map((u) => {
            // Stored label stays "code · property" (stable across pick + reload);
            // unitType is a dropdown-only disambiguator, not part of the label.
            const label = `${u.unitCode} · ${u.propertyName}`;
            const sub = u.unitType ? `${u.propertyName} · ${u.unitType}` : u.propertyName;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  onSelect(u.id, label);
                  setOpen(false);
                  setQ("");
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
              >
                <div className="flex items-center gap-2 font-medium">
                  {u.unitCode}
                </div>
                <div className="text-xs text-muted-foreground">{sub}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Pick a Listing/room by apartment code → submits the unit (listing) id. */
export function UnitPicker(props: LabelPickerProps) {
  return (
    <AsyncLabelPicker
      {...props}
      endpoint="/inventory/units"
      queryKey="unit-picker"
      placeholder={props.placeholder ?? "Search by unit code or property…"}
    />
  );
}

/** Pick an Apartment by unit code → submits the apartment id (whole-unit bills). */
export function ApartmentPicker(props: LabelPickerProps) {
  return (
    <AsyncLabelPicker
      {...props}
      endpoint="/inventory/apartments"
      queryKey="apartment-picker"
      placeholder={props.placeholder ?? "Search by apartment code or property…"}
    />
  );
}
