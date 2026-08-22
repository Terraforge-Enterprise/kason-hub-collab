// Manual invoices register — create + view (R11). The New-Invoice drawer (T7)
// mounts via the CTA; this shell lists the counterparty's bill documents —
// docTypes = invoice (IVTEN/IVOWN) + debit_note (DEP: rent/aircond/utilities) —
// in a proper accounting table (Document · Bill To · Property · Unit · Period · Issued ·
// Total). Clicking a row opens the DocumentDetailDrawer, which is the SINGLE
// container for acting on a document — line items, Payments, Adjustments and
// Activity all live in its tabs. The register carries NO row actions: the old
// "Correct" wizard duplicated the Adjustments tab (its CREDIT_ADJUSTMENT /
// DEBIT_ADJUSTMENT strategies are exactly that tab's inline add-row), so its
// entry point was removed from this page. CorrectInvoiceDrawer itself still
// ships — the Receipts page mounts it for the REFUND strategy.
//
// Search (document number OR party name), a status filter, and server-side
// pagination are wired through useBillingDocuments' q/status/page/pageSize —
// the hook + route already support these and return `total` (spec §4.x). The
// status axis is the legacy BillingDocumentStatus enum
// ("issued" | "partially_settled" | "settled" | "offset"); there is no single
// "outstanding" server value, so the filter offers the concrete statuses —
// "Issued" + "Partially settled" together are the outstanding set.
import { useState, type KeyboardEvent } from "react";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";
import type { BillingDocumentListItem } from "@kason/shared";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isInvoiceAdjustmentsEnabled } from "@/lib/feature-flags";
import { useBillingDocuments, type BillingDocumentFilters } from "@/api/billing-documents";
import { DocsFilterControls, type DocsFilterValue } from "./docs-filter-controls";
import { NewInvoiceDrawer } from "./new-invoice-drawer";
import { DocumentsTable } from "./document-shared";
import { DocumentDetailDrawer } from "./document-detail-drawer";
import { downloadAllAccountingTransactions } from "@/api/accounting-export";

const PAGE_SIZE = 25;

const INVOICE_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "issued", label: "Issued (outstanding)" },
  { value: "partially_settled", label: "Partially settled (outstanding)" },
  { value: "settled", label: "Settled" },
  { value: "offset", label: "Offset" },
];

// ── Register doc-type facets (Phase 1.6, spec D3) ───────────────────────────
// A SEPARATE control from the party (All/Tenant/Owner) tabs inside
// DocsFilterControls — this axis picks WHICH document types are listed, not WHO
// they're billed to. "Invoices" is the default and reproduces today's hardcoded
// query exactly (docTypes invoice+debit_note, primaryOnly, activeOnly); the other
// three facets are new, flag-gated visibility onto documents that already exist
// in the register's data model.
type DocTypeFacet = "all" | "invoices" | "proformas" | "creditNotes" | "debitNotes";

const DOC_TYPE_FACETS: { id: DocTypeFacet; label: string }[] = [
  { id: "all", label: "All documents" },
  { id: "invoices", label: "Invoices" },
  { id: "proformas", label: "Proforma" },
  { id: "creditNotes", label: "Credit notes" },
  { id: "debitNotes", label: "Debit notes" },
];

function facetQueryParams(facet: DocTypeFacet): Partial<BillingDocumentFilters> {
  switch (facet) {
    case "creditNotes":
      // No primaryOnly: a credit note ALWAYS carries originalDocumentId (it points
      // at the invoice it corrects), so primaryOnly:true would filter every CN out.
      return { docType: "credit_note" };
    case "debitNotes":
      // primaryOnly:false (explicit): a debit note is BOTH a primary bill (rent/
      // utility DEP series) and a DEBIT_ADJUSTMENT correction note — this facet
      // shows both, unlike the Invoices facet which scopes to primary bills only.
      return { docType: "debit_note", primaryOnly: false };
    case "proformas":
      // Its own facet rather than riding the Invoices default: a proforma is a REQUEST
      // for payment that the workflow replaces at will, and mixing it into the register
      // an admin reads as "what did we bill" is exactly the confusion the split exists
      // to remove. activeOnly keeps replaced proformas out unless asked for.
      return { docType: "proforma", activeOnly: true };
    case "all":
      return { docTypes: ["invoice", "credit_note", "debit_note", "refund_note", "owner_expense_advice", "proforma"] };
    case "invoices":
    default:
      // OEA rides the DEFAULT facet deliberately: an owner-borne expense deducted from
      // rent must be visible where an admin looks for "what did we bill this month", not
      // hidden behind a secondary tab — that invisibility is the whole reason the
      // document exists. It is a primary document (no originalDocumentId), so
      // primaryOnly does not exclude it.
      return { docTypes: ["invoice", "debit_note", "owner_expense_advice"], primaryOnly: true, activeOnly: true };
  }
}

