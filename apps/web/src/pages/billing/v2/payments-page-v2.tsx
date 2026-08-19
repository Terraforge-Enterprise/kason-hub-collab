// apps/web/src/pages/billing/v2/payments-page-v2.tsx
// Payments v2 (2026-07-04 spec §4): cursor-paginated register with a status
// pill filter, metric tiles from getPaymentsSummary, per-row actions
// (PaymentRowMenu), per-allocation Reverse, and the restyled FPX card.
// Record-payment (header CTA) opens RecordPaymentDrawer; the row menu's
// Allocate opens AllocateDrawer scoped to that payment (Task 13).
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Wallet } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface, StatusPill } from "@/components/ui";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PillBar } from "@/components/ui/pill-bar";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatMoney, formatDateTime } from "@/components/format";
import { PHASE2_STATUS_TONES, type StatusTone } from "@kason/shared";
import { getPaymentsSummary, reverseAllocation, ENABLE_FPX } from "@/api/payments";
import { currentMonth } from "./use-billing-v2";
import { PaymentRowMenu, type PaymentMenuRow } from "./payment-row-menu";
import { FpxInFlightCard } from "./fpx-inflight-card";
import { NeedsReconciliationSection } from "../needs-reconciliation-section";
import { RecordPaymentDrawer } from "./record-payment-drawer";
import { AllocateDrawer } from "./allocate-drawer";
import type { PaymentListItem } from "../payments-table";

// The API now returns partyId + hasBatchKey on every payment row (Task 4 /
// final-review fix wave). payments-table's PaymentListItem is a read-only
// import from a prior task — extend it locally instead of editing that shared
// type. allocations is further overridden (Spec1 R6) to add documentNumber —
// each allocation's charge's minted document number, resolved server-side via
// findDocumentsByChargeIds (payments.repository.ts); null when the charge has
// no minted document yet.
type PaymentRowData = Omit<PaymentListItem, "allocations"> & {
  partyId: string;
  hasBatchKey: boolean;
  allocations: (PaymentListItem["allocations"][number] & { documentNumber: string | null })[];
};
type Allocation = PaymentRowData["allocations"][number];
type PaymentsPage = { data: PaymentRowData[]; nextCursor: string | null };

type StatusFilter = "" | "pending_approval" | "posted" | "void" | "refunded";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "posted", label: "Posted" },
  { value: "void", label: "Void" },
  { value: "refunded", label: "Refunded" },
];

function paymentTone(status: string): StatusTone {
  return (PHASE2_STATUS_TONES.payment as Record<string, StatusTone>)[status] ?? "slate";
}

// ── Per-allocation reverse (own AlertDialog — never a bare destructive click) ─

