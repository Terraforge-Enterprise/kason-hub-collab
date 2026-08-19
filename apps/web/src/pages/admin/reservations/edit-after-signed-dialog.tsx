import { useState, type FormEvent } from "react";
import { FileSignature, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ApiError } from "@/lib/api-client";
import {
  adminEditReservation,
  type AdminEditReservationPatch,
} from "@/api/admin-edit-reservation";
import type { ReservationDto } from "@/api/reservations";
import { TERMS_AND_CONDITIONS } from "@/lib/reservation-terms";

interface EditAfterSignedDialogProps {
  open: boolean;
  onClose: () => void;
  reservation: ReservationDto;
  onSaved: () => void;
}

interface FormState {
  applicantFullName: string;
  applicantNric: string;
  applicantContact: string;
  applicantEmail: string;
  carPark: string;
  specialRemarks: string;
  reservationDeposit: string;
  documentationFee: string;
  rentalDeposit: string;
  utilityDeposit: string;
  accessCardDeposit: string;
}

function reservationToFormState(r: ReservationDto): FormState {
  return {
    applicantFullName: r.applicant.fullName ?? "",
    applicantNric: r.applicant.nric ?? "",
    applicantContact: r.applicant.contact ?? "",
    applicantEmail: r.applicant.email ?? "",
    carPark: r.carPark ?? "",
    specialRemarks: r.specialRemarks ?? "",
    reservationDeposit: r.charges.reservationDeposit,
    documentationFee: r.charges.documentationFee,
    rentalDeposit: r.charges.rentalDeposit,
    utilityDeposit: r.charges.utilityDeposit,
    accessCardDeposit: r.charges.accessCardDeposit,
  };
}

// Compare two customTerms arrays as ordered lists. Used to decide whether
// to include customTerms in the diff payload.
function customTermsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Compute the diff against the original DTO so we only PATCH the fields that
// actually changed. Empty strings on optional fields map to null (carPark,
// specialRemarks); empty strings on required identity fields are passed only
// if the admin explicitly cleared them (the server enforces min(1)).
function buildPatch(
  reservation: ReservationDto,
  state: FormState,
  customTerms: string[],
): AdminEditReservationPatch {
  const patch: AdminEditReservationPatch = {};
  const baseline = reservationToFormState(reservation);

  if (state.applicantFullName !== baseline.applicantFullName) {
    patch.applicantFullName = state.applicantFullName.trim();
  }
  if (state.applicantNric !== baseline.applicantNric) {
    patch.applicantNric = state.applicantNric.trim();
  }
  if (state.applicantContact !== baseline.applicantContact) {
    patch.applicantContact = state.applicantContact.trim();
  }
  if (state.applicantEmail !== baseline.applicantEmail) {
    patch.applicantEmail = state.applicantEmail.trim();
  }
  if (state.carPark !== baseline.carPark) {
    patch.carPark = state.carPark.trim() === "" ? null : state.carPark.trim();
  }
  if (state.specialRemarks !== baseline.specialRemarks) {
    patch.specialRemarks = state.specialRemarks.trim() === "" ? null : state.specialRemarks;
  }
  if (state.reservationDeposit !== baseline.reservationDeposit) {
    patch.reservationDeposit = state.reservationDeposit;
  }
  if (state.documentationFee !== baseline.documentationFee) {
    patch.documentationFee = state.documentationFee;
  }
  if (state.rentalDeposit !== baseline.rentalDeposit) {
    patch.rentalDeposit = state.rentalDeposit;
  }
  if (state.utilityDeposit !== baseline.utilityDeposit) {
    patch.utilityDeposit = state.utilityDeposit;
  }
  if (state.accessCardDeposit !== baseline.accessCardDeposit) {
    patch.accessCardDeposit = state.accessCardDeposit;
  }
  if (!customTermsEqual(customTerms, reservation.customTerms)) {
    patch.customTerms = customTerms;
  }
  return patch;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </label>
  );
}

