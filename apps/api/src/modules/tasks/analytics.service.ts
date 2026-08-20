import { normalizeCategoryAgainst, RECURRING_THRESHOLD } from "@kason/shared";
import type {
  AnalyticsQueryInput,
  UnitMiniStatQueryInput,
  AnalyticsWindow,
  UnitsAnalyticsResponse,
  UnitAnalyticsRow,
  CategoryCount,
  CategoryLensRow,
  TrendPoint,
  UnitMiniStat,
  UnitTicketRow,
  AnalyticsSummary,
} from "@kason/shared";
import {
  fetchOrgTicketsForAnalytics,
  fetchUnitTicketsForAnalytics,
  fetchWorkCategoryNames,
  type AnalyticsTicketRow,
} from "./analytics.repository";

type Ok<T> = { ok: true; status: 200; data: T };
type Err = { ok: false; status: number; error: string };
type Result<T> = Ok<T> | Err;
const ok = <T>(data: T): Ok<T> => ({ ok: true, status: 200, data });

const OPEN_STATUSES = new Set(["open", "in_progress"]);
const DAY = 86_400_000;

export function windowStartFrom(window: AnalyticsWindow, now: Date): Date | null {
  switch (window) {
    case "all":
      return null;
    case "30d":
      return new Date(now.getTime() - 30 * DAY);
    case "90d":
      return new Date(now.getTime() - 90 * DAY);
    case "12mo": {
      // Use UTC month arithmetic to match bucketMonth (which uses getUTCFullYear/getUTCMonth),
      // avoiding an ~8h skew at UTC+8 when local-time setMonth/getMonth differs from UTC.
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - 12);
      return d;
    }
  }
}

export function bucketMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const inWindow = (t: AnalyticsTicketRow, start: Date | null) =>
  start === null || t.createdAt >= start;

function categoryCounts(windowTickets: AnalyticsTicketRow[], names: readonly string[]): {
  byCategory: CategoryCount[];
  recurring: string[];
  unmapped: number;
} {
  const map = new Map<string, { count: number; isMapped: boolean }>();
  let unmapped = 0;
  for (const t of windowTickets) {
    const { canonical, isMapped } = normalizeCategoryAgainst(t.category, names);
    if (!isMapped) unmapped += 1;
    const cur = map.get(canonical) ?? { count: 0, isMapped };
    cur.count += 1;
    cur.isMapped = isMapped || cur.isMapped;
    map.set(canonical, cur);
  }
  const byCategory: CategoryCount[] = [...map.entries()]
    .map(([canonical, v]) => ({
      canonical,
      count: v.count,
      isMapped: v.isMapped,
      recurring: v.count >= RECURRING_THRESHOLD,
    }))
    .sort((a, b) => b.count - a.count);
  const recurring = byCategory.filter((c) => c.recurring).map((c) => c.canonical);
  return { byCategory, recurring, unmapped };
}

function computeSummary(tickets: AnalyticsTicketRow[], now: Date): AnalyticsSummary {
  const openStatuses = OPEN_STATUSES;
  const nowMs = now.getTime();

  // MTTR: mean of (resolvedAt - createdAt) in days over resolved tickets with resolvedAt set
  const resolvedWithDate = tickets.filter(
    (t) => t.status === "resolved" && t.resolvedAt !== null,
  );
  let mttrDays: number | null = null;
  if (resolvedWithDate.length > 0) {
    const totalMs = resolvedWithDate.reduce((sum, t) => {
      return sum + (t.resolvedAt!.getTime() - t.createdAt.getTime());
    }, 0);
    mttrDays = Math.round((totalMs / resolvedWithDate.length / DAY) * 10) / 10;
  }

  // Open tickets — all open/in_progress regardless of window
  const openTickets = tickets.filter((t) => openStatuses.has(t.status));

  // oldestOpenDays: max age in days of open/in_progress tickets
  let oldestOpenDays: number | null = null;
  if (openTickets.length > 0) {
    const maxAgeMs = Math.max(...openTickets.map((t) => nowMs - t.createdAt.getTime()));
    oldestOpenDays = Math.round((maxAgeMs / DAY) * 10) / 10;
  }

  // openOver30: count of open/in_progress tickets older than 30 days
  const openOver30 = openTickets.filter((t) => nowMs - t.createdAt.getTime() > 30 * DAY).length;

  return { mttrDays, oldestOpenDays, openOver30 };
}

export async function getUnitsAnalytics(
  orgId: string,
  input: AnalyticsQueryInput,
  now: Date = new Date(),
): Promise<Result<UnitsAnalyticsResponse>> {
  const [tickets, names] = await Promise.all([fetchOrgTicketsForAnalytics(orgId, input.propertyId), fetchWorkCategoryNames(orgId)]);
  const start = windowStartFrom(input.window, now);
  const byUnit = new Map<string, AnalyticsTicketRow[]>();
  for (const t of tickets) {
    const arr = byUnit.get(t.unitId) ?? [];
    arr.push(t);
    byUnit.set(t.unitId, arr);
  }

  let unmappedTotal = 0;
  const rows: UnitAnalyticsRow[] = [...byUnit.entries()].map(([unitId, all]) => {
    const head = all[0]!;
    const windowTickets = all.filter((t) => inWindow(t, start));
    const { byCategory, recurring, unmapped } = categoryCounts(windowTickets, names);
    unmappedTotal += unmapped;
    return {
      unitId,
      unitCode: head.unitCode,
      propertyId: head.propertyId,
      propertyName: head.propertyName,
      total: all.length,
      open: all.filter((t) => OPEN_STATUSES.has(t.status)).length,
      windowTotal: windowTickets.length,
      byCategory,
      recurringCategories: recurring,
      topRecurringCategory: byCategory.find((c) => c.recurring)?.canonical ?? null,
    };
  });
  rows.sort(
    (a, b) =>
      b.open - a.open || b.total - a.total || a.unitCode.localeCompare(b.unitCode),
  );
  const summary = computeSummary(tickets, now);
  return ok({ rows, unmapped: { count: unmappedTotal }, summary });
}

