// apps/web/src/features/inventory-explorer/hooks/use-inventory-filters.ts
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { type Availability, type DepositChoice, type InventoryFilters, type SortKey, type ViewMode, type GroupKey, type SourceFilter } from "../domain/types";

const SORT_VALUES: SortKey[] = ["ready", "price-asc", "price-desc", "sqft-desc", "newest", "beds-desc"];
const VIEW_VALUES: ViewMode[] = ["grid", "list"];
const GROUP_VALUES: GroupKey[] = ["building", "none"];
const SOURCE_VALUES: SourceFilter[] = ["company", "agent_sourced"];

const parseIntList = (raw: string | null): number[] =>
  (raw ?? "").split(",").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n));

const parseStrList = (raw: string | null): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const parseInt1 = (raw: string | null): number | null => {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseIsoDate = (raw: string | null): string | null =>
  raw && ISO_DATE_RE.test(raw) ? raw : null;

const FACING_VALUES = new Set(["N", "S", "E", "W"]);

const parseAvailability = (sp: URLSearchParams): Availability => {
  const explicit = sp.get("availability");
  if (explicit === "now" || explicit === "occupied" || explicit === "all") return explicit;

  const legacyReady = sp.get("ready") === "1";
  const legacyOccupied = sp.get("occupied") === "1";
  if (legacyOccupied) return "all";
  if (legacyReady) return "now";
  return "all";
};

const parseFacings = (raw: string | null): string[] => {
  if (!raw) return [];
  return Array.from(new Set(
    raw.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.charAt(0).toUpperCase())
      .filter((c) => FACING_VALUES.has(c)),
  ));
};

const parseDeposit = (raw: string | null): DepositChoice | null => {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

export function parseFilters(sp: URLSearchParams): InventoryFilters {
  return {
    q: sp.get("q") ?? "",
    availability: parseAvailability(sp),
    beds: parseIntList(sp.get("beds")),
    baths: parseIntList(sp.get("baths")),
    priceMin: parseInt1(sp.get("priceMin")),
    priceMax: parseInt1(sp.get("priceMax")),
    sqftMin: parseInt1(sp.get("sqftMin")),
    sqftMax: parseInt1(sp.get("sqftMax")),
    moveInFrom: parseIsoDate(sp.get("moveInFrom")),
    moveInTo: parseIsoDate(sp.get("moveInTo")),
    moveOutFrom: parseIsoDate(sp.get("moveOutFrom")),
    moveOutTo: parseIsoDate(sp.get("moveOutTo")),
    types: parseStrList(sp.get("types")),
    cities: parseStrList(sp.get("cities")),
    buildings: parseStrList(sp.get("buildings")),
    inCharge: parseStrList(sp.get("incharge")),
    sources: parseStrList(sp.get("sources")).filter((s): s is SourceFilter =>
      SOURCE_VALUES.includes(s as SourceFilter),
    ),
    sourcedByPartyIds: parseStrList(sp.get("sourcedBy")),
    furnishingLevels: parseStrList(sp.get("furnishing")),
    amenities: parseStrList(sp.get("amenities")),
    floorMin: parseInt1(sp.get("floorMin")),
    floorMax: parseInt1(sp.get("floorMax")),
    facings: parseFacings(sp.get("facing")),
    vacantSinceMinDays: parseInt1(sp.get("vacantMin")),
    depositMonthsMax: parseDeposit(sp.get("deposit")),
  };
}

export function serializeFilters(f: InventoryFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.q) sp.set("q", f.q);
  if (f.availability !== "all") sp.set("availability", f.availability);
  if (f.beds.length > 0) sp.set("beds", f.beds.join(","));
  if (f.baths.length > 0) sp.set("baths", f.baths.join(","));
  if (f.priceMin != null) sp.set("priceMin", String(f.priceMin));
  if (f.priceMax != null) sp.set("priceMax", String(f.priceMax));
  if (f.sqftMin != null) sp.set("sqftMin", String(f.sqftMin));
  if (f.sqftMax != null) sp.set("sqftMax", String(f.sqftMax));
  if (f.moveInFrom != null) sp.set("moveInFrom", f.moveInFrom);
  if (f.moveInTo != null) sp.set("moveInTo", f.moveInTo);
  if (f.moveOutFrom != null) sp.set("moveOutFrom", f.moveOutFrom);
  if (f.moveOutTo != null) sp.set("moveOutTo", f.moveOutTo);
  if (f.types.length > 0) sp.set("types", f.types.join(","));
  if (f.cities.length > 0) sp.set("cities", f.cities.join(","));
  if (f.buildings.length > 0) sp.set("buildings", f.buildings.join(","));
  if (f.inCharge.length > 0) sp.set("incharge", f.inCharge.join(","));
  if (f.sources.length > 0) sp.set("sources", f.sources.join(","));
  if (f.sourcedByPartyIds.length > 0) sp.set("sourcedBy", f.sourcedByPartyIds.join(","));
  if (f.furnishingLevels.length > 0) sp.set("furnishing", f.furnishingLevels.join(","));
  if (f.amenities.length > 0) sp.set("amenities", f.amenities.join(","));
  if (f.floorMin != null) sp.set("floorMin", String(f.floorMin));
  if (f.floorMax != null) sp.set("floorMax", String(f.floorMax));
  if (f.facings.length > 0) sp.set("facing", f.facings.join(","));
  if (f.vacantSinceMinDays != null) sp.set("vacantMin", String(f.vacantSinceMinDays));
  if (f.depositMonthsMax != null) {
    sp.set("deposit", typeof f.depositMonthsMax === "number" ? String(f.depositMonthsMax) : f.depositMonthsMax);
  }
  return sp;
}

