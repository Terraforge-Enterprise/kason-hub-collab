import type { AdminRole } from "../../lib/rbac";

export type ServiceResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

// Resolved actor for every mutation — manual path = session; cron = per-org system admin.
export type AutoDraftActorCtx = { orgId: string; actorUserId: string; actorRole: AdminRole; ip?: string; userAgent?: string };

export type DraftConfigRow = {
  id: string; runDayOfMonth: number; billPeriodOffset: number; dueDayOffset: number | null;
  /** Day drafts are auto-BILLED; null = off (a human issues from the queue). */
  autoBillDayOfMonth: number | null;
  includeRent: boolean; includeElectricity: boolean; includeMgmtFee: boolean; includeCleaning: boolean;
  autoApprove: boolean; isActive: boolean; updatedAt: string;
};
export type DraftRunRow = {
  id: string; periodMonth: string; runDate: string; status: string;
  draftsCreated: number; draftsSkipped: number; errorText: string | null; triggeredBy: string | null; createdAt: string;
};
export type DraftChargeLine = {
  id: string; chargeNumber: string; chargeType: string; status: string; amount: number; description: string | null;
  /** ISO first-of-month; each line states its OWN period (attached charges can differ). */
  billingMonth: string | null;
};
export type DraftInvoiceRow = {
  id: string; invoiceNumber: string; invoiceType: string; status: string; partyName: string;
  tenancyCode: string | null; periodMonth: string | null; invoiceDate: string; dueDate: string | null;
  totalAmount: number; sstAmount: number | null; updatedAt: string;
  /** WHICH unit this row bills, e.g. "A-01-01". Null for owner-side / unresolvable. */
  unitCode: string | null;
  /** WHICH property that unit sits in. */
  propertyName: string | null;
};
export type DraftInvoiceDetail = DraftInvoiceRow & {
  charges: DraftChargeLine[];
  /** WHICH unit this draft bills, e.g. "A-01-01". Null for owner-side / unresolvable. */
  unitCode: string | null;
  /** WHICH property that unit sits in. */
  propertyName: string | null;
  /** "ROOM" | "WHOLE" — a room-level draft bills one room of the unit, not all of it. */
  listingType: string | null;
};
export type RunSummary = { runId: string; status: "completed" | "failed"; draftsCreated: number; draftsSkipped: number; errorText: string | null };
