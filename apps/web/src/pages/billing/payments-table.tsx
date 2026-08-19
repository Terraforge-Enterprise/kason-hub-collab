import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EnhancedDataTable } from "@/components/data-table";
import { BulletList, StatusPill } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/components/format";
import { PHASE2_STATUS_TONES, type StatusTone } from "@kason/shared";
import { ENABLE_MULTI_PAY, reverseAllocation } from "@/api/payments";

export type PaymentListItem = {
  id: string;
  paymentNumber: string;
  partyName: string;
  paymentType: string;
  paymentMethod: string;
  status: string;
  amount: number;
  currency: string;
  receivedAt: string;
  historySummary: string[];
  allocations: {
    id: string;
    chargeNumber: string;
    allocatedAmount: number;
    allocatedAt: string;
  }[];
};

function paymentTone(status: string): StatusTone {
  return (PHASE2_STATUS_TONES.payment as Record<string, StatusTone>)[status] ?? "slate";
}

// ── Per-allocation reverse button (flag-gated) ───────────────────────────────

function ReverseAllocationButton({
  paymentId,
  allocationId,
}: {
  paymentId: string;
  allocationId: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const reverseMutation = useMutation({
    mutationFn: () => reverseAllocation(paymentId, allocationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  return (
    <span className="ml-2 inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        className="text-xs text-rose-600 underline underline-offset-2 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={reverseMutation.isPending}
        onClick={() => {
          setError(null);
          reverseMutation.mutate();
        }}
      >
        {reverseMutation.isPending ? "Reversing…" : "Reverse"}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </span>
  );
}

export function PaymentTable({ payments }: { payments: PaymentListItem[] }) {
  const columns = [
    {
      key: "paymentNumber",
      label: "Payment #",
      sortable: true,
      sortValue: (row: PaymentListItem) => row.paymentNumber,
      render: (row: PaymentListItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.paymentNumber}</span>
      ),
    },
    {
      key: "partyName",
      label: "Payer",
      sortable: true,
      sortValue: (row: PaymentListItem) => row.partyName,
      render: (row: PaymentListItem) => row.partyName,
    },
    {
      key: "paymentMethod",
      label: "Method",
      sortable: true,
      sortValue: (row: PaymentListItem) => row.paymentMethod,
      render: (row: PaymentListItem) => row.paymentMethod,
    },
    {
      key: "amount",
      label: "Amount",
      sortable: true,
      sortValue: (row: PaymentListItem) => row.amount,
      render: (row: PaymentListItem) => formatMoney(row.amount, row.currency),
    },
    {
      key: "receivedAt",
      label: "Received",
      sortable: true,
      sortValue: (row: PaymentListItem) => row.receivedAt,
      render: (row: PaymentListItem) => formatDateTime(row.receivedAt),
    },
    {
      key: "allocations",
      label: "Allocations",
      render: (row: PaymentListItem) =>
        row.allocations.length > 0 ? (
          <BulletList>
            {row.allocations.map((a) => (
              <li key={a.id} className="flex items-center gap-1 flex-wrap">
                <span>
                  {a.chargeNumber} · {formatMoney(a.allocatedAmount)}
                </span>
                {ENABLE_MULTI_PAY && (
                  <ReverseAllocationButton
                    paymentId={row.id}
                    allocationId={a.id}
                  />
                )}
              </li>
            ))}
          </BulletList>
        ) : (
          "-"
        ),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: PaymentListItem) => row.status,
      render: (row: PaymentListItem) => (
        <StatusPill tone={paymentTone(row.status)}>{row.status}</StatusPill>
      ),
    },
    {
      key: "historySummary",
      label: "History",
      render: (row: PaymentListItem) =>
        row.historySummary.length > 0 ? (
          <BulletList>
            {row.historySummary.map((h, idx) => (
              <li key={`${row.id}-${idx}`}>{h}</li>
            ))}
          </BulletList>
        ) : (
          "-"
        ),
    },
  ];

  return (
    <EnhancedDataTable
      data={payments}
      columns={columns}
      searchPlaceholder="Search payments..."
      searchKeys={["paymentNumber", "partyName", "paymentMethod"]}
      emptyMessage="No payments yet. Create one below."
    />
  );
}
