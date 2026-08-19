import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { formatMoney } from "@/components/format";
import { PillBar } from "@/components/ui/pill-bar";
import { PaymentTable } from "./payments-table";
import { PaymentForms } from "./payments-forms";
import { InFlightFpxSection } from "./in-flight-fpx-section";
import { NeedsReconciliationSection } from "./needs-reconciliation-section";
import { ENABLE_FPX } from "@/api/payments";
import type { PaymentListItem } from "./payments-table";
import type { ChargeListItem } from "./charges-table";

type TenantListItem = { id: string; displayName: string };

const STATUS_OPTIONS = [
  { value: "" as const, label: "All" },
  { value: "pending_approval" as const, label: "Pending approval" },
  { value: "posted" as const, label: "Posted" },
  { value: "void" as const, label: "Void" },
  { value: "refunded" as const, label: "Refunded" },
];

type StatusFilter = "" | "pending_approval" | "posted" | "void" | "refunded";

export default function PaymentsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter[]>([""]);

  // The active status is the last selected pill (PillBar is multi-select; we use it
  // as a single-select by always taking the most recently toggled value, or "" for All).
  const activeStatus = statusFilter.length > 0 ? statusFilter[statusFilter.length - 1] : "";

  const filters = { status: activeStatus || undefined };

  const payments = useQuery({
    queryKey: ["payments", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      const qs = params.toString();
      return apiFetch<{ data: PaymentListItem[]; nextCursor: string | null }>(
        `/payments${qs ? `?${qs}` : ""}`,
      );
    },
  });

  const tenants = useQuery({
    queryKey: ["parties", "tenants"],
    queryFn: () => apiFetch<{ data: TenantListItem[] }>("/parties/tenants"),
  });

  const charges = useQuery({
    queryKey: ["billing", "charges"],
    queryFn: () => apiFetch<{ data: ChargeListItem[] }>("/billing/charges"),
  });

  const isLoading = payments.isLoading || tenants.isLoading || charges.isLoading;
  const hasError = payments.isError || tenants.isError || charges.isError;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (hasError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load payments data. Please refresh.
      </p>
    );
  }

  const paymentList = payments.data!.data;
  const tenantList = tenants.data!.data;
  const chargeList = charges.data!.data;

  const receivedTotal = paymentList.reduce((sum, p) => sum + p.amount, 0);
  const allocatedCount = paymentList.filter((p) => p.allocations.length > 0).length;

  // Single-select behaviour: toggling a pill selects it exclusively (deselect = back to All).
  function handleStatusChange(next: StatusFilter[]) {
    // If the user toggled off the current value (next is empty), reset to All.
    if (next.length === 0) {
      setStatusFilter([""]);
      return;
    }
    // Take the last newly-added value as the active filter.
    const prev = statusFilter[statusFilter.length - 1] ?? "";
    const added = next.find((v) => !statusFilter.includes(v));
    if (added !== undefined) {
      setStatusFilter([added]);
    } else {
      // User deselected the active pill — find which one was removed and reset to All.
      const removed = statusFilter.find((v) => !next.includes(v));
      if (removed === activeStatus) {
        setStatusFilter([""]);
      } else {
        setStatusFilter([prev]);
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments and allocations"
        description="Track incoming cash, map allocations to charges, and keep status changes visible without leaving the page."
        metrics={[
          { label: "Payments", value: String(paymentList.length), hint: "Recorded inbound payments" },
          {
            label: "Received",
            value: formatMoney(receivedTotal),
            hint: "Gross receipts captured",
          },
          {
            label: "Allocated",
            value: String(allocatedCount),
            hint: "Payments linked to charges",
          },
          {
            label: "Charge pool",
            value: String(chargeList.length),
            hint: `${tenantList.length} possible payers`,
          },
        ]}
      />
      <Surface
        title="Payments register"
        description="Incoming payments with allocations and history summaries kept visible."
      >
        <div className="mb-3">
          <PillBar
            value={statusFilter}
            onChange={handleStatusChange}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by payment status"
            size="sm"
          />
        </div>
        <PaymentTable payments={paymentList} />
      </Surface>
      {/* Reconciliation FIRST: these are payments the bank already took, so they
          outrank in-flight attempts that may still resolve themselves. */}
      {ENABLE_FPX && <NeedsReconciliationSection />}
      {ENABLE_FPX && <InFlightFpxSection />}
      <PaymentForms
        tenants={tenantList.map((t) => ({ id: t.id, displayName: t.displayName }))}
        charges={chargeList.map((c) => ({
          id: c.id,
          chargeNumber: c.chargeNumber,
          outstandingAmount: c.outstandingAmount,
          invoiceNumber: c.invoiceNumber ?? null,
        }))}
        payments={paymentList.map((p) => ({
          id: p.id,
          paymentNumber: p.paymentNumber,
          partyName: p.partyName,
          status: p.status,
        }))}
      />
    </div>
  );
}
