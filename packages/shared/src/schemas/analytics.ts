import { z } from "zod";

export const ANALYTICS_WINDOWS = ["30d", "90d", "12mo", "all"] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];
export const RECURRING_THRESHOLD = 3;

export const analyticsQuerySchema = z
  .object({
    window: z.enum(ANALYTICS_WINDOWS).default("12mo"),
    propertyId: z.string().uuid().optional(),
  })
  .strict();
export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;

export const unitMiniStatQuerySchema = z
  .object({ window: z.enum(ANALYTICS_WINDOWS).default("12mo") })
  .strict();
export type UnitMiniStatQueryInput = z.infer<typeof unitMiniStatQuerySchema>;

export interface CategoryCount {
  canonical: string;
  count: number;
  isMapped: boolean;
  recurring: boolean;
}
export interface UnitAnalyticsRow {
  unitId: string;
  unitCode: string;
  propertyId: string;
  propertyName: string;
  total: number;       // all-time excl. void
  open: number;        // current open + in_progress
  windowTotal: number; // excl. void within window
  byCategory: CategoryCount[];        // window-scoped, count desc
  recurringCategories: string[];      // canonicals with windowCount >= RECURRING_THRESHOLD
  topRecurringCategory: string | null;
}
export interface UnmappedInfo {
  count: number;       // window-scoped count of non-canonical tickets
}
export interface AnalyticsSummary {
  /** Mean time-to-resolve in days over all resolved tickets with resolvedAt set; null if none. Rounded to 1 decimal. */
  mttrDays: number | null;
  /** Age in days of the oldest open/in_progress ticket; null if none open. Rounded to 1 decimal. */
  oldestOpenDays: number | null;
  /** Count of open/in_progress tickets older than 30 days. */
  openOver30: number;
}
export interface UnitsAnalyticsResponse {
  rows: UnitAnalyticsRow[];
  unmapped: UnmappedInfo;
  summary: AnalyticsSummary;
}
export interface CategoryUnitCount {
  unitId: string;
  unitCode: string;
  propertyName: string;
  count: number;
  recurring: boolean;
}
export interface CategoryLensRow {
  canonical: string;
  total: number;
  units: CategoryUnitCount[]; // count desc
}
export interface TrendPoint {
  month: string;    // "YYYY-MM"
  created: number;  // tickets created in this month
  resolved: number; // tickets resolved (by resolvedAt) in this month
}
export interface UnitTicketRow {
  id: string;
  categoryCanonical: string;
  status: string;
  createdAt: string;           // ISO
  resolvedAt: string | null;   // ISO or null
  ageDays: number;             // whole days createdAt→(resolvedAt ?? now)
  title: string;
}
export interface UnitMiniStat {
  unitId: string;
  total: number;
  open: number;
  windowTotal: number;
  byCategory: CategoryCount[];
  recurringCategories: string[];
  tickets: UnitTicketRow[];
}
