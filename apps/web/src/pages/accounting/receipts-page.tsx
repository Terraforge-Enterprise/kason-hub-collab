// Receipts register + payment entry points (R9).
//
// TWO ways to record a payment live on this page:
//   • PRIMARY — "Receive payment" (payer-first): pick a tenant/owner, load ALL
//     their open charges, and spread one received amount across them. No invoice
//     needed. Mounts <ReceivePaymentDrawer/>.
//   • SECONDARY — "Record transfer" (invoice-first shortcut): pick ONE issued
//     invoice from the register and record a transfer against that invoice's
//     lines. Mounts <TransferFromInvoiceDrawer/> bound to one document id.
//
// The receipts register (docType=receipt) lists issued receipts in a proper
// accounting table. Clicking a row opens the read-only DocumentDetailDrawer
// (allocated line items + totals + Download PDF). Both the register and the
// invoice picker carry search + status filter + server-side pagination via
// useBillingDocuments' q/status/page/pageSize (the hook + route already support
// these and return `total`), mirroring invoices-page.
//
// R9 (Task 12) — each receipt row carries three correction actions:
//   • Reverse       → useReverseAllocation (POST …/allocations/:id/reverse)
//   • Void payment  → useVoidPayment (PUT …/status {status:"void"}) — VOID ONLY
//   • Refund        → opens the CorrectInvoiceDrawer's REFUND strategy
// Void ≠ Refund (user decision): "Void payment" is a raw status change; a genuine
// outgoing refund is the REFUND correction strategy (a Refund Note), reached via
// the "Refund" action → CorrectInvoiceDrawer, never `status:"refunded"`.
import { useState } from "react";
import { Receipt } from "lucide-react";
import type { BillingDocumentListItem } from "@kason/shared";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { ListFilterBar, filterControlClass, type ListFilterState } from "@/components/list-filter-bar";
import { useBillingDocuments } from "@/api/billing-documents";
import { DocsFilterControls, type DocsFilterValue } from "./docs-filter-controls";
import { ReceivePaymentDrawer } from "./receive-payment-drawer";
import { TransferFromInvoiceDrawer } from "./transfer-from-invoice-drawer";
import { ReceiptRowActions } from "./receipt-row-actions";
import { CorrectInvoiceDrawer } from "./correct-invoice-drawer";
import { DocumentsTable } from "./document-shared";
import { DocumentDetailDrawer } from "./document-detail-drawer";

const PAGE_SIZE = 25;

// The status axis is the legacy BillingDocumentStatus enum
// ("issued" | "partially_settled" | "settled" | "offset"); there is no single
// "outstanding" server value, so the filter offers the concrete statuses.
// Shared between the receipts register and the invoice picker (same enum).
function StatusFilterSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={filterControlClass}
      aria-label="Status"
    >
      <option value="all">All statuses</option>
      <option value="issued">Issued (outstanding)</option>
      <option value="partially_settled">Partially settled (outstanding)</option>
      <option value="settled">Settled</option>
      <option value="offset">Offset</option>
    </select>
  );
}

const EMPTY_FILTER: ListFilterState = { search: "", sort: "", order: "desc", extras: { status: "all" } };

const RECEIPT_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "issued", label: "Issued" },
  { value: "settled", label: "Settled" },
  { value: "offset", label: "Offset" },
];

