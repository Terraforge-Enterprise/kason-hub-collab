import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { PillBar } from "@/components/ui/pill-bar";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { Search } from "lucide-react";
import { FilterSection } from "./filter-section";

const CHIP_MAX = 6;
const LIST_MAX = 15;

export type DDSValue = { id: string; name: string };

export type DataDrivenSectionProps = {
  title: string;
  values: DDSValue[];
  selected: string[];
  onChange: (next: string[]) => void;
  alwaysOpen?: boolean;
  defaultOpen?: boolean;
};

export function DataDrivenSection({
  title, values, selected, onChange, alwaysOpen, defaultOpen,
}: DataDrivenSectionProps) {
  const hidden = values.length < 2;

  const mode = values.length <= CHIP_MAX
    ? "chip"
    : values.length <= LIST_MAX ? "list" : "combobox";

  const body =
    mode === "chip" ? (
      <PillBar
        ariaLabel={title}
        size="sm"
        value={selected}
        onChange={onChange}
        options={values.map((v) => ({ value: v.id, label: <span className="capitalize">{v.name}</span> }))}
      />
    ) : mode === "list" ? (
      <CheckboxList values={values} selected={selected} onChange={onChange} />
    ) : (
      <ComboboxPopover title={title} values={values} selected={selected} onChange={onChange} />
    );

  return (
    <FilterSection
      title={title}
      activeCount={selected.length}
      alwaysOpen={alwaysOpen}
      defaultOpen={defaultOpen}
      hidden={hidden}
    >
      {body}
    </FilterSection>
  );
}

function CheckboxList({ values, selected, onChange }: {
  values: DDSValue[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return values;
    return values.filter((v) => v.name.toLowerCase().includes(ql));
  }, [values, q]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-xs">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          aria-label="Search"
          className="flex-1 bg-transparent outline-none placeholder:text-[var(--text-muted)]"
        />
      </label>
      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
        {filtered.map((v) => (
          <div key={v.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(v.id)}
              onCheckedChange={() => toggle(v.id)}
              aria-label={v.name}
            />
            <span className="truncate capitalize">{v.name}</span>
          </div>
        ))}
        {filtered.length === 0 && <p className="text-xs text-muted-foreground py-2">No matches.</p>}
      </div>
    </div>
  );
}

function ComboboxPopover({ title, values, selected, onChange }: {
  title: string; values: DDSValue[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return values;
    return values.filter((v) => v.name.toLowerCase().includes(ql));
  }, [values, q]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const triggerLabel = selected.length === 0
    ? `Select ${title.toLowerCase()}…`
    : `${selected.length} selected`;

  return (
    <div className="space-y-2">
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex w-full items-center justify-between gap-2 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm hover:border-border">
          <span>{triggerLabel}</span>
          <span className="text-xs text-muted-foreground">▼</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
          <div className="p-2 sticky top-0 bg-popover">
            <label className="flex items-center gap-2 rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-xs">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                aria-label="Search"
                className="flex-1 bg-transparent outline-none"
              />
            </label>
          </div>
          <div className="space-y-1 px-2 pb-2">
            {filtered.map((v) => (
              <div key={v.id} className="flex items-center gap-2 text-sm py-1">
                <Checkbox
                  checked={selected.includes(v.id)}
                  onCheckedChange={() => toggle(v.id)}
                  aria-label={v.name}
                />
                <span className="truncate capitalize">{v.name}</span>
              </div>
            ))}
            {filtered.length === 0 && <p className="text-xs text-muted-foreground py-2">No matches.</p>}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const v = values.find((x) => x.id === id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--gold)]/30 bg-[var(--gold)]/10 px-2 py-0.5 text-[11px]"
              >
                <span className="capitalize">{v?.name ?? id}</span>
                <span aria-hidden>×</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
