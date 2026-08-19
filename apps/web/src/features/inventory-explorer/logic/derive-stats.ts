import type { PortalUnit } from "../domain/types";

export type InventoryStats = {
  count: number;
  readyNowCount: number;
  buildingCount: number;
  avgRental: number | null;
};

export function deriveStats(units: PortalUnit[]): InventoryStats {
  if (units.length === 0) {
    return { count: 0, readyNowCount: 0, buildingCount: 0, avgRental: null };
  }
  let readyNowCount = 0;
  let priceSum = 0;
  let priceCount = 0;
  const buildings = new Set<string>();
  for (const u of units) {
    if (u.readyNow) readyNowCount++;
    if (u.rentalRate != null) {
      priceSum += Number(u.rentalRate);
      priceCount++;
    }
    buildings.add(u.property?.name ?? "Unknown");
  }
  return {
    count: units.length,
    readyNowCount,
    buildingCount: buildings.size,
    avgRental: priceCount === 0 ? null : Math.round(priceSum / priceCount),
  };
}
