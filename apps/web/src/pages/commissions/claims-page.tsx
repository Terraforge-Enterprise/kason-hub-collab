import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { PageHeader, Surface } from "@/components/ui";
import { formatMoney } from "@/components/format";
import { Button } from "@/components/ui/button";
import { toCsv, downloadCsv } from "@/lib/csv-export";
import { ListFilterBar, filterControlClass, type ListFilterState } from "@/components/list-filter-bar";
import { ClaimsTableNavigable } from "./claims-table";
import { ClaimDrawer, type ClaimForDrawer, type ClaimDrawerMode } from "./claim-drawer";
import { useClaimActions } from "./use-claim-actions";
import { BulkApproveDialog, type BulkApproveCandidate } from "./bulk-approve-dialog";
import { RequestAmendmentModal } from "@/components/amendment/request-amendment-modal";
import { RoleGate } from "@/components/role-gate";
import type { ClaimListItem } from "./claims-table";

type ClaimsResponse = {
  data: ClaimListItem[];
  pagination: { page: number; limit: number; total: number };
};

export default function CommissionClaimsPage() {
  const [filter, setFilter] = useState<ListFilterState>({
    search: "",
    sort: "newest",
    order: "desc",
    dateField: "createdAt",
    from: undefined,
    to: undefined,
    extras: { status: "all", claimType: "all" },
  });
  const [drawerClaim, setDrawerClaim] = useState<ClaimForDrawer | null>(null);
  const [drawerMode, setDrawerMode] = useState<ClaimDrawerMode>(null);
  const [amendmentModalClaim, setAmendmentModalClaim] = useState<ClaimForDrawer | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const { approve, needsAmendment } = useClaimActions();
  const queryClient = useQueryClient();

  const params = new URLSearchParams({ limit: "200" });
  if (filter.search) params.set("search", filter.search);
  params.set("sort", filter.sort);
  if (filter.dateField) params.set("dateField", filter.dateField);
  if (filter.from) params.set("dateFrom", filter.from);
  if (filter.to) params.set("dateTo", filter.to);
  const st = String(filter.extras.status ?? "all");
  if (st !== "all") params.set("status", st);
  const ct = String(filter.extras.claimType ?? "all");
  if (ct !== "all") params.set("claimType", ct);

  const claims = useQuery({
    queryKey: ["commissions", "claims", filter],
    queryFn: () => apiFetch<ClaimsResponse>(`/commissions/claims?${params}`),
    // Keep the previous page of results visible while the new filter fetches.
    // Prevents the whole page from collapsing to the skeleton on every keystroke.
    placeholderData: (prev) => prev,
  });

  const bulkApprove = useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<{ approved: string[]; failed: { claimId: string; reason: string }[] }>(
        `/commissions/claims/bulk-approve`,
        { method: "POST", body: JSON.stringify({ claimIds: ids }) },
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["commissions", "claims"] });
      setSelectedIds(new Set());
      setBulkOpen(false);
      if (data.failed.length === 0) {
        toast.success(`${data.approved.length} claim${data.approved.length === 1 ? "" : "s"} approved`);
      } else {
        toast(`${data.approved.length} approved, ${data.failed.length} failed`, {
          description: data.failed
            .map((f) => `${f.claimId.slice(0, 8)}…: ${f.reason}`)
            .join("; "),
          duration: 10000,
        });
      }
    },
    onError: (err: Error) => toast.error(`Bulk approve failed: ${err.message}`),
  });

  if (claims.isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
        <div className="h-64 rounded-xl bg-[var(--card-bg)] border border-[var(--card-border)]" />
      </div>
    );
  }

  if (claims.isError) {
    return (
      <p className="p-6 text-sm text-rose-600">
        Failed to load commission claims. Please refresh.
      </p>
    );
  }

  const claimList = claims.data!.data;
  const pendingCount = claimList.filter((c) => c.status === "submitted").length;
  const approvedCount = claimList.filter((c) => c.status === "approved").length;
  const paidCount = claimList.filter((c) => c.status === "paid").length;
  const totalNettPayout = claimList.reduce((sum, c) => sum + c.totalNettPayout, 0);

  const submittedSelectedClaims = claimList.filter((c) => selectedIds.has(c.id) && c.status === "submitted");

  const submittedCandidates: BulkApproveCandidate[] = submittedSelectedClaims.map((c) => ({
    id: c.id,
    claimNumber: c.claimNumber,
    agentName: c.agentName ?? "—",
    totalNettPayout: Number(c.totalNettPayout),
  }));

  const allSubmittedCount = claimList.filter((c) => c.status === "submitted").length;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllSubmitted() {
    setSelectedIds(new Set(claimList.filter((c) => c.status === "submitted").map((c) => c.id)));
  }

  function exportSelectedCsv() {
    const selected = claimList.filter((c) => selectedIds.has(c.id));
    const csv = toCsv(
      selected.map((c) => ({
        claim_number: c.claimNumber,
        agent: c.agentName ?? "",
        amount_nett: Number(c.totalNettPayout),
        status: c.status,
        submitted_at: c.submittedAt,
      })),
      [
        { key: "claim_number", label: "Claim #" },
        { key: "agent", label: "Agent" },
        { key: "amount_nett", label: "Nett Payout" },
        { key: "status", label: "Status" },
        { key: "submitted_at", label: "Submitted At" },
      ],
    );
    downloadCsv(`claims_${Date.now()}.csv`, csv);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Commission claims"
        description="Review, approve, reject, and pay out agent commission claims from a single workspace."
        metrics={[
          { label: "Total Claims", value: String(claimList.length), hint: "All claims on record" },
          { label: "Submitted", value: String(pendingCount), hint: "Awaiting admin review" },
          { label: "Approved", value: String(approvedCount), hint: "Approved, pending payment" },
          { label: "Paid", value: String(paidCount), hint: `${formatMoney(totalNettPayout)} total nett payout` },
        ]}
      />

      <Surface
        title="Claims register"
        description="Click a claim number to view details and take action."
      >
        <div className="space-y-4">
          <ListFilterBar
            value={filter}
            onChange={setFilter}
            searchPlaceholder="Search claim#, agent, unit, tenant, condo..."
            dateFields={[
              { value: "createdAt", label: "Created" },
              { value: "salesDate", label: "Sales date" },
              { value: "moveInDate", label: "Move-in date" },
            ]}
            sortOptions={[
              { value: "newest",    label: "Newest first" },
              { value: "oldest",    label: "Oldest first" },
              { value: "updated",   label: "Recently updated" },
              { value: "status",    label: "By status" },
              { value: "claimType", label: "By type" },
            ]}
            extras={
              <>
                <select
                  value={String(filter.extras.status ?? "all")}
                  onChange={(e) => setFilter({ ...filter, extras: { ...filter.extras, status: e.target.value } })}
                  className={filterControlClass}
                  aria-label="Status"
                >
                  <option value="all">All statuses</option>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                  <option value="needs_amendment">Needs amendment</option>
                  <option value="approved">Approved</option>
                  <option value="amended">Amended</option>
                  <option value="rejected">Rejected</option>
                  <option value="paid">Paid</option>
                </select>
                <select
                  value={String(filter.extras.claimType ?? "all")}
                  onChange={(e) => setFilter({ ...filter, extras: { ...filter.extras, claimType: e.target.value } })}
                  className={filterControlClass}
                  aria-label="Claim type"
                >
                  <option value="all">All types</option>
                  <option value="tenant_portion">Tenant Portion</option>
                  <option value="listing_portion">Listing Portion</option>
                  <option value="tenant_listing_portion">Tenant + Listing Portion</option>
                </select>
              </>
            }
          />

          {allSubmittedCount > 0 && (
            <RoleGate min="manager">
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={selectAllSubmitted}>
                  Select all submitted ({allSubmittedCount})
                </Button>
                {selectedIds.size > 0 && (
                  <span className="text-xs text-muted-foreground">{selectedIds.size} selected</span>
                )}
              </div>
            </RoleGate>
          )}

          <ClaimsTableNavigable
            claims={claimList}
            onApprove={(c) => approve.mutate({ claim: c })}
            onOpenDrawer={(c, m) => { setDrawerClaim(c); setDrawerMode(m); }}
            onSendBackForAmendment={(c) => setAmendmentModalClaim(c)}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        </div>
      </Surface>
      <ClaimDrawer
        claim={drawerClaim}
        mode={drawerMode}
        onClose={() => { setDrawerClaim(null); setDrawerMode(null); }}
      />
      <RequestAmendmentModal
        open={!!amendmentModalClaim}
        onClose={() => setAmendmentModalClaim(null)}
        entityLabel="claim"
        busy={needsAmendment.isPending}
        onSubmit={async (note) => {
          if (!amendmentModalClaim) return;
          await needsAmendment.mutateAsync({ claim: amendmentModalClaim, note });
          setAmendmentModalClaim(null);
        }}
      />

      {/* Floating bulk bar — manager+ only (bulk-approve is a destructive/approval action). */}
      <RoleGate min="manager">
        {selectedIds.size > 0 && (
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="fixed bottom-6 left-1/2 z-40 hidden -translate-x-1/2 items-center gap-3 rounded-full border border-border/50 bg-background/80 px-5 py-2.5 shadow-2xl backdrop-blur-xl md:flex motion-reduce:animate-none"
          >
            <span className="gold-text font-semibold text-sm">{selectedIds.size} selected</span>
            <Button
              variant="gold"
              size="sm"
              disabled={submittedCandidates.length === 0 || bulkApprove.isPending}
              onClick={() => setBulkOpen(true)}
            >
              Approve all{submittedCandidates.length > 0 ? ` (${submittedCandidates.length})` : ""}
            </Button>
            <Button variant="ghost" size="sm" onClick={exportSelectedCsv}>
              Export CSV
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </RoleGate>

      <BulkApproveDialog
        open={bulkOpen}
        candidates={submittedCandidates}
        onCancel={() => setBulkOpen(false)}
        onConfirm={() => bulkApprove.mutate(submittedCandidates.map((c) => c.id))}
        isPending={bulkApprove.isPending}
      />
    </div>
  );
}
