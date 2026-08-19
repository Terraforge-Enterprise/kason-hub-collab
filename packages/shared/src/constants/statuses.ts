// "pending" added 2026-05-12 for agent-sourced properties awaiting admin
// approval. Admin can flip it to active via the source queue or the
// property edit dialog.
export const PROPERTY_STATUSES = ["active", "inactive", "pending"] as const;
export const PUBLISH_STATUSES = ["draft", "published", "archived"] as const;
export const UNIT_OCCUPANCY_STATUSES = ["vacant", "occupied", "reserved", "maintenance"] as const;
export const UNIT_LISTING_STATUSES = ["draft", "listed", "unlisted"] as const;
export const TENANCY_STATUSES = ["draft", "active", "ended", "terminated", "renewed"] as const;
// Reconciled 2026-07-02 (accounting-docs P1, spec §4.1): live code writes
// "partially_paid" (apps/api/src/modules/payments/payments.charge-status.ts),
// and the void→Credit-Note flow (Plan 3) adds "credited". Legacy pre-M3 rows
// may still carry "partial" in old data — readers must treat this list as the
// LIVE write-set, not an exhaustive historical set.
export const CHARGE_STATUSES = ["draft", "posted", "partially_paid", "paid", "credited", "void"] as const;
// Reconciled 2026-08-11 against every `payment.create`/`payment.update` in
// apps/api — this array had drifted badly, naming two statuses the code never
// writes and omitting all four it does:
//   pending_approval  portal/payments/portal.payments.repository.ts (FPX initiate)
//   posted            payments/payments.repository.ts (settle)
//   expired           portal.payments.repository.ts + payments.repository.ts (sweep)
//   failed            payments/fpx-callback.repository.ts (gateway failure)
//   void | refunded   payments/payments.repository.ts (reversal)
//   rejected          payments/payments.repository.ts (admin refused a tenant's
//                     transfer slip — see rejectPaymentTx). Distinct from
//                     "void": void reverses money the org ACCEPTED, whereas
//                     "rejected" means it was never accepted in the first
//                     place, so the tenant is told why and may re-submit.
//   needs_reconciliation
//                     payments/fpx-callback.repository.ts (holdForReconciliationTx).
//                     A SIGNED gateway success arrived for a payment a HUMAN had
//                     already cancelled, or one the gateway itself had already
//                     failed. The bank says money moved; local state says a
//                     person refused it. Auto-settling would override the human,
//                     so the row parks here for an admin to resolve. It is NOT
//                     cash (nothing has been applied to any charge) and NOT
//                     terminal — it is a queue.
// ⚠️ "recorded" and "allocated" were listed here historically and are written
// NOWHERE in the current codebase. Legacy rows may still carry them, so readers
// must treat this as the LIVE write-set, not an exhaustive historical set — the
// same caveat CHARGE_STATUSES carries above. Cash-meaning readers go through
// billing/cash-allocation.ts, whose IS_CASH_PAYMENT_STATUS map is this array's
// only consumer and turns any addition here into a build failure.
export const PAYMENT_STATUSES = ["pending_approval", "posted", "expired", "failed", "void", "refunded", "rejected", "needs_reconciliation"] as const;
export const NOTIFICATION_QUEUE_STATUSES = ["pending", "sent", "failed"] as const;
export const COMMISSION_CLAIM_STATUSES = ["draft", "submitted", "approved", "rejected", "paid"] as const;

// Who bears the 8% SST on KAEN's letting commission. DB-ENFORCED by CHECK
// "Tenancy_commissionSstBearer_check" (migration 20260727140000).
//
// NOT the same vocabulary as the bills-grid `bearer` (owner|tenant) despite the
// shared "Bearer" suffix — this one is owner|KAEN, because the tenant never bears
// KAEN's own commission SST. Constraining it to owner|tenant would break the
// letting-commission feature. Consolidated here from three inline z.enum copies
// (schemas/tenancy.ts x2, schemas/inventory.ts x1) so the CHECK has a single
// source of truth to bind against.
export const COMMISSION_SST_BEARER = ["owner", "kaen"] as const;
export type CommissionSstBearer = (typeof COMMISSION_SST_BEARER)[number];
