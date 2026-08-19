// Shared pure presentation helpers for the Owner-Ledger view (owner-ledger view
// clarity, Task 3). Consumed by the admin owner/unit workspaces and the portal
// ledger page — kept dependency-free (no React, no API types) so both sides can
// import it without pulling in admin-only or portal-only modules.

type Tone = "sky" | "slate" | "emerald" | "amber" | "rose";

// `status` is optional: the portal DTO omits it (portal rows are always
// status:"active", filtered server-side), so `e.status === "void"` is
// correctly false there. Admin rows carry it.
interface StatusRow {
  direction: string;
  paymentStatus: string;
  includeInPayout: boolean;
  status?: string;
}

// Covers all 6 real OwnerPaymentStatus values (packages/shared/src/schemas/owner-ledger.ts
// OWNER_PAYMENT_STATUSES). Every tone below is aligned to EXACTLY what
// getStatusTone() (apps/web/src/components/format.ts) already returns for that
// same string today, so switching a page from getStatusTone(paymentStatus) to
// this map is a no-op for color: "pending" sits in getStatusTone's amber
// category list; "cancelled" is NOT in any of its category lists (its rose
// list has "terminated"/"void"/"voided"/"credited"/"refunded"/"blacklisted"/
// "failed"/"archived"/"rejected" — no "cancelled") so it falls through to
// getStatusTone's own slate default, same as reimbursed/waived.
const INCOME_TONE: Record<string, Tone> = {
  paid: "emerald",
  partial: "amber",
  pending: "amber",
  cancelled: "slate",
  reimbursed: "slate",
  waived: "slate",
};
const INCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  partial: "Partial",
  pending: "Pending",
  cancelled: "Cancelled",
  reimbursed: "Reimbursed",
  waived: "Waived",
};

export function ownerLedgerRowStatus(e: StatusRow): { label: string; tone: Tone } {
  if (e.status === "void") return { label: "Void", tone: "slate" };
  if (e.direction === "income") {
    return { label: INCOME_LABEL[e.paymentStatus] ?? "Pending", tone: INCOME_TONE[e.paymentStatus] ?? "slate" };
  }
  return e.includeInPayout ? { label: "Deducted", tone: "sky" } : { label: "Owner-paid", tone: "amber" };
}

export function groupByDirection<T extends { direction: string }>(entries: T[]): { income: T[]; expenses: T[] } {
  return {
    income: entries.filter((e) => e.direction === "income"),
    expenses: entries.filter((e) => e.direction === "expense"),
  };
}
