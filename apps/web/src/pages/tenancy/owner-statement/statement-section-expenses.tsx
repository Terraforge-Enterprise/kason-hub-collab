// Section 5 — Expense Breakdown
// Table: category, description, amount, SST, payment status, (optional) per-row BILL.
// paymentStatus column uses StatusPill (Badge variant from getStatusTone).
//
// PER-EXPENSE PROOF (B3): when the proof scope (ownerPartyId + statementMonth) is
// supplied, a "Bill" column surfaces the legal proof attached to THAT (apartment,
// category) — admins attach/detach inline; a thumbnail opens the shared BillLightbox.
// Proof is keyed off the RAW ledger category (row.categoryKey), apartment-scoped via
// the statement's apartmentId. When the scope is absent (e.g. the read-only portal
// statement, which has no proof props) the table renders exactly as before — no Bill
// column — so this stays additive for non-admin surfaces.
import { useRef, useState } from "react";
import { Expand, FileText, Paperclip, TrendingDown, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRM, getStatusTone } from "@/components/format";
import { StatusPill } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { YannieSections } from "@/api/owner-ledger";
import {
  useExpenseProofs,
  useAttachExpenseProof,
  useDetachExpenseProof,
  type ExpenseProofGroup,
  type ExpenseProofItem,
} from "@/api/owner-billing";
import { BillLightbox, isImageFilename } from "./bill-lightbox";

interface Props {
  data: YannieSections["expenseBreakdown"];
  /**
   * Per-expense proof scope. Supplied by the admin statement page (owner + month +
   * the statement's apartment). Omitted on read-only surfaces (portal) → no Bill
   * column, identical to the pre-B3 table.
   */
  ownerPartyId?: string;
  /** "YYYY-MM" — the statement month the bills are keyed under. */
  statementMonth?: string;
  /** Statement apartment scope (Invoice.apartmentId); null = legacy combined. */
  apartmentId?: string | null;
  /** Admin can attach/detach; false/omitted = view-only (still shows bills). */
  editable?: boolean;
}

