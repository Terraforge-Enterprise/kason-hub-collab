// Which money a TENANT is allowed to see, and which of it they may pay against.
//
// ── The invariant this file encodes ────────────────────────────────────────────
// A `Charge` with status "draft" means NO DOCUMENT HAS BEEN ISSUED FOR IT YET.
// Both issuance paths flip draft → posted at the exact moment the document goes
// live:
//   • apps/api/src/modules/billing-documents/invoice-create.service.ts
//       (manual issue: charge → "posted", then issueDocumentTx)
//   • apps/api/src/modules/billing/auto-draft.service.ts
//       (approve a drafted rent invoice: postApprovedInvoiceChargesTx,
//        draft → posted, guarded + idempotent)
// So `status === "draft"` is precisely "the admin has not approved this yet".
// A tenant must therefore NEVER see a draft charge on ANY portal surface: not in
// a list, not by direct id, not in a statement, not folded into their balance,
// and not as something they can pay. Showing one bills the tenant for money no
// human has approved, and leaks an internal pre-approval figure.
//
// ── Why a Record and not an array ─────────────────────────────────────────────
// This rule has to hold at NINE independent read sites across five portal
// modules. Before this file each site invented its own filter and they all
// disagreed — `{ in: ["posted","partial"] }` here, `{ not: "void" }` there, no
// filter at all in the balance aggregate. A bare `string[]` allowlist would let
// that drift happen again silently: adding a status to CHARGE_STATUSES produces
// ZERO type errors against an array.
//
// `Record<LiveChargeStatus, boolean>` makes the compiler the enforcer — add a status
// to CHARGE_STATUSES and every map below fails to build until someone decides,
// explicitly, whether a tenant may see it and whether they may pay it.
//
// ── Why the query filter is `notIn` (deny-list) and not `in` (allow-list) ──────
// constants/statuses.ts warns, verbatim:
//   "Legacy pre-M3 rows may still carry 'partial' in old data — readers must
//    treat this list as the LIVE write-set, not an exhaustive historical set."
// An allow-list derived from the LIVE write-set would silently hide any
// legacy-status charge — real money the tenant genuinely owes would vanish from
// their portal. A deny-list fails in the safe direction: unknown/legacy statuses
// stay VISIBLE (a tenant over-seeing their own historical debt is a display
// nit), while "draft" and "void" are provably excluded.
//
// Payability inverts that risk, so it is an ALLOW-list: letting a tenant pay
// against a charge in an unrecognised state is a money mutation, not a display
// nit, and must fail closed.
import { CHARGE_STATUSES } from "../constants/statuses";
import type { DocumentStatus } from "../schemas/billing-documents";

/**
 * The LIVE charge-status write-set, derived from CHARGE_STATUSES.
 *
 * ⚠️ Deliberately NOT the `ChargeStatus` exported by ../types/billing.ts. That
 * older hand-written union reads
 *     "draft" | "posted" | "paid" | "partial" | "void"
 * which has drifted from what the API actually writes: it still carries the
 * legacy "partial" and is MISSING both "partially_paid" (the live value, written
 * by payments.charge-status.ts) and "credited" (written by the void→credit-note
 * flow). Binding the visibility maps below to that union would leave the two
 * statuses that matter most for a tenant's balance completely unclassified.
 *
 * Deriving from the constant instead is what makes the exhaustiveness check
 * load-bearing. Renaming/merging these two types is a separate, wider change —
 * ../types/billing.ts's union is imported elsewhere and is not touched here.
 */
export type LiveChargeStatus = (typeof CHARGE_STATUSES)[number];

/**
 * May a tenant SEE a charge in this status on a portal surface?
 *
 * Exhaustive by construction — a new entry in CHARGE_STATUSES breaks the build
 * here until its tenant visibility is decided.
 */
export const TENANT_CHARGE_VISIBILITY: Record<LiveChargeStatus, boolean> = {
  // NOT YET APPROVED. No document exists. The whole point of this module.
  draft: false,
  // Live receivable — a document has been issued for it.
  posted: true,
  // Live receivable, part-settled. Still owed, still theirs to see.
  partially_paid: true,
  // History. outstandingAmount is 0, so it contributes nothing to the balance,
  // but hiding it would erase the tenant's own payment record.
  paid: true,
  // Offset by a credit note the tenant HOLDS a copy of. Hiding the charge while
  // they hold the CN that references it would make their records unreconcilable.
  credited: true,
  // Cancelled. Never happened, as far as the tenant is concerned.
  void: false,
};

/**
 * May a tenant PAY against a charge in this status?
 *
 * Strictly narrower than visibility: a `paid`/`credited` charge is visible as
 * history but has nothing left to settle, and `draft`/`void` are not real
 * receivables at all.
 */
export const TENANT_CHARGE_PAYABILITY: Record<LiveChargeStatus, boolean> = {
  draft: false,
  posted: true,
  partially_paid: true,
  paid: false,
  credited: false,
  void: false,
};

/**
 * May a tenant SEE a BillingDocument in this lifecycle state?
 *
 * Mirrors the charge rule one level up: a DRAFT document is an un-issued
 * document. Nothing writes DRAFT today (BillingDocument.documentStatus defaults
 * to "ISSUED"), but the column and the vocabulary both permit it, so the portal
 * reads are filtered now rather than after something starts writing it.
 *
 * CANCELLED / SUPERSEDED stay visible: those documents were genuinely issued and
 * the tenant received them. Their replacement/credit note references them by
 * number, so hiding them would orphan that reference.
 */
