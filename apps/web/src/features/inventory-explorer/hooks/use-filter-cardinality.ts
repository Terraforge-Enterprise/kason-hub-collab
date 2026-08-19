import { useMemo } from "react";
import { type InventoryListing, type SourceFilter } from "../domain/types";

export type FilterCardinality = {
  unitTypes: string[];
  cities: string[];
  buildings: string[];
  inChargeAgents: { id: string; name: string }[];
  sourcingAgents: { id: string; name: string }[];
  sources: SourceFilter[];
  furnishingLevels: string[];
  amenities: { id: string; name: string }[];
  facings: string[];
  hasVacantSince: boolean;
  hasFloor: boolean;
  hasDepositData: boolean;
};

const sortedUnique = <T>(values: Iterable<T>, cmp: (a: T, b: T) => number): T[] => {
  const set = new Set<T>(values);
  return Array.from(set).sort(cmp);
};

const cmpStr = (a: string, b: string) => a.localeCompare(b);

export function computeFilterCardinality(units: InventoryListing[]): FilterCardinality {
  const unitTypes = new Set<string>();
  const cities = new Set<string>();
  const buildings = new Set<string>();
  const inCharge = new Map<string, string>();
  const sourcing = new Map<string, string>();
  const sources = new Set<SourceFilter>();
  const furnishings = new Set<string>();
  const amenitiesPresent = new Map<string, string>();   // id → name
  const facings = new Set<string>();
  let hasVacantSince = false;
  let hasFloor = false;
  let hasDepositData = false;

  for (const u of units) {
    if (u.unitType) unitTypes.add(u.unitType);
    if (u.property?.city) cities.add(u.property.city);
    if (u.property?.name) buildings.add(u.property.name);
    if (u.inChargePartyId && u.inChargeName) inCharge.set(u.inChargePartyId, u.inChargeName);
    if (u.sourcingAgentId && u.sourcingAgentName) sourcing.set(u.sourcingAgentId, u.sourcingAgentName);
    sources.add(u.sourceFlag === "COMPANY" ? "company" : "agent_sourced");
    if (u.furnishingLevel) furnishings.add(u.furnishingLevel);
    for (const a of u.amenities) {
      if (!a.id) continue;
      amenitiesPresent.set(a.id, a.name);
    }
    if (u.facing) facings.add(u.facing.charAt(0).toUpperCase());
    if (u.vacantSince) hasVacantSince = true;
    if (u.floor != null) hasFloor = true;
    if (u.depositMonths != null) hasDepositData = true;
  }

  return {
    unitTypes: sortedUnique(unitTypes, cmpStr),
    cities: sortedUnique(cities, cmpStr),
    buildings: sortedUnique(buildings, cmpStr),
    inChargeAgents: Array.from(inCharge.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => cmpStr(a.name, b.name)),
    sourcingAgents: Array.from(sourcing.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => cmpStr(a.name, b.name)),
    sources: Array.from(sources),
    furnishingLevels: sortedUnique(furnishings, cmpStr),
    amenities: Array.from(amenitiesPresent.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    facings: sortedUnique(facings, cmpStr),
    hasVacantSince,
    hasFloor,
    hasDepositData,
  };
}

export function useFilterCardinality(units: InventoryListing[]): FilterCardinality {
  return useMemo(() => computeFilterCardinality(units), [units]);
}
