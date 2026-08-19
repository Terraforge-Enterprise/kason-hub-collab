import { X } from "lucide-react";
import { EMPTY_FILTERS, type InventoryFilters as F, type InventoryListing } from "../domain/types";
import { furnishingLabel, facingLabel } from "../domain/labels";

type Chip = { label: string; key: string; clear: () => F };

function buildChips(
  value: F,
  inChargeNameById: Map<string, string>,
  sourcingNameById: Map<string, string>,
  amenityNameById: Map<string, string>,
): Chip[] {
  const chips: Chip[] = [];
  if (value.q) chips.push({ key: "q", label: `"${value.q}"`, clear: () => ({ ...value, q: "" }) });

  if (value.availability === "now") chips.push({ key: "av", label: "Available now", clear: () => ({ ...value, availability: "all" }) });
  else if (value.availability === "occupied") chips.push({ key: "av", label: "Occupied", clear: () => ({ ...value, availability: "all" }) });

  if (value.beds.length) chips.push({ key: "beds", label: `${value.beds.join(", ")} bed`, clear: () => ({ ...value, beds: [] }) });
  if (value.baths.length) chips.push({ key: "baths", label: `${value.baths.join(", ")} bath`, clear: () => ({ ...value, baths: [] }) });

  if (value.priceMin != null && value.priceMax != null)
    chips.push({ key: "price", label: `RM ${value.priceMin.toLocaleString()} - ${value.priceMax.toLocaleString()}`, clear: () => ({ ...value, priceMin: null, priceMax: null }) });
  else if (value.priceMin != null)
    chips.push({ key: "priceMin", label: `from RM ${value.priceMin.toLocaleString()}`, clear: () => ({ ...value, priceMin: null }) });
  else if (value.priceMax != null)
    chips.push({ key: "priceMax", label: `up to RM ${value.priceMax.toLocaleString()}`, clear: () => ({ ...value, priceMax: null }) });

  if (value.sqftMin != null || value.sqftMax != null)
    chips.push({ key: "sqft", label: `${value.sqftMin ?? 0}–${value.sqftMax ?? "∞"} sqft`, clear: () => ({ ...value, sqftMin: null, sqftMax: null }) });

  if (value.moveInFrom != null && value.moveInTo != null)
    chips.push({ key: "moveIn", label: `Move-in: ${value.moveInFrom} → ${value.moveInTo}`, clear: () => ({ ...value, moveInFrom: null, moveInTo: null }) });
  else if (value.moveInFrom != null)
    chips.push({ key: "moveInFrom", label: `Move-in from ${value.moveInFrom}`, clear: () => ({ ...value, moveInFrom: null }) });
  else if (value.moveInTo != null)
    chips.push({ key: "moveInTo", label: `Move-in by ${value.moveInTo}`, clear: () => ({ ...value, moveInTo: null }) });

  if (value.moveOutFrom != null && value.moveOutTo != null)
    chips.push({ key: "moveOut", label: `Move-out: ${value.moveOutFrom} → ${value.moveOutTo}`, clear: () => ({ ...value, moveOutFrom: null, moveOutTo: null }) });
  else if (value.moveOutFrom != null)
    chips.push({ key: "moveOutFrom", label: `Move-out from ${value.moveOutFrom}`, clear: () => ({ ...value, moveOutFrom: null }) });
  else if (value.moveOutTo != null)
    chips.push({ key: "moveOutTo", label: `Move-out by ${value.moveOutTo}`, clear: () => ({ ...value, moveOutTo: null }) });

  for (const t of value.types) chips.push({ key: `type:${t}`, label: t, clear: () => ({ ...value, types: value.types.filter((x) => x !== t) }) });
  for (const c of value.cities) chips.push({ key: `city:${c}`, label: c, clear: () => ({ ...value, cities: value.cities.filter((x) => x !== c) }) });
  for (const b of value.buildings) chips.push({ key: `bldg:${b}`, label: b, clear: () => ({ ...value, buildings: value.buildings.filter((x) => x !== b) }) });
  for (const id of value.inCharge) chips.push({ key: `ic:${id}`, label: `In charge: ${inChargeNameById.get(id) ?? id}`, clear: () => ({ ...value, inCharge: value.inCharge.filter((x) => x !== id) }) });
  for (const s of value.sources) chips.push({ key: `src:${s}`, label: s === "company" ? "Company" : "Agent sourced", clear: () => ({ ...value, sources: value.sources.filter((x) => x !== s) }) });
  for (const id of value.sourcedByPartyIds) chips.push({ key: `sb:${id}`, label: `Sourced by: ${sourcingNameById.get(id) ?? id}`, clear: () => ({ ...value, sourcedByPartyIds: value.sourcedByPartyIds.filter((x) => x !== id) }) });

  for (const f of value.furnishingLevels) chips.push({ key: `fr:${f}`, label: furnishingLabel(f), clear: () => ({ ...value, furnishingLevels: value.furnishingLevels.filter((x) => x !== f) }) });
  for (const id of value.amenities)
    chips.push({
      key: `am:${id}`,
      label: amenityNameById.get(id) ?? id,
      clear: () => ({ ...value, amenities: value.amenities.filter((x) => x !== id) }),
    });
  if (value.floorMin != null && value.floorMax != null)
    chips.push({ key: "floor", label: `Floor ${value.floorMin}–${value.floorMax}`, clear: () => ({ ...value, floorMin: null, floorMax: null }) });
  else if (value.floorMin != null)
    chips.push({ key: "floorMin", label: `Floor ≥ ${value.floorMin}`, clear: () => ({ ...value, floorMin: null }) });
  else if (value.floorMax != null)
    chips.push({ key: "floorMax", label: `Floor ≤ ${value.floorMax}`, clear: () => ({ ...value, floorMax: null }) });
  for (const fc of value.facings) chips.push({ key: `fc:${fc}`, label: `Facing ${facingLabel(fc)}`, clear: () => ({ ...value, facings: value.facings.filter((x) => x !== fc) }) });

  if (value.vacantSinceMinDays != null)
    chips.push({ key: "vs", label: `Vacant > ${value.vacantSinceMinDays} days`, clear: () => ({ ...value, vacantSinceMinDays: null }) });

  if (value.depositMonthsMax != null) {
    const label = `Deposit ≤ ${value.depositMonthsMax} month${value.depositMonthsMax === 1 ? "" : "s"}`;
    chips.push({ key: "dep", label, clear: () => ({ ...value, depositMonthsMax: null }) });
  }

  return chips;
}

export function InventoryActiveChips({ value, onChange, units = [] }: { value: F; onChange: (f: F) => void; units?: InventoryListing[] }) {
  const inChargeNameById = new Map<string, string>();
  const sourcingNameById = new Map<string, string>();
  const amenityNameById = new Map<string, string>();
  for (const u of units) {
    if (u.inChargePartyId && u.inChargeName) inChargeNameById.set(u.inChargePartyId, u.inChargeName);
    if (u.sourcingAgentId && u.sourcingAgentName) sourcingNameById.set(u.sourcingAgentId, u.sourcingAgentName);
    for (const a of u.amenities) amenityNameById.set(a.id, a.name);
  }
  const chips = buildChips(value, inChargeNameById, sourcingNameById, amenityNameById);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.clear())}
          aria-label={`Remove filter: ${c.label}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--gold)]/10 border border-[var(--gold)]/30 px-3 py-1 text-xs text-foreground hover:bg-[var(--gold)]/20 transition"
        >
          {c.label}
          <X className="h-3 w-3" />
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange(EMPTY_FILTERS)}
        className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
      >
        Reset all
      </button>
    </div>
  );
}