export const TENANT_DOCUMENT_VISIBILITY: Record<DocumentStatus, boolean> = {
  DRAFT: false,
  ISSUED: true,
  CANCELLED: true,
  SUPERSEDED: true,
};

/**
 * Legacy Charge.status values that predate the current vocabulary, mapped to
 * their live equivalent.
 *
 * constants/statuses.ts documents exactly one: pre-M3 rows may carry "partial"
 * where the API now writes "partially_paid". Those are REAL, part-settled,
 * still-owed charges — they must stay payable, so they are normalised rather
 * than dropped by the payability allow-list.
 *
 * Only "partial" is a true ALIAS (same meaning, older spelling). See
 * LEGACY_PAYABLE_CHARGE_STATUSES for the wider set of non-vocabulary statuses
 * that remain payable.
 */
export const LEGACY_CHARGE_STATUS_ALIASES: Record<string, LiveChargeStatus> = {
  partial: "partially_paid",
};

/**
 * Statuses OUTSIDE the live vocabulary that a tenant may still pay against.
 *
 * These are enumerated one by one, deliberately, so the payability allow-list
 * keeps failing closed for anything genuinely new: an unrecognised status that
 * is not on this list is NOT payable.
 *
 *  • "partial" — documented in constants/statuses.ts as the pre-M3 spelling of
 *    "partially_paid". Real, part-settled, still-owed money.
 *  • "overdue" / "pending" — no code path in this repo writes either (verified
 *    by grep across apps/ and packages/), but both are pinned as payable by
 *    portal/payments/__tests__/portal.payments.pay.integration.test.ts, which
 *    seeds them explicitly and asserts listPayableCharges returns them. Both
 *    denote an OPEN receivable, so keeping them payable is also the correct
 *    reading — dropping them would turn a payable charge unpayable in any
 *    environment whose data does contain them.
 *
 * None of these is "draft" or "void", so the security property this module
 * exists for is untouched.
 */
export const LEGACY_PAYABLE_CHARGE_STATUSES: string[] = ["overdue", "partial", "pending"];

/** Live status for a raw DB value, resolving documented legacy aliases. */
export function normalizeChargeStatus(status: string): string {
  return LEGACY_CHARGE_STATUS_ALIASES[status] ?? status;
}

function hiddenFrom<T extends string>(map: Record<T, boolean>): T[] {
  return (Object.keys(map) as T[]).filter((k) => !map[k]).sort();
}

/**
 * Charge statuses a tenant may never see — for `where: { status: { notIn: … } }`.
 * Deny-list on purpose (see the header): legacy/unknown statuses stay visible.
 */
export const TENANT_HIDDEN_CHARGE_STATUSES: LiveChargeStatus[] = hiddenFrom(TENANT_CHARGE_VISIBILITY);

/**
 * BillingDocument lifecycle states a tenant may never see — for
 * `where: { documentStatus: { notIn: … } }`.
 */
export const TENANT_HIDDEN_DOCUMENT_STATUSES: DocumentStatus[] = hiddenFrom(TENANT_DOCUMENT_VISIBILITY);

/**
 * The Prisma `where` fragment every tenant-facing Charge read must spread.
 *
 * Returned fresh each call — a shared object literal could be mutated by one
 * caller and corrupt the filter for every other read site.
 */
export function tenantVisibleChargeWhere(): { status: { notIn: LiveChargeStatus[] } } {
  return { status: { notIn: [...TENANT_HIDDEN_CHARGE_STATUSES] } };
}

/**
 * The Prisma `where` fragment every tenant-facing BillingDocument read must spread.
 */
export function tenantVisibleDocumentWhere(): { documentStatus: { notIn: DocumentStatus[] } } {
  return { documentStatus: { notIn: [...TENANT_HIDDEN_DOCUMENT_STATUSES] } };
}

/**
 * Runtime guard for a status string read back from the DB (which may hold a
 * legacy value outside CHARGE_STATUSES). Deny-list semantics, matching
 * tenantVisibleChargeWhere: unknown → visible.
 */
export function isTenantVisibleChargeStatus(status: string): boolean {
  return !(TENANT_HIDDEN_CHARGE_STATUSES as string[]).includes(normalizeChargeStatus(status));
}

/**
 * Charge statuses a tenant MAY pay against — for `where: { status: { in: … } }`.
 *
 * Allow-list (payability fails closed), but it carries the documented legacy
 * aliases too, so a pre-M3 "partial" row is still listed as payable instead of
 * quietly becoming unsettleable.
 */
export const TENANT_PAYABLE_CHARGE_STATUSES: string[] = [
  ...(Object.keys(TENANT_CHARGE_PAYABILITY) as LiveChargeStatus[]).filter(
    (s) => TENANT_CHARGE_PAYABILITY[s],
  ),
  ...LEGACY_PAYABLE_CHARGE_STATUSES,
].sort();

/**
 * Runtime guard for the payment paths. ALLOW-list semantics — an unrecognised
 * status is NOT payable, so a legacy/unknown state can never be settled through
 * the portal by accident.
 */
export function isTenantPayableChargeStatus(status: string): boolean {
  if (LEGACY_PAYABLE_CHARGE_STATUSES.includes(status)) return true;
  const live = normalizeChargeStatus(status);
  return Object.prototype.hasOwnProperty.call(TENANT_CHARGE_PAYABILITY, live)
    ? TENANT_CHARGE_PAYABILITY[live as LiveChargeStatus]
    : false;
}
