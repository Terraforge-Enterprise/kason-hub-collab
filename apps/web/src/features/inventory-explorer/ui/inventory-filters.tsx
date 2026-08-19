// apps/web/src/features/inventory-explorer/ui/inventory-filters.tsx
import { useState } from "react";
import { EMPTY_FILTERS, type InventoryFilters as F, type InventoryListing, ENDING_SOON_WINDOW_DAYS } from "../domain/types";
import { Segmented } from "@/components/ui/segmented";
import { FilterSection } from "./filter-section";
import { classifyOccupancy } from "../logic/occupancy";
import { PillBar } from "@/components/ui/pill-bar";
import { useFilterCardinality } from "../hooks/use-filter-cardinality";
import { DataDrivenSection } from "./data-driven-section";
import { furnishingLabel, facingLabel } from "../domain/labels";

type Props = { value: F; onChange: (next: F) => void; units: InventoryListing[] };

function NumericInput({
  value, onChange, ariaLabel, placeholder, className,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
}) {
  const [local, setLocal] = useState(value != null ? String(value) : "");
  const [last, setLast] = useState(value);
  if (value !== last) { setLast(value); setLocal(value != null ? String(value) : ""); }
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={local}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      onChange={(e) => {
        // Strip everything but digits — blocks negatives, decimals, and stray characters.
        // Filter inputs are integer-only (price RM, floor-area sqft); no fractional ranges.
        const raw = e.target.value.replace(/[^0-9]/g, "");
        setLocal(raw);
        onChange(raw === "" ? null : Number(raw));
      }}
    />
  );
}

