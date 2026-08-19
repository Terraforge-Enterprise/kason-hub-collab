import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { X, Search } from "lucide-react";

type AmenityOption = { id: string; name: string };

export type AmenityComboboxProps = {
  value: string[];
  onChange: (ids: string[]) => void;
  catalog: AmenityOption[];
  placeholder?: string;
  disabled?: boolean;
};

export function AmenityCombobox({ value, onChange, catalog, placeholder, disabled }: AmenityComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selectedById = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog]);
  const selectedOptions = value.map((id) => selectedById.get(id)).filter((x): x is AmenityOption => !!x);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((a) => a.name.toLowerCase().includes(q));
  }, [catalog, query]);

  if (catalog.length === 0) {
    return (
      <div className="rounded-md border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
        <p className="text-amber-900 dark:text-amber-100">
          No amenities defined yet —{" "}
          <Link to="/settings/inventory" className="underline font-medium">
            go to Inventory Settings
          </Link>{" "}
          to add some.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedOptions.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-0.5 rounded-full bg-[var(--gold)]/10 border border-[var(--gold)]/30 pl-3 pr-1 py-1 text-xs text-foreground"
            >
              {a.name}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((id) => id !== a.id));
                  }}
                  className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition hover:bg-rose-500/15 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <div className="flex items-center gap-2 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            role="combobox"
            type="text"
            value={query}
            disabled={disabled}
            placeholder={placeholder ?? "Search amenities..."}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
            aria-expanded={open}
          />
        </div>
        {open && filtered.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-auto rounded-md border border-border/50 bg-background shadow-lg">
            {filtered.map((a) => {
              const isSelected = value.includes(a.id);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange(isSelected ? value.filter((id) => id !== a.id) : [...value, a.id]);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/50 ${isSelected ? "text-foreground" : "text-foreground/80"}`}
                  >
                    {a.name}
                    {isSelected && <span className="text-xs text-muted-foreground">selected</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
