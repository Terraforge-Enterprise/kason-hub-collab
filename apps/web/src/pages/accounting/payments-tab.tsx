// Payments tab body (invoice-adjustments rework, Change 2). The drawer is now
// the single container for the invoice-detail surface: this tab renders the
// aggregate Amount paid / Balance due summary (unchanged) PLUS an embedded
// "Record payment" section, scoped to THIS invoice — no separate row action,
// no nested drawer. It reuses the EXACT SAME Pay-now allocation form + hooks
// the standalone TransferFromInvoiceDrawer uses (see
// record-invoice-payment-form.tsx), so both entry points submit through
// useRecordInvoicePayment with the same mandatory-slip business rule.
import { Loader2 } from "lucide-react";
import type { BillingDocumentDetail } from "@kason/shared";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { formatRM } from "@/components/format";
import { useInvoicePaymentForm, InvoicePaymentFormFields } from "./record-invoice-payment-form";
import { PendingVerificationPanel } from "./pending-verification-panel";

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 rounded-lg border border-border/50 bg-background/40 px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-base font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

/** The embedded record-payment section — a thin wrapper around the shared
 * Pay-now fields with its own (non-drawer) primary CTA. No confirm sub-dialog
 * here (that's FormDrawer-specific chrome); disable+spinner on submit instead. */
function RecordPaymentSection({ detail }: { detail: BillingDocumentDetail | undefined }) {
  const form = useInvoicePaymentForm(detail, detail?.id ?? "");

  return (
    <div className="space-y-4 rounded-lg border border-border/50 bg-background/40 p-4">
      <h3 className="text-sm font-semibold text-foreground">Record payment</h3>
      <InvoicePaymentFormFields form={form} />
      <div className="flex justify-end">
        <Button
          type="button"
          variant="gold"
          disabled={!form.canSubmit}
          onClick={() => void form.submit(() => {})}
        >
          {form.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {form.isPending ? "Recording…" : "Record payment"}
        </Button>
      </div>
    </div>
  );
}

export function PaymentsTab({
  detail,
  isPayable,
}: {
  detail: BillingDocumentDetail | undefined;
  /** Receipts/credit notes carry no payable balance — see document-detail-drawer's isPayable. */
  isPayable: boolean;
}) {
  if (!isPayable) {
    return (
      <Callout variant="info" title="No balance on this document">
        This document type doesn't carry a payable balance, so there's nothing to allocate against.
      </Callout>
    );
  }

  const balance = Number(detail?.balance ?? 0);

  return (
    <div className="space-y-6">
      {/*
        Above the summary on purpose. A tenant-submitted transfer is the reason
        an admin opened this drawer (the register's red dot links here), and it
        also EXPLAINS the summary directly beneath it: a claimed-but-unverified
        payment leaves "Amount paid" at 0.00, which reads as a bug unless the
        pending claim is visible first. Renders nothing when nothing is pending.
      */}
      {detail?.id ? <PendingVerificationPanel documentId={detail.id} /> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SummaryRow label="Amount paid" value={formatRM(Number(detail?.amountPaid ?? 0))} />
        <SummaryRow label="Balance due" value={formatRM(balance)} />
      </div>

      {balance > 0.005 ? (
        <RecordPaymentSection detail={detail} />
      ) : (
        <Callout variant="info" title="Fully paid">
          This document has no outstanding balance — there's nothing to record a payment against.
        </Callout>
      )}
    </div>
  );
}
