import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { X, Receipt } from "lucide-react";
import { formatRM, formatDateMY, getStatusTone } from "@/components/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/empty-state";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { usePortalPayments, type PaymentItem } from "./use-billing-data";

const TH = "px-4 py-3 text-left text-[10px] uppercase tracking-widest text-[var(--text-muted)]";
const TD = "px-4 py-3.5 text-sm text-[var(--text-primary)]";

// Named per the brief's example (`bank_transfer`→`Bank transfer`); anything
// else falls back to a generic underscore -> Title Case conversion rather
// than showing a raw snake_case token.
const METHOD_LABEL: Record<string, string> = {
  bank_transfer: "Bank transfer",
  fpx: "FPX",
  cash: "Cash",
};

function humanizeMethod(method: string): string {
  const known = METHOD_LABEL[method];
  if (known) return known;
  return method
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Map getStatusTone → Badge variant (Badge has no "slate" variant) — mirrors
 * the identical fallback already used in dashboard.tsx / my-tenancy.tsx. */
function badgeTone(status?: string | null) {
  const t = getStatusTone(status);
  return t === "slate" ? ("secondary" as const) : t;
}

// The raw DB values are engineering vocabulary; a tenant reading
// "pending_approval" learns nothing about what is happening to their money.
const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Being verified",
  posted: "Confirmed",
  rejected: "Not accepted",
  expired: "Expired",
  failed: "Failed",
  void: "Cancelled",
  refunded: "Refunded",
  // The bank told us this one went through, but it reached us after the payment
  // had already been closed off, so a person has to apply it by hand. Deliberately
  // NOT worded as a failure or a delay caused by the tenant — from their side the
  // money has left their account and the ball is entirely in our court.
  needs_reconciliation: "With our finance team",
};

/**
 * `pending_approval` means two completely different things depending on how the
 * tenant paid, and the old single label described only one of them.
 *
 * A bank transfer is waiting on a PERSON here to check the slip. A bank redirect
 * is waiting on the BANK — nobody here is reviewing anything, and on FPX that
 * wait is entirely normal: business accounts need a second person to approve the
 * transfer, which can take a day or more.
 */
