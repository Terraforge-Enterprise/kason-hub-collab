import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Receipt, FileText } from "lucide-react";
import { formatRM, formatDateMY } from "@/components/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { portalApiFetch } from "@/lib/portal-api";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { usePortalCharges, isOverdueCharge, type ChargeItem } from "./use-billing-data";
import { ChargeDrawer } from "./charge-drawer";

const TH = "px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]";
const TD = "px-4 py-3.5 text-sm text-[var(--text-primary)]";
// Money columns right-align with lined-up digits — this tab was the outlier
// among its siblings (payments/charges/statement all use text-right).
const TH_MONEY = `${TH} text-right`;
const TD_MONEY = `${TD} text-right tabular-nums`;

type StatusBucket = "paid" | "credited" | "overdue" | "partial" | "unpaid";
type StatusFilterValue = "all" | "unpaid" | "paid" | "overdue";

const STATUS_FILTERS: { value: StatusFilterValue; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "unpaid", label: "Unpaid" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
];

// Status bucket derivation (tenant-facing labels + Badge tone). "Paid" and
// "Overdue" are DERIVED conditions (balance / isOverdueCharge), not raw enum
// values — getStatusTone can't know about them, so this task owns a small,
// self-contained bucket→label/tone map instead of forcing them through it.
//
// - "credited" takes priority over the outstanding<=0 check: a charge fully
//   offset by a credit note is NOT the same as tenant-paid (a reviewer-audit
//   finding) — it's its own resolved state, excluded from both Paid and
//   Unpaid filters (only visible under "All").
// - isOverdueCharge only flags status==="posted" as overdue-eligible (a T5
//   contract this task reuses, not redefines) — a past-due "partial" charge
//   is real and still counted as owed, just bucketed as "unpaid" rather than
//   "overdue" (documented gap, not an oversight).
function chargeBucket(charge: ChargeItem): StatusBucket {
  if (charge.status === "credited") return "credited";
  if (charge.outstandingAmount <= 0) return "paid";
  if (isOverdueCharge(charge)) return "overdue";
  if (charge.status === "partial" || charge.status === "partially_paid") return "partial";
  return "unpaid";
}

const STATUS_DISPLAY: Record<StatusBucket, { label: string; tone: "emerald" | "amber" | "rose" | "sky" }> = {
  paid: { label: "Paid", tone: "emerald" },
  credited: { label: "Credited", tone: "rose" },
  overdue: { label: "Overdue", tone: "rose" },
  partial: { label: "Partially paid", tone: "amber" },
  unpaid: { label: "Unpaid", tone: "sky" },
};

function matchesStatusFilter(bucket: StatusBucket, filter: StatusFilterValue): boolean {
  if (filter === "all") return true;
  if (filter === "paid") return bucket === "paid";
  if (filter === "overdue") return bucket === "overdue";
  if (filter === "unpaid") return bucket === "unpaid" || bucket === "partial";
  return true;
}

export function InvoicesTab() {
  const { data, isLoading, isError, error } = usePortalCharges(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");
  const [openChargeId, setOpenChargeId] = useState<string | null>(null);

  // void/voided charges are hidden unconditionally (Appendix A §Billing
  // Invoices: "void/voided rows HIDDEN") — never shown under any filter.
  const nonVoidCharges = useMemo(
    () => (data?.data ?? []).filter((c) => c.status !== "void" && c.status !== "voided"),
    [data],
  );

  const charges = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nonVoidCharges.filter((c) => {
      if (!matchesStatusFilter(chargeBucket(c), statusFilter)) return false;
      if (!q) return true;
      return (
        // documentNumber FIRST: it is what the Document column shows and therefore
        // what a tenant types when searching for "IVTEN-0002". chargeNumber stays
        // searchable so an admin walking a tenant through a ticket can still paste
        // the internal id, even though no column prints it any more.
        (c.documentNumber ?? "").toLowerCase().includes(q) ||
        c.chargeNumber.toLowerCase().includes(q) ||
        c.chargeType.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [nonVoidCharges, search, statusFilter]);

  if (isLoading) return <InvoicesTabSkeleton />;

  // A failed fetch must NEVER render as the zero-charges EmptyState — that
  // would silently tell the tenant "you owe nothing" when the server call
  // actually failed (a reviewer-audit finding on this money-adjacent list).
  if (isError) {
    return (
      <div className="space-y-6">
        <Callout variant="danger" title="Couldn't load your charges">
          {(error as Error)?.message || "Something went wrong. Please try again."}
        </Callout>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm backdrop-blur-sm focus-within:border-primary sm:flex-none sm:w-72">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoices…"
            aria-label="Search invoices"
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilterValue)}
          aria-label="Filter by status"
          className="rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm text-foreground backdrop-blur-sm outline-none focus:border-primary"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {nonVoidCharges.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No invoices or charges yet"
          description="Invoices and charges for your tenancy will appear here."
        />
      ) : charges.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching charges"
          description="Try a different search term or status filter."
        />
      ) : (
        <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
              <tr>
                <th className={TH}>Document</th>
                <th className={TH}>Description</th>
                <th className={TH}>Due</th>
                <th className={TH_MONEY}>Total</th>
                <th className={TH_MONEY}>Balance</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => {
                const display = STATUS_DISPLAY[chargeBucket(c)];
                return (
                  <tr
                    key={c.id}
                    onClick={() => setOpenChargeId(c.id)}
                    className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)] cursor-pointer"
                  >
                    {/* The header says "Document", so print the DOCUMENT number.
                        It used to print `chargeNumber` — an internal key that for
                        grid-minted rows embeds raw UUIDs, so this column showed
                        `GRIDEXP-202608-360f0307-…-SST` under a heading promising the
                        tenant their invoice number. */}
                    <td className={`${TD} font-medium`}>{c.documentNumber ?? "—"}</td>
                    <td className={TD}>{c.description || c.chargeType}</td>
                    <td className={TD}>{formatDateMY(c.dueDate)}</td>
                    {/* CN/DN-adjusted — matches the Balance's basis so Total − payments = Balance. */}
                    <td className={TD_MONEY}>{formatRM(c.adjustedAmount ?? c.amount)}</td>
                    <td className={TD_MONEY}>{formatRM(c.outstandingAmount)}</td>
                    <td className={TD}>
                      <Badge variant={display.tone}>{display.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS") && <BillingDocumentsSection />}

      {openChargeId && <ChargeDrawer chargeId={openChargeId} onClose={() => setOpenChargeId(null)} />}
    </div>
  );
}

function InvoicesTabSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-9 w-full max-w-md bg-muted rounded-md" />
      <div className="h-64 bg-muted rounded-xl" />
    </div>
  );
}

// --- Relocated "Billing documents" subsection (spec R13) --------------------
// Task 9 removed the equivalent <BillingDocumentsSection> from Documents
// (Appendix A §4: "Invoices, receipts, debit/credit notes should NOT appear
// there") — this is its new home, restyled to the current design system.
// Silent (renders nothing) when the flag is off or the list is empty, same
// as the section it replaces.

type BillingDocItem = {
  id: string;
  docType: string;
  documentNumber: string;
  status: string;
  issuedAt: string;
  billingMonth: string | null;
  total: string;
  reason: string | null;
  originalDocumentNumber: string | null;
  /** Credit notes only: unspent balance still on this note. null ⇒ nothing to spend. */
  creditRemaining: string | null;
};

const BILLING_DOC_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  debit_note: "Debit Note",
  credit_note: "Credit Note",
  refund_note: "Refund Note",
  receipt: "Receipt",
};