function isoOffset(today: Date, days: number): string {
  const d = new Date(today.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function medianRentalRate(units: InventoryListing[]): number | null {
  const rates = units
    .map((u) => (u.rentalRate == null ? null : Number(u.rentalRate)))
    .filter((n): n is number => n != null && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 === 0 ? Math.round((rates[mid - 1] + rates[mid]) / 2) : rates[mid];
}

export function countActiveFilters(f: F): number {
  let n = 0;
  if (f.q) n++;
  if (f.availability !== "all") n++;
  if (f.beds.length) n++;
  if (f.baths.length) n++;
  if (f.priceMin != null || f.priceMax != null) n++;
  if (f.sqftMin != null || f.sqftMax != null) n++;
  if (f.moveInFrom != null || f.moveInTo != null) n++;
  if (f.moveOutFrom != null || f.moveOutTo != null) n++;
  if (f.types.length) n++;
  if (f.cities.length) n++;
  if (f.buildings.length) n++;
  if (f.inCharge.length) n++;
  if (f.sources.length) n++;
  if (f.sourcedByPartyIds.length) n++;
  if (f.furnishingLevels.length) n++;
  if (f.amenities.length) n++;
  if (f.floorMin != null || f.floorMax != null) n++;
  if (f.facings.length) n++;
  if (f.vacantSinceMinDays != null) n++;
  if (f.depositMonthsMax != null) n++;
  return n;
}

export function InventoryFilters({ value, onChange, units }: Props) {
  const card = useFilterCardinality(units);
  const active = countActiveFilters(value);
  return (
    <aside className="space-y-5">
      <div className="sticky top-0 -mt-1 -mx-1 px-1 pt-1 pb-2 bg-background/80 backdrop-blur-xl z-10 flex items-center justify-between gap-2 border-b border-border/50">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filters {active > 0 && <span className="ml-1 text-foreground">· {active} active</span>}
        </div>
        {active > 0 && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      <FilterSection title="Availability" alwaysOpen activeCount={value.availability !== "all" ? 1 : 0}>
        <Segmented<F["availability"]>
          ariaLabel="Availability"
          size="sm"
          value={value.availability}
          onChange={(v) => onChange({ ...value, availability: v })}
          options={[
            { value: "now", label: "Available now" },
            { value: "occupied", label: "Occupied" },
            { value: "all", label: "All" },
          ]}
        />
        <p className="text-xs text-muted-foreground mt-1.5">
          {(() => {
            const today = new Date();
            const counts = { ready: 0, occupied: 0 };
            for (const u of units) {
              const cls = classifyOccupancy(u, ENDING_SOON_WINDOW_DAYS, today);
              if (cls === "ready") counts.ready++;
              else if (cls === "occupied" || cls === "ending-soon") counts.occupied++;
            }
            const total = units.length;
            if (value.availability === "now") return `Showing ${counts.ready} of ${total} units · ${total - counts.ready} filtered`;
            if (value.availability === "occupied") return `Showing ${counts.occupied} of ${total} units · ${total - counts.occupied} filtered`;
            return `${total} units`;
          })()}
        </p>
      </FilterSection>
      <FilterSection title="Bedrooms" alwaysOpen activeCount={value.beds.length}>
        <PillBar<number>
          ariaLabel="Bedrooms"
          size="sm"
          value={value.beds}
          onChange={(next) => onChange({ ...value, beds: next.sort((a, b) => a - b) })}
          options={[
            { value: 1, label: "1" },
            { value: 2, label: "2" },
            { value: 3, label: "3" },
            { value: 4, label: "4+" },
          ]}
        />
      </FilterSection>

      <FilterSection title="Bathrooms" alwaysOpen activeCount={value.baths.length}>
        <PillBar<number>
          ariaLabel="Bathrooms"
          size="sm"
          value={value.baths}
          onChange={(next) => onChange({ ...value, baths: next.sort((a, b) => a - b) })}
          options={[
            { value: 1, label: "1" },
            { value: 2, label: "2" },
            { value: 3, label: "3+" },
          ]}
        />
      </FilterSection>
      <FilterSection
        title="Price (RM/month)"
        alwaysOpen
        activeCount={value.priceMin != null || value.priceMax != null ? 1 : 0}
      >
        <div className="grid grid-cols-2 gap-2">
          <NumericInput
            value={value.priceMin}
            onChange={(v) => onChange({ ...value, priceMin: v })}
            ariaLabel="Min RM"
            placeholder="Min RM"
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
          />
          <NumericInput
            value={value.priceMax}
            onChange={(v) => onChange({ ...value, priceMax: v })}
            ariaLabel="Max RM"
            placeholder="Max RM"
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
          />
        </div>
        {(() => {
          const m = medianRentalRate(units);
          return m != null ? (
            <p className="text-xs text-muted-foreground mt-1.5">
              Median: RM {m.toLocaleString()}
            </p>
          ) : null;
        })()}
      </FilterSection>
      <div className="pt-3 border-t border-border/40">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">More filters</p>
      </div>

      <FilterSection
        title="Floor area"
        activeCount={value.sqftMin != null || value.sqftMax != null ? 1 : 0}
      >
        <div className="grid grid-cols-2 gap-2">
          <NumericInput
            value={value.sqftMin}
            onChange={(v) => onChange({ ...value, sqftMin: v })}
            ariaLabel="Min sqft"
            placeholder="Min sqft"
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
          />
          <NumericInput
            value={value.sqftMax}
            onChange={(v) => onChange({ ...value, sqftMax: v })}
            ariaLabel="Max sqft"
            placeholder="Max sqft"
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
          />
        </div>
      </FilterSection>
      {(() => {
        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const presetActive = (days: number) =>
          value.moveInFrom === todayIso && value.moveInTo === isoOffset(today, days);
        const anyPresetActive = presetActive(30) || presetActive(60) || presetActive(90);
        const customActive =
          !!(value.moveInFrom || value.moveInTo) && !anyPresetActive;
        const togglePreset = (days: number) =>
          presetActive(days)
            ? onChange({ ...value, moveInFrom: null, moveInTo: null })
            : onChange({ ...value, moveInFrom: todayIso, moveInTo: isoOffset(today, days) });
        // Custom range: seed `from=today, to=null`. Leaving `to` null guarantees
        // we do NOT collide with the 30-day preset shape, so customActive stays
        // true and the date inputs render. The user picks `to` themselves.
        const setCustom = () =>
          customActive
            ? onChange({ ...value, moveInFrom: null, moveInTo: null })
            : onChange({ ...value, moveInFrom: todayIso, moveInTo: null });
        return (
          <FilterSection
            title="Move-in window"
            activeCount={(value.moveInFrom != null || value.moveInTo != null) ? 1 : 0}
          >
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {[30, 60, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={presetActive(days)}
                    onClick={() => togglePreset(days)}
                    className={`rounded-md border px-2 py-1 text-xs transition ${presetActive(days) ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground" : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    Next {days} days
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={customActive}
                  onClick={setCustom}
                  className={`rounded-md border px-2 py-1 text-xs transition ${customActive ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground" : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"}`}
                >
                  Custom range
                </button>
              </div>
              {customActive && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={value.moveInFrom ?? ""}
                    aria-label="Move-in from"
                    className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-xs"
                    onChange={(e) => onChange({ ...value, moveInFrom: e.target.value || null })}
                  />
                  <input
                    type="date"
                    value={value.moveInTo ?? ""}
                    aria-label="Move-in to"
                    className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-xs"
                    onChange={(e) => onChange({ ...value, moveInTo: e.target.value || null })}
                  />
                </div>
              )}
            </div>
          </FilterSection>
        );
      })()}
      {(() => {
        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        const presetActive = (days: number) =>
          value.moveOutFrom === todayIso && value.moveOutTo === isoOffset(today, days);
        const anyPresetActive = presetActive(30) || presetActive(60) || presetActive(90);
        const customActive =
          !!(value.moveOutFrom || value.moveOutTo) && !anyPresetActive;
        const togglePreset = (days: number) =>
          presetActive(days)
            ? onChange({ ...value, moveOutFrom: null, moveOutTo: null })
            : onChange({ ...value, moveOutFrom: todayIso, moveOutTo: isoOffset(today, days) });
        const setCustom = () =>
          customActive
            ? onChange({ ...value, moveOutFrom: null, moveOutTo: null })
            : onChange({ ...value, moveOutFrom: todayIso, moveOutTo: null });
        return (
          <FilterSection
            title="Move-out window"
            activeCount={(value.moveOutFrom != null || value.moveOutTo != null) ? 1 : 0}
          >
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {[30, 60, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={presetActive(days)}
                    onClick={() => togglePreset(days)}
                    className={`rounded-md border px-2 py-1 text-xs transition ${presetActive(days) ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground" : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    Next {days} days
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={customActive}
                  onClick={setCustom}
                  className={`rounded-md border px-2 py-1 text-xs transition ${customActive ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground" : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"}`}
                >
                  Custom range
                </button>
              </div>
              {customActive && (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={value.moveOutFrom ?? ""}
                    aria-label="Move-out from"
                    className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-xs"
                    onChange={(e) => onChange({ ...value, moveOutFrom: e.target.value || null })}
                  />
                  <input
                    type="date"
                    value={value.moveOutTo ?? ""}
                    aria-label="Move-out to"
                    className="rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-xs"
                    onChange={(e) => onChange({ ...value, moveOutTo: e.target.value || null })}
                  />
                </div>
              )}
            </div>
          </FilterSection>
        );
      })()}
      <DataDrivenSection
        title="Property type"
        values={card.unitTypes.map((t) => ({ id: t, name: t }))}
        selected={value.types}
        onChange={(next) => onChange({ ...value, types: next })}
      />

      <DataDrivenSection
        title="City"
        values={card.cities.map((c) => ({ id: c, name: c }))}
        selected={value.cities}
        onChange={(next) => onChange({ ...value, cities: next })}
      />

      <DataDrivenSection
        title="Building"
        values={card.buildings.map((b) => ({ id: b, name: b }))}
        selected={value.buildings}
        onChange={(next) => onChange({ ...value, buildings: next })}
      />

      <DataDrivenSection
        title="In charge"
        values={card.inChargeAgents}
        selected={value.inCharge}
        onChange={(next) => onChange({ ...value, inCharge: next })}
      />
      {card.sources.length >= 2 && (
        <FilterSection
          title="Source"
          activeCount={value.sources.length + (value.sources.includes("agent_sourced") ? value.sourcedByPartyIds.length : 0)}
        >
          <div className="space-y-3">
            <PillBar<F["sources"][number]>
              ariaLabel="Source"
              size="sm"
              value={value.sources}
              onChange={(next) => {
                const sourcedByPartyIds = next.includes("agent_sourced") ? value.sourcedByPartyIds : [];
                onChange({ ...value, sources: next, sourcedByPartyIds });
              }}
              options={[
                { value: "company", label: "Company" },
                { value: "agent_sourced", label: "Agent sourced" },
              ]}
            />
            {value.sources.includes("agent_sourced") && card.sourcingAgents.length >= 2 && (
              <div className="pl-3 border-l-2 border-border/40">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Sourced by</p>
                <DataDrivenSection
                  title=""
                  alwaysOpen
                  values={card.sourcingAgents}
                  selected={value.sourcedByPartyIds}
                  onChange={(next) => onChange({ ...value, sourcedByPartyIds: next })}
                />
              </div>
            )}
          </div>
        </FilterSection>
      )}
      {card.furnishingLevels.length >= 2 && (
        <FilterSection title="Furnishing" activeCount={value.furnishingLevels.length}>
          <PillBar<string>
            ariaLabel="Furnishing"
            size="sm"
            value={value.furnishingLevels}
            onChange={(next) => onChange({ ...value, furnishingLevels: next })}
            options={card.furnishingLevels.map((f) => ({ value: f, label: furnishingLabel(f) }))}
          />
        </FilterSection>
      )}

      {card.hasFloor && (
        <FilterSection
          title="Floor"
          activeCount={value.floorMin != null || value.floorMax != null ? 1 : 0}
        >
          <div className="grid grid-cols-2 gap-2">
            <NumericInput
              value={value.floorMin}
              onChange={(v) => onChange({ ...value, floorMin: v })}
              ariaLabel="Min floor"
              placeholder="Min"
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
            />
            <NumericInput
              value={value.floorMax}
              onChange={(v) => onChange({ ...value, floorMax: v })}
              ariaLabel="Max floor"
              placeholder="Max"
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm"
            />
          </div>
          {(() => {
            // Data hint: the range of floors actually present in the loaded
            // units. Helps the user pick sensible bounds without us imposing
            // hardcoded Low/Mid/High bands.
            const floors = units
              .map((u) => u.floor)
              .filter((n): n is number => n != null && Number.isFinite(n));
            if (floors.length === 0) return null;
            const min = Math.min(...floors);
            const max = Math.max(...floors);
            return (
              <p className="text-xs text-muted-foreground mt-1.5">
                {min === max ? `Only floor ${min} in data` : `Floors in data: ${min}–${max}`}
              </p>
            );
          })()}
        </FilterSection>
      )}

      {card.facings.length >= 2 && (
        <FilterSection title="Facing" activeCount={value.facings.length}>
          <PillBar<string>
            ariaLabel="Facing"
            size="sm"
            value={value.facings}
            onChange={(next) => onChange({ ...value, facings: next })}
            options={card.facings.map((f) => ({ value: f, label: facingLabel(f) }))}
          />
        </FilterSection>
      )}
      <DataDrivenSection
        title="Amenities"
        values={card.amenities}
        selected={value.amenities}
        onChange={(next) => onChange({ ...value, amenities: next })}
      />
      {card.hasVacantSince && (
        <FilterSection title="Vacant-since" activeCount={value.vacantSinceMinDays != null ? 1 : 0}>
          <div className="flex flex-wrap gap-1.5">
            {[30, 60, 90].map((days) => {
              const active = value.vacantSinceMinDays === days;
              return (
                <button
                  key={days}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    onChange({ ...value, vacantSinceMinDays: active ? null : days })
                  }
                  className={`rounded-md border px-2 py-1 text-xs transition ${active ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground" : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"}`}
                >
                  &gt; {days} days
                </button>
              );
            })}
          </div>
        </FilterSection>
      )}

      {card.hasDepositData && (
        <FilterSection title="Deposit months" activeCount={value.depositMonthsMax != null ? 1 : 0}>
          <div className="flex flex-wrap gap-1.5">
            {([
              [1, "≤ 1 month"],
              [2, "≤ 2 months"],
            ] as const).map(([key, label]) => {
              const active = value.depositMonthsMax === key;
              return (
                <button
                  key={String(key)}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange({ ...value, depositMonthsMax: active ? null : key })}
                  className={`rounded-md border px-2 py-1 text-xs transition ${active ? "border-[var(--gold)] bg-[var(--gold)]/15 text-foreground" : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </FilterSection>
      )}
    </aside>
  );
}
