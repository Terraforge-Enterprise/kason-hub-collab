import type { PortalUnit, SortKey } from "../domain/types";

const numOrInf = (v: number | string | null, fallback: number): number =>
  v == null ? fallback : Number(v);

export function sortUnits(units: PortalUnit[], key: SortKey): PortalUnit[] {
  const copy = units.slice();
  switch (key) {
    case "ready":
      return copy.sort((a, b) => Number(b.readyNow) - Number(a.readyNow));
    case "price-asc":
      return copy.sort((a, b) =>
        numOrInf(a.rentalRate, Number.POSITIVE_INFINITY) - numOrInf(b.rentalRate, Number.POSITIVE_INFINITY),
      );
    case "price-desc":
      return copy.sort((a, b) =>
        numOrInf(b.rentalRate, Number.NEGATIVE_INFINITY) - numOrInf(a.rentalRate, Number.NEGATIVE_INFINITY),
      );
    case "sqft-desc":
      return copy.sort((a, b) =>
        numOrInf(b.floorArea, Number.NEGATIVE_INFINITY) - numOrInf(a.floorArea, Number.NEGATIVE_INFINITY),
      );
    case "newest":
      return copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    case "beds-desc":
      return copy.sort((a, b) =>
        numOrInf(b.bedrooms, Number.NEGATIVE_INFINITY) - numOrInf(a.bedrooms, Number.NEGATIVE_INFINITY),
      );
  }
}
