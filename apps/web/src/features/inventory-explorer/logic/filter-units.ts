import { ENDING_SOON_WINDOW_DAYS, type InventoryFilters, type InventoryListing } from "../domain/types";
import { classifyOccupancy } from "./occupancy";

const DAY_MS = 24 * 60 * 60 * 1000;

export function filterUnits(
  units: InventoryListing[],
  f: InventoryFilters,
  today: Date = new Date(),
): InventoryListing[] {
  const q = f.q.trim().toLowerCase();
  return units.filter((u) => {
    if (q) {
      const hay = [u.unitCode, u.property?.name ?? "", u.property?.city ?? "", u.unitType]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }

    // Availability — replaces the old ready/showOccupied booleans.
    // "Occupied" means "has a current tenant" in the user's mental model,
    // which covers both `occupied` (no foreseeable move-out) and `ending-soon`
    // (tenant in place but end date within the window). Splitting them here
    // would hide every unit whose tenant is leaving soon — exactly the units
    // the Move-out window filter is designed to surface.
    if (f.availability !== "all") {
      const cls = classifyOccupancy(u, ENDING_SOON_WINDOW_DAYS, today);
      if (f.availability === "now" && cls !== "ready") return false;
      if (f.availability === "occupied" && cls !== "occupied" && cls !== "ending-soon") return false;
    }

    if (f.beds.length > 0) {
      if (u.bedrooms == null) return false;
      const bedKey = u.bedrooms >= 4 ? 4 : u.bedrooms;
      const wants4Plus = f.beds.includes(4);
      const matches = f.beds.includes(bedKey) || (wants4Plus && u.bedrooms >= 4);
      if (!matches) return false;
    }
    if (f.baths.length > 0) {
      if (u.bathrooms == null) return false;
      const bathKey = u.bathrooms >= 3 ? 3 : u.bathrooms;
      const wants3Plus = f.baths.includes(3);
      const matches = f.baths.includes(bathKey) || (wants3Plus && u.bathrooms >= 3);
      if (!matches) return false;
    }
    if (f.priceMin != null || f.priceMax != null) {
      if (u.rentalRate == null) return false;
      const r = Number(u.rentalRate);
      if (f.priceMin != null && r < f.priceMin) return false;
      if (f.priceMax != null && r > f.priceMax) return false;
    }
    if (f.sqftMin != null || f.sqftMax != null) {
      if (u.floorArea == null) return false;
      if (f.sqftMin != null && u.floorArea < f.sqftMin) return false;
      if (f.sqftMax != null && u.floorArea > f.sqftMax) return false;
    }
    if (f.moveInFrom != null || f.moveInTo != null) {
      if (u.moveInDate == null) return false;
      const day = u.moveInDate.slice(0, 10);
      if (f.moveInFrom != null && day < f.moveInFrom) return false;
      if (f.moveInTo != null && day > f.moveInTo) return false;
    }
    if (f.moveOutFrom != null || f.moveOutTo != null) {
      if (u.currentTenancyEndDate == null) return false;
      const day = u.currentTenancyEndDate.slice(0, 10);
      if (f.moveOutFrom != null && day < f.moveOutFrom) return false;
      if (f.moveOutTo != null && day > f.moveOutTo) return false;
    }
    if (f.types.length > 0 && !f.types.includes(u.unitType)) return false;
    if (f.cities.length > 0 && !f.cities.includes(u.property?.city ?? "")) return false;
    if (f.buildings.length > 0 && !f.buildings.includes(u.property?.name ?? "")) return false;
    if (f.inCharge.length > 0 && !(u.inChargePartyId && f.inCharge.includes(u.inChargePartyId))) return false;
    if (f.sources.length > 0) {
      const key = u.sourceFlag === "COMPANY" ? "company" : "agent_sourced";
      if (!f.sources.includes(key)) return false;
    }
    if (f.sourcedByPartyIds.length > 0) {
      if (!u.sourcingAgentId || !f.sourcedByPartyIds.includes(u.sourcingAgentId)) return false;
    }
    if (f.furnishingLevels.length > 0) {
      if (!u.furnishingLevel || !f.furnishingLevels.includes(u.furnishingLevel)) return false;
    }
    if (f.amenities.length > 0) {
      const unitIds = new Set(u.amenities.map((a) => a.id));
      for (const id of f.amenities) {
        if (!unitIds.has(id)) return false;
      }
    }
    if (f.floorMin != null || f.floorMax != null) {
      if (u.floor == null) return false;
      if (f.floorMin != null && u.floor < f.floorMin) return false;
      if (f.floorMax != null && u.floor > f.floorMax) return false;
    }
    // DB may store multi-letter facing (e.g. "NE"); charAt(0) buckets it to the nearest cardinal, consistent with parseFacings.
    if (f.facings.length > 0) {
      if (!u.facing) return false;
      const first = u.facing.charAt(0).toUpperCase();
      if (!f.facings.includes(first)) return false;
    }
    if (f.vacantSinceMinDays != null) {
      if (!u.vacantSince) return false;
      const elapsed = (today.getTime() - new Date(u.vacantSince).getTime()) / DAY_MS;
      if (elapsed < f.vacantSinceMinDays) return false;
    }
    if (f.depositMonthsMax != null) {
      if (u.depositMonths == null || u.depositMonths > f.depositMonthsMax) return false;
    }
    return true;
  });
}
