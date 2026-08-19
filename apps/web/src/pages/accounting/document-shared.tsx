// Shared presentation for the accounting Documents register (Invoices + Receipts).
// Two consumers (invoices-page, receipts-page) share this table + status helpers
// — the rule-of-three threshold for a reusable primitive (frontend §11/§15).
//
// Defensive rendering: every optional field is null-guarded because the register
// row (BillingDocumentListItem) legitimately carries nulls (a manual invoice with
// no unit → no unitCode/propertyName) AND because tests mount the page against a
// partial fixture. The load-bearing fields (documentNumber, partyName, total) are
// always rendered; the rest degrade to "—".
import type { ReactNode } from "react";
import type { BillingDocumentListItem } from "@kason/shared";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { formatRM, formatDate } from "@/components/format";
import { docTypeLabel, statusMeta, formatBillingMonth, signedFaceAmount, adjustmentToneClass } from "./document-helpers";

/**
 * The register's red dot: N tenant-submitted payments on this document are
 * waiting for an admin to verify a transfer slip. Opening the row lands on the
 * drawer's Payments tab, where the panel offers Approve / Reject.
 *
 * Renders nothing at 0 — the register is scanned in bulk, so a badge on every
 * row would carry no signal.
 *
 * Rose (not amber) deliberately: amber is this codebase's "pending" tone and is
 * already spent on the row's own settlement pill. This mark means "someone is
 * blocked waiting on YOU", which has to survive a glance down a column of amber.
 */
export function PendingVerificationDot({ count }: { count?: number }) {
  // `undefined` means the API stopped sending the field, not "none pending" —
  // a silent 0 here would hide every slip awaiting review with no visible
  // failure (frontend §16). Distinguish the two in dev; render nothing either
  // way, since inventing a dot would be worse.
  if (count === undefined) {
    if (import.meta.env.DEV) {
      console.warn("[accounting] BillingDocumentListItem.pendingVerificationCount missing — red dot suppressed");
    }
    return null;
  }
  if (count <= 0) return null;
  return (
    <span
      title={`${count} payment${count === 1 ? "" : "s"} awaiting your verification`}
      aria-label={`${count} payment${count === 1 ? "" : "s"} awaiting verification`}
      className="ml-2 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-bold leading-none text-white"
    >
      {count}
    </span>
  );
}

/** Tenant/Owner chip for the Bill-To column. */
export function CounterpartyBadge({ type }: { type?: "tenant" | "owner" }) {
  if (!type) return null;
  return (
    <Badge variant={type === "owner" ? "gold" : "sky"} className="mt-0.5 w-fit">
      {type === "owner" ? "Owner" : "Tenant"}
    </Badge>
  );
}

/**
 * The accounting register table — a proper column set (Date · Document ·
 * Bill To · Property · Unit · Period · Total+Status · Actions) replacing the
 * old three-field <ul>. Date leads because the register is chronological, like
 * a ledger; Total is right-aligned with the status pill stacked beneath. Rows
 * are clickable (→ `onRowClick`, opens the detail
 * drawer); the actions cell stops propagation so per-row buttons (Reverse, Void,
 * Refund — the Receipts register; the Invoices register passes no renderActions
 * at all) never trigger a row open. The document-number cell is a real <button>
 * for keyboard/AT users.
 */
export function DocumentsTable({
  items,
  onRowClick,
  renderActions,
  emptyLabel,
  showAdjustmentFace = false,
}: {
  items: BillingDocumentListItem[];
  onRowClick: (d: BillingDocumentListItem) => void;
  renderActions?: (d: BillingDocumentListItem) => ReactNode;
  emptyLabel: string;
  /** Invoice-adjustments Phase 1.6 / spec D3 — on a mixed (non-Invoices) register
   * facet, a credit_note/debit_note row shows its own signed face amount +
   * "Credit note"/"Debit note" text (never color-only) + the linked invoice
   * number, instead of the plain unsigned total. Defaults false so every
   * existing caller (Receipts, the Invoices facet, flag-off) renders byte-for-byte
   * as before. */
  showAdjustmentFace?: boolean;
}) {
  const colCount = 7 + (renderActions ? 1 : 0);
  return (
    <TableWrap>
      <DataTable>
        <TableHead>
          <tr>
            <HeadCell>Date</HeadCell>
            <HeadCell>Document</HeadCell>
            <HeadCell>Bill To</HeadCell>
            <HeadCell className="hidden lg:table-cell">Property</HeadCell>
            <HeadCell className="hidden md:table-cell">Unit</HeadCell>
            <HeadCell className="hidden xl:table-cell">Period</HeadCell>
            <HeadCell className="text-right">Total</HeadCell>
            {renderActions ? <HeadCell className="text-right">Actions</HeadCell> : null}
          </tr>
        </TableHead>
        <tbody>
          {items.length === 0 ? (
            <EmptyRow colSpan={colCount} label={emptyLabel} />
          ) : (
            items.map((d) => {
              const st = statusMeta(d);
              return (
                <tr
                  key={d.id}
                  onClick={() => onRowClick(d)}
                  className="cursor-pointer border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                >
                  <BodyCell className="whitespace-nowrap tabular-nums">{formatDate(d.issuedAt)}</BodyCell>
                  <BodyCell>
                    <button
                      type="button"
                      aria-label={`View ${d.documentNumber}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRowClick(d);
                      }}
                      className="rounded font-semibold text-[var(--text-primary)] underline-offset-2 transition hover:text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {d.documentNumber}
                    </button>
                    <PendingVerificationDot count={d.pendingVerificationCount} />
                    <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                      {d.seriesCode || docTypeLabel(d.docType)}
                    </span>
                  </BodyCell>
                  <BodyCell>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{d.partyName}</span>
                      <CounterpartyBadge type={d.counterpartyType} />
                    </div>
                  </BodyCell>
                  <BodyCell className="hidden lg:table-cell">{d.propertyName ?? "—"}</BodyCell>
                  <BodyCell className="hidden md:table-cell">{d.unitCode ?? "—"}</BodyCell>
                  <BodyCell className="hidden xl:table-cell">{formatBillingMonth(d.billingMonth)}</BodyCell>
                  <BodyCell className="text-right">
                    <div className="flex flex-col items-end gap-1">
                      {showAdjustmentFace && (d.docType === "credit_note" || d.docType === "debit_note") ? (
                        (() => {
                          const face = signedFaceAmount(d.docType, d.total);
                          return (
                            <>
                              <span className={cn("font-semibold tabular-nums", adjustmentToneClass(face.tone))}>
                                {face.text}
                              </span>
                              <span className="text-[11px] text-[var(--text-muted)]">
                                {docTypeLabel(d.docType)}
                                {d.originalDocumentNumber ? ` · Ref ${d.originalDocumentNumber}` : ""}
                              </span>
                            </>
                          );
                        })()
                      ) : (
                        <span className="font-semibold tabular-nums text-[var(--text-primary)]">
                          {formatRM(Number(d.total))}
                        </span>
                      )}
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <StatusPill tone={st.primary.tone}>{st.primary.label}</StatusPill>
                        {st.secondary ? (
                          <StatusPill tone={st.secondary.tone}>{st.secondary.label}</StatusPill>
                        ) : null}
                      </div>
                    </div>
                  </BodyCell>
                  {renderActions ? (
                    <td className="px-4 py-3.5 text-right align-top" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end">{renderActions(d)}</div>
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </DataTable>
    </TableWrap>
  );
}
