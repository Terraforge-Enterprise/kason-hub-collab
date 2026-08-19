// Record Payment (from an invoice) — records a manual bank transfer already
// received outside the app. Bound to ONE `documentId` (the register/receipts
// row entry point). The actual field logic (Pay-now allocation grid, mandatory
// slip upload, submit) lives in record-invoice-payment-form.tsx — SHARED with
// the invoice-detail drawer's Payments tab (invoice-adjustments rework, Change
// 2) so both entry points submit through the exact same hook and business
// rules. This file is now just the FormDrawer chrome: title/description,
// confirm-before-submit dialog, and mounting the shared fields.
import { FormDrawer } from "@/components/ui/form-drawer";
import { formatRM } from "@/components/format";
import { useBillingDocument } from "@/api/billing-documents";
import { useInvoicePaymentForm, InvoicePaymentFormFields } from "./record-invoice-payment-form";

export function TransferFromInvoiceDrawer({
  open, documentId, onClose,
}: { open: boolean; documentId: string; onClose: () => void }) {
  const detailQuery = useBillingDocument(open ? documentId : null);
  const detail = detailQuery.data?.data;
  const form = useInvoicePaymentForm(detail, documentId);

  const payerName = detail?.partyName ?? "this customer";
  const docNumber = detail?.documentNumber;
  const activeLines = form.rows.filter((r) => Number(form.pay[r.chargeId]) > 0).length;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="lg"
      title={docNumber ? `Record payment — ${docNumber}` : "Record payment"}
      description={
        <span>
          {payerName} · Outstanding <strong className="text-[var(--text-primary)]">{formatRM(form.invoiceBalance)}</strong>
        </span>
      }
      onSubmit={() => void form.submit(onClose)}
      submit={{
        label: "Record payment",
        pendingLabel: "Recording…",
        pending: form.isPending,
        disabled: !form.canSubmit,
        confirm: {
          title: "Record this payment?",
          body: `Record ${formatRM(form.total)} received from ${payerName}${docNumber ? ` against ${docNumber}` : ""}, applied to ${activeLines} line(s). A receipt will be issued.`,
          confirmLabel: "Record receipt",
        },
      }}
    >
      <InvoicePaymentFormFields form={form} />
    </FormDrawer>
  );
}
