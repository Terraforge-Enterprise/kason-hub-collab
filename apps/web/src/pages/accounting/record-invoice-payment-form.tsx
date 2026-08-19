// Shared invoice-scoped "Record payment" form logic (Pay-now allocation model).
// Extracted from transfer-from-invoice-drawer.tsx (invoice-adjustments rework,
// Change 2) so BOTH the standalone TransferFromInvoiceDrawer (register/receipts
// row entry point, kept working) and the invoice-detail drawer's Payments tab
// (new, embedded-in-tab entry point) submit through the EXACT SAME
// useRecordInvoicePayment hook + mandatory slip-upload logic — no new endpoint,
// no duplicated business rules.
//
// ALLOCATION UNIT = the CHARGE. A pooled utility charge itemised across several
// lines (meter path) shares one chargeId, so lines are grouped by chargeId into
// one Pay-now row — an allocation settles a charge, not a display line. Grid/
// manual/owner invoices are 1:1 line↔charge, so each line is its own row (the
// common case). There is NO "Amount received" field: the payment amount is
// DERIVED as the sum of the per-line "Pay now" allocations. Payer + method are
// derived server-side from the invoice, and the transfer slip is mandatory.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { BillingDocumentDetail, RecordInvoicePaymentInput } from "@kason/shared";
import { ApiError } from "@/lib/api-client";
import { Field, TextInput, TextAreaInput } from "@/components/form-ui";
import { Callout } from "@/components/ui/callout";
import { TableWrap, DataTable, TableHead, HeadCell, BodyCell, Row } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatRM } from "@/components/format";
import { useRecordInvoicePayment, uploadSlipProof, deleteSlipProof } from "@/api/accounting";