function ReverseAllocationLink({
  paymentId,
  paymentNumber,
  allocation,
  currency,
}: {
  paymentId: string;
  paymentNumber: string;
  allocation: Allocation;
  currency: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const reverse = useMutation({
    mutationFn: () => reverseAllocation(paymentId, allocation.id),
    onSuccess: () => {
      toast.success(`${allocation.chargeNumber} allocation reversed`);
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (e: Error) => toast.error(e.message || "Reverse failed"),
  });

  return (
    <>
      <button
        type="button"
        className="text-xs text-rose-600 underline underline-offset-2 hover:text-rose-800"
        onClick={() => setOpen(true)}
      >
        Reverse
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse {allocation.chargeNumber} on {paymentNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              Restores {formatMoney(allocation.allocatedAmount, currency)} to {allocation.chargeNumber}&apos;s outstanding balance.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={reverse.isPending} onClick={() => reverse.mutate()}>
              Reverse allocation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Register row — expands via <details> to its allocations ─────────────────

function PaymentRow({
  payment,
  onAllocate,
}: {
  payment: PaymentRowData;
  onAllocate: (p: PaymentMenuRow) => void;
}) {
  return (
    <details className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3">
        <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">{payment.paymentNumber}</span>
        <span className="text-sm text-[var(--text-secondary)]">{payment.partyName}</span>
        <span className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">{payment.paymentMethod}</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-sm font-semibold tabular-nums">{formatMoney(payment.amount, payment.currency)}</span>
          <span className="text-xs text-[var(--text-secondary)]">{formatDateTime(payment.receivedAt)}</span>
          <StatusPill tone={paymentTone(payment.status)}>{payment.status.replace(/_/g, " ")}</StatusPill>
          {/* Stops the click from bubbling to <summary> — real browsers toggle
              <details> on any click that reaches it (see owner-tab.tsx's
              StatementCard/IVOWN-PDF-button precedent); stopPropagation is
              what actually matters, preventDefault is defensive belt-and-braces. */}
          <span
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <PaymentRowMenu
              payment={{
                id: payment.id,
                paymentNumber: payment.paymentNumber,
                partyId: payment.partyId,
                status: payment.status,
                amount: payment.amount,
                currency: payment.currency,
                hasBatchKey: payment.hasBatchKey,
                allocatedTotal: payment.allocations.reduce((s, a) => s + a.allocatedAmount, 0),
              }}
              onAllocate={onAllocate}
            />
          </span>
        </span>
      </summary>
      <div className="border-t border-[var(--card-border)] px-4 py-3">
        {payment.allocations.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">No allocations yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {payment.allocations.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {a.documentNumber ?? a.chargeNumber} · {formatMoney(a.allocatedAmount, payment.currency)} · {formatDateTime(a.allocatedAt)}
                </span>
                <ReverseAllocationLink
                  paymentId={payment.id}
                  paymentNumber={payment.paymentNumber}
                  allocation={a}
                  currency={payment.currency}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PaymentsPageV2() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter[]>([""]);
  const [recordOpen, setRecordOpen] = useState(false);
  const [allocatingPayment, setAllocatingPayment] = useState<PaymentMenuRow | null>(null);

  const activeStatus = statusFilter.length > 0 ? statusFilter[statusFilter.length - 1] : "";

  // Single-select behaviour over PillBar's multi-select API: toggling a pill
  // selects it exclusively (deselect = back to All). Copied from the legacy
  // payments-page.tsx handleStatusChange (lines 85-105).
  function handleStatusChange(next: StatusFilter[]) {
    if (next.length === 0) {
      setStatusFilter([""]);
      return;
    }
    const prev = statusFilter[statusFilter.length - 1] ?? "";
    const added = next.find((v) => !statusFilter.includes(v));
    if (added !== undefined) {
      setStatusFilter([added]);
    } else {
      const removed = statusFilter.find((v) => !next.includes(v));
      if (removed === activeStatus) {
        setStatusFilter([""]);
      } else {
        setStatusFilter([prev]);
      }
    }
  }

  const summary = useQuery({
    queryKey: ["payments", "summary", currentMonth()],
    queryFn: () => getPaymentsSummary(currentMonth()),
  });

  const payments = useInfiniteQuery({
    queryKey: ["payments", { status: activeStatus || undefined }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (activeStatus) params.set("status", activeStatus);
      if (pageParam) params.set("cursor", pageParam);
      const qs = params.toString();
      return apiFetch<PaymentsPage>(`/payments${qs ? `?${qs}` : ""}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const rows = payments.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Incoming cash, allocations to charges, and status changes — all from one register."
        metrics={
          summary.data
            ? [
                { label: "Received", value: formatMoney(summary.data.receivedTotal), hint: currentMonth() },
                { label: "Unallocated", value: String(summary.data.unallocatedCount), hint: "Payments awaiting allocation" },
                { label: "Pending approval", value: String(summary.data.pendingApprovalCount), hint: "Awaiting manager sign-off" },
                // Deliberately NOT phrased "In-flight FPX" — that text is reserved for the
                // FpxInFlightCard callout below, which self-hides when the count is zero;
                // this metric tile always shows, so it must read distinctly from the card.
                { label: "FPX in flight", value: String(summary.data.inFlightFpxCount), hint: "Tenant attempts awaiting the gateway" },
              ]
            : []
        }
        actions={
          <Button variant="gold" onClick={() => setRecordOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Record payment
          </Button>
        }
      />

      {/* Reconciliation FIRST: these are payments the bank already took, so they
          outrank in-flight attempts that may still resolve themselves. */}
      {ENABLE_FPX && <NeedsReconciliationSection />}
      {ENABLE_FPX && <FpxInFlightCard />}

      <Surface title="Payments register" description="Expand a row to see its allocations.">
        <div className="mb-3">
          <PillBar
            value={statusFilter}
            onChange={handleStatusChange}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by payment status"
            size="sm"
          />
        </div>

        {payments.isLoading ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-16 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]" />
            <div className="h-16 rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)]" />
          </div>
        ) : payments.isError ? (
          <Callout variant="danger" title="Couldn't load payments">
            <Button size="sm" variant="outline" onClick={() => payments.refetch()}>Retry</Button>
          </Callout>
        ) : rows.length === 0 ? (
          <EmptyState icon={Wallet} title="No payments yet" description="Recorded payments will appear here." />
        ) : (
          <>
            <div className="space-y-2">
              {rows.map((p) => (
                <PaymentRow key={p.id} payment={p} onAllocate={setAllocatingPayment} />
              ))}
            </div>
            {payments.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="outline"
                  disabled={payments.isFetchingNextPage}
                  onClick={() => payments.fetchNextPage()}
                >
                  {payments.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </Surface>

      <RecordPaymentDrawer open={recordOpen} onOpenChange={setRecordOpen} />
      <AllocateDrawer
        payment={allocatingPayment}
        onOpenChange={(v) => { if (!v) setAllocatingPayment(null); }}
      />
    </div>
  );
}
