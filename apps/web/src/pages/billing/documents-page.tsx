/**
 * Documents register (spec §4.2 Visibility) — Yannie's reconciliation/audit
 * surface. Server-paginated list of immutable BillingDocuments with
 * docType/status/month/search filters and on-demand PDF links.
 * Flag-gated: route only registers when VITE_ENABLE_PHASE2_BILLING_DOCS is on.
 */
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader, StatusPill, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/components/format";
import {
  fetchBillingDocumentPdfUrl,
  useBillingDocuments,
  type BillingDocumentFilters,
} from "@/api/billing-documents";
import { NewCreditNoteDrawer, type CreditNoteInvoiceRef } from "./new-credit-note-drawer";

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  debit_note: "Debit Note",
  credit_note: "Credit Note",
  refund_note: "Refund Note",
  receipt: "Receipt",
};

const STATUS_TONE: Record<string, "emerald" | "amber" | "rose" | "sky" | "slate"> = {
  issued: "sky",
  partially_settled: "amber",
  settled: "emerald",
  offset: "rose",
};

const PAGE_SIZE = 25;

export default function BillingDocumentsPage() {
  const [docType, setDocType] = useState("");
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [cnInvoice, setCnInvoice] = useState<CreditNoteInvoiceRef | null>(null);

  const filters: BillingDocumentFilters = {
    docType: docType || undefined,
    status: status || undefined,
    month: month || undefined,
    q: q || undefined,
    page,
    pageSize: PAGE_SIZE,
  };
  const query = useBillingDocuments(filters);
  const items = query.data?.data.items ?? [];
  const total = query.data?.data.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function openPdf(id: string) {
    try {
      const url = await fetchBillingDocumentPdfUrl(id);
      window.open(url, "_blank", "noopener");
    } catch {
      toast.error("Couldn't generate the PDF. Try again.");
    }
  }

  const selectCls =
    "rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1.5 text-sm text-[var(--text-primary)]";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <PageHeader
          title="Documents"
          description="Immutable invoices, debit notes, credit notes and refund notes — series-numbered, linked to their charges, never edited after issue."
          metrics={[{ label: "Documents", value: String(total), hint: "Matching current filters" }]}
        />
        <Button
          variant="outline"
          onClick={() => {
            const inv = items.find((d) => d.docType === "invoice");
            if (!inv) {
              toast.error("Filter to an invoice first, then create its credit note.");
              return;
            }
            setCnInvoice({ id: inv.id, partyId: inv.partyId, counterpartyType: inv.counterpartyType, documentNumber: inv.documentNumber });
          }}
        >
          New credit note
        </Button>
      </div>
      <NewCreditNoteDrawer open={cnInvoice !== null} invoice={cnInvoice} onClose={() => setCnInvoice(null)} />
      <Surface
        title="Register"
        description="Filter by type, status, month, or search a document number / counterparty."
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            Type
            <select aria-label="Type" className={selectCls} value={docType} onChange={(e) => { setDocType(e.target.value); setPage(1); }}>
              <option value="">All types</option>
              <option value="invoice">Invoice</option>
              <option value="debit_note">Debit Note</option>
              <option value="credit_note">Credit Note</option>
              <option value="refund_note">Refund Note</option>
              <option value="receipt">Receipt</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            Status
            <select aria-label="Status" className={selectCls} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              <option value="issued">Issued</option>
              <option value="partially_settled">Partially settled</option>
              <option value="settled">Settled</option>
              <option value="offset">Offset</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            Month
            <input aria-label="Month" type="month" className={selectCls} value={month} onChange={(e) => { setMonth(e.target.value); setPage(1); }} />
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
            Search
            <input
              aria-label="Search"
              className={selectCls}
              placeholder="Document # or counterparty…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
            />
          </label>
        </div>

        {query.isLoading ? (
          <div className="h-40 animate-pulse rounded-lg bg-[var(--card-bg)]" />
        ) : query.isError ? (
          <p className="text-sm text-rose-600">Failed to load documents. Please refresh.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">No documents match the current filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--card-border)] text-left text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                  <th className="px-3 py-2">Document #</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Counterparty</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2">Month</th>
                  <th className="px-3 py-2">Issued</th>
                  <th className="px-3 py-2 text-right">Total (RM)</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id} className="border-b border-[var(--card-border)]">
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)]">
                      {d.documentNumber}
                      {d.originalDocumentNumber && (
                        <span className="ml-2 text-xs text-[var(--text-secondary)]">↩ {d.originalDocumentNumber}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{DOC_TYPE_LABEL[d.docType] ?? d.docType}</td>
                    <td className="px-3 py-2">{d.partyName}</td>
                    <td className="px-3 py-2">{d.unitCode ?? "-"}</td>
                    <td className="px-3 py-2">{d.billingMonth ? d.billingMonth.slice(0, 7) : "-"}</td>
                    <td className="px-3 py-2">{formatDate(d.issuedAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.total}</td>
                    <td className="px-3 py-2">
                      <StatusPill tone={STATUS_TONE[d.status] ?? "slate"}>{d.status}</StatusPill>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => void openPdf(d.id)}>
                        PDF
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <span>
                Page {page} of {pageCount} — {total} document(s)
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </Surface>
    </div>
  );
}
