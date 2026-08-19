import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { formatDate, formatMoney, getStatusTone } from "@/components/format";

export type TenancyListItem = {
  id: string;
  tenancyCode: string;
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitCode: string;
  tenantPartyId: string;
  tenantName: string;
  status: string;
  billingStatus: string;
  startDate: string;
  endDate: string | null;
  monthlyRentAmount: number;
  depositAmount: number | null;
  previousTenancyId: string | null;
};

export function TenancyTable({ tenancies }: { tenancies: TenancyListItem[] }) {
  const columns = [
    {
      key: "tenancyCode",
      label: "Tenancy",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.tenancyCode,
      render: (row: TenancyListItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.tenancyCode}</span>
      ),
    },
    {
      key: "tenantName",
      label: "Tenant",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.tenantName,
      render: (row: TenancyListItem) => row.tenantName,
    },
    {
      key: "propertyUnit",
      label: "Property / Unit",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.propertyName,
      render: (row: TenancyListItem) => `${row.propertyName} · ${row.unitCode}`,
    },
    {
      key: "startDate",
      label: "Start",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.startDate,
      render: (row: TenancyListItem) => formatDate(row.startDate),
    },
    {
      key: "endDate",
      label: "End",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.endDate ?? "",
      render: (row: TenancyListItem) => formatDate(row.endDate),
    },
    {
      key: "monthlyRentAmount",
      label: "Rent",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.monthlyRentAmount,
      render: (row: TenancyListItem) => formatMoney(row.monthlyRentAmount),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: TenancyListItem) => row.status,
      render: (row: TenancyListItem) => (
        <StatusPill tone={getStatusTone(row.status)}>{row.status}</StatusPill>
      ),
    },
    {
      key: "chain",
      label: "Chain",
      render: (row: TenancyListItem) =>
        row.previousTenancyId
          ? `renewal of ${row.previousTenancyId.slice(0, 8)}...`
          : "root tenancy",
    },
  ];

  return (
    <EnhancedDataTable
      data={tenancies}
      columns={columns}
      searchPlaceholder="Search tenancies..."
      searchKeys={["tenancyCode", "tenantName", "propertyName", "unitCode"]}
      emptyMessage="No tenancies yet. Create one below."
    />
  );
}
