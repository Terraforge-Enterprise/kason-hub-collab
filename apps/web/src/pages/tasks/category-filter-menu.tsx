// Multi-select category filter for the Tasks board. A compact checkbox
// dropdown backed by the admin-managed WorkCategory list (passed in as
// `options`) plus an "Uncategorized" bucket. Pure/presentational — the board
// page owns the state and the WorkCategory fetch. Unbounded list ⇒ dropdown
// (mirrors the Assignee filter), not pills (which are for the 3 fixed
// priorities). Selected state uses the gold-active vocabulary of PillBar.
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { UNCATEGORIZED } from "./task-filters";

interface Props {
  value: string[]; // selected category names (may include the UNCATEGORIZED sentinel)
  onChange: (next: string[]) => void;
  options: string[]; // active WorkCategory names
}

function triggerLabel(value: string[]): string {
  if (value.length === 0) return "All categories";
  if (value.length === 1) return value[0] === UNCATEGORIZED ? "Uncategorized" : value[0];
  return `${value.length} categories`;
}

export function CategoryFilterMenu({ value, onChange, options }: Props) {
  const active = value.length > 0;
  const toggle = (v: string, checked: boolean) =>
    onChange(checked ? [...value, v] : value.filter((x) => x !== v));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Category filter"
        className={cn(
          "flex min-h-0 w-44 items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm transition",
          active
            ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground"
            : "border-border/50 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground",
        )}
      >
        <span className="truncate">{triggerLabel(value)}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.map((name) => (
          <DropdownMenuCheckboxItem
            key={name}
            checked={value.includes(name)}
            onCheckedChange={(checked) => toggle(name, checked)}
          >
            {name}
          </DropdownMenuCheckboxItem>
        ))}
        {options.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuCheckboxItem
          checked={value.includes(UNCATEGORIZED)}
          onCheckedChange={(checked) => toggle(UNCATEGORIZED, checked)}
        >
          Uncategorized
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
