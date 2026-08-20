import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { portalApiFetch } from "@/lib/portal-api";

type ChargeDetail = {
  id: string; chargeNumber: string; chargeType: string; description: string | null;
  status: string; dueDate: string; amount: number; outstandingAmount: number; currency: string; createdAt: string;
  documents?: { id: string; docType: string; documentNumber: string }[];
  creditApplications?: { amount: number; creditNoteNumber: string }[];
};

export default function PortalChargeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["portal-charge", id],
    queryFn: () => portalApiFetch<{ data: ChargeDetail }>(`/charges/${id}`),
  });

  const [method, setMethod] = useState("fpx");
  const [refNumber, setRefNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [showPay, setShowPay] = useState(false);

  const payMutation = useMutation({
    mutationFn: (payAmount: number) =>
      portalApiFetch(`/charges/${id}/pay`, {
        method: "POST",
        body: JSON.stringify({
          amount: payAmount,
          paymentMethod: method,
          referenceNumber: refNumber,
          notes: notes || undefined,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portal-charge", id] });
      queryClient.invalidateQueries({ queryKey: ["portal-charges"] });
      setShowPay(false);
      navigate("/portal/payments");
    },
  });

  if (isLoading) return <div className="animate-pulse text-sm">Loading...</div>;

  const charge = data?.data;
  if (!charge) return <p className="text-sm text-[var(--text-secondary)]">Charge not found.</p>;

  const canPay = ["posted", "partial", "partially_paid"].includes(charge.status) && charge.outstandingAmount > 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Charge {charge.chargeNumber}</h1>

      <div className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] p-6 space-y-3">
        <Row label="Type" value={charge.chargeType} />
        <Row label="Description" value={charge.description ?? "—"} />
        <Row label="Due Date" value={charge.dueDate.slice(0, 10)} />
        <Row label="Amount" value={`RM ${charge.amount.toFixed(2)}`} />
        <Row label="Outstanding" value={`RM ${charge.outstandingAmount.toFixed(2)}`} />
        <Row label="Status" value={charge.status} />
      </div>

      {(charge.documents?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] p-6 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Documents</h2>
          {charge.documents!.map((d) => (
            <Row
              key={d.id}
              label={d.docType === "credit_note" ? "Credit Note" : d.docType === "refund_note" ? "Refund Note" : d.docType === "invoice" ? "Invoice" : "Debit Note"}
              value={d.documentNumber}
            />
          ))}
          {charge.status === "credited" && (
            <p className="text-xs text-[var(--text-secondary)]">
              This charge was voided — the Credit Note above offsets it in full.
            </p>
          )}
        </div>
      )}

      {(charge.creditApplications?.length ?? 0) > 0 && (
        <div className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] p-6 space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Credit applied</h2>
          {charge.creditApplications!.map((a, i) => (
            <Row key={i} label={`Credit applied — ${a.creditNoteNumber}`} value={`RM ${a.amount.toFixed(2)}`} />
          ))}
        </div>
      )}

      {canPay && !showPay && (
        <button onClick={() => setShowPay(true)} className="rounded-md bg-[var(--gold)] px-4 py-2 text-sm font-medium text-[var(--gold-fg)]">
          Submit Payment
        </button>
      )}

      {showPay && (
        <form
          onSubmit={(e) => { e.preventDefault(); payMutation.mutate(charge.outstandingAmount); }}
          className="rounded-lg bg-[var(--card-bg)] border border-[var(--card-border)] p-6 space-y-4"
        >
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Submit Payment</h2>

          {payMutation.error && (
            <div className="text-sm text-red-400">{(payMutation.error as Error).message}</div>
          )}

          <div>
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Amount</label>
            {/* Locked to the full outstanding balance — partial payments are
                not permitted on this surface (mirrors the Pay Charges basket
                lock). No input: the tenant cannot edit this value. */}
            <div className="flex items-center gap-1 text-sm text-[var(--text-primary)]">
              <span className="text-xs text-[var(--text-secondary)]">RM</span>
              <span className="font-medium tabular-nums">{charge.outstandingAmount.toFixed(2)}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Payment Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]">
              <option value="fpx">FPX</option>
              <option value="bank_transfer">Bank Transfer</option>
              <option value="cash">Cash</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Reference Number *</label>
            <input type="text" required maxLength={100} value={refNumber} onChange={(e) => setRefNumber(e.target.value)} className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]" />
          </div>

          <div>
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Notes (optional)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]" />
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={payMutation.isPending} className="rounded-md bg-[var(--gold)] px-4 py-2 text-sm font-medium text-[var(--gold-fg)] disabled:opacity-50">
              {payMutation.isPending ? "Submitting..." : "Submit for Approval"}
            </button>
            <button type="button" onClick={() => setShowPay(false)} className="rounded-md border border-[var(--input-border)] px-4 py-2 text-sm text-[var(--text-secondary)]">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-[var(--page-bg)] pb-2 last:border-0">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <span className="text-sm font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
