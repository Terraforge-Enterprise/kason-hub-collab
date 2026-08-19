import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { portalApiFetch } from "@/lib/portal-api";
import { formatRM, formatDateMY } from "@/components/format";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

// Shape matches charge-detail.tsx:6-11 (the pre-existing single-charge page
// this drawer supersedes as the primary tenant surface for one charge).
type ChargeDetail = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  description: string | null;
  status: string;
  dueDate: string;
  amount: number;
  /** CN/DN awareness (2026-08-06) — optional so an older API still parses. */
  debitNoteTotal?: number;
  creditNoteTotal?: number;
  adjustedAmount?: number;
  outstandingAmount: number;
  currency: string;
  createdAt: string;
  documents?: { id: string; docType: string; documentNumber: string }[];
  creditApplications?: { amount: number; creditNoteNumber: string }[];
};

const PAYABLE_STATUSES = new Set(["posted", "partial", "partially_paid"]);

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  debit_note: "Debit Note",
  credit_note: "Credit Note",
  refund_note: "Refund Note",
  receipt: "Receipt",
};

export function ChargeDrawer({ chargeId, onClose }: { chargeId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [pdfError, setPdfError] = useState<string | null>(null);
  const { data, isError, error } = useQuery({
    queryKey: ["portal-charge", chargeId],
    queryFn: () => portalApiFetch<{ data: ChargeDetail }>(`/charges/${chargeId}`),
  });
  const charge = data?.data;
  const canPay = !!charge && PAYABLE_STATUSES.has(charge.status) && charge.outstandingAmount > 0;

  const documents = charge?.documents ?? [];
  // Credit APPLIED as payment (auto-offset) — distinct from a direct credit
  // note, which reduces the adjusted total instead.
  const creditApplied = (charge?.creditApplications ?? []).reduce((sum, a) => sum + a.amount, 0);
  const debitNoteTotal = charge?.debitNoteTotal ?? 0;
  const creditNoteTotal = charge?.creditNoteTotal ?? 0;
  const adjustedAmount = charge?.adjustedAmount ?? (charge ? charge.amount + debitNoteTotal - creditNoteTotal : 0);
  // Paid = adjusted total − credit applied − still outstanding. Basing the plug
  // on the ADJUSTED amount (not the original) is what stops a credit note
  // rendering as a payment the tenant never made, and a debit note leaving an
  // unexplained gap (punch list B, 2026-08-06). Clamped at 0 — inconsistent
  // upstream data must never render a nonsensical negative "paid" line.
  const amountPaidRaw = charge ? adjustedAmount - creditApplied - charge.outstandingAmount : 0;
  const amountPaid = Math.max(0, amountPaidRaw);

  // Footer shortcuts for the two common single-document cases. ALL documents
  // are still individually reachable via the "Line items" rows above (a
  // charge can carry more than one of either kind, e.g. a superseding
  // re-Bill) — these buttons pick the MOST RECENT (last) match as a
  // convenience, not the only way to reach a document.
  const invoiceDoc = [...documents].reverse().find((d) => d.docType === "invoice" || d.docType === "debit_note");
  const creditNoteDoc = [...documents].reverse().find((d) => d.docType === "credit_note");

  // The tab is opened SYNCHRONOUSLY, before the await: /documents/billing/:id/pdf
  // renders the PDF on demand the first time it is asked for (53.8s cold vs 0.08s
  // warm on UAT), which is far past the 5s user-activation window a popup blocker
  // allows — so an open deferred until after the fetch is silently blocked. Same
  // shape as owner-statement.tsx:239 and portal/documents.tsx.
  async function openDocumentPdf(id: string) {
    setPdfError(null);
    const win = window.open("about:blank", "_blank");
    try {
      const res = await portalApiFetch<{ data: { downloadUrl: string } }>(`/documents/billing/${id}/pdf`);
      if (win) {
        win.opener = null;
        win.location.href = res.data.downloadUrl;
      } else {
        window.location.assign(res.data.downloadUrl);
      }
    } catch (e) {
      win?.close();
      setPdfError((e as Error)?.message || "Couldn't open that document. Please try again.");
    }
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>{charge?.description || charge?.chargeType || "Charge"}</SheetTitle>
          {charge && <SheetDescription>Due {formatDateMY(charge.dueDate)}</SheetDescription>}
        </SheetHeader>
        <SheetBody className="space-y-3">
          {isError && (
            <Callout variant="danger" title="Couldn't load this charge">
              {(error as Error)?.message || "Something went wrong. Please try again."}
            </Callout>
          )}
          {charge && (
            <>
              <Row label="Charge number" value={charge.chargeNumber} />
              <Row label="Issue date" value={formatDateMY(charge.createdAt)} />
              <Row label="Due date" value={formatDateMY(charge.dueDate)} />

              {documents.length > 0 && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs uppercase tracking-widest text-muted-foreground">Line items</p>
                  {documents.map((d) => (
                    <Row key={d.id} label={DOC_TYPE_LABEL[d.docType] ?? d.docType} value={d.documentNumber} />
                  ))}
                </div>
              )}

              <Row label="Original total" value={formatRM(charge.amount)} strong />
              {debitNoteTotal > 0 && <Row label="Debit notes" value={`+${formatRM(debitNoteTotal)}`} />}
              {creditNoteTotal > 0 && <Row label="Credit notes" value={`-${formatRM(creditNoteTotal)}`} />}
              {adjustedAmount !== charge.amount && (
                <Row label="Adjusted total" value={formatRM(adjustedAmount)} strong />
              )}
              {creditApplied > 0 && <Row label="Credit applied" value={`-${formatRM(creditApplied)}`} />}
              {amountPaid > 0 && <Row label="Amount paid" value={`-${formatRM(amountPaid)}`} />}
              <Row label="Outstanding" value={formatRM(charge.outstandingAmount)} strong />
            </>
          )}
          {pdfError && <Callout variant="danger" title="Couldn't open that document">{pdfError}</Callout>}
        </SheetBody>
        <SheetFooter>
          {canPay && (
            <Button variant="gold" onClick={() => navigate("/portal/pay")}>
              Pay {formatRM(charge!.outstandingAmount)}
            </Button>
          )}
          {invoiceDoc && (
            <Button variant="outline" onClick={() => void openDocumentPdf(invoiceDoc.id)}>
              Download invoice
            </Button>
          )}
          {creditNoteDoc && (
            <Button variant="outline" onClick={() => void openDocumentPdf(creditNoteDoc.id)}>
              View credit note
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between border-b border-border/50 pb-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={strong ? "text-sm font-semibold text-foreground" : "text-sm font-medium text-foreground"}>
        {value}
      </span>
    </div>
  );
}