export type InventoryUrlState = {
  filters: InventoryFilters;
  group: GroupKey;
  view: ViewMode;
  sort: SortKey;
  take: number;
  setFilters: (next: InventoryFilters) => void;
  setGroup: (g: GroupKey) => void;
  setView: (v: ViewMode) => void;
  setSort: (s: SortKey) => void;
  setTake: (n: number) => void;
  reset: () => void;
};

export function useInventoryUrlState(): InventoryUrlState {
  const [sp, setSp] = useSearchParams();

  const filters = useMemo(() => parseFilters(sp), [sp]);
  const group: GroupKey = GROUP_VALUES.includes(sp.get("group") as GroupKey)
    ? (sp.get("group") as GroupKey)
    : "building";
  const view: ViewMode = VIEW_VALUES.includes(sp.get("view") as ViewMode)
    ? (sp.get("view") as ViewMode)
    : "grid";
  const sort: SortKey = SORT_VALUES.includes(sp.get("sort") as SortKey)
    ? (sp.get("sort") as SortKey)
    : "ready";
  const take = parseInt1(sp.get("take")) ?? 24;

  const writeFilters = useCallback(
    (next: InventoryFilters) => {
      const nextSp = serializeFilters(next);
      const carry: Array<["group" | "view" | "sort" | "take", string]> = [];
      if (sp.get("group")) carry.push(["group", sp.get("group")!]);
      if (sp.get("view")) carry.push(["view", sp.get("view")!]);
      if (sp.get("sort")) carry.push(["sort", sp.get("sort")!]);
      if (sp.get("take")) carry.push(["take", sp.get("take")!]);
      for (const [k, v] of carry) nextSp.set(k, v);
      setSp(nextSp, { replace: true });
    },
    [sp, setSp],
  );

  const setKey = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(sp);
      if (value == null) next.delete(key);
      else next.set(key, value);
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );

  return {
    filters,
    group,
    view,
    sort,
    take,
    setFilters: writeFilters,
    setGroup: (g) => setKey("group", g === "building" ? null : g),
    setView: (v) => setKey("view", v === "grid" ? null : v),
    setSort: (s) => setKey("sort", s === "ready" ? null : s),
    setTake: (n) => setKey("take", n === 24 ? null : String(n)),
    reset: () => setSp(new URLSearchParams(), { replace: true }),
  };
}
