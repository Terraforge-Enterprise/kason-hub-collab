import { EnhancedDataTable } from "@/components/data-table";
import { StatusPill } from "@/components/ui";
import { formatDate, getStatusTone } from "@/components/format";
import { useState } from "react";
import { FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ManagementAgreementDialog } from "./management-agreement-dialog";

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
  const [agreement, setAgreement] = useState<LandlordTenancyListItem | null>(null);
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
      label: "Owner",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.landlordName,
      render: (row: LandlordTenancyListItem) => row.landlordName,
    },
    {
      key: "startDate",
      label: "Management Start",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.startDate,
      render: (row: LandlordTenancyListItem) => formatDate(row.startDate),
    },
    {
      key: "endDate",
      label: "Management End",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.endDate ?? "",
      render: (row: LandlordTenancyListItem) => formatDate(row.endDate),
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      sortValue: (row: LandlordTenancyListItem) => row.status,
      render: (row: LandlordTenancyListItem) => (
        <StatusPill tone={getStatusTone(row.status)}>
          {row.status.charAt(0).toUpperCase() + row.status.slice(1)}
        </StatusPill>
      ),
    },
    {
      key: "agreement",
      label: "Management Agreement",
      render: (row: LandlordTenancyListItem) => <Button type="button" variant="outline" size="sm" className="gap-1.5 whitespace-nowrap" onClick={() => setAgreement(row)}><FileSignature className="h-4 w-4" />Create / Open Agreement</Button>,
    },
  ];

  return (<>
    <EnhancedDataTable
      data={tenancies}
      columns={columns}
      searchPlaceholder="Search landlord tenancies..."
      searchKeys={["propertyName", "landlordName"]}
      emptyMessage="No Property Management Agreement records yet."
    />
    {agreement ? <ManagementAgreementDialog relation={agreement} open onClose={() => setAgreement(null)} /> : null}
  </>);
}
