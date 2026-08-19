import type { Bucket, PortalUnit } from "../domain/types";

export function groupUnitsByBuilding(units: PortalUnit[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const u of units) {
    const name = u.property?.name?.trim() || "Unknown";
    const existing = map.get(name);
    if (existing) {
      existing.units.push(u);
    } else {
      map.set(name, { buildingName: name, city: u.property?.city ?? null, units: [u] });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.units.length !== a.units.length) return b.units.length - a.units.length;
    return a.buildingName.localeCompare(b.buildingName);
  });
}