/** One allocatable unit = one charge, aggregated from the lines that reference it. */
export type ChargeRow = { chargeId: string; title: string; outstanding: number };

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function paymentNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `RCV-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** Today in the organisation's local timezone (Asia/Kuala_Lumpur), as YYYY-MM-DD. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
}

/** Group document lines into allocatable charge rows (preserving invoice-line order).
 * Charge-less lines (overpayment CN, R12a) are not allocatable and are skipped. The
 * charge outstanding = Σ of its lines' (prorated) outstanding. */
export function groupChargeRows(detail: BillingDocumentDetail | undefined): ChargeRow[] {
  if (!detail) return [];
  const byCharge = new Map<string, ChargeRow>();
  const order: string[] = [];
  for (const l of detail.lines) {
    if (!l.chargeId) continue;
    const lineOutstanding = Number(l.outstanding ?? l.amount);
    const existing = byCharge.get(l.chargeId);
    if (existing) {
      existing.title = `${existing.title} · ${l.description}`;
      existing.outstanding = round2(existing.outstanding + lineOutstanding);
    } else {
      byCharge.set(l.chargeId, { chargeId: l.chargeId, title: l.description, outstanding: lineOutstanding });
      order.push(l.chargeId);
    }
  }
  return order.map((id) => byCharge.get(id)!);
}

/**
 * All state + derived values + submit for the invoice-scoped Pay-now flow.
 * `resetKey` re-seeds a clean form whenever it changes (e.g. the target
 * document id) — mirrors the reset-on-reopen pattern the standalone drawer
 * used before this extraction.
 */
export function useInvoicePaymentForm(detail: BillingDocumentDetail | undefined, resetKey: string) {
  const record = useRecordInvoicePayment();

  const [receivedAt, setReceivedAt] = useState(todayLocal);
  const [bankRef, setBankRef] = useState("");
  const [memo, setMemo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [slipTouched, setSlipTouched] = useState(false);
  // chargeId → "Pay now" amount (string). Starts EMPTY — no auto-allocation.
  const [pay, setPay] = useState<Record<string, string>>({});

  // Fresh form each time the reset key (e.g. target document) changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
    setReceivedAt(todayLocal());
    setBankRef("");
    setMemo("");
    setFile(null);
    setSlipTouched(false);
    setPay({});
  }, [resetKey]);

  const rows = useMemo(() => groupChargeRows(detail), [detail]);
  const invoiceBalance = useMemo(() => round2(rows.reduce((s, r) => s + r.outstanding, 0)), [rows]);

  const total = round2(rows.reduce((s, r) => s + (Number(pay[r.chargeId]) || 0), 0));
  const remaining = round2(invoiceBalance - total);

  const overCapRows = rows.filter((r) => (Number(pay[r.chargeId]) || 0) > r.outstanding + 0.005);
  const anyNegative = rows.some((r) => Number(pay[r.chargeId]) < 0);
  const anyPositive = total > 0.005;
  const slipMissing = file === null;

  const canSubmit =
    !!detail && anyPositive && overCapRows.length === 0 && !anyNegative && !slipMissing && !record.isPending;

  function setPayFor(chargeId: string, v: string) {
    setPay((p) => ({ ...p, [chargeId]: v }));
  }

  /** Pay all — fill every line with its outstanding balance. */
  function payAll() {
    const next: Record<string, string> = {};
    for (const r of rows) next[r.chargeId] = r.outstanding > 0.005 ? r.outstanding.toFixed(2) : "";
    setPay(next);
  }

  /** Clear — reset every Pay now to zero. */
  function clearAll() {
    setPay({});
  }

  async function submit(onSuccess: () => void) {
    if (!detail || !canSubmit || !file) return;
    let uploadedKey: string | null = null;
    try {
      uploadedKey = await uploadSlipProof(file);
      const body: RecordInvoicePaymentInput = {
        documentId: detail.id,
        paymentNumber: paymentNumber(),
        receivedAt,
        idempotencyKey: crypto.randomUUID(),
        attachmentKeys: [uploadedKey],
        ...(bankRef.trim() ? { externalReference: bankRef.trim() } : {}),
        ...(memo.trim() ? { referenceNote: memo.trim() } : {}),
        allocations: rows
          .filter((r) => Number(pay[r.chargeId]) > 0)
          .map((r) => ({ chargeId: r.chargeId, allocatedAmount: Number(pay[r.chargeId]).toFixed(2) })),
      };
      await record.mutateAsync(body);
      toast.success("Payment recorded — receipt issued");
      // Reset local state BEFORE the caller's onSuccess — the drawer unmounts on
      // success (onSuccess = onClose) so this is a no-op there; the Payments tab
      // stays mounted, so its form must come back clean for the next payment.
      setReceivedAt(todayLocal());
      setBankRef("");
      setMemo("");
      setFile(null);
      setSlipTouched(false);
      setPay({});
      onSuccess();
    } catch (err) {
      // Delete-on-failure: the slip uploaded but the record call failed — clean
      // up the orphan so storage never holds an object with no payment.
      if (uploadedKey) await deleteSlipProof(uploadedKey).catch(() => {});
      toast.error(err instanceof ApiError ? err.message : "Failed to record payment");
    }
  }

  return {
    receivedAt, setReceivedAt,
    bankRef, setBankRef,
    memo, setMemo,
    file, setFile,
    slipTouched, setSlipTouched,
    pay, setPayFor, payAll, clearAll,
    rows, invoiceBalance, total, remaining, overCapRows, anyNegative, anyPositive, slipMissing,
    canSubmit, submit,
    isPending: record.isPending,
  };
}

export type InvoicePaymentForm = ReturnType<typeof useInvoicePaymentForm>;

/**
 * The shared field markup — date/bank-ref, the mandatory slip, the Pay-now
 * allocation table, the running summary, and the internal memo. Rendered
 * inside FormDrawer's body by the standalone drawer, and inline (no drawer
 * chrome, no confirm dialog) by the invoice-detail drawer's Payments tab.
 */
export function InvoicePaymentFormFields({ form }: { form: InvoicePaymentForm }) {
  const {
    receivedAt, setReceivedAt,
    bankRef, setBankRef,
    memo, setMemo,
    setFile, slipTouched, setSlipTouched,
    pay, setPayFor, payAll, clearAll,
    rows, invoiceBalance, total, remaining, overCapRows, anyPositive, slipMissing,
  } = form;

  return (
    <div className="space-y-5">
      {/* Payment details — date, bank ref, required slip. Memo is secondary (below). */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date received" hint="Defaults to today — editable for a back-dated receipt.">
          <TextInput
            type="date"
            aria-label="Date received"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </Field>
        <Field label="Bank reference" hint="Optional — slip / transaction reference.">
          <TextInput
            aria-label="Bank reference"
            placeholder="e.g. FT250714…"
            value={bankRef}
            onChange={(e) => setBankRef(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="Transfer slip *"
        hint="Required — proof of the bank transfer (image or PDF)."
        error={slipTouched && slipMissing ? "Attach the transfer slip to record this payment." : undefined}
      >
        <input
          aria-label="Transfer slip"
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setSlipTouched(true);
          }}
          onBlur={() => setSlipTouched(true)}
          className="text-sm text-[var(--text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--page-bg)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--text-primary)]"
        />
      </Field>

      {/* Line allocations — three columns: Invoice item · Outstanding · Pay now. */}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-[var(--text-primary)]">Pay invoice lines</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={invoiceBalance <= 0} onClick={payAll}>
              Pay all
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!anyPositive} onClick={clearAll}>
              Clear
            </Button>
          </div>
        </div>
        <TableWrap>
          <DataTable>
            <TableHead>
              <tr>
                <HeadCell>Invoice item</HeadCell>
                <HeadCell className="text-right">Outstanding</HeadCell>
                <HeadCell className="text-right">Pay now</HeadCell>
              </tr>
            </TableHead>
            <tbody>
              {rows.map((r) => {
                const over = (Number(pay[r.chargeId]) || 0) > r.outstanding + 0.005;
                return (
                  <Row key={r.chargeId}>
                    <BodyCell>
                      <span className="font-medium text-[var(--text-primary)]">{r.title}</span>
                    </BodyCell>
                    <BodyCell className="text-right font-medium tabular-nums">{formatRM(r.outstanding)}</BodyCell>
                    <BodyCell className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <TextInput
                          type="number"
                          min={0}
                          step="0.01"
                          aria-label={`Pay now for ${r.title}`}
                          placeholder="0.00"
                          className="w-28 text-right"
                          value={pay[r.chargeId] ?? ""}
                          onChange={(e) => setPayFor(r.chargeId, e.target.value)}
                        />
                        {over ? (
                          <span role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">
                            Cannot exceed outstanding ({formatRM(r.outstanding)}).
                          </span>
                        ) : null}
                      </div>
                    </BodyCell>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </TableWrap>
      </div>

      {/* Payment summary — only the two figures that matter. */}
      <div className="rounded-lg border border-border/50 bg-background/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-[var(--text-secondary)]">Payment being recorded</span>
          <span data-testid="payment-total" className="text-lg font-bold tabular-nums text-[var(--text-primary)]">
            {formatRM(total)}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border/50 pt-1.5">
          <span className="text-sm text-[var(--text-secondary)]">Remaining invoice balance</span>
          <span data-testid="remaining-balance" className="text-sm font-medium tabular-nums text-[var(--text-primary)]">
            {formatRM(remaining)}
          </span>
        </div>
      </div>

      {overCapRows.length > 0 ? (
        <Callout variant="danger" title="A line exceeds its outstanding">
          Reduce the highlighted Pay now amounts — no line can take more than its own outstanding balance.
        </Callout>
      ) : !anyPositive ? (
        <Callout variant="info" title="Enter an amount to pay">
          Enter a Pay now amount on at least one line, or use Pay all. The payment total is the sum of these amounts.
        </Callout>
      ) : null}

      {/* Internal memo — optional, visually secondary. */}
      <Field label="Internal memo" hint="Optional — internal note stored with the receipt.">
        <TextAreaInput aria-label="Internal memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </Field>
    </div>
  );
}
