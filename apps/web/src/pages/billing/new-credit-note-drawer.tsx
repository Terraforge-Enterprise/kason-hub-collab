// New credit note drawer (P4, spec R12) — accountant issues a manual
// overpayment Credit Note against an invoice/debit_note. The API wall +
// row-lock + idempotency are the real boundary; this UI just posts a
// well-formed request. creditAmount defaults server-side to the CN total.
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCreateCreditNote } from "@/api/billing-documents";
import type { CreateCreditNoteInput } from "@kason/shared";

export type CreditNoteInvoiceRef = {
  id: string;
  partyId: string;
  counterpartyType: "tenant" | "owner";
  documentNumber: string;
};

export function NewCreditNoteDrawer({
  open,
  invoice,
  onClose,
}: {
  open: boolean;
  invoice: CreditNoteInvoiceRef | null;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateCreditNote();

  if (!open || !invoice) return null;

  function submit() {
    if (!invoice) return;
    if (!amount.trim()) {
      setError("Amount is required.");
      return;
    }
    if (!reason.trim()) {
      setError("Reason is required.");
      return;
    }
    setError(null);
    const input: CreateCreditNoteInput = {
      originalDocumentId: invoice.id,
      partyId: invoice.partyId,
      counterpartyType: invoice.counterpartyType,
      lines: [{ description: "Overpayment credit", amount: amount.trim() }],
      reason: reason.trim(),
      idempotencyKey: crypto.randomUUID(),
    };
    create.mutate(input, {
      onSuccess: (res) => {
        toast.success(`Credit note ${res.data.documentNumber} issued`);
        setAmount("");
        setReason("");
        onClose();
      },
      onError: () => toast.error("Couldn't create the credit note. Refresh and try again."),
    });
  }

  const inputCls =
    "rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm text-[var(--text-primary)]";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-label="New credit note">
      <div className="h-full w-full max-w-md space-y-4 overflow-y-auto bg-[var(--card-bg)] p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">New credit note</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Against invoice <span className="font-medium">{invoice.documentNumber}</span> — issues a spendable credit for an overpaid amount.
        </p>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          Amount (RM)
          <input aria-label="Amount" className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          Reason
          <input aria-label="Reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex gap-2">
          <Button onClick={submit} disabled={create.isPending}>Create credit note</Button>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
