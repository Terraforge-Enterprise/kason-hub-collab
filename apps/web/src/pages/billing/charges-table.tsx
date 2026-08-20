import { EnhancedDataTable } from "@/components/data-table";
import { BulletList, StatusPill } from "@/components/ui";
import { formatDate, formatDateTime, formatMoney, getStatusTone } from "@/components/format";

export type ChargeEventListItem = {
  eventType: string;
  eventAt: string;
  payloadJson: unknown;
};

export type ChargeListItem = {
  id: string;
  chargeNumber: string;
  partyName: string;
  tenancyCode: string | null;
  unitCode: string | null;
  chargeType: string;
  status: string;
  dueDate: string;
  amount: number;
  outstandingAmount: number;
  currency: string;
  invoiceNumber: string | null;
  /** Issued BillingDocument number (IVTEN/DEP…); null = draft or pre-cutover. */
  documentNumber: string | null;
  events: ChargeEventListItem[];
};

function formatEventPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;

  const parts: string[] = [];
  if (obj.method) parts.push(String(obj.method).replace(/_/g, " "));
  if (obj.reason) parts.push(String(obj.reason));
  if (obj.note) parts.push(String(obj.note));
  if (obj.status) parts.push(String(obj.status));
  if (obj.amount) {
    const currencyLabel = (obj.currency ?? "MYR") === "MYR" ? "RM" : obj.currency;
    parts.push(`${currencyLabel} ${Number(obj.amount).toLocaleString()}`);
  }

  // Fallback: show remaining keys not already covered
  if (parts.length === 0) {
    for (const k of keys) parts.push(`${k}: ${String(obj[k])}`);
  }
  return parts.join(" · ");
}

export function ChargeTable({ charges }: { charges: ChargeListItem[] }) {
  const columns = [
    {
      key: "chargeNumber",
      label: "Charge #",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.chargeNumber,
      render: (row: ChargeListItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.chargeNumber}</span>
      ),
    },
    {
      key: "partyName",
      label: "Party",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.partyName,
      render: (row: ChargeListItem) => row.partyName,
    },
    {
      key: "tenancyCode",
      label: "Tenancy",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.tenancyCode ?? "",
      render: (row: ChargeListItem) => row.tenancyCode ?? "-",
    },
    {
      key: "unitCode",
      label: "Unit",
      render: (row: ChargeListItem) => row.unitCode ?? "-",
    },
    {
      key: "chargeType",
      label: "Type",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.chargeType,
      render: (row: ChargeListItem) => row.chargeType,
    },
    {
      key: "documentNumber",
      label: "Document",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.documentNumber ?? "",
      render: (row: ChargeListItem) =>
        row.documentNumber ? (
          <span className="font-medium text-[var(--text-primary)]">{row.documentNumber}</span>
        ) : (
          "-"
        ),
    },
    {
      key: "dueDate",
      label: "Due",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.dueDate,
      render: (row: ChargeListItem) => formatDate(row.dueDate),
    },
    {
      key: "amount",
      label: "Amount",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.amount,
      render: (row: ChargeListItem) => formatMoney(row.amount, row.currency),
    },
    {
      key: "outstandingAmount",
      label: "Outstanding",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.outstandingAmount,
      render: (row: ChargeListItem) => formatMoney(row.outstandingAmount),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: ChargeListItem) => row.status,
      render: (row: ChargeListItem) => (
        <StatusPill tone={getStatusTone(row.status)}>{row.status}</StatusPill>
      ),
    },
    {
      key: "events",
      label: "Events",
      render: (row: ChargeListItem) =>
        row.events.length > 0 ? (
          <details className="group">
            <summary className="cursor-pointer list-none font-medium text-sky-700 marker:hidden group-open:mb-3">
              {row.events.length} recent event(s)
            </summary>
            <BulletList>
              {row.events.map((event, index) => {
                const details = formatEventPayload(event.payloadJson);
                return (
                  <li key={`${row.id}-${event.eventAt}-${index}`}>
                    <span className="font-medium text-slate-800">
                      {event.eventType} ({formatDateTime(event.eventAt)})
                    </span>
                    {details && (
                      <span className="ml-1 text-slate-500">— {details}</span>
                    )}
                  </li>
                );
              })}
            </BulletList>
          </details>
        ) : (
          "-"
        ),
    },
  ];

  return (
    <EnhancedDataTable
      data={charges}
      columns={columns}
      searchPlaceholder="Search charges..."
      searchKeys={["chargeNumber", "partyName", "tenancyCode", "unitCode", "chargeType"]}
      emptyMessage="No charges yet. Create one below."
    />
  );
}
