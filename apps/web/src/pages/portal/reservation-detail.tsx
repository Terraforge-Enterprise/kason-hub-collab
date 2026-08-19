import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Download,
  FileSignature,
  Hash,
  Loader2,
  Mail,
  MapPin,
  Phone,
  ReceiptText,
  ShieldAlert,
  User,
} from "lucide-react";
import {
  cancelPortalReservation,
  getPortalReservation,
} from "@/api/portal-reservations";
import type { ReservationStatus } from "@/api/reservations";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SendLinkActions } from "@/pages/admin/reservations/reservation-detail-page.send-link-actions";
import { portalApiUrl } from "@/lib/portal-api";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  ReservationStatus,
  {
    label: string;
    variant: "amber" | "emerald" | "rose" | "secondary";
    hint: string;
  }
> = {
  pending_approval: {
    label: "Pending manager approval",
    variant: "amber",
    hint: "You customised the T&Cs. A manager must approve before the sign link is sent.",
  },
  needs_amendment: {
    label: "Needs amendment",
    variant: "rose",
    hint: "Manager rejected. Open the reservation, address the note, and resubmit.",
  },
  pending_customer: {
    label: "Awaiting customer",
    variant: "amber",
    hint: "Share the sign link with your customer below. The reservation becomes valid once they fill Section B and sign.",
  },
  signed: {
    label: "Signed",
    variant: "emerald",
    hint: "The customer has filled Section B and signed. A signed PDF is available below.",
  },
  cancelled: {
    label: "Cancelled",
    variant: "rose",
    hint: "This reservation was cancelled. No further action is possible.",
  },
  expired: {
    label: "Expired",
    variant: "secondary",
    hint: "The sign link expired before the customer completed signing. Create a new reservation if needed.",
  },
};

function formatMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className="h-[18px] w-[3px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
        {label}
      </span>
    </div>
  );
}