// Server-side field-error renderer. The API responds with
// fieldErrors keyed under the patch.<name> path (validation.ts wraps the
// patch object in a Zod schema), so the dialog reads the same prefix.
// Prior to this helper the dialog only rendered the applicantFullName
// error and silently dropped every other field's hint.
function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <p role="alert" className="mt-1 text-xs text-rose-600">{message}</p>;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function EditAfterSignedDialog({
  open,
  onClose,
  reservation,
  onSaved,
}: EditAfterSignedDialogProps) {
  const [form, setForm] = useState<FormState>(() => reservationToFormState(reservation));
  // D5: admin can now edit the T&C list. customTerms.length === 0 means
  // "use bundled defaults"; the toggle below mirrors the portal's UX.
  const [keepDefaults, setKeepDefaults] = useState<boolean>(
    reservation.customTerms.length === 0,
  );
  const [customTerms, setCustomTerms] = useState<string[]>(
    reservation.customTerms.length > 0
      ? [...reservation.customTerms]
      : [...TERMS_AND_CONDITIONS],
  );
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});

  if (!open) return null;

  const trimmedReason = reason.trim();
  const reasonValid = trimmedReason.length >= 10;
  const showReasonError = reasonTouched && !reasonValid;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setReasonTouched(true);
    if (!reasonValid) return;

    const cleanedTerms = keepDefaults
      ? []
      : customTerms.map((t) => t.trim()).filter((t) => t.length > 0);
    const patch = buildPatch(reservation, form, cleanedTerms);
    if (Object.keys(patch).length === 0) {
      toast.error("No changes to save.");
      return;
    }

    setSubmitting(true);
    setServerFieldErrors({});
    try {
      await adminEditReservation(reservation.id, patch, trimmedReason);
      if (reservation.status === "signed") {
        toast.success(
          "Reservation reset to Awaiting Tenant — share the sign link so the tenant can re-sign.",
        );
      } else {
        toast.success("Reservation updated. Audit log entry recorded.");
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.data && typeof err.data === "object") {
        const body = err.data as { error?: string; fieldErrors?: Record<string, string> };
        if (body.fieldErrors) setServerFieldErrors(body.fieldErrors);
        toast.error(body.error ?? err.message);
      } else {
        toast.error(err instanceof Error ? err.message : "Could not save changes");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((s) => ({ ...s, [key]: value }));
  }

  // D5: pending_customer reservations may have no Section B yet (tenant
  // hasn't opened the sign link). Surface that state so the empty applicant
  // fields below don't read as a broken pre-fill.
  const sectionBPending =
    reservation.status === "pending_customer" && !reservation.applicant.fullName;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-after-signed-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl rounded-2xl border border-border/60 bg-background p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-amber-500/10 p-2">
            <FileSignature className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <h3 id="edit-after-signed-title" className="text-lg font-semibold">
              {reservation.status === "signed"
                ? "Edit signed reservation"
                : "Edit reservation (awaiting tenant)"}
            </h3>
            <p className="text-xs text-muted-foreground">
              {reservation.status === "signed"
                ? "Saving will flip this reservation back to Awaiting Tenant and require the tenant to re-sign. The old signed PDF and signature image are deleted. Every change is recorded in the audit log with your reason."
                : "Every change is recorded in the audit log with your reason. The tenant has the sign link but hasn't signed yet, so they will see the updated content next time they open it."}
            </p>
          </div>
        </div>

        {reservation.status === "signed" && (
          <div className="mb-4">
            <Callout variant="warning" title="Tenant will need to re-sign">
              Saving will set status back to <strong>Awaiting Tenant</strong>. The previous signed PDF
              and signature image are deleted from storage. Applicant identity, charges, dates,
              and T&amp;Cs are preserved. Share the sign link with the tenant once you've saved.
            </Callout>
          </div>
        )}

        {sectionBPending && (
          <div className="mb-4">
            <Callout variant="info" title="Tenant hasn't filled Section B yet">
              Applicant fields below are empty because the tenant hasn't opened the sign link.
              You can pre-fill them on the tenant's behalf if needed.
            </Callout>
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <FieldLabel>Tenant full name</FieldLabel>
              <input
                value={form.applicantFullName}
                onChange={(e) =>
                  update("applicantFullName", e.target.value.toUpperCase())
                }
                className={INPUT_CLASS}
                maxLength={120}
              />
              <FieldError message={serverFieldErrors["patch.applicantFullName"]} />
            </div>
            <div>
              <FieldLabel>NRIC</FieldLabel>
              <input
                value={form.applicantNric}
                onChange={(e) => update("applicantNric", e.target.value)}
                className={INPUT_CLASS}
                maxLength={40}
              />
              <FieldError message={serverFieldErrors["patch.applicantNric"]} />
            </div>
            <div>
              <FieldLabel>Contact</FieldLabel>
              <input
                value={form.applicantContact}
                onChange={(e) => update("applicantContact", e.target.value)}
                className={INPUT_CLASS}
                maxLength={40}
              />
              <FieldError message={serverFieldErrors["patch.applicantContact"]} />
            </div>
            <div>
              <FieldLabel>Email</FieldLabel>
              <input
                type="email"
                value={form.applicantEmail}
                onChange={(e) => update("applicantEmail", e.target.value)}
                className={INPUT_CLASS}
              />
              <FieldError message={serverFieldErrors["patch.applicantEmail"]} />
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Car park</FieldLabel>
              <input
                value={form.carPark}
                onChange={(e) => update("carPark", e.target.value)}
                className={INPUT_CLASS}
                maxLength={40}
              />
              <FieldError message={serverFieldErrors["patch.carPark"]} />
            </div>
            <div className="md:col-span-2">
              <FieldLabel>Special remarks</FieldLabel>
              <textarea
                value={form.specialRemarks}
                onChange={(e) => update("specialRemarks", e.target.value)}
                rows={2}
                className={INPUT_CLASS}
                maxLength={2000}
              />
              <FieldError message={serverFieldErrors["patch.specialRemarks"]} />
            </div>
          </div>

          <div className="border-t border-border/40 pt-4">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              Charges (MYR)
            </p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <div>
                <FieldLabel>Reservation</FieldLabel>
                <input
                  inputMode="decimal"
                  value={form.reservationDeposit}
                  onChange={(e) => update("reservationDeposit", e.target.value)}
                  className={INPUT_CLASS}
                />
                <FieldError message={serverFieldErrors["patch.reservationDeposit"]} />
              </div>
              <div>
                <FieldLabel>Documentation</FieldLabel>
                <input
                  inputMode="decimal"
                  value={form.documentationFee}
                  onChange={(e) => update("documentationFee", e.target.value)}
                  className={INPUT_CLASS}
                />
                <FieldError message={serverFieldErrors["patch.documentationFee"]} />
              </div>
              <div>
                <FieldLabel>Rental</FieldLabel>
                <input
                  inputMode="decimal"
                  value={form.rentalDeposit}
                  onChange={(e) => update("rentalDeposit", e.target.value)}
                  className={INPUT_CLASS}
                />
                <FieldError message={serverFieldErrors["patch.rentalDeposit"]} />
              </div>
              <div>
                <FieldLabel>Utility</FieldLabel>
                <input
                  inputMode="decimal"
                  value={form.utilityDeposit}
                  onChange={(e) => update("utilityDeposit", e.target.value)}
                  className={INPUT_CLASS}
                />
                <FieldError message={serverFieldErrors["patch.utilityDeposit"]} />
              </div>
              <div>
                <FieldLabel>Access card</FieldLabel>
                <input
                  inputMode="decimal"
                  value={form.accessCardDeposit}
                  onChange={(e) => update("accessCardDeposit", e.target.value)}
                  className={INPUT_CLASS}
                />
                <FieldError message={serverFieldErrors["patch.accessCardDeposit"]} />
              </div>
            </div>
          </div>

          <div className="border-t border-border/40 pt-4">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
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
          </div>

          <div className="border-t border-border/40 pt-4">
            <FieldLabel>Reason for edit (will be audited)</FieldLabel>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setReasonTouched(true)}
              rows={2}
              className={INPUT_CLASS}
              placeholder="e.g. Tenant typo correction per email 2026-05-19"
              aria-invalid={showReasonError}
              aria-describedby="reason-help"
            />
            <p
              id="reason-help"
              className={`mt-1 text-xs ${showReasonError ? "text-rose-600" : "text-muted-foreground"}`}
            >
              {showReasonError
                ? "Reason must be at least 10 characters."
                : `${trimmedReason.length} / 10 characters required.`}
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-border/40 pt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            {/*
              Save stays enabled even when reason is too short — the submit
              handler does the gating and surfaces the inline error. A
              disabled button can't fire onClick / receive focus, so the
              user would see no feedback for why nothing happened.
            */}
            <Button type="submit" variant="gold" className="gap-2" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