export default function AccountingReceiptsPage() {
  // Payer-first primary flow.
  const [receiveOpen, setReceiveOpen] = useState(false);
  // Invoice-first secondary flow: the picker + the bound transfer drawer.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recordDocId, setRecordDocId] = useState<string | null>(null);
  // R9 Refund → the CorrectInvoiceDrawer defaulting to the REFUND strategy.
  const [refundDoc, setRefundDoc] = useState<BillingDocumentListItem | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<BillingDocumentListItem | null>(null);

  // ── Receipts register: tabs + filters + server pagination ──────────────────
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<DocsFilterValue>({});

  const query = useBillingDocuments({
    docType: "receipt",
    ...filter,
    page,
    pageSize: PAGE_SIZE,
  });
  const items = query.data?.data.items ?? [];
  const total = query.data?.data.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Any filter change resets to page 1 so a narrowed result set never lands the
  // user on an out-of-range page.
  function onFilterChange(next: DocsFilterValue) {
    setPage(1);
    setFilter(next);
  }

  // ── Invoice picker (secondary "Record transfer"): its OWN searchable +
  // status-filtered + paginated register. Same shape as invoices-page, but the
  // picker stays docType:"invoice" because TransferFromInvoiceDrawer binds to a
  // single invoice documentId — do NOT swap its data source.
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerFilter, setPickerFilter] = useState<ListFilterState>(EMPTY_FILTER);
  const pickerQ = pickerFilter.search.trim();
  const pickerStatusExtra = String(pickerFilter.extras.status ?? "all");
  const pickerStatus = pickerStatusExtra === "all" ? undefined : pickerStatusExtra;

  const invoicesQuery = useBillingDocuments(
    pickerOpen
      ? {
          docType: "invoice",
          q: pickerQ || undefined,
          status: pickerStatus,
          page: pickerPage,
          pageSize: PAGE_SIZE,
        }
      : undefined,
  );
  const invoiceItems = invoicesQuery.data?.data.items ?? [];
  const invoiceTotal = invoicesQuery.data?.data.total ?? 0;
  const invoicePageCount = Math.max(1, Math.ceil(invoiceTotal / PAGE_SIZE));

  function onPickerFilterChange(next: ListFilterState) {
    const searchChanged = next.search.trim() !== pickerQ;
    const statusChanged = String(next.extras.status ?? "all") !== pickerStatusExtra;
    if (searchChanged || statusChanged) setPickerPage(1);
    setPickerFilter(next);
  }

  function openPicker() {
    // Fresh picker each time — reset its filter + page so a prior search doesn't
    // leak into the next invoice hunt.
    setPickerFilter(EMPTY_FILTER);
    setPickerPage(1);
    setPickerOpen(true);
  }

  function recordAgainst(d: BillingDocumentListItem) {
    setRecordDocId(d.id);
    setPickerOpen(false);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Receipt}
        title="Receipts"
        description="Receive a payment from a payer and apply it across their open charges — a receipt is issued. Or record a payment against a single invoice. Click any row to open the full receipt."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="gold" onClick={() => setReceiveOpen(true)}>
              Receive payment
            </Button>
            <Button variant="outline" onClick={openPicker}>
              Record from invoice
            </Button>
          </div>
        }
      />

      {pickerOpen ? (
        <Surface
          title="Choose an invoice to record against"
          description="Record a payment against a single invoice's lines. Search, filter by status, or page through the register."
          actions={
            <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
              Cancel
            </Button>
          }
        >
          <div className="space-y-4">
            <ListFilterBar
              value={pickerFilter}
              onChange={onPickerFilterChange}
              searchPlaceholder="Search invoice # or party name..."
              hideDateRange
              extras={
                <StatusFilterSelect
                  value={pickerStatusExtra}
                  onChange={(next) =>
                    onPickerFilterChange({
                      ...pickerFilter,
                      extras: { ...pickerFilter.extras, status: next },
                    })
                  }
                />
              }
            />

            {invoicesQuery.isLoading ? (
              <div className="h-40 animate-pulse rounded-lg bg-[var(--card-bg)]" />
            ) : (
              <DocumentsTable
                items={invoiceItems}
                onRowClick={recordAgainst}
                emptyLabel="No invoices match your filters."
                renderActions={(d) => (
                  <Button variant="outline" size="sm" onClick={() => recordAgainst(d)}>
                    Record
                  </Button>
                )}
              />
            )}

            <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <span>
                Page {pickerPage} of {invoicePageCount} — {invoiceTotal} invoice(s)
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pickerPage <= 1}
                  onClick={() => setPickerPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pickerPage >= invoicePageCount}
                  onClick={() => setPickerPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        </Surface>
      ) : null}

      <Surface title="Issued receipts">
        <div className="space-y-4">
          <DocsFilterControls
            statusOptions={RECEIPT_STATUS_OPTIONS}
            searchPlaceholder="Search receipt #, name, or phone…"
            onChange={onFilterChange}
          />

          {query.isLoading ? (
            <div className="h-40 animate-pulse rounded-lg bg-[var(--card-bg)]" />
          ) : (
            <DocumentsTable
              items={items}
              onRowClick={setSelectedDoc}
              emptyLabel="No receipts match your filters."
              renderActions={(d) => <ReceiptRowActions doc={d} onRefund={() => setRefundDoc(d)} />}
            />
          )}

          <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>
              Page {page} of {pageCount} — {total} receipt(s)
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </Surface>

      <DocumentDetailDrawer doc={selectedDoc} onClose={() => setSelectedDoc(null)} />

      {/* PRIMARY payer-first flow — no invoice needed. Mounted only while open
          (like the transfer drawer) so its payer-charges query + record hooks
          stay idle until the accountant actually opens it. */}
      {receiveOpen ? (
        <ReceivePaymentDrawer open onClose={() => setReceiveOpen(false)} />
      ) : null}

      {/* SECONDARY invoice-first flow — bound to one picked invoice's documentId. */}
      {recordDocId ? (
        <TransferFromInvoiceDrawer open documentId={recordDocId} onClose={() => setRecordDocId(null)} />
      ) : null}
      {/* R9 Refund (Void ≠ Refund): a genuine refund is the REFUND correction
          strategy, opened here on the receipt's document, NOT a raw status change. */}
      <CorrectInvoiceDrawer doc={refundDoc} onClose={() => setRefundDoc(null)} defaultStrategy="REFUND" />
    </div>
  );
}