function Card({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-border/50 bg-background/40 p-5 backdrop-blur-xl ${className}`}
    >
      <SectionHeader label={label} />
      {children}
    </section>
  );
}

function KeyValue({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

function CancelDialog({
  open,
  onClose,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}) {
  const [reason, setReason] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-background p-6 shadow-2xl">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-rose-500/10 p-2">
            <ShieldAlert className="h-5 w-5 text-rose-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Cancel reservation?</h3>
            <p className="text-xs text-muted-foreground">
              This is permanent. The customer's sign link will stop working.
            </p>
          </div>
        </div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          Reason (visible in audit log)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="mb-4 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="e.g. Customer requested withdrawal"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Keep reservation
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(reason.trim() || "No reason provided")}
            disabled={isPending}
          >
            {isPending ? "Cancelling…" : "Cancel reservation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PortalReservationDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);

  const { data: r, isLoading, isError } = useQuery({
    queryKey: ["portal-reservation", id],
    queryFn: () => getPortalReservation(id),
    enabled: !!id,
  });

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => cancelPortalReservation(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["portal-reservation", id] });
      void qc.invalidateQueries({ queryKey: ["portal-reservations"] });
      setCancelOpen(false);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading reservation…
      </div>
    );
  }
  if (isError || !r) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-rose-600">Failed to load reservation.</p>
        <Link to="/portal/reservations" className="text-sm underline">
          Back to reservations
        </Link>
      </div>
    );
  }

  const status = STATUS_META[r.status];
  const canCancel = r.status === "pending_customer";

  return (
    <div className="space-y-6">
      <CancelDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={(reason) => cancelMutation.mutate(reason)}
        isPending={cancelMutation.isPending}
      />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/portal/reservations"
            className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All reservations
          </Link>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
            <FileSignature className="h-7 w-7 text-primary" />
            <span className="font-mono">{r.referenceCode}</span>
          </h1>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant={status?.variant ?? "secondary"}>
              {status?.label ?? r.status}
            </Badge>
            <span className="text-sm text-muted-foreground">{status?.hint}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {r.signedPdfDownloadUrl && (
            <a
              href={r.signedPdfDownloadUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "gold" }), "gap-2")}
            >
              <Download className="h-4 w-4" />
              Download signed PDF
            </a>
          )}
          {canCancel && (
            <Button variant="destructive" onClick={() => setCancelOpen(true)}>
              Cancel reservation
            </Button>
          )}
        </div>
      </div>

      {/* Sign link — visible to the issuing agent while waiting for the customer */}
      {r.status === "pending_customer" && r.publicToken && (
        <Card label="Sign link — share manually with the customer">
          <Callout variant="info" title="Heads up">
            Sign links are <strong>not</strong> emailed automatically. Copy the link below and send it to
            the customer via WhatsApp, email, or your preferred channel.
          </Callout>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-border/40 bg-background/50 p-3">
            <code className="flex-1 truncate font-mono text-xs text-foreground">
              {`${window.location.origin}/reserve/${r.publicToken}`}
            </code>
          </div>
          <div className="mt-3">
            <SendLinkActions
              reservationId={r.id}
              referenceCode={r.referenceCode}
              publicToken={r.publicToken}
              propertyName={r.property.name}
              unitCode={r.unit.unitCode}
              apiBasePath={portalApiUrl("/reservations")}
            />
          </div>
        </Card>
      )}

      {/* Timeline tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-border/40 bg-background/40 p-4 backdrop-blur-xl">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            Issued
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">{formatDateTime(r.issuedAt)}</p>
        </div>
        <div className="rounded-xl border border-border/40 bg-background/40 p-4 backdrop-blur-xl">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            Expires
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">{formatDateTime(r.expiresAt)}</p>
        </div>
        <div className="rounded-xl border border-border/40 bg-background/40 p-4 backdrop-blur-xl">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            Signed
          </div>
          <p className="mt-1 text-sm font-medium text-foreground">
            {r.signedAt ? formatDateTime(r.signedAt) : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-border/40 bg-background/40 p-4 backdrop-blur-xl">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <Hash className="h-3 w-3" />
            Reservation ID
          </div>
          <p className="mt-1 truncate font-mono text-xs text-foreground/80">{r.id}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Property & Unit */}
        <Card label="Property & Unit">
          <div className="space-y-4">
            <KeyValue label="Property" icon={Building2} value={r.property.name} />
            <KeyValue label="Unit" icon={MapPin} value={r.unit.unitCode} />
            <KeyValue label="Car park" value={r.carPark ?? "—"} />
          </div>
        </Card>

        {/* Tenancy */}
        <Card label="Tenancy">
          <div className="space-y-4">
            <KeyValue
              label="Proposed move-in"
              icon={CalendarDays}
              value={formatDate(r.proposedMoveIn)}
            />
            <KeyValue
              label="Proposed move-out"
              value={r.proposedMoveOut ? formatDate(r.proposedMoveOut) : "—"}
            />
            <KeyValue
              label="Special remarks"
              value={
                r.specialRemarks ? (
                  <span className="whitespace-pre-wrap text-sm">{r.specialRemarks}</span>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </Card>

        {/* Charges */}
        <Card label="Charges" className="lg:col-span-2">
          <div className="overflow-hidden rounded-lg border border-border/40">
            <table className="w-full text-sm">
              <tbody>
                {[
                  ["Reservation deposit", r.charges.reservationDeposit],
                  ["Documentation fee", r.charges.documentationFee],
                  ["Rental deposit", r.charges.rentalDeposit],
                  ["Utility deposit", r.charges.utilityDeposit],
                  ["Access card deposit", r.charges.accessCardDeposit],
                ].map(([label, value], idx) => (
                  <tr
                    key={label}
                    className={idx % 2 === 0 ? "bg-background/30" : "bg-background/10"}
                  >
                    <td className="px-4 py-2.5 text-muted-foreground">{label}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium tabular-nums text-foreground">
                      {formatMoney(value)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border/60 bg-amber-500/5">
                  <td className="px-4 py-3 text-sm font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    <span className="flex items-center gap-1.5">
                      <ReceiptText className="h-3.5 w-3.5" />
                      Total
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-base font-bold tabular-nums text-amber-700 dark:text-amber-300">
                    {formatMoney(
                      [
                        r.charges.reservationDeposit,
                        r.charges.documentationFee,
                        r.charges.rentalDeposit,
                        r.charges.utilityDeposit,
                        r.charges.accessCardDeposit,
                      ]
                        .reduce((acc, v) => acc + (Number(v) || 0), 0)
                        .toFixed(2),
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* Applicant */}
        <Card label="Applicant" className="lg:col-span-2">
          {!r.applicant.fullName ? (
            <div className="rounded-lg border border-dashed border-amber-400/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-300">
              Awaiting Section B — the customer will provide these details when they open
              the sign link.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <KeyValue label="Full name" icon={User} value={r.applicant.fullName} />
              <KeyValue
                label="NRIC"
                icon={Hash}
                value={<span className="font-mono">{r.applicant.nric ?? "—"}</span>}
              />
              <KeyValue label="Contact" icon={Phone} value={r.applicant.contact ?? "—"} />
              <KeyValue label="Email" icon={Mail} value={r.applicant.email ?? "—"} />
              <KeyValue label="Address line 1" icon={MapPin} value={r.applicant.addressLine1 ?? "—"} />
              <KeyValue label="Address line 2" icon={MapPin} value={r.applicant.addressLine2 ?? "—"} />
              <KeyValue label="City" value={r.applicant.city ?? "—"} />
              <KeyValue label="Postcode" value={r.applicant.postcode ?? "—"} />
              <KeyValue label="State" value={r.applicant.state ?? "—"} />
              <KeyValue label="Country" value={r.applicant.country ?? "—"} />
              <div className="md:col-span-2 mt-2 text-sm">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Identity documents</span>
                <div className="mt-1">
                  {r.documents.length === 0 ? (
                    <span className="text-muted-foreground">No identity documents uploaded</span>
                  ) : (
                    <span className="text-emerald-600">
                      {r.documents.some((d) => d.kind.startsWith("passport")) ? "Passport ✓ " : ""}
                      {r.documents.some((d) => d.kind.startsWith("ic")) ? "IC ✓" : ""}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* Signed document */}
        <Card label="Signed Document" className="lg:col-span-2">
          {r.status === "signed" && r.signedPdfDownloadUrl ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-emerald-500/10 p-2.5">
                  <FileSignature className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Signed PDF available</p>
                  <p className="text-xs text-muted-foreground">
                    Signed {r.signedAt ? formatDateTime(r.signedAt) : ""}
                  </p>
                </div>
              </div>
              <a
                href={r.signedPdfDownloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] px-3.5 py-2 text-sm font-medium text-white shadow-[0_8px_24px_-8px_rgba(212,175,55,0.4)] transition-shadow hover:shadow-[0_12px_28px_-6px_rgba(212,175,55,0.5)]"
              >
                <Download className="h-4 w-4" />
                Download PDF
              </a>
            </div>
          ) : r.status === "pending_customer" ? (
            <div className="rounded-lg border border-dashed border-amber-400/40 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-300">
              Awaiting customer signature. A PDF will be generated automatically once the
              customer fills Section B and signs.
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
              No signed document — reservation is {(status?.label ?? r.status).toLowerCase()}.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