// The BillingDocument legacy `status` enum (schema comment: "issued |
// partially_settled | settled | offset") is already tenant-presentable —
// this just adds Title Case + a Badge tone per bucket.
type BillingDocTone = "emerald" | "amber" | "rose" | "sky" | "outline";

const BILLING_DOC_STATUS: Record<string, { label: string; tone: BillingDocTone }> = {
  issued: { label: "Issued", tone: "sky" },
  partially_settled: { label: "Partially settled", tone: "amber" },
  settled: { label: "Settled", tone: "emerald" },
  offset: { label: "Offset", tone: "rose" },
};

// `total` arrives as a STRING (e.g. "1060.00"). formatRM only guards
// null/undefined, not NaN — an empty/garbled value would otherwise render
// the literal text "RM NaN" (reviewer-audit finding B24).
function safeParseMoney(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function BillingDocumentsSection() {
  const { data } = useQuery({
    queryKey: ["portal-billing-documents"],
    queryFn: () => portalApiFetch<{ data: { documents: BillingDocItem[] } }>("/documents/billing"),
  });
  // Declared above the early return — hooks cannot sit behind a conditional exit.
  const [pdfError, setPdfError] = useState<string | null>(null);
  const docs = data?.data.documents ?? [];
  if (docs.length === 0) return null;

  // Opened SYNCHRONOUSLY, before the await — /documents/billing/:id/pdf renders the
  // PDF on demand on first ask (53.8s cold vs 0.08s warm on UAT), long past the 5s
  // user-activation window, so a deferred open is silently swallowed by the popup
  // blocker. Same shape as owner-statement.tsx:239 and portal/documents.tsx.
  async function openPdf(id: string) {
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
      // Closing the pre-opened tab must not be the ONLY thing that happens — that
      // is the silent dead button this whole change exists to remove.
      win?.close();
      setPdfError((e as Error)?.message || "Couldn't open that document. Please try again.");
    }
  }

  return (
    <Card className="bg-background/60 backdrop-blur-xl border-border/50 shadow-xl">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" />
          Billing documents
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {pdfError && (
          <Callout variant="danger" title="Couldn't open that document">
            {pdfError}
          </Callout>
        )}
        {docs.map((d) => {
          // "outline" (a real, neutral Badge variant — matches the same
          // unknown-status passthrough precedent in statement-documents-
          // card.tsx) rather than a made-up token Badge doesn't define.
          const display = BILLING_DOC_STATUS[d.status] ?? { label: d.status, tone: "outline" as const };
          return (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3 backdrop-blur-sm transition-all hover:bg-background/60 hover:border-border/80"
            >
              <div className="min-w-0">
                <span className="text-sm font-medium text-foreground">{d.documentNumber}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {BILLING_DOC_TYPE_LABEL[d.docType] ?? d.docType}
                </span>
                {d.reason && <span className="ml-2 text-xs text-muted-foreground">({d.reason})</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-sm tabular-nums text-foreground">{formatRM(safeParseMoney(d.total))}</span>
                {/* A credit note's `total` only says a credit was ISSUED, which
                    reads as history. This says the money is still sitting on the
                    tenant's account waiting to come off a future bill — the
                    difference between "you were credited once" and "you hold
                    this". Absent once the note is fully spent. */}
                {d.creditRemaining && (
                  <Badge variant="emerald" data-testid="credit-remaining">
                    {formatRM(safeParseMoney(d.creditRemaining))} available
                  </Badge>
                )}
                <Badge variant={display.tone}>{display.label}</Badge>
                <Button variant="outline" size="sm" onClick={() => void openPdf(d.id)}>
                  PDF
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
