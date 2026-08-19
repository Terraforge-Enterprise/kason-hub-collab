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
