import { z } from "zod";

const uuid = z.string().uuid();
// Money strings: validated as non-empty numeric; coerced to Number in the service.
const money = z.string().min(1).regex(/^\d+(\.\d{1,2})?$/, "Must be a number with up to 2 decimals");
const moneyOptional = money.optional();
// period: YYYY-MM-01 (first-of-month). The service normalises to UTC midnight.
const periodMonth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD (first of month)");

// ── ElectricityMeter config ─────────────────────────────────────────────────
export const createMeterSchema = z.object({
  unitId: uuid,
  meterNumber: z.string().max(64).optional(),
  ratePerKwh: z.string().regex(/^\d+(\.\d{1,4})?$/, "Up to 4 decimals").optional(),
});
export type CreateMeterInput = z.infer<typeof createMeterSchema>;

export const updateMeterSchema = z.object({
  meterNumber: z.string().max(64).nullable().optional(),
  ratePerKwh: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type UpdateMeterInput = z.infer<typeof updateMeterSchema>;

export const meterListQuerySchema = z.object({
  propertyId: uuid.optional(),
  unitId: uuid.optional(),
  isActive: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type MeterListQuery = z.infer<typeof meterListQuerySchema>;

// ── MeterReading (aircon) ───────────────────────────────────────────────────
export const createReadingSchema = z.object({
  unitId: uuid,
  periodMonth,
  previousReading: moneyOptional, // admin-supplied opening read / override; omit → auto-chain
  currentReading: money,
  ratePerKwh: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(), // override snapshot
  imageKey: z.string().max(512).optional(),
});
export type CreateReadingInput = z.infer<typeof createReadingSchema>;

export const updateReadingSchema = z.object({
  previousReading: moneyOptional,
  currentReading: money.optional(),
  ratePerKwh: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  imageKey: z.string().max(512).nullable().optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type UpdateReadingInput = z.infer<typeof updateReadingSchema>;

export const readingListQuerySchema = z.object({
  periodMonth: periodMonth.optional(),
  unitId: uuid.optional(),
  status: z.enum(["submitted", "charged", "void", "all"]).default("all"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ReadingListQuery = z.infer<typeof readingListQuerySchema>;

// ── UnitUtilityBill ─────────────────────────────────────────────────────────
// Who bears each non-electricity utility: "owner" (default — out of the tenant
// pool) or "tenant" (pooled per-pax). TNB + AirSelangor are always tenant.
const utilityBearer = z.enum(["owner", "tenant"]).optional();
export const createUtilityBillSchema = z.object({
  apartmentId: uuid,
  periodMonth,
  tnbTotal: money,
  airSelangor: moneyOptional,
  indahWater: moneyOptional,
  cleaning: moneyOptional,
  wifi: moneyOptional,
  indahWaterBearer: utilityBearer,
  cleaningBearer: utilityBearer,
  wifiBearer: utilityBearer,
  notes: z.string().max(2000).optional(),
});
export type CreateUtilityBillInput = z.infer<typeof createUtilityBillSchema>;

export const updateUtilityBillSchema = z.object({
  tnbTotal: money.optional(),
  airSelangor: moneyOptional,
  indahWater: moneyOptional,
  cleaning: moneyOptional,
  wifi: moneyOptional,
  indahWaterBearer: utilityBearer,
  cleaningBearer: utilityBearer,
  wifiBearer: utilityBearer,
  notes: z.string().max(2000).nullable().optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type UpdateUtilityBillInput = z.infer<typeof updateUtilityBillSchema>;

export const utilityBillListQuerySchema = z.object({
  propertyId: uuid.optional(),
  apartmentId: uuid.optional(),
  periodMonth: periodMonth.optional(),
  status: z.enum(["draft", "charged", "void", "all"]).default("all"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type UtilityBillListQuery = z.infer<typeof utilityBillListQuerySchema>;

// charge step accepts an optional dueDate override; default = end of periodMonth.
export const chargeUtilityBillSchema = z.object({
  dueDate: periodMonth.optional(),
  expectedUpdatedAt: z.string().optional(),
});
export type ChargeUtilityBillInput = z.infer<typeof chargeUtilityBillSchema>;

// ── Month cockpit (portfolio-wide per-period billing progress, §4.1/§4.6) ────
// Read-only aggregation over the session org for one period. The query mirrors
// billingGridQuerySchema's optional first-of-month `period`; the service
// defaults to the current month (UTC first-of-month) when omitted.
export const cockpitQuerySchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
export type CockpitQuery = z.infer<typeof cockpitQuerySchema>;

/** One unread occupied room surfaced in the reconciliation worklist (§4.6). */
export type CockpitOccupiedUnread = { unitId: string; unitCode: string | null; apartmentId: string };
/** One anomalous vacant-room-with-a-reading surfaced in the worklist (§4.6). */
export type CockpitVacantWithReading = { unitId: string; unitCode: string | null };

/**
 * `GET /api/meter/cockpit?period=YYYY-MM-DD` — billing-cycle progress + the
 * occupancy⋈billing reconciliation worklist for the session org + period.
 * Counts are status-filter independent (they describe the portfolio for the
 * period, not any UI filter result).
 *
 * - `readings.total`  = occupied rooms (an active Tenancy) in the org.
 * - `readings.done`   = those rooms with a non-void MeterReading for the period.
 * - `bills.total`     = apartments that have >=1 occupied room (the billable set).
 * - `bills.drafted`   = apartments with a UnitUtilityBill (ANY status) for the period.
 * - `charged.total`   = same billable-apartment denominator as `bills.total`.
 * - `charged.done`    = apartments whose period UnitUtilityBill is status "charged".
 * - `worklist.occupiedUnread`      = occupied rooms with NO reading this period (the
 *                                    items to fix), capped at WORKLIST_CAP; the full
 *                                    tally is `occupiedUnreadCount`.
 * - `worklist.vacantWithReading`   = non-occupied rooms WITH a (non-void) reading this
 *                                    period (an anomaly), capped at WORKLIST_CAP; full
 *                                    tally is `vacantWithReadingCount`.
 */
export type CockpitResponse = {
  period: string; // YYYY-MM-DD (UTC first-of-month)
  readings: { done: number; total: number };
  bills: { drafted: number; total: number };
  charged: { done: number; total: number };
  worklist: {
    occupiedUnread: CockpitOccupiedUnread[];
    occupiedUnreadCount: number;
    vacantWithReading: CockpitVacantWithReading[];
    vacantWithReadingCount: number;
  };
};

/** Max items returned per worklist array; the full count rides alongside. */
export const COCKPIT_WORKLIST_CAP = 200;

// ── Billing Grid (per-apartment billing view) ───────────────────────────────
export const billingGridQuerySchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export type BillingGridRoom = {
  unitId: string; unitCode: string | null; listingType: string | null;
  occupied: boolean; tenantName: string | null; tenancyId: string | null; pax: number | null;
  meter: { id: string; ratePerKwh: string; meterNumber: string | null } | null;
  previousReading: string | null;
  currentReading: { id: string; previousReading: string; currentReading: string; consumption: string; computedAmount: string; status: "submitted" | "charged" } | null;
};
export type BillingGridResponse = {
  // listingMode drives the bill-create bearer default in the workspace: a WHOLE
  // unit's tenant bears ALL utilities, so indah/cleaning/wifi default to "tenant"
  // (PARTITIONED → "owner"). Mirrors the server default in createUtilityBillService.
  // ownerPartyId (Task 9 D1): the apartment's owner, or null when unassigned — gates
  // the bill workspace's Generate-statement action (nothing to bill without an owner).
  apartment: { id: string; unitCode: string | null; propertyName: string | null; listingMode: "WHOLE" | "PARTITIONED"; ownerPartyId: string | null };
  period: string; // YYYY-MM-01
  rooms: BillingGridRoom[];
  bill: { id: string; status: "draft" | "charged" | "void" } | null;
};

// ── Tenancy pax (billing headcount) ─────────────────────────────────────────
// Body for `PATCH /api/meter/tenancies/:tenancyId/pax`. Sets Tenancy.numberOfPax
// — the per-pax split denominator the utility-bill preview/charge reads. The M9
// import is the only OTHER writer; this is the inline UI affordance the bill
// workspace uses so a paxless tenant (numberOfPax = null) can be made billable
// without leaving the grid. NOT the same as the Utilities-settings subsidyPerPax
// (the subsidy RATE) — this is the HEADCOUNT. Capped at 50 (a defensive upper
// bound; a single room never houses anywhere near that many).
export const setTenancyPaxSchema = z.object({
  numberOfPax: z.number().int().min(1).max(50),
});
export type SetTenancyPaxInput = z.infer<typeof setTenancyPaxSchema>;

// ── Bill attachments (tenant-tracker draft bills; mirror to owner ledger on post) ──
export const billAttachmentRowSchema = z.object({
  id: uuid,
  filename: z.string().min(1),
  url: z.string().min(1), // signed inline view URL
  createdAt: z.string(),
});
export type BillAttachmentRow = z.infer<typeof billAttachmentRowSchema>;

export const listBillAttachmentsResponseSchema = z.object({
  data: z.array(billAttachmentRowSchema),
});
export type ListBillAttachmentsResponse = z.infer<typeof listBillAttachmentsResponseSchema>;
