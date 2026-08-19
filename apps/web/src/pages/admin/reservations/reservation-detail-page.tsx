import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  CheckCircle2,
  Download,
  FileSignature,
  Hash,
  History,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  ReceiptText,
  ShieldAlert,
  User,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  approveReservation,
  cancelReservation,
  getReservation,
  getReservationDocViewUrl,
  rejectReservation,
  type ReservationStatus,
} from "@/api/reservations";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { TERMS_AND_CONDITIONS } from "@/lib/reservation-terms";
import { API_BASE } from "@/lib/api-client";
import { SendLinkActions } from "./reservation-detail-page.send-link-actions";
import { EditAfterSignedDialog } from "./edit-after-signed-dialog";
import { useReservationEditHistory } from "./use-reservation-edit-history";

const STATUS_META: Record<
  ReservationStatus,
  {
    label: string;
    variant: "amber" | "emerald" | "rose" | "secondary";
    hint: string;
  }
> = {
  pending_approval: {
    label: "Pending approval",
    variant: "amber",
    hint: "The reservation is awaiting operator approval.",
  },
  needs_amendment: {
    label: "Needs amendment",
    variant: "rose",
    hint: "The operator has requested changes before approval.",
  },
  pending_customer: {
    label: "Pending customer",
    variant: "amber",
    hint: "Sign link is live — share it with the customer below. The reservation becomes valid once they fill Section B and sign.",
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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-background p-6 shadow-2xl">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-rose-500/10 p-2">
            <ShieldAlert className="h-5 w-5 text-rose-600" />
          </div>
          <div>
            <h3 id="cancel-dialog-title" className="text-lg font-semibold">Cancel reservation?</h3>
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

function RejectDialog({
  open,
  onClose,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
  isPending: boolean;
}) {
  const [note, setNote] = useState("");
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-background p-6 shadow-2xl">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-rose-500/10 p-2">
            <XCircle className="h-5 w-5 text-rose-600" />
          </div>
          <div>
            <h3 id="reject-dialog-title" className="text-lg font-semibold">Reject reservation?</h3>
            <p className="text-xs text-muted-foreground">
              The agent will see your note and can amend the T&Cs to resubmit.
            </p>
          </div>
        </div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          Note to agent (required)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
          className="mb-4 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="e.g. Please restore clause 5 and clarify the addendum"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(note.trim())}
            disabled={isPending || note.trim().length === 0}
          >
            {isPending ? "Rejecting…" : "Reject reservation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function ReservationDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { data: r, isLoading, isError } = useQuery({
    queryKey: ["admin", "reservation", id],
    queryFn: () => getReservation(id),
    enabled: !!id,
  });

  // Admin-only audit trail — surfaces "Edited (N times)" pill when present.
  // Skipped entirely for non-admins (the API would 403 anyway). Fetched for
  // both signed and pending_customer statuses since admin edits are allowed
  // on both (the audit-log endpoint returns either action code).
  const { data: editHistory } = useReservationEditHistory(
    id,
    isAdmin &&
      !!id &&
      (r?.status === "signed" || r?.status === "pending_customer"),
  );

  const cancelMutation = useMutation({
    mutationFn: (reason: string) => cancelReservation(id, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "reservation", id] });
      void qc.invalidateQueries({ queryKey: ["admin", "reservations"] });
      setCancelOpen(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not cancel");
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => approveReservation(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "reservation", id] });
      void qc.invalidateQueries({ queryKey: ["admin", "reservations"] });
      toast.success("Reservation approved — share the sign link with the customer");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (note: string) => rejectReservation(id, note),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "reservation", id] });
      void qc.invalidateQueries({ queryKey: ["admin", "reservations"] });
      setRejectOpen(false);
      toast.success("Reservation rejected — agent notified");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not reject");
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
        <Link to="/admin/reservations" className="text-sm underline">
          Back to reservations
        </Link>
      </div>
    );
  }

  const status = STATUS_META[r.status];
  const canCancel = r.status === "pending_customer";
  // Admin/manager may edit signed OR pending_customer (awaiting-tenant)
  // reservations. The dialog adjusts its warning copy by status. Pre-sign
  // edits don't touch any PDF (none exists yet); post-sign edits warn that
  // the already-signed PDF is not regenerated.
  const canAdminEdit =
    (r.status === "signed" || r.status === "pending_customer") && isAdmin;
  const editCount = editHistory?.entries.length ?? 0;

  return (
    <div className="space-y-6">
      <CancelDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={(reason) => cancelMutation.mutate(reason)}
        isPending={cancelMutation.isPending}
      />
      <RejectDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={(note) => rejectMutation.mutate(note)}
        isPending={rejectMutation.isPending}
      />
      {canAdminEdit && (
        <EditAfterSignedDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          reservation={r}
          onSaved={() => {
            setEditOpen(false);
            void qc.invalidateQueries({ queryKey: ["admin", "reservation", id] });
            void qc.invalidateQueries({ queryKey: ["admin", "reservation-edit-history", id] });
            void qc.invalidateQueries({ queryKey: ["admin", "reservations"] });
          }}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/admin/reservations"
            className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All reservations
          </Link>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
            <FileSignature className="h-7 w-7 text-primary" />
            <span className="font-mono">{r.referenceCode}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={status.variant}>{status.label}</Badge>
            {editCount > 0 && (
              <Badge
                variant="amber"
                className="inline-flex items-center gap-1"
                title={editHistory?.entries
                  .map(
                    (e) =>
                      `${formatDateTime(e.createdAt)} — ${e.actorName}: ${e.reason}`,
                  )
                  .join("\n")}
              >
                <History className="h-3 w-3" />
                Edited ({editCount} {editCount === 1 ? "time" : "times"})
              </Badge>
            )}
            <span className="text-sm text-muted-foreground">{status.hint}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
          {r.status === "pending_customer" && r.publicToken && (
            <SendLinkActions
              reservationId={r.id}
              referenceCode={r.referenceCode}
              publicToken={r.publicToken}
              propertyName={r.property.name}
              unitCode={r.unit.unitCode}
              apiBasePath={`${API_BASE}/admin/reservations`}
            />
          )}
          {/* Header-right actions slot — follows /frontend skill section 6:
              "page header on the right with an actions slot". All buttons
              use the `gap-2` icon spacing pattern (no per-button margin
              tweaks) so the row reads as a single horizontal block. */}
          {canAdminEdit && (
            <Button variant="outline" className="gap-2" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
          )}
          {canCancel && (
            <Button
              variant="destructive"
              className="gap-2"
              onClick={() => setCancelOpen(true)}
            >
              <XCircle className="h-4 w-4" />
              Cancel reservation
            </Button>
          )}
        </div>
      </div>

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
              <KeyValue label="Nationality" value={r.applicant.nationality ?? "—"} />
              <KeyValue label="Occupation" value={r.applicant.occupation ?? "—"} />
              <KeyValue label="Monthly income" value={r.applicant.monthlyIncome ? `RM ${r.applicant.monthlyIncome}` : "—"} />
              <KeyValue label="Emergency contact" value={r.applicant.emergencyContactName ?? "—"} />
              <KeyValue label="Emergency phone" value={r.applicant.emergencyContactPhone ?? "—"} />
              <KeyValue label="Emergency relationship" value={r.applicant.emergencyContactRelation ?? "—"} />
            </div>
          )}
        </Card>

        {/* Identity Documents */}
        <Card label="Identity Documents" className="lg:col-span-2">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {([
              ["passport_front", "Passport (front)"],
              ["passport_back", "Passport (back)"],
              ["ic_front", "IC (front)"],
              ["ic_back", "IC (back)"],
            ] as const).map(([kind, label]) => {
              const doc = r.documents.find((d) => d.kind === kind);
              return (
                <div key={kind} className="flex items-center justify-between rounded-lg border border-border/50 p-3 text-sm">
                  <span>{label}</span>
                  {doc ? (
                    <button
                      type="button"
                      className="text-xs text-amber-600"
                      onClick={async () => {
                        const { url } = await getReservationDocViewUrl(id, doc.id);
                        window.open(url, "_blank", "noopener");
                      }}
                    >
                      Uploaded ✓ — View
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not provided</span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* T&C Customization — Approval review */}
        {r.status === "pending_approval" && (
          <Card label="T&C Customization — Review" className="lg:col-span-2">
            <div className="space-y-4">
              {r.customTerms.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    Agent's proposed clauses ({r.customTerms.length}) — replaces the bundled defaults
                  </p>
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                    {r.customTerms.map((clause, i) => (
                      <li key={i}>{clause}</li>
                    ))}
                  </ol>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    For reference, the bundled defaults are:
                  </p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                    {TERMS_AND_CONDITIONS.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No custom clauses recorded — this row is in pending_approval anomalously. You can still approve.
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-border/40">
                <Button
                  variant="gold"
                  onClick={() => approveMutation.mutate()}
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                >
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                  {approveMutation.isPending ? "Approving…" : "Approve & send link"}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setRejectOpen(true)}
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                >
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Reject
                </Button>
              </div>
            </div>
          </Card>
        )}

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
              No signed document — reservation is {status.label.toLowerCase()}.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