function humanizeStatus(status: string, paymentMethod?: string): string {
  if (status === "pending_approval" && paymentMethod === "fpx") return "Waiting for your bank";
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// No tenant-reachable PDF endpoint exists for a single payment today (the
// portal's GET /payments/:id/receipt returns JSON, not a file, and the
// BillingDocument PDF route is staff-only) — this task is frontend-only
// (spec R22), so "download" opens a small print-ready receipt built from the
// data already on screen, using the SAME "fetch then window.open" idiom as
// ChargeDrawer's openDocumentPdf (no new backend dependency).
function downloadReceipt(payment: PaymentItem) {
  const html = `<!doctype html><html><head><title>Receipt ${escapeHtml(payment.paymentNumber)}</title></head>` +
    `<body style="font-family: sans-serif; padding: 24px; color: #1a1a1a;">` +
    `<h1 style="font-size: 18px;">Payment Receipt</h1>` +
    `<p><strong>Receipt:</strong> ${escapeHtml(payment.paymentNumber)}</p>` +
    `<p><strong>Date:</strong> ${escapeHtml(formatDateMY(payment.receivedAt))}</p>` +
    `<p><strong>Method:</strong> ${escapeHtml(humanizeMethod(payment.paymentMethod))}</p>` +
    `<p><strong>Amount:</strong> ${escapeHtml(formatRM(payment.amount))}</p>` +
    (payment.referenceNote ? `<p><strong>Applied to:</strong> ${escapeHtml(payment.referenceNote)}</p>` : "") +
    `</body></html>`;
  window.open(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, "_blank", "noopener");
}

// "pending" is a real, common FPX outcome — not an error state. A company bank
// account needs a second person to approve the transfer, so the payer is
// returned to us before the money has moved and must be told to expect a wait
// rather than left assuming it failed.
type FpxOutcome = "success" | "failed" | "pending";

export function PaymentsTab() {
  const { data, isLoading, isError, error } = usePortalPayments(1);
  const payments = data?.data ?? [];
  const [openPayment, setOpenPayment] = useState<PaymentItem | null>(null);

  // FPX return banner — the gateway/mock returns the payer to
  // /portal/payments?fpx=success|failed, which PaymentsToBillingRedirect
  // (router.tsx) forwards, query-preserving, to
  // /portal/billing?tab=payments&fpx=success|failed. Read it once here (this
  // component only mounts when tab==="payments"), then strip ONLY `fpx` —
  // `tab` (and any other future param) must survive the strip — so a refresh
  // or back-nav doesn't re-show the banner. Carried over from the old
  // payments.tsx:26-37.
  const [searchParams, setSearchParams] = useSearchParams();
  // Lazy-init from the URL ONCE at mount — NOT via setState-in-effect (which
  // trips react-hooks/set-state-in-effect and cascades renders). The banner
  // then lives in state and survives the URL strip below.
  const [fpxBanner, setFpxBanner] = useState<FpxOutcome | null>(() => {
    const fpx = searchParams.get("fpx");
    return fpx === "success" || fpx === "failed" || fpx === "pending" ? fpx : null;
  });
  // Strip ONLY `fpx` (keep `tab` + any future param) so a refresh/back-nav
  // doesn't re-show the banner. This effect updates the URL (an external
  // system) and does NOT setState, so it is rule-clean.
  useEffect(() => {
    if (searchParams.get("fpx")) {
      const next = new URLSearchParams(searchParams);
      next.delete("fpx");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // "pending" is warning-toned, never danger: nothing has gone wrong, the bank
  // simply has not finished. Showing it as a failure would push the tenant to
  // pay a second time for a transfer that is still on its way.
  const fpxBannerEl = fpxBanner && (
    <Callout variant={fpxBanner === "success" ? "success" : fpxBanner === "pending" ? "warning" : "danger"}>
      <div className="flex items-start justify-between gap-3">
        <span>
          {fpxBanner === "success"
            ? "Your payment was received."
            : fpxBanner === "pending"
              ? "Your bank is still processing this payment. Some accounts need a second person to approve it, so it can take a while. We'll update this automatically — please don't pay again."
              : "Your payment didn't complete — please try again."}
        </span>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => setFpxBanner(null)}
          className="shrink-0 rounded p-0.5 opacity-70 transition hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </Callout>
  );

  // Banner visibility is deliberately independent of the list's own load
  // state (loading/error/empty) — it reports the FPX gateway outcome, not the
  // payments-list fetch outcome, and old payments.tsx showed it unconditionally
  // too (payments.tsx:47-69, sibling to its own isLoading branch).
  let body: ReactNode;
  if (isLoading) {
    body = <PaymentsTabSkeleton />;
  } else if (isError) {
    // A failed fetch must NEVER render as the zero-payments EmptyState — that
    // would silently tell the tenant "you have no payments" when the server
    // call actually failed (mirrors invoices-tab.tsx's identical guard).
    body = (
      <Callout variant="danger" title="Couldn't load your payments">
        {(error as Error)?.message || "Something went wrong. Please try again."}
      </Callout>
    );
  } else if (payments.length === 0) {
    body = (
      <EmptyState
        icon={Receipt}
        title="No payments yet"
        description="Payments you make on your tenancy will appear here."
      />
    );
  } else {
    body = (
      <>
        <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
          <table className="w-full">
            <thead className="bg-[var(--page-bg)] border-b border-[var(--border)]">
              <tr>
                <th className={TH}>Payment</th>
                <th className={TH}>Method</th>
                <th className={TH}>Date</th>
                <th className={`${TH} text-right`}>Amount</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setOpenPayment(p)}
                  className="border-b border-[var(--border)] transition hover:bg-[var(--page-bg)] cursor-pointer"
                >
                  <td className={`${TD} font-medium`}>{p.paymentNumber}</td>
                  <td className={TD}>{humanizeMethod(p.paymentMethod)}</td>
                  <td className={TD}>{formatDateMY(p.receivedAt)}</td>
                  <td className={`${TD} text-right`}>{formatRM(p.amount)}</td>
                  <td className={TD}>
                    <Badge variant={badgeTone(p.status)}>{humanizeStatus(p.status, p.paymentMethod)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {openPayment && (
          <Sheet open onOpenChange={(open) => { if (!open) setOpenPayment(null); }}>
            <SheetContent size="md">
              <SheetHeader>
                <SheetTitle>{openPayment.paymentNumber}</SheetTitle>
                <SheetDescription>{formatDateMY(openPayment.receivedAt)}</SheetDescription>
              </SheetHeader>
              <SheetBody className="space-y-3">
                {/* The two states a tenant most needs explaining, before the
                    figures: money they think they've paid but we haven't
                    confirmed, and money we've actively refused. */}
                {/* A bank redirect waits on the BANK; a transfer slip waits on a
                    PERSON here. The old copy described only the slip, so anyone
                    who paid online was told we were checking a slip they had
                    never uploaded. On FPX this wait is also entirely normal —
                    company accounts need a second person to approve — so the
                    copy says that rather than implying something went wrong. */}
                {openPayment.status === "pending_approval" && openPayment.paymentMethod === "fpx" && (
                  <Callout variant="warning" title="Waiting for your bank">
                    Your bank hasn't confirmed this payment yet. That's normal &mdash; some accounts
                    need a second person to approve the transfer, which can take a day or more. We
                    check with them regularly and this will update on its own. The charges stay open
                    until it clears, so please don't pay them again.
                  </Callout>
                )}
                {openPayment.status === "pending_approval" && openPayment.paymentMethod !== "fpx" && (
                  <Callout variant="warning" title="We're verifying this">
                    We're checking your transfer slip against our bank account. The charges it
                    covers stay open until we confirm — please don't pay them again.
                  </Callout>
                )}
                {openPayment.status === "needs_reconciliation" && (
                  <Callout variant="warning" title="We're sorting this one out">
                    Your bank confirmed this payment, but it reached us after the payment had
                    already been closed off, so someone here needs to apply it by hand. You don't
                    need to do anything and you don't need to pay again &mdash; we'll update this
                    once it's applied.
                  </Callout>
                )}
                {openPayment.status === "rejected" && (
                  <Callout variant="danger" title="This payment wasn't accepted">
                    {openPayment.rejectionReason
                      ? openPayment.rejectionReason
                      : "Please contact the office for details."}
                    <span className="mt-2 block">
                      The charges are still open, so you can submit again with a corrected slip.
                    </span>
                  </Callout>
                )}
                <Row label="Status" value={humanizeStatus(openPayment.status, openPayment.paymentMethod)} />
                <Row label="Date" value={formatDateMY(openPayment.receivedAt)} />
                <Row label="Method" value={humanizeMethod(openPayment.paymentMethod)} />
                <Row label="Amount" value={formatRM(openPayment.amount)} strong />
                {openPayment.referenceNote && <Row label="Applied to" value={openPayment.referenceNote} />}
                <Row label="Receipt" value={openPayment.paymentNumber} />
              </SheetBody>
              <SheetFooter>
                {/* A receipt asserts money was received. Only "posted" means
                    that, so an unverified or refused payment offers no
                    download — handing one out would let a tenant produce proof
                    of a payment the org has not accepted. */}
                {openPayment.status === "posted" ? (
                  <Button variant="outline" onClick={() => downloadReceipt(openPayment)}>
                    Download receipt
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    A receipt becomes available once this payment is confirmed.
                  </p>
                )}
              </SheetFooter>
            </SheetContent>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      {fpxBannerEl}
      {body}
    </div>
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

function PaymentsTabSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-64 bg-muted rounded-xl" />
    </div>
  );
}
