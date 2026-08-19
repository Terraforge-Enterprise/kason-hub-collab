import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { UnitCard } from "./unit-card";
import type { Bucket, ViewMode } from "../domain/types";

type Props = {
  bucket: Bucket;
  defaultExpanded: boolean;
  view: ViewMode;
  getHref: (unit: Bucket["units"][number]) => string;
  today?: Date;
};

export function InventoryGroup({ bucket, defaultExpanded, view, getHref, today = new Date() }: Props) {
  const [open, setOpen] = useState(defaultExpanded);
  const Chevron = open ? ChevronDown : ChevronRight;
  const panelId = useId();
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? `Collapse ${bucket.buildingName}` : `Expand ${bucket.buildingName}`}
        className="flex items-center justify-between w-full text-left rounded-lg px-3 py-2 hover:bg-muted/30 transition"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Chevron className="h-4 w-4" />
          {bucket.buildingName}
          <span className="text-xs font-normal text-muted-foreground">({bucket.units.length})</span>
        </span>
        {bucket.city && <span className="text-xs text-muted-foreground">{bucket.city}</span>}
      </button>
      {open && (
        view === "grid" ? (
          <div id={panelId} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {bucket.units.map((u) => <UnitCard key={u.id} unit={u} view="grid" to={getHref(u)} today={today} />)}
          </div>
        ) : (
          <div id={panelId} className="space-y-2">
            {bucket.units.map((u) => <UnitCard key={u.id} unit={u} view="list" to={getHref(u)} today={today} />)}
          </div>
        )
      )}
    </section>
  );
}
