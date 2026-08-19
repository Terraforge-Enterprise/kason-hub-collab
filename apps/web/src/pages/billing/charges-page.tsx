import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/components/format";
import { ChargeTable } from "./charges-table";
import { ChargeForms } from "./charges-forms";
import type { ChargeListItem } from "./charges-table";

type TenantListItem = { id: string; displayName: string };
type TenancyListItem = { id: string; tenancyCode: string; tenantName: string };
type UnitListItem = { id: string; propertyName: string; unitCode: string };

// Spec §4.8 gap: the register was unpaginated at 100+ unit / monthly-posting
// scale. GET /billing/charges only paginates when ?page/?pageSize are sent —
// omitting them (as payments-page's charge pool and the parked M5
// draft-invoice-charge-picker still do) keeps the old full-list response.
const PAGE_SIZE = 25;

export default function ChargesPage() {
  const [page, setPage] = useState(1);

  // Register table: server-paginated (spec §4.8 gap fix).
  const chargesPage = useQuery({
    queryKey: ["billing", "charges", "page", { page, pageSize: PAGE_SIZE }],
    queryFn: () =>
      apiFetch<{ data: ChargeListItem[]; total: number }>(
        `/billing/charges?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });

  // Post/void pickers (ChargeForms) + header metrics need the FULL org-wide
  // list — no page params sent, so this hits the exact pre-existing
  // unpaginated response shape (same query key + queryFn payments-page and
  // the parked M5 picker still use). Keeping this separate from the table
  // query means the register can paginate without truncating what an admin
  // can post/void, or making the ledger metrics page-scoped.
  const charges = useQuery({
    queryKey: ["billing", "charges"],
    queryFn: () => apiFetch<{ data: ChargeListItem[] }>("/billing/charges"),
  });

  const tenancies = useQuery({
    queryKey: ["tenancy", "tenancies"],
    queryFn: () => apiFetch<{ data: TenancyListItem[] }>("/tenancy/tenancies"),
  });

  const tenants = useQuery({
    queryKey: ["parties", "tenants"],
    queryFn: () => apiFetch<{ data: TenantListItem[] }>("/parties/tenants"),
  });

  const units = useQuery({
    queryKey: ["inventory", "units"],
    queryFn: () => apiFetch<{ data: UnitListItem[] }>("/inventory/units"),
  });

  const isLoading =
    charges.isLoading ||
    chargesPage.isLoading ||
    tenancies.isLoading ||
    tenants.isLoading ||
    units.isLoading;
  const hasError =
    charges.isError || chargesPage.isError || tenancies.isError || tenants.isError || units.isError;

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
        Failed to load charges data. Please refresh.
      </p>
    );
  }

  const chargeList = charges.data!.data;
  const pageItems = chargesPage.data!.data;
  const total = chargesPage.data!.total;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tenancyList = tenancies.data!.data;
  const tenantList = tenants.data!.data;
  const unitList = units.data!.data;

  const outstandingTotal = chargeList.reduce((sum, c) => sum + c.outstandingAmount, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Charges ledger"
        description="Draft, post, and void billable items with related tenancy and event history visible in the same workspace."
        metrics={[
          { label: "Charges", value: String(chargeList.length), hint: "Ledger rows created" },
          {
            label: "Posted",
            value: String(chargeList.filter((c) => c.status === "posted").length),
            hint: "Live for collection",
          },
          {
            label: "Outstanding",
            value: formatMoney(outstandingTotal),
            hint: "Uncleared exposure",
          },
          {
            label: "Tenancies linked",
            value: String(tenancyList.length),
            hint: `${tenantList.length} tenants · ${unitList.length} units`,
          },
        ]}
      />
      <Surface
        title="Charge register"
        description="Billing items with party, tenancy, unit, exposure, and latest event context. Search filters within the current page."
      >
        <ChargeTable charges={pageItems} />
        <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)]">
          <span>
            Page {page} of {pageCount} — {total} charge(s)
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      </Surface>
      {/* tenants/tenancies/units queries above still feed the PageHeader
          metrics; ChargeForm fetches its own pickers on the SAME query keys.
          ChargeForms below is fed the FULL (unpaginated) charge list so an
          admin can post/void ANY charge, not just the visible register page. */}
      <ChargeForms
        charges={chargeList.map((c) => ({
          id: c.id,
          chargeNumber: c.chargeNumber,
          status: c.status,
        }))}
      />
    </div>
  );
}
