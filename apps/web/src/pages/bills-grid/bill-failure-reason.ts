import type { BillRowResult } from "@/api/bills-grid";

const money = (n: number) => `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Human-readable reason for a non-success Bill outcome, surfaced per-unit in the Bill
 * toast so an admin sees WHY a row "needs attention" instead of a bare count. Keyed on
 * the row's `outcome` plus the stable `code` the server forwards for compute/issuance
 * failures (e.g. `save_failed` + `OWNER_UNRESOLVED` → "no owner assigned to this unit").
 *
 * NOTE on AIRCON_EXCEEDS_TNB: it only reaches here for a WHOLE unit. PARTITIONED units
 * bill private per-room aircond whose Σ MAY exceed the master TNB bill (excess = owner
 * profit) and are exempt from the guard (see meter/compute.ts `privateAircond`), so the
 * copy names the whole-unit cause plainly instead of a bare "check the readings".
 *
 * Lives in its own module (not bills-grid-page.tsx) so the page file stays
 * component-only and keeps Vite Fast Refresh working (react-refresh/only-export-components).
 */
export function billFailureReason(r: BillRowResult): string {
  switch (r.outcome) {
    case "stale": return "changed since you loaded it — refresh and retry";
    case "no_entry": return "nothing saved yet — save the row first";
    case "already_billed": return "already billed";
    case "already_invoiced": return "already invoiced by another billing run";
    case "conflicting_invoice": return "a conflicting invoice from another billing run exists — resolve it first";
    case "rebill_blocked_previous_period": return "re-Billing is not allowed for a previous billing period — use the accounting correction process instead";
    case "rebill_blocked_payment_exists": {
      const blockers = r.paidBlockers ?? [];
      if (blockers.length === 0) {
        return "cannot re-Bill — a payment has already been recorded; issue a Credit/Debit Note on the invoice instead";
      }
      const parts = blockers.map((b) => {
        const who = b.counterparty === "owner" ? "owner" : "tenant";
        const inv = b.invoiceNumber ?? "(unnumbered)";
        const state = b.paymentState === "paid"
          ? `is PAID IN FULL (${money(b.paidAmount)})`
          : `is PARTIALLY PAID (${money(b.paidAmount)} of ${money(b.invoiceTotal)})`;
        return `${who} invoice ${inv} ${state}`;
      });
      return `can't re-Bill — ${parts.join(" · ")}. A paid invoice can't be re-Billed — issue a Credit/Debit Note on it instead`;
    }
    case "rebill_confirmation_required": return "already invoiced — confirm to void and reissue";
    case "blocked_future_period": return "this period is too far ahead — only the current or next month can be billed";
    case "paid_locked": return "locked — an invoice for it is already paid";
    case "occupancy_changed": return "the tenant/owner changed since invoicing — handle the handover first";
    case "pax_blocked": return "set the number of tenants (pax) on the room first";
    case "recurring_unresolved": return "a recurring charge couldn't resolve its owner/tenant — fix the recurring setup, then re-Bill";
    case "nature_unresolved": return "a recurring charge is missing its Expense/Profit type — re-save the recurring definition with a type, then re-Bill";
    case "compute_error":
      return r.code === "AIRCON_EXCEEDS_TNB" ? "this is a whole unit — its aircon is part of the TNB bill and can't be higher than the TNB total; lower the aircon reading or raise the TNB total"
        : r.code === "TNB_UNDERSHOOT" ? "the TNB total is just below the aircon total — raise the TNB total to at least the aircon amount, or lower the reading"
        : "utility amounts don't add up — check the readings";
    case "save_failed":
      return r.code === "OWNER_UNRESOLVED" ? "assign an owner to this unit — it has owner-borne charges to bill"
        : r.code === "CATEGORY_UNRESOLVED" ? "billing categories aren't set up — contact support"
        : r.code === "ABSORBED_REQUIRES_OWNER_BORNE" ? "enter an amount for the absorbed utility"
        : r.code === "EXPENSE_TENANT_UNRESOLVED" ? "a tenant expense isn't linked to a tenant — set the tenant on the expense, then re-Bill"
        : "couldn't issue the invoice — try again or contact support";
    default: return "needs attention";
  }
}

/** Human message for a raw per-unit Save/reading error code. handleSave reports each
 * unit's OWN failure (Promise.allSettled) instead of one blanket "Save failed", so a
 * rejected row is never mistaken for a save — and never hides behind a bare code. */
export function saveFailureReason(raw: string): string {
  switch (raw) {
    case "APARTMENT_NOT_FOUND": return "unit not found — refresh the grid (it may have changed since you loaded it)";
    // The server condition changed (2026-08-17): expense + bearer-config writes lock on REAL
    // payment, not on `billedAt`, so a billed-but-unpaid month is amendable and this message
    // must no longer claim "already billed" is the reason.
    case "ENTRY_LOCKED": return "money has already been received for this month — use the accounting adjustment process to change it";
    case "STALE": return "changed since you loaded it — refresh and retry";
    case "recurring_charge_locked": return "this amount is managed in Unit Settings — change it there";
    case "WHOLE_UNIT_MULTI_READING": return "a whole unit can only carry one room's reading";
    case "LISTING_NOT_FOUND": return "a room in this unit no longer exists — refresh the grid";
    case "TENANCY_NOT_FOUND": return "a tenant link couldn't be resolved — refresh the grid";
    case "BEARER_LOCKED": return "the billing setup is locked for this month";
    default: return raw; // never hide the raw code behind a vague message
  }
}