/**
 * Hand-rolled `role="tablist"` — mirrors the pattern already used in this
 * codebase (e.g. `document-detail-drawer.tsx`'s DrawerTabs / `owner-workspace.tsx`)
 * since no shared Tabs primitive exists. Arrow Left/Right + Home/End move focus
 * AND selection (roving tabIndex).
 */
function DocTypeFacetTabs({ value, onChange }: { value: DocTypeFacet; onChange: (v: DocTypeFacet) => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const count = DOC_TYPE_FACETS.length;
    const current = DOC_TYPE_FACETS.findIndex((f) => f.id === value);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onChange(DOC_TYPE_FACETS[(current + 1) % count].id);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onChange(DOC_TYPE_FACETS[(current - 1 + count) % count].id);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(DOC_TYPE_FACETS[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(DOC_TYPE_FACETS[count - 1].id);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Document type"
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-1 border-b border-border/50"
    >
      {DOC_TYPE_FACETS.map((f) => {
        const active = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(f.id)}
            className={cn(
              "relative -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

export default function AccountingInvoicesPage() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<BillingDocumentListItem | null>(null);

  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<DocsFilterValue>({});
  const adjustmentsOn = isInvoiceAdjustmentsEnabled();
  // Flag off (default) ⇒ facet is pinned to "invoices" and the tab strip below
  // isn't rendered at all — the query stays byte-for-byte the pre-cut hardcoded one.
  const [docTypeFacet, setDocTypeFacet] = useState<DocTypeFacet>("invoices");
  const effectiveFacet: DocTypeFacet = adjustmentsOn ? docTypeFacet : "invoices";

  function onFacetChange(next: DocTypeFacet) {
    setPage(1);
    setDocTypeFacet(next);
  }

  // The register spans both bill docTypes: `invoice` (IVTEN tenant / IVOWN owner) AND
  // `debit_note` (DEP — rent, aircond, utilities). Rent is routed to a DEP debit note
  // (pay_back_landlord family), so an approved rent draft mints a debit note, not an
  // IVTEN invoice; listing only `docType:"invoice"` hid every approved rent bill here.
  // primaryOnly + activeOnly scope it to PRIMARY, LIVE bills: correction/adjustment
  // notes (e.g. DEBIT_ADJUSTMENT debit notes that reuse a parent's charge) and
  // superseded/cancelled docs are excluded — they are not independent, payable bills.
  // That "Invoices" shape is also the default/only facet (facetQueryParams) when the
  // flag is off, so this call is unchanged from the pre-cut behavior in that case.
  const query = useBillingDocuments({
    ...facetQueryParams(effectiveFacet),
    ...filter,
    page,
    pageSize: PAGE_SIZE,
  });
  const items = query.data?.data.items ?? [];
  const total = query.data?.data.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // D3: a mixed facet's CN/DN rows show their own signed face amount + linked
  // invoice, never the plain unsigned total — the Invoices facet stays "current".
  const showAdjustmentFace = adjustmentsOn && effectiveFacet !== "invoices";

  // Any filter change resets to page 1 so a narrowed result set never lands the
  // user on an out-of-range page.
  function onFilterChange(next: DocsFilterValue) {
    setPage(1);
    setFilter(next);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={FileText}
        title="Invoices"
        description="Raise a manual invoice and review everything billed to tenants and owners — invoices plus rent and utility debit notes. Click any row to open the full document — record a payment or adjust it from inside."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await downloadAllAccountingTransactions();
                  toast.success("Accounting workbook downloaded.");
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not download accounting workbook.");
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download className="mr-2 h-4 w-4" />
              {exporting ? "Preparing…" : "Export all transactions"}
            </Button>
            <Button variant="gold" onClick={() => setDrawerOpen(true)}>New invoice</Button>
          </div>
        }
      />
      <Surface title="Issued invoices">
        <div className="space-y-4">
          {adjustmentsOn ? <DocTypeFacetTabs value={docTypeFacet} onChange={onFacetChange} /> : null}

          <DocsFilterControls
            statusOptions={INVOICE_STATUS_OPTIONS}
            searchPlaceholder="Search invoice #, name, or phone…"
            onChange={onFilterChange}
          />

          {query.isLoading ? (
            <div className="h-40 animate-pulse rounded-lg bg-[var(--card-bg)]" />
          ) : (
            <DocumentsTable
              items={items}
              onRowClick={setSelectedDoc}
              emptyLabel="No invoices match your filters."
              showAdjustmentFace={showAdjustmentFace}
            />
          )}

          <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>
              Page {page} of {pageCount} — {total} document(s)
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
      <NewInvoiceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