export function StatementSectionExpenses({
  data,
  ownerPartyId,
  statementMonth,
  apartmentId = null,
  editable = false,
}: Props) {
  // DEV guard: required fields per frontend-design rule #16
  if (import.meta.env.DEV) {
    if (data.rows === undefined)
      console.warn("[owner-statement/expenses] missing rows from API response");
    if (data.totalExpenses === undefined)
      console.warn("[owner-statement/expenses] missing totalExpenses from API response");
  }

  // The Bill column shows only when an owner+month scope is supplied (admin page).
  // useExpenseProofs is ALWAYS called (rules of hooks) but disabled until both are
  // known, so the portal usage (no scope) never hits the network.
  const showProof = Boolean(ownerPartyId && statementMonth);
  const proofsQuery = useExpenseProofs(ownerPartyId, statementMonth, apartmentId);
  const proofsByCategory = new Map<string, ExpenseProofItem[]>();
  for (const g of (proofsQuery.data?.data ?? []) as ExpenseProofGroup[]) {
    proofsByCategory.set(g.category, g.proofs);
  }

  const scope =
    showProof && ownerPartyId && statementMonth
      ? { ownerPartyId, statementMonth, apartmentId }
      : null;

  // Total-row trailing empty span widens by 1 when the Bill column is present.
  const trailingColSpan = showProof ? 3 : 2;

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2" id="section-heading-expenses">
          <TrendingDown className="h-5 w-5 text-primary" />
          Expense Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
              <tr>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Category
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Description
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Amount
                </th>
                <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  SST
                </th>
                <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                  Status
                </th>
                {showProof && (
                  <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)] font-semibold">
                    Bill
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={`expense-${i}`}
                  className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)]"
                >
                  <td className="px-4 py-3.5 text-sm font-medium text-[var(--text-primary)]">
                    {row.category}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-muted-foreground max-w-xs">
                    {/* truncate moved OFF the cell and onto the description alone —
                        on the <td> it also swallowed the adjustment note below,
                        which is the one line that must not be clipped. */}
                    <div className="truncate">{row.description ?? "—"}</div>
                    {/* WHICH credit/debit note moved this row, and by how much. The
                        Amount and SST columns have always shown the ADJUSTED figure
                        (the receivable path nets notes in; owner-ledger.sync nets
                        them into the charge-backed rows), so an owner watched a
                        RM 1.00 expense read RM 0.50 with nothing on the page naming
                        the note or letting them check it against their documents.
                        §4 has named it beside the income line since 2026-08-07.

                        Amber + explicit "Credit note"/"Debit note" wording — never
                        colour alone — matching the owner-ledger workspace's
                        AdjustmentNote verbatim, so one adjustment reads the same on
                        every surface it appears. */}
                    {row.adjustmentNote && (
                      <div
                        data-testid={`expense-row-adjustment-${i}`}
                        className="mt-0.5 text-[11px] font-normal text-amber-500"
                        title="This amount is adjusted by active credit/debit notes."
                      >
                        {row.adjustmentNote}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums font-semibold text-rose-600 dark:text-rose-400">
                    {formatRM(Number(row.amount))}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-right tabular-nums text-muted-foreground">
                    {Number(row.sstAmount) > 0
                      ? formatRM(Number(row.sstAmount))
                      : "—"}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusPill tone={getStatusTone(row.paymentStatus)}>
                      {row.paymentStatus}
                    </StatusPill>
                  </td>
                  {showProof && scope && (
                    <td className="px-4 py-3.5">
                      <ExpenseProofCell
                        scope={scope}
                        category={row.categoryKey}
                        proofs={proofsByCategory.get(row.categoryKey) ?? []}
                        editable={editable}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-background/40">
              <tr>
                <td colSpan={2} className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Total expenses
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-sm font-bold text-rose-600 dark:text-rose-400">
                  {formatRM(Number(data.totalExpenses))}
                </td>
                <td colSpan={trailingColSpan} />
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Per-row proof cell ──────────────────────────────────────────────────────
//
// Lists the bills attached to one (apartment, category) expense as small preview
// tiles (image keys → thumbnail, else a file icon) that open the shared BillLightbox.
// Admins get an "Attach bill" affordance (paperclip) + a detach (×) per tile; a
// no-proof row shows "Attach bill" (editable) or "—" (view-only). The attach posts
// category=<row.categoryKey> + the statement's apartmentId so B2 keys it correctly.

function ExpenseProofCell({
  scope,
  category,
  proofs,
  editable,
}: {
  scope: { ownerPartyId: string; statementMonth: string; apartmentId: string | null };
  category: string;
  proofs: ExpenseProofItem[];
  editable: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const attach = useAttachExpenseProof();
  const detach = useDetachExpenseProof();

  const total = proofs.length;
  const active = lightboxIndex !== null ? proofs[lightboxIndex] : undefined;

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    attach.mutate(
      { ...scope, category, files: Array.from(list) },
      {
        onSuccess: (rows) =>
          toast.success(rows.length === 1 ? "Bill attached." : `${rows.length} bills attached.`),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  function detachProof(id: string) {
    detach.mutate(id, {
      onSuccess: () => toast.success("Bill detached."),
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {proofs.map((p, i) => (
        <ProofThumb
          key={p.id}
          proof={p}
          editable={editable}
          detaching={detach.isPending}
          onOpen={() => setLightboxIndex(i)}
          onDetach={() => detachProof(p.id)}
        />
      ))}

      {editable ? (
        <>
          <button
            type="button"
            disabled={attach.isPending}
            aria-label={`Attach bill for ${category}`}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition",
              "hover:border-[var(--gold)] hover:text-foreground",
              attach.isPending && "cursor-not-allowed opacity-60",
            )}
          >
            <Paperclip className="h-3.5 w-3.5" />
            {attach.isPending ? "Uploading…" : proofs.length === 0 ? "Attach bill" : "Add"}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden="true"
            data-testid={`expense-attach-input-${category}`}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </>
      ) : (
        proofs.length === 0 && <span className="text-xs text-muted-foreground">—</span>
      )}

      <BillLightbox
        open={lightboxIndex !== null && Boolean(active?.url)}
        index={lightboxIndex}
        total={total}
        url={active?.url}
        label={active?.filename ?? ""}
        isImage={active ? isImageFilename(active.filename) : false}
        onClose={() => setLightboxIndex(null)}
        onPrev={() => setLightboxIndex((i) => (i === null ? null : (i - 1 + total) % total))}
        onNext={() => setLightboxIndex((i) => (i === null ? null : (i + 1) % total))}
      />
    </div>
  );
}

/** One attached bill tile: image → thumbnail, else a file icon; opens the lightbox. */
function ProofThumb({
  proof,
  editable,
  detaching,
  onOpen,
  onDetach,
}: {
  proof: ExpenseProofItem;
  editable: boolean;
  detaching: boolean;
  onOpen: () => void;
  onDetach: () => void;
}) {
  const image = isImageFilename(proof.filename);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Preview ${proof.filename}`}
        title={proof.filename}
        className="group relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40 transition hover:border-[var(--gold)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        {image ? (
          <img
            src={proof.url}
            alt={proof.filename}
            loading="lazy"
            decoding="async"
            className="h-10 w-10 rounded object-cover"
          />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/40 text-white group-hover:flex">
          <Expand className="h-3.5 w-3.5" />
        </span>
      </button>
      {editable && !proof.readOnly && (
        <button
          type="button"
          aria-label={`Detach ${proof.filename}`}
          disabled={detaching}
          onClick={onDetach}
          className="absolute -right-1.5 -top-1.5 rounded-full border border-border/60 bg-background p-0.5 text-muted-foreground shadow-sm transition hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-50"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
