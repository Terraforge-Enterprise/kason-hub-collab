// DocumentDetailDrawer — the "click into a document" surface the register was
// missing. A read-only Sheet (same primitive FormDrawer is built on) that renders
// a BillingDocument as a proper accounting document: header, Bill-To / Property /
// Unit block, a line-items table, and Subtotal → SST → Total. "Download PDF"
// opens the richer server-rendered letterhead version.
//
// The clicked list row (`doc`) seeds the header/meta instantly; the full detail
// (line items + totals) streams in via useBillingDocument. Everything is
// null-guarded — the register legitimately carries nulls (manual invoice with no
// unit → no property/unit).
import { useRef, useState, type KeyboardEvent, type ReactNode, type ComponentType } from "react";
import {
  Building2,
  CalendarDays,
  Download,
  DoorOpen,
  Hash,
  Loader2,
  Paperclip,
  User,
} from "lucide-react";
import { toast } from "sonner";
import type { BillingDocumentDetail, BillingDocumentListItem } from "@kason/shared";
import { foldTaxLines } from "@kason/shared";
import { ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { isInvoiceAdjustmentsEnabled } from "@/lib/feature-flags";
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
import {
  TableWrap,
  DataTable,
  TableHead,
  HeadCell,
  BodyCell,
  Row,
  EmptyRow,
  StatusPill,
} from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { formatRM, formatDate } from "@/components/format";
import {
  useBillingDocument,
  fetchBillingDocumentPdfUrl,
  fetchBillingDocumentAttachmentUrl,
} from "@/api/billing-documents";
import { CounterpartyBadge } from "./document-shared";
import { docTypeLabel, documentKindLabel, statusMeta, formatBillingMonth, summariseDocumentUnits } from "./document-helpers";
import { LineItemsTab } from "./line-items-tab";
import { PaymentsTab } from "./payments-tab";
import { AdjustmentsTab } from "./adjustments-tab";
import { ActivityTab } from "./activity-tab";

function MetaItem({
  icon: Icon,
  label,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className={strong ? "text-base font-bold text-foreground" : "text-sm text-muted-foreground"}>
        {label}
      </span>
      <span
        className={
          strong
            ? "whitespace-nowrap text-lg font-bold tabular-nums text-foreground"
            : "whitespace-nowrap text-sm font-medium tabular-nums text-foreground"
        }
      >
        {value}
      </span>
    </div>
  );
}

// ── Flag-on tabbed layout (invoice-adjustments Phase 1/2, plan §1.2) ────────────
// Everything below this line is additive: it only renders when
// isInvoiceAdjustmentsEnabled() is true. The flag-off render path further down
// (the original single-scroll `<div className="space-y-6">` block) is left
// byte-for-byte untouched so existing tests / visual behavior can't regress.

/**
 * Totals block for the tabbed layout — the SAME figures as the classic block
 * below, plus an OVERPAID "Credit balance" disclosure (deliverable #7). Kept as
 * a deliberately SEPARATE component (not a shared extraction of the legacy
 * block) so the flag-OFF DOM stays provably identical to pre-cut behavior.
 */
function TotalsSummary({
  doc,
  detail,
  isPayable,
}: {
  doc: BillingDocumentListItem;
  detail: BillingDocumentDetail | undefined;
  isPayable: boolean;
}) {
  const overpaid = (doc.derivedPaymentStatus ?? doc.settlementStatus) === "OVERPAID";
  return (
    <div className="flex justify-end">
      <div className="w-full max-w-xs space-y-2 rounded-lg border border-border/50 bg-background/40 p-4">
        <TotalRow label="Subtotal" value={formatRM(Number(detail?.subtotal ?? 0))} />
        <TotalRow label="SST" value={formatRM(Number(detail?.sstAmount ?? 0))} />
        {detail?.creditAmount ? (
          <TotalRow label="Credit applied" value={formatRM(Number(detail.creditAmount))} />
        ) : null}
        <div className="border-t border-border/50 pt-2">
          <TotalRow label="Total" value={formatRM(Number(doc.total))} strong />
        </div>
        {isPayable && detail ? (
          <>
            {detail.adjustmentStatus && detail.adjustmentStatus !== "NONE" ? (
              <>
                {Number(detail.debitNoteTotal ?? 0) > 0 ? (
                  <TotalRow label="Debit note total" value={formatRM(Number(detail.debitNoteTotal))} />
                ) : null}
                {Number(detail.creditNoteTotal ?? 0) > 0 ? (
                  <TotalRow label="Credit note total" value={`− ${formatRM(Number(detail.creditNoteTotal))}`} />
                ) : null}
                <div className="border-t border-border/50 pt-2">
                  <TotalRow
                    label="Adjusted invoice amount"
                    value={formatRM(Number(detail.adjustedTotal))}
                    strong
                  />
                </div>
              </>
            ) : null}
            <TotalRow label="Amount paid" value={formatRM(Number(detail.amountPaid))} />
            <div className="border-t border-border/50 pt-2">
              {/* Balance due = charge outstanding (SST-exclusive), the same source
                  the settlement pill reads. NOT adjustedTotal − amountPaid, which
                  would mix the SST-inclusive display total against SST-exclusive
                  cash. */}
              <TotalRow label="Balance due" value={formatRM(Number(detail.balance))} strong />
            </div>
            {overpaid ? (
              <Callout variant="info" title="Credit balance" className="mt-1">
                This document is overpaid — the excess is available as credit. See Amount
                paid above; no separate credit-balance figure is computed here.
              </Callout>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

const DETAIL_TABS = [
  { id: "lineItems", label: "Line items" },
  { id: "payments", label: "Payments" },
  { id: "adjustments", label: "Adjustments" },
  { id: "activity", label: "Activity" },
] as const;
type DetailTabId = (typeof DETAIL_TABS)[number]["id"];

/**
 * Hand-rolled `role="tablist"` — mirrors the pattern used by
 * `owner-workspace.tsx` / `unit-media-step.tsx` (no shared Tabs primitive
 * exists in this design system). Full keyboard/ARIA per spec §7-A11: Arrow
 * Left/Right + Home/End move focus AND selection (roving tabIndex — only the
 * active tab is in the Tab order), `aria-selected`/`aria-controls` on each tab.
 * Each panel stays in the DOM (so screen-reader `aria-controls` targets
 * resolve) but only the ACTIVE panel's content is mounted — notably so the
 * Activity tab's audit-log fetch doesn't fire until a viewer opens it.
 */
function DrawerTabs({
  doc,
  detail,
  isLoading,
}: {
  doc: BillingDocumentListItem;
  detail: BillingDocumentDetail | undefined;
  isLoading: boolean;
}) {
  const [active, setActive] = useState<DetailTabId>("lineItems");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number) {
    const id = DETAIL_TABS[index]?.id;
    if (!id) return;
    setActive(id);
    tabRefs.current[index]?.focus();
  }

  function onTabListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const count = DETAIL_TABS.length;
    const current = DETAIL_TABS.findIndex((t) => t.id === active);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusTab((current + 1) % count);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusTab((current - 1 + count) % count);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusTab(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusTab(count - 1);
    }
  }

  // Balance/paid apply only to a settleable document (invoice/debit note) that's
  // still live — mirrors the flag-off isPayable computed further down.
  const isLiveLifecycle = doc.documentStatus !== "CANCELLED" && doc.documentStatus !== "SUPERSEDED";
  const isPayable = (doc.docType === "invoice" || doc.docType === "debit_note") && isLiveLifecycle;
  const relatedDocuments = detail?.relatedDocuments ?? [];
  // §7-A9: a CN/DN issue event is recorded on the NOTE's own entityId, not the
  // invoice's, so Activity must query both.
  const entityIds = [doc.id, ...relatedDocuments.map((r) => r.id)];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Document details"
        onKeyDown={onTabListKeyDown}
        className="flex gap-1 border-b border-border/50"
      >
        {DETAIL_TABS.map((t, i) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`doc-detail-tab-${t.id}`}
              aria-selected={isActive}
              aria-controls={`doc-detail-panel-${t.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={cn(
                "relative -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="doc-detail-panel-lineItems"
        aria-labelledby="doc-detail-tab-lineItems"
        hidden={active !== "lineItems"}
      >
        {active === "lineItems" ? (
          <div className="space-y-6">
            <LineItemsTab lines={detail?.lines ?? []} isLoading={isLoading} />
            <TotalsSummary doc={doc} detail={detail} isPayable={isPayable} />
          </div>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id="doc-detail-panel-payments"
        aria-labelledby="doc-detail-tab-payments"
        hidden={active !== "payments"}
      >
        {active === "payments" ? (
          <PaymentsTab detail={detail} isPayable={isPayable} />
        ) : null}
      </div>
      <div
        role="tabpanel"
        id="doc-detail-panel-adjustments"
        aria-labelledby="doc-detail-tab-adjustments"
        hidden={active !== "adjustments"}
      >
        {active === "adjustments" ? (
          <AdjustmentsTab
            relatedDocuments={relatedDocuments}
            lines={detail?.lines ?? []}
            counterpartyType={doc.counterpartyType}
            canCreateNotes={
              doc.docType === "invoice" && (doc.counterpartyType === "tenant" || doc.counterpartyType === "owner")
            }
          />
        ) : null}
      </div>
      <div
        role="tabpanel"
        id="doc-detail-panel-activity"
        aria-labelledby="doc-detail-tab-activity"
        hidden={active !== "activity"}
      >
        {active === "activity" ? <ActivityTab entityIds={entityIds} /> : null}
      </div>
    </div>
  );
}

export function DocumentDetailDrawer({
  doc,
  onClose,
  footerActions,
}: {
  /** The clicked register row — seeds the header/meta while the detail loads. */
  doc: BillingDocumentListItem | null;
  onClose: () => void;
  /** Page-specific actions rendered in the footer, alongside Download PDF / Close.
   * Optional and currently unused — the Invoices register dropped its "Correct"
   * footer button (the Adjustments tab covers it); kept as the extension point. */
  footerActions?: ReactNode;
}) {
  const query = useBillingDocument(doc?.id ?? null);
  const detail = query.data?.data;
  const [pdfLoading, setPdfLoading] = useState(false);
  // Flag off (default) ⇒ the branch below renders EXACTLY the pre-cut single-scroll
  // layout — zero visual change. Computed once per render; cheap env read.
  const adjustmentsOn = isInvoiceAdjustmentsEnabled();

  async function openPdf() {
    if (!doc) return;
    setPdfLoading(true);
    try {
      const url = await fetchBillingDocumentPdfUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't open the PDF.");
    } finally {
      setPdfLoading(false);
    }
  }

  async function openAttachment(attachmentId: string) {
    if (!doc) return;
    try {
      const url = await fetchBillingDocumentAttachmentUrl(doc.id, attachmentId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't open the attachment.");
    }
  }

  const st = doc ? statusMeta(doc) : null;
  // Display rows for the flag-OFF inline table below — the SST sibling folded into
  // the base line it taxes, exactly as the flag-ON LineItemsTab does, so the two
  // renderings of the same invoice can never disagree. Consumers that must keep the
  // tax line (AdjustmentsTab, the Record-Payment form) read `detail.lines` directly.
  const lines = foldTaxLines(detail?.lines ?? []);
  // Amount Paid / Balance Due apply only to documents that get settled — an invoice or a
  // debit note. Receipts and credit/refund notes carry no balance; and a voided / re-Billed
  // (CANCELLED / SUPERSEDED) document is closed, so its balance block is suppressed too.
  const isLiveLifecycle = doc?.documentStatus !== "CANCELLED" && doc?.documentStatus !== "SUPERSEDED";
  const isPayable = (doc?.docType === "invoice" || doc?.docType === "debit_note") && isLiveLifecycle;

  return (
    <Sheet open={doc !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="full">
        <SheetHeader>
          <SheetTitle>
            {doc ? `${documentKindLabel(doc.docType, doc.documentNumber)} · ${doc.documentNumber}` : "Document"}
          </SheetTitle>
          <SheetDescription>
            {doc ? `Billed to ${doc.partyName}` : "Loading…"}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {doc ? (
            <div className="space-y-6">
              {detail?.reason ? (
                <Callout variant="info" title="Correction reason">
                  {detail.reason}
                </Callout>
              ) : null}

              {/* Document header band */}
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/50 bg-background/50 p-4">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {documentKindLabel(doc.docType, doc.documentNumber)}
                  </p>
                  <p className="text-2xl font-bold text-foreground">{doc.documentNumber}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {st ? (
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <StatusPill tone={st.primary.tone}>{st.primary.label}</StatusPill>
                      {st.secondary ? (
                        <StatusPill tone={st.secondary.tone}>{st.secondary.label}</StatusPill>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-xs text-muted-foreground">Issued {formatDate(doc.issuedAt)}</p>
                </div>
              </div>

              {/* Bill-to / Property / Unit / Period — the header block a proper invoice needs */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <MetaItem icon={User} label="Bill to">
                  <div className="flex flex-col">
                    <span className="font-medium">{doc.partyName}</span>
                    <CounterpartyBadge type={doc.counterpartyType} />
                  </div>
                </MetaItem>
                <MetaItem icon={Building2} label="Property">{doc.propertyName ?? "—"}</MetaItem>
                {/* Answered from the LINES, so a combined owner statement reads
                    "3 units" instead of a bare "—". See summariseDocumentUnits. */}
                <MetaItem icon={DoorOpen} label="Unit">
                  {summariseDocumentUnits(doc.unitCode, detail?.lines ?? [])}
                </MetaItem>
                <MetaItem icon={CalendarDays} label="Billing period">
                  {formatBillingMonth(doc.billingMonth)}
                </MetaItem>
                <MetaItem icon={CalendarDays} label="Issued">{formatDate(doc.issuedAt)}</MetaItem>
                <MetaItem icon={Hash} label="Series">{doc.seriesCode || "—"}</MetaItem>
              </div>

              {adjustmentsOn ? (
                <DrawerTabs doc={doc} detail={detail} isLoading={query.isLoading} />
              ) : (
                <>
              {/* Line items */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-foreground">Line items</h3>
                {query.isLoading && lines.length === 0 ? (
                  <div className="h-24 animate-pulse rounded-lg bg-muted" />
                ) : (
                  <TableWrap>
                    <DataTable>
                      <TableHead>
                        <tr>
                          <HeadCell className="w-10">#</HeadCell>
                          <HeadCell>Description</HeadCell>
                          <HeadCell className="text-right">Amount</HeadCell>
                          {/* Same per-line SST column as the flag-on LineItemsTab —
                              server value verbatim, "—" for an untaxed line. */}
                          <HeadCell className="text-right">SST</HeadCell>
                          <HeadCell className="text-right">Paid</HeadCell>
                          <HeadCell className="text-right">Outstanding</HeadCell>
                        </tr>
                      </TableHead>
                      <tbody>
                        {lines.length === 0 ? (
                          <EmptyRow colSpan={6} label="No line items." />
                        ) : (
                          lines.map((l, i) => {
                            const outstanding = Number(l.outstanding ?? l.amount);
                            const paid = Number(l.paid ?? 0);
                            // A settleable line is fully paid once nothing remains. Charge-less
                            // lines (overpayment CN) never carry a settlement state.
                            const fullyPaid = l.chargeId !== null && outstanding <= 0.005;
                            const sstRate = Number(l.sstRate);
                            return (
                              <Row key={l.id}>
                                <BodyCell className="align-top text-muted-foreground">{i + 1}</BodyCell>
                                <BodyCell>
                                  <span className="font-medium text-foreground">{l.description}</span>
                                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                    {l.categoryName}
                                    {sstRate > 0 ? ` · SST ${sstRate}%` : ""}
                                  </span>
                                  {l.attachments.length > 0 ? (
                                    <div className="mt-1 flex flex-wrap gap-1.5">
                                      {l.attachments.map((a) => (
                                        <button
                                          key={a.id}
                                          type="button"
                                          onClick={() => openAttachment(a.id)}
                                          className="inline-flex items-center gap-1 text-[11px] text-primary underline underline-offset-2 hover:opacity-80"
                                        >
                                          <Paperclip className="h-3 w-3" />
                                          {a.filename}
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                </BodyCell>
                                <BodyCell className="align-top text-right tabular-nums">
                                  {formatRM(Number(l.amount))}
                                </BodyCell>
                                <BodyCell className="align-top text-right tabular-nums">
                                  {Number(l.sstAmount) > 0 ? (
                                    formatRM(Number(l.sstAmount))
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </BodyCell>
                                {/* Always a value, never a dash (RM0.00 for an unpaid line). */}
                                <BodyCell className="align-top text-right tabular-nums text-muted-foreground">
                                  {formatRM(paid)}
                                </BodyCell>
                                <BodyCell className="align-top text-right">
                                  <div className="flex flex-col items-end gap-1">
                                    <span className="font-medium tabular-nums text-foreground">
                                      {formatRM(outstanding)}
                                    </span>
                                    {fullyPaid ? <Badge variant="sky" className="w-fit">Paid</Badge> : null}
                                  </div>
                                </BodyCell>
                              </Row>
                            );
                          })
                        )}
                      </tbody>
                    </DataTable>
                  </TableWrap>
                )}
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-full max-w-xs space-y-2 rounded-lg border border-border/50 bg-background/40 p-4">
                  <TotalRow label="Subtotal" value={formatRM(Number(detail?.subtotal ?? 0))} />
                  <TotalRow label="SST" value={formatRM(Number(detail?.sstAmount ?? 0))} />
                  {detail?.creditAmount ? (
                    <TotalRow label="Credit applied" value={formatRM(Number(detail.creditAmount))} />
                  ) : null}
                  <div className="border-t border-border/50 pt-2">
                    <TotalRow label="Total" value={formatRM(Number(doc.total))} strong />
                  </div>
                  {isPayable && detail ? (
                    <>
                      {detail.adjustmentStatus && detail.adjustmentStatus !== "NONE" ? (
                        <>
                          {Number(detail.debitNoteTotal ?? 0) > 0 ? (
                            <TotalRow label="Debit note total" value={formatRM(Number(detail.debitNoteTotal))} />
                          ) : null}
                          {Number(detail.creditNoteTotal ?? 0) > 0 ? (
                            <TotalRow label="Credit note total" value={`− ${formatRM(Number(detail.creditNoteTotal))}`} />
                          ) : null}
                          <div className="border-t border-border/50 pt-2">
                            <TotalRow
                              label="Adjusted invoice amount"
                              value={formatRM(Number(detail.adjustedTotal))}
                              strong
                            />
                          </div>
                        </>
                      ) : null}
                      <TotalRow label="Amount paid" value={formatRM(Number(detail.amountPaid))} />
                      <div className="border-t border-border/50 pt-2">
                        {/* Balance due = charge outstanding (the SST-exclusive charge basis the
                            settlement pill reads from). NOT adjustedTotal − amountPaid, which would
                            mix the SST-inclusive display total against SST-exclusive cash. */}
                        <TotalRow label="Balance due" value={formatRM(Number(detail.balance))} strong />
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Related documents (credit/refund notes in the chain) */}
              {detail?.relatedDocuments?.length ? (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">Related documents</h3>
                  <div className="flex flex-wrap gap-2">
                    {detail.relatedDocuments.map((r) => (
                      <Badge key={r.id} variant="outline">
                        {docTypeLabel(r.docType)} · {r.documentNumber}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
                </>
              )}
            </div>
          ) : null}
        </SheetBody>

        <SheetFooter>
          {/* SheetFooter is flex-row-reverse → primary renders rightmost */}
          <Button variant="gold" onClick={openPdf} disabled={pdfLoading || !doc}>
            {pdfLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {pdfLoading ? "Opening…" : "Download PDF"}
          </Button>
          {footerActions}
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
