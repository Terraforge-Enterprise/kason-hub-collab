import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { FileSignature, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  listPortalReservations,
  resubmitPortalReservation,
  type ReservationDto,
  type ReservationStatus,
  type ResubmitPortalReservationPayload,
} from "@/api/portal-reservations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { TERMS_AND_CONDITIONS } from "@/lib/reservation-terms";

const STATUS_TABS: Array<{ value: ReservationStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending_approval", label: "Awaiting Manager" },
  { value: "needs_amendment", label: "Needs Amendment" },
  { value: "pending_customer", label: "Awaiting Tenant" },
  { value: "signed", label: "Signed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

const STATUS_BADGE: Record<
  ReservationStatus,
  { label: string; variant: "amber" | "emerald" | "rose" | "secondary" }
> = {
  pending_approval: { label: "Awaiting Manager", variant: "amber" },
  needs_amendment: { label: "Needs Amendment", variant: "rose" },
  pending_customer: { label: "Awaiting Tenant", variant: "amber" },
  signed: { label: "Signed", variant: "emerald" },
  cancelled: { label: "Cancelled", variant: "rose" },
  expired: { label: "Expired", variant: "secondary" },
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date(iso));
}

export default function ReservationListPage() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const awaitingApprovalId = searchParams.get("awaiting_approval");
  const justCreatedId = searchParams.get("just");
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data = [], isLoading, isError } = useQuery({
    queryKey: ["portal-reservations"],
    queryFn: listPortalReservations,
  });

  const editingReservation = editingId ? data.find((r) => r.id === editingId) ?? null : null;

  const filtered =
    statusFilter === "all" ? data : data.filter((r) => r.status === statusFilter);

  const counts = data.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    acc.all = (acc.all ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground md:text-4xl">
            <FileSignature className="h-7 w-7 text-primary" />
            My Reservations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Unit reservations you've created. Click any reservation to view the details.
          </p>
        </div>
        <Link
          to="/portal/reservations/new"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_-8px_rgba(212,175,55,0.4)] transition-shadow hover:shadow-[0_12px_28px_-6px_rgba(212,175,55,0.5)]"
        >
          <Plus className="h-4 w-4" />
          New reservation
        </Link>
      </div>

      {awaitingApprovalId && (
        <Callout variant="info" title="Reservation pending approval">
          Sent to your manager for review. Once approved, the sign link becomes available
          on the reservation's detail page — you'll then share it manually with the customer.
        </Callout>
      )}
      {justCreatedId && !awaitingApprovalId && (
        <Callout variant="success" title="Reservation saved — share the sign link">
          Open the reservation to copy the sign link, send it via WhatsApp, or download the
          unsigned PDF. The customer signs digitally from the link.
        </Callout>
      )}

      <div className="flex flex-wrap gap-1.5">
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.value;
          const count = counts[tab.value] ?? 0;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setStatusFilter(tab.value)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "border-amber-300 bg-gradient-to-r from-amber-50 to-yellow-50 text-amber-800 shadow-sm dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  : "border-border/60 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground"
              }`}
            >
              {tab.label}
              <span className="rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-border/50 bg-background/40 backdrop-blur-xl">
        {isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading reservations…
          </div>
        ) : isError ? (
          <p className="p-6 text-sm text-rose-600">Failed to load reservations.</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
            <div className="rounded-full bg-muted/40 p-3">
              <FileSignature className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No reservations</p>
            <p className="text-xs text-muted-foreground">
              {statusFilter === "all"
                ? "Start by creating your first reservation."
                : `No reservations in the '${statusFilter}' state.`}
            </p>
            {statusFilter === "all" && (
              <Link
                to="/portal/reservations/new"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
              >
                <Plus className="h-3 w-3" />
                Create reservation
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-3">Reference</th>
                  <th className="px-5 py-3">Property · Unit</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Issued</th>
                  <th className="px-5 py-3">Expires</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, idx) => {
                  // Defense-in-depth: if the API ever returns a status not in our union
                  // (e.g. a new DB enum value the frontend hasn't been rebuilt for),
                  // fall back to a neutral pill instead of crashing on undefined access.
                  const badge = STATUS_BADGE[r.status];
                  return (
                    <tr
                      key={r.id}
                      className={`border-b border-border/30 last:border-b-0 transition-colors hover:bg-muted/40 ${
                        idx % 2 === 0 ? "bg-background/20" : ""
                      }`}
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          to={`/portal/reservations/${r.id}`}
                          className="font-mono text-sm font-semibold text-foreground transition-colors hover:text-primary"
                        >
                          {r.referenceCode}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="text-sm font-medium text-foreground">
                          {r.property.name}
                        </div>
                        <div className="text-xs text-muted-foreground">{r.unit.unitCode}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge variant={badge?.variant ?? "secondary"}>
                          {badge?.label ?? r.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground tabular-nums">
                        {formatDate(r.issuedAt)}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground tabular-nums">
                        {formatDate(r.expiresAt)}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {/* D1 + D2: agent self-edit on every live status.
                            - needs_amendment: "Edit & Resubmit" (manager
                              rejected; T&C customisation re-triggers approval).
                            - pending_approval: "Edit" (manager hasn't decided
                              — edit stays in pending_approval).
                            - pending_customer: "Edit" (sign link is out but
                              tenant hasn't signed — typo fix without
                              cancel + re-create).
                            - signed: "Edit" — flips back to pending_customer,
                              nulls the signature, tenant must re-sign.
                            Terminal statuses (cancelled, expired) stay
                            read-only per user decision. */}
                        {(r.status === "needs_amendment" ||
                          r.status === "pending_approval" ||
                          r.status === "pending_customer" ||
                          r.status === "signed") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingId(r.id)}
                          >
                            {r.status === "needs_amendment" ? "Edit & Resubmit" : "Edit"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingReservation && (
        <ResubmitDialog
          reservation={editingReservation}
          onClose={() => setEditingId(null)}
          onSuccess={() => {
            setEditingId(null);
            // Clear both query params on resubmit success — the Callouts they
            // trigger refer to the original create flow and are stale once the
            // agent has interacted with the row.
            setSearchParams({});
            void qc.invalidateQueries({ queryKey: ["portal-reservations"] });
            // Also invalidate the detail-page cache for THIS reservation —
            // without this, the signed→pending_customer reset shows on the
            // list but the detail page still serves the stale "Signed" entry
            // (and the SendLinkActions card stays hidden because it's gated
            // on r.status === "pending_customer").
            void qc.invalidateQueries({
              queryKey: ["portal-reservation", editingReservation.id],
            });
          }}
        />
      )}
    </div>
  );
}

// Form state for the unified portal Edit dialog. Mirrors the editable subset
// of UnitReservation. Dates are kept as "YYYY-MM-DD" strings for <input
// type="date"> compatibility — converted to ISO datetime on submit.
interface PortalEditFormState {
  applicantFullName: string;
  applicantNric: string;
  applicantContact: string;
  applicantEmail: string;
  carPark: string;
  proposedMoveIn: string;
  proposedMoveOut: string;
  specialRemarks: string;
  reservationDeposit: string;
  documentationFee: string;
  rentalDeposit: string;
  utilityDeposit: string;
  accessCardDeposit: string;
}

function isoToDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function dateInputToIso(yyyymmdd: string): string {
  // <input type="date"> already gives us a date-only string; round-trip
  // through Date to produce the timezone-aware ISO format the backend
  // expects (z.string().datetime()). UTC midnight is fine for date-only.
  return new Date(`${yyyymmdd}T00:00:00.000Z`).toISOString();
}

function reservationToPortalForm(r: ReservationDto): PortalEditFormState {
  return {
    applicantFullName: r.applicant.fullName ?? "",
    applicantNric: r.applicant.nric ?? "",
    applicantContact: r.applicant.contact ?? "",
    applicantEmail: r.applicant.email ?? "",
    carPark: r.carPark ?? "",
    proposedMoveIn: isoToDateInput(r.proposedMoveIn),
    proposedMoveOut: isoToDateInput(r.proposedMoveOut),
    specialRemarks: r.specialRemarks ?? "",
    reservationDeposit: r.charges.reservationDeposit,
    documentationFee: r.charges.documentationFee,
    rentalDeposit: r.charges.rentalDeposit,
    utilityDeposit: r.charges.utilityDeposit,
    accessCardDeposit: r.charges.accessCardDeposit,
  };
}

// Diff-based payload: only fields the agent actually changed go on the wire.
// Empty strings on optional fields (carPark, specialRemarks, applicant*) map
// to null when explicitly cleared. proposedMoveIn is required — never sent
// as empty.
function buildPortalEditPayload(
  reservation: ReservationDto,
  state: PortalEditFormState,
  customTerms: string[],
): ResubmitPortalReservationPayload {
  const baseline = reservationToPortalForm(reservation);
  const payload: ResubmitPortalReservationPayload = { customTerms };

  if (state.applicantFullName !== baseline.applicantFullName && state.applicantFullName.trim()) {
    payload.applicantFullName = state.applicantFullName.trim();
  }
  if (state.applicantNric !== baseline.applicantNric && state.applicantNric.trim()) {
    payload.applicantNric = state.applicantNric.trim();
  }
  if (state.applicantContact !== baseline.applicantContact && state.applicantContact.trim()) {
    payload.applicantContact = state.applicantContact.trim();
  }
  if (state.applicantEmail !== baseline.applicantEmail && state.applicantEmail.trim()) {
    payload.applicantEmail = state.applicantEmail.trim();
  }
  if (state.carPark !== baseline.carPark) {
    payload.carPark = state.carPark.trim() === "" ? null : state.carPark.trim();
  }
  if (state.proposedMoveIn !== baseline.proposedMoveIn && state.proposedMoveIn) {
    payload.proposedMoveIn = dateInputToIso(state.proposedMoveIn);
  }
  if (state.proposedMoveOut !== baseline.proposedMoveOut) {
    payload.proposedMoveOut = state.proposedMoveOut ? dateInputToIso(state.proposedMoveOut) : null;
  }
  if (state.specialRemarks !== baseline.specialRemarks) {
    payload.specialRemarks = state.specialRemarks.trim() === "" ? null : state.specialRemarks;
  }
  if (state.reservationDeposit !== baseline.reservationDeposit) {
    payload.reservationDeposit = state.reservationDeposit;
  }
  if (state.documentationFee !== baseline.documentationFee) {
    payload.documentationFee = state.documentationFee;
  }
  if (state.rentalDeposit !== baseline.rentalDeposit) {
    payload.rentalDeposit = state.rentalDeposit;
  }
  if (state.utilityDeposit !== baseline.utilityDeposit) {
    payload.utilityDeposit = state.utilityDeposit;
  }
  if (state.accessCardDeposit !== baseline.accessCardDeposit) {
    payload.accessCardDeposit = state.accessCardDeposit;
  }
  return payload;
}

function PortalFieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </label>
  );
}

const PORTAL_INPUT_CLASS =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ResubmitDialog({
  reservation,
  onClose,
  onSuccess,
}: {
  reservation: ReservationDto;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState<PortalEditFormState>(() => reservationToPortalForm(reservation));
  const [keepDefaults, setKeepDefaults] = useState<boolean>(
    reservation.customTerms.length === 0,
  );
  const [customTerms, setCustomTerms] = useState<string[]>(
    reservation.customTerms.length > 0
      ? [...reservation.customTerms]
      : [...TERMS_AND_CONDITIONS],
  );
  // D2: signed-edit triggers the reset flow and needs an audit-grade reason.
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);

  function update<K extends keyof PortalEditFormState>(key: K, value: PortalEditFormState[K]) {
    setForm((s) => ({ ...s, [key]: value }));
  }

  const isSignedEdit = reservation.status === "signed";
  const trimmedReason = reason.trim();
  const reasonValid = !isSignedEdit || trimmedReason.length >= 10;
  const showReasonError = isSignedEdit && reasonTouched && !reasonValid;

  const mutation = useMutation({
    mutationFn: () => {
      const cleanedTerms = keepDefaults
        ? []
        : customTerms.map((t) => t.trim()).filter((t) => t.length > 0);
      const payload = buildPortalEditPayload(reservation, form, cleanedTerms);
      if (isSignedEdit) payload.reason = trimmedReason;
      return resubmitPortalReservation(reservation.id, payload);
    },
    onSuccess: () => {
      if (isSignedEdit) {
        toast.success(
          "Reservation reset to Awaiting Tenant — share the sign link so the tenant can re-sign.",
        );
      }
      onSuccess();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSignedEdit) {
      setReasonTouched(true);
      if (!reasonValid) return;
    }
    mutation.mutate();
  }

  const tncCustomized = !keepDefaults && customTerms.some((t) => t.trim().length > 0);
  // Status-aware copy. needs_amendment → "Edit & Resubmit" (manager already
  // rejected). pending_approval / pending_customer / signed → "Edit".
  const isAwaitingManager = reservation.status === "pending_approval";
  const isPendingCustomer = reservation.status === "pending_customer";
  const dialogTitle =
    reservation.status === "needs_amendment"
      ? "Edit & Resubmit Reservation"
      : isSignedEdit
        ? "Edit Signed Reservation"
        : "Edit Reservation";
  const submitLabel =
    reservation.status === "needs_amendment"
      ? "Resubmit"
      : isSignedEdit
        ? "Save & require re-sign"
        : "Save edits";
  const pendingLabel =
    reservation.status === "needs_amendment" ? "Resubmitting…" : "Saving…";

  // D5: when the row is pending_customer but the tenant hasn't filled
  // Section B yet, applicant fields are legitimately empty in the DB.
  // The agent CAN pre-fill them on the tenant's behalf, but we surface the
  // state so it doesn't look like a broken pre-fill.
  const sectionBPending =
    isPendingCustomer && !reservation.applicant.fullName;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resubmit-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-3xl rounded-2xl border border-border/60 bg-background p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 id="resubmit-dialog-title" className="text-lg font-semibold">{dialogTitle}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {reservation.referenceCode} · {reservation.property.name} · {reservation.unit.unitCode}
            </p>
            {isAwaitingManager && (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                Your manager hasn't reviewed yet — they'll see your updated version.
              </p>
            )}
            {isPendingCustomer && (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                The sign link is already live. The tenant will see the updated copy when they next open it.
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {reservation.approvalNote && (
          <Callout variant="warning" title="Manager's note">
            <p className="whitespace-pre-wrap">{reservation.approvalNote}</p>
          </Callout>
        )}

        {isSignedEdit && (
          <div className="mt-4">
            <Callout variant="warning" title="Tenant will need to re-sign">
              Saving an edit on a signed reservation flips it back to <strong>Awaiting Tenant</strong>.
              The previous signed PDF + signature are deleted. The reservation data you entered is preserved,
              but the tenant must open the sign link and sign again. Share the sign link manually once saved.
            </Callout>
          </div>
        )}

        {sectionBPending && (
          <div className="mt-4">
            <Callout variant="info" title="Tenant hasn't filled Section B yet">
              Applicant fields below are empty because the tenant hasn't opened the sign link.
              You can pre-fill them on the tenant's behalf if needed, or leave blank and let the tenant fill in.
            </Callout>
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-4 space-y-5">
          {/* Applicant */}
          <section>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Tenant details
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <PortalFieldLabel>Tenant full name</PortalFieldLabel>
                <input
                  value={form.applicantFullName}
                  onChange={(e) =>
                    update("applicantFullName", e.target.value.toUpperCase())
                  }
                  className={PORTAL_INPUT_CLASS}
                  maxLength={120}
                />
              </div>
              <div>
                <PortalFieldLabel>NRIC</PortalFieldLabel>
                <input
                  value={form.applicantNric}
                  onChange={(e) => update("applicantNric", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                  maxLength={40}
                />
              </div>
              <div>
                <PortalFieldLabel>Contact</PortalFieldLabel>
                <input
                  value={form.applicantContact}
                  onChange={(e) => update("applicantContact", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                  maxLength={40}
                />
              </div>
              <div>
                <PortalFieldLabel>Email</PortalFieldLabel>
                <input
                  type="email"
                  value={form.applicantEmail}
                  onChange={(e) => update("applicantEmail", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
            </div>
          </section>

          {/* Tenancy */}
          <section>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Tenancy
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <PortalFieldLabel>Proposed move-in</PortalFieldLabel>
                <input
                  type="date"
                  value={form.proposedMoveIn}
                  onChange={(e) => update("proposedMoveIn", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
              <div>
                <PortalFieldLabel>Proposed move-out</PortalFieldLabel>
                <input
                  type="date"
                  value={form.proposedMoveOut}
                  onChange={(e) => update("proposedMoveOut", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
              <div>
                <PortalFieldLabel>Car park</PortalFieldLabel>
                <input
                  value={form.carPark}
                  onChange={(e) => update("carPark", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                  maxLength={40}
                />
              </div>
              <div className="md:col-span-2">
                <PortalFieldLabel>Special remarks</PortalFieldLabel>
                <textarea
                  value={form.specialRemarks}
                  onChange={(e) => update("specialRemarks", e.target.value)}
                  rows={2}
                  className={PORTAL_INPUT_CLASS}
                  maxLength={2000}
                />
              </div>
            </div>
          </section>

          {/* Charges */}
          <section>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Charges (RM)
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <div>
                <PortalFieldLabel>Reservation</PortalFieldLabel>
                <input
                  inputMode="decimal"
                  value={form.reservationDeposit}
                  onChange={(e) => update("reservationDeposit", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
              <div>
                <PortalFieldLabel>Documentation</PortalFieldLabel>
                <input
                  inputMode="decimal"
                  value={form.documentationFee}
                  onChange={(e) => update("documentationFee", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
              <div>
                <PortalFieldLabel>Rental</PortalFieldLabel>
                <input
                  inputMode="decimal"
                  value={form.rentalDeposit}
                  onChange={(e) => update("rentalDeposit", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
              <div>
                <PortalFieldLabel>Utility</PortalFieldLabel>
                <input
                  inputMode="decimal"
                  value={form.utilityDeposit}
                  onChange={(e) => update("utilityDeposit", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
              <div>
                <PortalFieldLabel>Access card</PortalFieldLabel>
                <input
                  inputMode="decimal"
                  value={form.accessCardDeposit}
                  onChange={(e) => update("accessCardDeposit", e.target.value)}
                  className={PORTAL_INPUT_CLASS}
                />
              </div>
            </div>
          </section>

          {/* Terms & Conditions */}
          <section>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Terms & Conditions
            </p>
            <div className="inline-flex rounded-lg border border-border/60 bg-background/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setKeepDefaults(true)}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  keepDefaults
                    ? "bg-amber-500/20 text-amber-900 dark:text-amber-100"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Use default clauses
              </button>
              <button
                type="button"
                onClick={() => setKeepDefaults(false)}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  !keepDefaults
                    ? "bg-amber-500/20 text-amber-900 dark:text-amber-100"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Customise
              </button>
            </div>
            {tncCustomized && reservation.status !== "pending_customer" && (
              <div className="mt-2">
                <Callout variant="warning" title="Manager approval will be required">
                  Your edited list will be re-sent to your manager for review.
                </Callout>
              </div>
            )}
            {!keepDefaults && (
              <div className="mt-3 space-y-3">
                <div className="space-y-2 max-h-72 overflow-y-auto pr-2">
                  {customTerms.map((line, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <textarea
                        rows={2}
                        value={line}
                        onChange={(e) => {
                          const next = [...customTerms];
                          next[idx] = e.target.value;
                          setCustomTerms(next);
                        }}
                        maxLength={2000}
                        placeholder="Enter a clause…"
                        className="flex-1 rounded-md border border-border/50 bg-background/40 p-2 text-sm"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCustomTerms(customTerms.filter((_, i) => i !== idx))}
                        aria-label={`Remove clause ${idx + 1}`}
                        className="shrink-0 text-rose-600 hover:text-rose-700"
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCustomTerms([...customTerms, ""])}
                  >
                    + Add clause
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCustomTerms([...TERMS_AND_CONDITIONS])}
                  >
                    Reset to defaults
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Auto-numbered on the PDF + sign page based on the order shown.
                </p>
              </div>
            )}
          </section>

          {isSignedEdit && (
            <section className="border-t border-border/40 pt-4">
              <PortalFieldLabel>Reason for edit (will be audited)</PortalFieldLabel>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setReasonTouched(true)}
                rows={2}
                className={PORTAL_INPUT_CLASS}
                placeholder="e.g. Tenant phoned to correct their NRIC after signing"
                aria-invalid={showReasonError}
                aria-describedby="signed-reason-help"
              />
              <p
                id="signed-reason-help"
                className={`mt-1 text-xs ${showReasonError ? "text-rose-600" : "text-muted-foreground"}`}
              >
                {showReasonError
                  ? "Reason must be at least 10 characters."
                  : `${trimmedReason.length} / 10 characters required.`}
              </p>
            </section>
          )}

          {mutation.isError && (
            <Callout variant="danger" title="Could not save changes">
              {mutation.error instanceof Error ? mutation.error.message : "Unknown error"}
            </Callout>
          )}

          <div className="flex justify-end gap-2 border-t border-border/40 pt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="gold" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {pendingLabel}
                </>
              ) : (
                submitLabel
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
