// Async "pick a payer by name, submit the id" combobox for the receive-payment /
// correction drawers. Mirrors the AsyncLabelPicker template in
// components/unit-picker.tsx (internal 250ms debounce, click-outside close,
// readonly label + Clear once picked), but is wired to the party typeahead
// (useSearchParties → GET /parties/{tenants,owners}/search) instead of the
// inventory endpoints. AsyncLabelPicker is not exported, so we clone its
// structure rather than reuse it. Kept a plain component under components/ (not
// pages/) so any drawer can reuse it. Frontend §15: pick from context, never
// re-type a UUID — the id is resolved by the search endpoint.
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useSearchParties, type PartyCounterparty } from "@/api/parties-search";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export type PartyPickerValue = { id: string; name: string };

export type PartyPickerProps = {
  /** Which register to search — switches endpoint + query-key scope. */
  counterparty: PartyCounterparty;
  /** Selected payer (null = nothing picked). */
  value: PartyPickerValue | null;
  onChange: (v: PartyPickerValue | null) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
};

export function PartyPicker({
  counterparty,
  value,
  onChange,
  label,
  placeholder,
  disabled,
}: PartyPickerProps) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 250);

  // Only fetch when the dropdown is open and there is a settled query — the hook
  // debounces nothing itself, so we feed it the already-debounced value.
  const results = useSearchParties(counterparty, debouncedQ, {
    enabled: open && debouncedQ.trim().length >= 1,
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

  const options = results.data ?? [];
  const showDropdown = open && !value && debouncedQ.trim().length >= 1;

  return (
    <div ref={containerRef} className="relative">
      {label ? (
        <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">{label}</span>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            aria-label={label ?? (counterparty === "tenant" ? "Search tenant" : "Search owner")}
            value={value ? value.name : q}
            readOnly={!!value}
            disabled={disabled}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => {
              if (!value) setOpen(true);
            }}
            placeholder={placeholder ?? (counterparty === "tenant" ? "Search tenant by name…" : "Search owner by name…")}
            className="min-h-10 w-full rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] py-2 pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
          />
        </div>
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onChange(null);
            }}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {showDropdown && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border/60 bg-background/95 shadow-lg backdrop-blur">
          {results.isLoading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
          )}
          {!results.isLoading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matches found.</div>
          )}
          {options.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange({ id: p.id, name: p.name });
                setOpen(false);
                setQ("");
              }}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-muted/40"
            >
              <div className="font-medium">{p.name}</div>
              {p.subtitle ? <div className="text-xs text-muted-foreground">{p.subtitle}</div> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
