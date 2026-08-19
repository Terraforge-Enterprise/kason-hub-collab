import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { formatDate, formatMoney, getStatusTone } from "@/components/format";

export type LandlordTenancyListItem = {
  id: string;
  propertyId: string;
  propertyName: string;
  landlordId: string;
  landlordName: string;
  startDate: string;
  endDate: string | null;
  monthlyRent: number;
  depositAmount: number | null;
  status: string;
  notes: string | null;
};

export function LandlordTenancyTable({
  tenancies,
}: {
  tenancies: LandlordTenancyListItem[];
}) {
  const columns = [
    {
      key: "propertyName",
      label: "Property",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.propertyName,
      render: (row: LandlordTenancyListItem) => (
        <span className="font-medium text-[var(--text-primary)]">{row.propertyName}</span>
      ),
    },
    {
      key: "landlordName",
      label: "Landlord",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.landlordName,
      render: (row: LandlordTenancyListItem) => row.landlordName,
    },
    {
      key: "startDate",
      label: "Start",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.startDate,
      render: (row: LandlordTenancyListItem) => formatDate(row.startDate),
    },
    {
      key: "endDate",
      label: "End",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.endDate ?? "",
      render: (row: LandlordTenancyListItem) => formatDate(row.endDate),
    },
    {
      key: "monthlyRent",
      label: "Monthly Rent",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.monthlyRent,
      render: (row: LandlordTenancyListItem) => formatMoney(row.monthlyRent),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.status,
      render: (row: LandlordTenancyListItem) => (
        <StatusPill tone={getStatusTone(row.status)}>{row.status}</StatusPill>
      ),
    },
  ];

  return (
    <EnhancedDataTable
      data={tenancies}
      columns={columns}
      searchPlaceholder="Search landlord tenancies..."
      searchKeys={["propertyName", "landlordName"]}
      emptyMessage="No landlord-tenancy linkages yet. Create one below."
    />
  );
}
