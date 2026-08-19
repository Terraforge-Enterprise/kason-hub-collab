import { useMemo, useState } from "react";
import { FileText, FolderOpen, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { portalApiFetch, portalApiUrl } from "@/lib/portal-api";
import { EmptyState } from "@/components/empty-state";
import { PillBar } from "@/components/ui/pill-bar";
import { formatDateMY } from "@/components/format";

// Tenant Documents.
//
// SUPERSEDES spec R13 (2026-08-17, user directive). R13 read: "Invoices, receipts,
// debit/credit notes must NOT appear on Documents — they live under Billing", and this
// page was stripped to tenancy paperwork only. The proforma work changes what a tenant
// needs from it: the document that proves they paid is now MINTED at the moment of
// payment, and a tenant looking for "my invoice" goes to Documents.
//
// So the page renders BOTH sources, merged newest-first:
//   - GET /documents        — tenancy files (agreement, house rules, handover, notices)
//   - GET /documents/billing — issued billing documents (proforma, invoice, receipt, notes)
//
// The Billing > Invoices tab still exists and still works; this is additive. Removing
// that tab is a separate, separately-approved change.

type DocItem = {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  label: string | null;
  createdAt: string;
};

/** An issued billing document (GET /documents/billing). Its file lives behind a signed
 *  URL, not a storage key, so it opens through a different route than a tenancy file. */
type BillingDocItem = {
  id: string;
  docType: string;
  documentNumber: string;
  issuedAt: string;
  total: string;
};

type DocTypeFilter = "all" | "billing" | "agreements" | "notices" | "handover" | "other";

const TYPE_FILTERS: { value: DocTypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "billing", label: "Invoices & receipts" },
  { value: "agreements", label: "Agreements" },
  { value: "notices", label: "Notices" },
  { value: "handover", label: "Handover" },
  { value: "other", label: "Other" },
];

/** Customer-facing label per docType. "proforma" reads as what it is — a request for
 *  payment — so a tenant can tell it from the tax invoice minted when they pay. */
const DOC_TYPE_LABEL: Record<string, string> = {
  proforma: "Proforma invoice",
  invoice: "Invoice",
  debit_note: "Debit note",
  credit_note: "Credit note",
  refund_note: "Refund note",
  receipt: "Receipt",
};

/** Client-side classification on label/fileName keywords (Appendix A §4). */
function classifyDoc(doc: DocItem): Exclude<DocTypeFilter, "all"> {
  const text = (doc.label || doc.fileName || "").toLowerCase();
  if (text.includes("agreement")) return "agreements";
  if (text.includes("notice")) return "notices";
  if (text.includes("handover")) return "handover";
  return "other";
}

function DocumentsPageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-56 bg-muted rounded" />
      <div className="h-9 w-full max-w-md bg-muted rounded-md" />
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export default function PortalDocumentsPage() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<DocTypeFilter>("all");
  const [pdfError, setPdfError] = useState<string | null>(null);
  // Which row is mid-open. A cold render can take the better part of a minute, and
  // every extra click starts another one — so the row that is working says so.
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-documents"],
    queryFn: () => portalApiFetch<{ data: DocItem[] }>("/documents"),
  });

  const billingQuery = useQuery({
    queryKey: ["portal-documents", "billing"],
    queryFn: () => portalApiFetch<{ data: { documents: BillingDocItem[] } }>("/documents/billing"),
  });

  const docs = data?.data ?? [];
  const billingDocs = billingQuery.data?.data.documents ?? [];

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((d) => {
      if (typeFilter !== "all" && classifyDoc(d) !== typeFilter) return false;
      if (q && !(d.label || d.fileName).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [docs, search, typeFilter]);

  const filteredBilling = useMemo(() => {
    const q = search.trim().toLowerCase();
    return billingDocs.filter((d) => {
      if (typeFilter !== "all" && typeFilter !== "billing") return false;
      if (q && !`${d.documentNumber} ${DOC_TYPE_LABEL[d.docType] ?? d.docType}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [billingDocs, search, typeFilter]);

  /**
   * Billing PDFs live behind a signed URL, so the link is fetched on click rather
   * than rendered as an href.
   *
   * The tab is opened SYNCHRONOUSLY, before the await — same shape as
   * owner-statement.tsx:239, and for the same reason. GET /documents/billing/:id/pdf
   * RENDERS the document on demand the first time anyone asks for it: measured on UAT,
   * 53.8s cold vs 0.08s warm. Chrome only carries user activation for 5s and Safari
   * does not carry it across an await at all, so a `window.open` deferred until after
   * the fetch is treated as non-user-initiated and blocked — the tenant gets no tab,
   * no error and no spinner while the server quietly renders and caches the PDF.
   */
  async function openBillingPdf(id: string) {
    setPdfError(null);
    setOpeningId(id);
    const win = window.open("about:blank", "_blank");
    try {
      const res = await portalApiFetch<{ data: { downloadUrl: string } }>(`/documents/billing/${id}/pdf`);
      if (win) {
        // Severing the opener is what the old call's "noopener" bought us; a tab we
        // have to navigate ourselves cannot ask for it in the features string.
        win.opener = null;
        win.location.href = res.data.downloadUrl;
      } else {
        // Blocker set to "block all" — navigating this tab beats swallowing the click.
        window.location.assign(res.data.downloadUrl);
      }
    } catch {
      win?.close();
      setPdfError("We couldn't open that document. Please try again in a moment.");
    } finally {
      setOpeningId(null);
    }
  }

  // Only the tenancy-file query blocks the page. A billing-document failure must not
  // hide the agreement a tenant came here for, so it degrades to an empty section.
  if (isLoading) return <DocumentsPageSkeleton />;
  if (error) return <p className="text-sm text-destructive">{(error as Error).message}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-foreground flex items-center gap-3">
          <FolderOpen className="h-8 w-8 text-primary" />
          Documents
        </h1>
        <p className="text-muted-foreground mt-1">Your invoices, receipts, tenancy agreement and notices.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm backdrop-blur-sm focus-within:border-primary sm:flex-none sm:w-72">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <PillBar
          value={[typeFilter]}
          onChange={(next) => setTypeFilter(next[next.length - 1] ?? "all")}
          options={TYPE_FILTERS}
          ariaLabel="Filter by document type"
          size="sm"
        />
      </div>

      {pdfError && (
        <p role="alert" className="text-sm text-destructive">
          {pdfError}
        </p>
      )}

      {filteredBilling.length > 0 && (
        <div className="space-y-2" data-testid="portal-billing-documents">
          {filteredBilling.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80"
            >
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {DOC_TYPE_LABEL[d.docType] ?? d.docType} · {d.documentNumber}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDateMY(d.issuedAt)} · RM {d.total}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void openBillingPdf(d.id)}
                disabled={openingId === d.id}
                className="shrink-0 rounded-md border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {openingId === d.id ? "Opening…" : "View"}
              </button>
            </div>
          ))}
        </div>
      )}

      {filteredDocs.length === 0 && filteredBilling.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No documents yet"
          description="Your invoices, receipts and tenancy documents will appear here."
        />
      ) : (
        <div className="space-y-2">
          {filteredDocs.map((d) => {
            const fileUrl = portalApiUrl(`/files?key=${encodeURIComponent(d.storageKey)}`);
            return (
              <div
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{d.label || d.fileName}</span>
                    <span className="block text-xs text-muted-foreground">{formatDateMY(d.createdAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-border hover:text-foreground"
                  >
                    View
                  </a>
                  <a
                    href={fileUrl}
                    download
                    className="rounded-md border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-border hover:text-foreground"
                  >
                    Download
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