export async function getCategoryLens(
  orgId: string,
  input: AnalyticsQueryInput,
  now: Date = new Date(),
): Promise<Result<CategoryLensRow[]>> {
  const [tickets, names] = await Promise.all([fetchOrgTicketsForAnalytics(orgId, input.propertyId), fetchWorkCategoryNames(orgId)]);
  const start = windowStartFrom(input.window, now);
  const win = tickets.filter((t) => inWindow(t, start));
  // canonical -> unitId -> {unitCode, propertyName, count}
  const cats = new Map<
    string,
    Map<string, { unitCode: string; propertyName: string; count: number }>
  >();
  for (const t of win) {
    const { canonical } = normalizeCategoryAgainst(t.category, names);
    const units = cats.get(canonical) ?? new Map();
    const cur = units.get(t.unitId) ?? {
      unitCode: t.unitCode,
      propertyName: t.propertyName,
      count: 0,
    };
    cur.count += 1;
    units.set(t.unitId, cur);
    cats.set(canonical, units);
  }
  const data: CategoryLensRow[] = [...cats.entries()]
    .map(([canonical, units]) => {
      const unitRows = [...units.entries()]
        .map(([unitId, v]) => ({
          unitId,
          unitCode: v.unitCode,
          propertyName: v.propertyName,
          count: v.count,
          recurring: v.count >= RECURRING_THRESHOLD,
        }))
        .sort((a, b) => b.count - a.count || a.unitCode.localeCompare(b.unitCode));
      return {
        canonical,
        total: unitRows.reduce((s, u) => s + u.count, 0),
        units: unitRows,
      };
    })
    .sort((a, b) => b.total - a.total);
  return ok(data);
}

export async function getTrend(
  orgId: string,
  input: AnalyticsQueryInput,
  now: Date = new Date(),
): Promise<Result<TrendPoint[]>> {
  // Always use full history — ignore the window filter for the trend
  const tickets = await fetchOrgTicketsForAnalytics(orgId, input.propertyId);
  if (tickets.length === 0) return ok([]);

  // Build created and resolved bucket maps
  const createdMap = new Map<string, number>();
  const resolvedMap = new Map<string, number>();

  for (const t of tickets) {
    const ck = bucketMonth(t.createdAt);
    createdMap.set(ck, (createdMap.get(ck) ?? 0) + 1);
    if (t.resolvedAt !== null) {
      const rk = bucketMonth(t.resolvedAt);
      resolvedMap.set(rk, (resolvedMap.get(rk) ?? 0) + 1);
    }
  }

  // Determine the full continuous month span: earliest ticket month → current month
  const earliestMonth = bucketMonth(tickets[0]!.createdAt); // repo returns orderBy createdAt asc
  const currentMonth = bucketMonth(now);

  // Enumerate all months in [earliestMonth, currentMonth] inclusive
  const months: string[] = [];
  let cursor = earliestMonth;
  while (cursor <= currentMonth) {
    months.push(cursor);
    // Advance by one month (UTC-safe)
    const [y, m] = cursor.split("-").map(Number) as [number, number];
    const next = m === 12
      ? `${y + 1}-01`
      : `${y}-${String(m + 1).padStart(2, "0")}`;
    cursor = next;
  }

  const data: TrendPoint[] = months.map((month) => ({
    month,
    created: createdMap.get(month) ?? 0,
    resolved: resolvedMap.get(month) ?? 0,
  }));

  return ok(data);
}

export async function getUnitMiniStat(
  orgId: string,
  unitId: string,
  input: UnitMiniStatQueryInput,
  now: Date = new Date(),
): Promise<Result<UnitMiniStat>> {
  const [all, names] = await Promise.all([fetchUnitTicketsForAnalytics(orgId, unitId), fetchWorkCategoryNames(orgId)]);
  const start = windowStartFrom(input.window, now);
  // repo already excludes void; filter here as a safety net so byCategory and tickets always agree
  const windowTickets = all.filter((t) => inWindow(t, start) && t.status !== "void");
  const { byCategory, recurring } = categoryCounts(windowTickets, names);

  const nowMs = now.getTime();
  const tickets: UnitTicketRow[] = windowTickets
    .map((t) => {
      const { canonical } = normalizeCategoryAgainst(t.category, names);
      const endMs = t.resolvedAt !== null ? t.resolvedAt.getTime() : nowMs;
      const ageDays = Math.floor((endMs - t.createdAt.getTime()) / DAY);
      return {
        id: t.id,
        title: t.title,
        categoryCanonical: canonical,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        resolvedAt: t.resolvedAt !== null ? t.resolvedAt.toISOString() : null,
        ageDays,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // most-recent first (ISO strings sort lexically)

  return ok({
    unitId,
    total: all.length,
    open: all.filter((t) => OPEN_STATUSES.has(t.status)).length,
    windowTotal: windowTickets.length,
    byCategory,
    recurringCategories: recurring,
    tickets,
  });
}
