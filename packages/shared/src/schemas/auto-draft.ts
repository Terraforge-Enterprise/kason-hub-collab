import { z } from "zod";
import {
  AUTO_BILL_DAY_MAX,
  AUTO_BILL_DAY_MIN,
  BILL_PERIOD_OFFSET_MAX,
  BILL_PERIOD_OFFSET_MIN,
  DEFAULT_BILLING_GAP_LOOKBACK_MONTHS,
} from "../utils/billing-schedule";

const ym = z.string().regex(/^\d{4}-\d{2}$/, "periodMonth must be YYYY-MM");
const uuid = z.string().uuid();
// run day capped at 28 so the gate fires every month (no 29/30/31 skips).
const runDay = z.number().int().min(1).max(28);
// The day drafts are BILLED (approved → live receivables). Nullable, and null is
// the default: an org that never sets it keeps the human approval gate. Bounds
// come from the shared util and are mirrored by a DB CHECK, so zod, Postgres and
// the UI cannot drift apart (the lock-step rule this repo keeps re-learning).
const autoBillDay = z.number().int().min(AUTO_BILL_DAY_MIN).max(AUTO_BILL_DAY_MAX).nullable();
const dueOffset = z.number().int().min(0).max(60).nullable();
// Months ahead of the run month to bill. Bounds come from the shared util (and are
// mirrored by a CHECK constraint) so zod, the DB, and the UI cannot drift apart.
const billPeriodOffset = z.number().int().min(BILL_PERIOD_OFFSET_MIN).max(BILL_PERIOD_OFFSET_MAX);
const toggles = {
  includeRent: z.boolean().optional(),
  includeElectricity: z.boolean().optional(),
  includeMgmtFee: z.boolean().optional(),
  includeCleaning: z.boolean().optional(),
};

export const draftConfigCreateSchema = z.object({
  runDayOfMonth: runDay.default(25),
  // Defaults to 1 (bill NEXT month) — KAEN's process out of the box.
  billPeriodOffset: billPeriodOffset.default(1),
  // Defaults to OFF. Creating a schedule must never, by itself, start posting
  // live receivables — turning auto-billing on is its own deliberate act.
  autoBillDayOfMonth: autoBillDay.default(null),
  dueDayOffset: dueOffset.optional(),
  ...toggles,
});

export const draftConfigPatchSchema = z.object({
  runDayOfMonth: runDay.optional(),
  billPeriodOffset: billPeriodOffset.optional(),
  autoBillDayOfMonth: autoBillDay.optional(),
  dueDayOffset: dueOffset.optional(),
  isActive: z.boolean().optional(),
  ...toggles,
  expectedUpdatedAt: z.string(), // ISO; optimistic concurrency
});

export const triggerRunSchema = z.object({ periodMonth: ym });
export const runListQuerySchema = z.object({
  periodMonth: ym.optional(),
  status: z.enum(["running", "completed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
/**
 * GET /draft-runs/gaps. The horizon is bounded on both ends: 0 would make the
 * check a silent no-op that always reports "no gaps", and an unbounded value
 * would walk an org's whole history every call.
 */
export const billingGapsQuerySchema = z.object({
  lookbackMonths: z.coerce
    .number()
    .int()
    .min(1)
    .max(24)
    .default(DEFAULT_BILLING_GAP_LOOKBACK_MONTHS),
});
export const invoiceQueueQuerySchema = z.object({
  status: z.enum(["draft", "approved", "sent", "paid", "void"]).default("draft"),
  periodMonth: ym.optional(),
  partyId: uuid.optional(),
  invoiceType: z.enum(["tenant_rental", "owner_statement", "tenant_aircon"]).optional(),
  // The approvals queue loads the whole period in one shot (it has no pagination)
  // and bulk-approves up to 200 at a time (approveBulkSchema.ids max 200) — so the
  // page cap MUST be >= 200. It previously defaulted lower and capped at 100, which
  // 400'd the queue's own `limit=200` request ("Failed to load invoices").
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export const editInvoiceDatesSchema = z.object({
  invoiceDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  expectedUpdatedAt: z.string(),
}).refine((v) => v.invoiceDate !== undefined || v.dueDate !== undefined, { message: "Nothing to update" });
export const attachChargeSchema = z.object({ chargeId: uuid });
export const voidInvoiceSchema = z.object({ reason: z.string().max(500).optional(), expectedUpdatedAt: z.string() });
export const approveBulkSchema = z.object({ ids: z.array(uuid).min(1).max(200) });
export const approveOneSchema = z.object({ expectedUpdatedAt: z.string() });
