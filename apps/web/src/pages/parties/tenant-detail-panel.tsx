/**
 * TenantDetailPanel — expand-in-place detail view for a single tenant.
 *
 * Rendered inside a full-width expansion row in the Tenants tab
 * (see `tenants-table.tsx`).  Wraps the shared `PartyDetailPanel` shell
 * and composes DetailField groups:
 *
 *   Identity   — IC (audited reveal via IcRevealField), gender, DOB, nationality
 *   Contact    — email, phone (formattedPhone), WhatsApp
 *   Employment — occupation, employer, employer address, monthly income (RM)
 *   Emergency  — name, phone, relation
 *   Status     — status pill, blacklisted flag + reason, created date
 *
 * The Edit button opens `EditTenantDialog` (same dialog used from the ⋯ menu).
 * Null fields display "—".
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { StatusPill } from "@/components/ui";
import { formatDate, formatRM, getStatusTone } from "@/components/format";
import { DetailField } from "@/pages/tenancy/tenant-tracker/row-parts";
import { displayPhone } from "@/pages/tenancy/tenant-tracker/phone-display";
import { useTenantDetail } from "@/api/parties-detail";
import { PartyDetailPanel, IcRevealField } from "./party-detail-panel";
import { EditTenantDialog } from "./tenants-action-dialogs";
import { PortalAccessSection } from "./portal-access-section";
import type { TenantListItem } from "./tenants-table";

// ── Component ─────────────────────────────────────────────────────────────────

export function TenantDetailPanel({
  partyId,
  hasReservation,
}: {
  partyId: string;
  /**
   * Passed down from the row's TenantListItem (GET /parties/tenants) rather
   * than re-fetched here — the tenant detail endpoint (findTenantDetail)
   * doesn't select `_count.reservationsCreatedFrom`, so this panel has no
   * independent source for it.
   */
  hasReservation?: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isLoading, isError, data, error } = useTenantDetail(partyId, true);

  // Project TenantDetail → TenantListItem for EditTenantDialog.
  // Only built when data is loaded; null while loading or on error.
  const tenantForDialog: TenantListItem | null = data
    ? {
        id: data.id,
        displayName: data.displayName,
        legalName: data.legalName,
        primaryEmail: data.primaryEmail,
        primaryPhone: data.primaryPhone,
        formattedPhone: data.formattedPhone,
        occupation: data.occupation,
        status: data.status,
        isBlacklisted: data.isBlacklisted,
        createdAt: data.createdAt,
        nationality: data.nationality,
        employerName: data.employerName,
        monthlyIncome: data.monthlyIncome,
        idType: data.idType,
        // Detail endpoint returns masked IC only (raw IC never leaves the server except
        // via the audited reveal). The Edit dialog has no IC field, so pass null — never
        // the masked string, which must not be mistaken for a real IC.
        idNumber: null,
        blacklistReason: data.blacklistReason,
        // deletable is a list-endpoint field (server-computed). The Edit dialog
        // within the detail panel never deletes, so we pass false safely.
        deletable: false,
      }
    : null;

  const errorMsg = isError
    ? error instanceof Error
      ? error.message
      : "Failed to load tenant details"
    : null;

  return (
    <>
      <PartyDetailPanel
        loading={isLoading}
        error={errorMsg}
        onEdit={() => setEditOpen(true)}
        editLabel="Edit Tenant"
      >
        {data && (
          <>
            {/* ── Identity ───────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Identity
              </p>
              <div className="grid grid-cols-2 gap-3">
                <IcRevealField partyId={partyId} masked={data.idNumberMasked} />
                <DetailField label="Gender">{data.gender ?? "—"}</DetailField>
                <DetailField label="Date of birth">
                  {data.dateOfBirth ? formatDate(data.dateOfBirth) : "—"}
                </DetailField>
                <DetailField label="Nationality">{data.nationality ?? "—"}</DetailField>
              </div>
            </div>

            {/* ── Contact ────────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Contact
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Email">{data.primaryEmail ?? "—"}</DetailField>
                <DetailField label="Phone">{data.formattedPhone ?? "—"}</DetailField>
                <DetailField label="WhatsApp">
                  {data.whatsappPhone ? displayPhone(data.whatsappPhone) : "—"}
                </DetailField>
              </div>
            </div>

            {/* ── Employment ─────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Employment
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Occupation">{data.occupation ?? "—"}</DetailField>
                <DetailField label="Employer">{data.employerName ?? "—"}</DetailField>
                <DetailField label="Employer address">
                  {data.employerAddress ?? "—"}
                </DetailField>
                <DetailField label="Monthly income">
                  {data.monthlyIncome != null
                    ? formatRM(parseFloat(data.monthlyIncome))
                    : "—"}
                </DetailField>
              </div>
            </div>

            {/* ── Emergency ──────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Emergency contact
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Name">{data.emergencyContactName ?? "—"}</DetailField>
                <DetailField label="Phone">{data.emergencyContactPhone ?? "—"}</DetailField>
                <DetailField label="Relation">
                  {data.emergencyContactRelation ?? "—"}
                </DetailField>
              </div>
            </div>

            {/* ── Portal Access ───────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Tenancy history
              </p>
              {(data.tenancyHistory ?? []).length === 0 ? (
                <div className="rounded-lg border border-border/70 bg-background/60 p-3 text-sm text-muted-foreground">
                  No tenancy history yet.
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border/70 bg-background/60">
                  <div className="grid grid-cols-[1.15fr_1.5fr_1fr_1fr] gap-2 bg-[var(--table-header-bg,#DFE9F3)] px-3 py-2 text-xs font-bold text-[var(--text-primary,#082B4F)]">
                    <span>Tenancy</span><span>Property & unit</span><span>Period</span><span>Status / rent</span>
                  </div>
                  {(data.tenancyHistory ?? []).map((item) => (
                    <div key={item.id} className="grid grid-cols-[1.15fr_1.5fr_1fr_1fr] gap-2 border-t border-border/70 px-3 py-2 text-sm">
                      <span className="font-semibold text-[var(--text-primary,#082B4F)]">{item.tenancyCode}</span>
                      <span>{item.propertyName} · {item.unitCode}</span>
                      <span>{formatDate(item.startDate)} – {item.endDate ? formatDate(item.endDate) : "Present"}</span>
                      <span><StatusPill tone={getStatusTone(item.status)}>{item.status}</StatusPill><span className="ml-2 font-semibold">{formatRM(parseFloat(item.monthlyRentAmount))}</span></span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Deposit Ledger ─────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Deposit ledger
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Every collected deposit is transferred to the owner for custody. It remains refundable tenant money—not owner income—and KAEN does not retain it.
                </p>
              </div>
              {(data.depositLedger ?? []).length === 0 ? (
                <div className="rounded-lg border border-border/70 bg-background/60 p-3 text-sm text-muted-foreground">
                  No deposit charges yet.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border/70 bg-background/60">
                  <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                    <thead className="bg-[var(--table-header-bg,#DFE9F3)] text-xs font-bold text-[var(--text-primary,#082B4F)]">
                      <tr>
                        <th className="px-3 py-2">Property & unit</th>
                        <th className="px-3 py-2">Deposit</th>
                        <th className="px-3 py-2">Expected</th>
                        <th className="px-3 py-2">Collected</th>
                        <th className="px-3 py-2">Outstanding</th>
                        <th className="px-3 py-2">With owner (custody)</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.depositLedger ?? []).map((item) => {
                        const expected = Number(item.expected);
                        const collected = Number(item.collected);
                        const outstanding = Number(item.outstanding);
                        const ownerTransferred = Number(item.ownerTransferred);
                        const transferNeedsReview = collected > ownerTransferred + 0.005;
                        const status = transferNeedsReview
                          ? "Owner transfer review"
                          : outstanding > 0 && collected > 0
                            ? "Partially collected"
                            : outstanding > 0
                              ? "Outstanding"
                              : "With owner for refund";
                        const tone = transferNeedsReview
                          ? "rose"
                          : outstanding > 0
                            ? "amber"
                            : "emerald";
                        return (
                          <tr key={item.id} className="border-t border-border/70">
                            <td className="px-3 py-2">
                              <div className="font-semibold">{item.propertyName} · {item.unitCode}</div>
                              <div className="text-xs text-muted-foreground">{item.tenancyCode} · {item.chargeNumber}</div>
                            </td>
                            <td className="px-3 py-2">{item.type === "rental" ? "Rental deposit" : "Utilities deposit"}</td>
                            <td className="px-3 py-2 font-semibold tabular-nums">{formatRM(expected)}</td>
                            <td className="px-3 py-2 font-semibold tabular-nums">{formatRM(collected)}</td>
                            <td className="px-3 py-2 font-semibold tabular-nums">{formatRM(outstanding)}</td>
                            <td className="px-3 py-2 font-semibold tabular-nums">{formatRM(ownerTransferred)}</td>
                            <td className="px-3 py-2"><StatusPill tone={tone}>{status}</StatusPill></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Portal Access ───────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Portal Access
              </p>
              <PortalAccessSection
                partyId={partyId}
                kind="tenant"
                portalUser={data.portalUser}
                defaultEmail={data.primaryEmail}
                defaultFullName={data.displayName}
              />
            </div>

            {/* ── Status ─────────────────────────────────────────────── */}
            <div className="col-span-2 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Status
              </p>
              <div className="grid grid-cols-2 gap-3">
                <DetailField label="Status">
                  <StatusPill tone={getStatusTone(data.status)}>{data.status}</StatusPill>
                </DetailField>
                <DetailField label="Blacklisted">
                  <StatusPill tone={data.isBlacklisted ? "rose" : "emerald"}>
                    {data.isBlacklisted ? "yes" : "no"}
                  </StatusPill>
                </DetailField>
                <DetailField label="Reservation">
                  <StatusPill tone={hasReservation ? "sky" : "slate"}>
                    {hasReservation ? "Has reservation" : "None"}
                  </StatusPill>
                </DetailField>
                {data.isBlacklisted && data.blacklistReason && (
                  <DetailField label="Blacklist reason">{data.blacklistReason}</DetailField>
                )}
                <DetailField label="Created">{formatDate(data.createdAt)}</DetailField>
              </div>
            </div>
          </>
        )}
      </PartyDetailPanel>

      {/* EditTenantDialog — rendered outside PartyDetailPanel so it isn't
          inside the detail grid; open state is controlled by the Edit button. */}
      {tenantForDialog && (
        <EditTenantDialog
          tenant={tenantForDialog}
          open={editOpen}
          onOpenChange={(open) => {
            if (!open) {
              void queryClient.invalidateQueries({ queryKey: ["parties", "tenants", partyId] });
            }
            setEditOpen(open);
          }}
        />
      )}
    </>
  );
}
