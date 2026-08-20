import { useState, useRef, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-client";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Callout } from "@/components/ui/callout";
import { ActionButton, Field, SelectInput, TextInput } from "@/components/form-ui";
import { PhoneInput } from "@/components/phone-input";
import { INDIVIDUAL_ID_TYPES, NATIONALITIES } from "@/lib/malaysia-refdata";
import { useTenantDetail } from "@/api/parties-detail";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { getReservation, listPickableReservations } from "@/api/reservations";
import type { TenantListItem } from "./tenants-table";

// Grouped 2-column section wrapper shared by the Create/Edit dialogs. Collapses
// the ~15-field single column into labelled Identity/Contact/Employment/Emergency
// sections so the form fits without deep scrolling. Layout-only.
function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

// Drops empty strings so a blank Edit field becomes a non-destructive no-op on
// the PUT (the API only updates keys that are present). Lifted verbatim from
// the former tenants-forms.tsx.
function getFormData(e: React.FormEvent<HTMLFormElement>): Record<string, string> {
  const fd = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

// Edit dialogs KEEP empties so a cleared prefilled field is SENT to the PUT and
// nulled by the backend (user directive: "blank = blank, save the blank"). The lone
// exception is idNumber (IC): a blank IC means "leave unchanged" — never wipe identity
// data — so a blank idNumber is dropped, matching drop-empties for that field.
function getEditFormData(e: React.FormEvent<HTMLFormElement>): Record<string, string> {
  const fd = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value !== "string") continue;
    if (value === "" && key === "idNumber") continue; // never wipe IC on blank
    out[key] = value;
  }
  return out;
}

// Server validation shape from formatZodError (apps/api/src/lib/zod-error-mapper.ts):
// { error: string, fieldErrors: Record<string,string> }. ApiError.data carries the
// raw parsed response body (api-client.ts), so pull fieldErrors from there for
// inline per-field display; the toast keeps showing the top-level message.
// Non-ApiError failures (network errors etc.) have no field map — return {}.
function extractFieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.data && typeof err.data === "object") {
    const body = err.data as { fieldErrors?: Record<string, string> };
    return body.fieldErrors ?? {};
  }
  return {};
}

// ── Create ────────────────────────────────────────────────────────────────

type CreatedTenant = {
  id: string;
  displayName: string;
  primaryPhone?: string | null;
  idType?: string | null;
};

export function CreateTenantDialog({
  trigger,
  onCreated,
}: {
  trigger: ReactNode;
  onCreated?: (tenant: CreatedTenant) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const phoneValidityRef = useRef<"empty" | "valid" | "invalid">("empty");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  const reservationGatedTenancyEnabled = isPhase2FlagEnabled(
    "ENABLE_PHASE2_RESERVATION_GATED_TENANCY",
  );
  const [selectedReservationId, setSelectedReservationId] = useState("");
  const pickableQuery = useQuery({
    queryKey: ["reservations", "pickable"],
    queryFn: listPickableReservations,
    enabled: open && reservationGatedTenancyEnabled,
  });
  const pickables = pickableQuery.data ?? [];

  // The picker (PickableReservationDto) only carries fullName/nricMasked/contact/
  // email. Fetch the FULL reservation once one is selected so we can prefill the
  // rest — unmasked NRIC, nationality, occupation, monthly income, and the
  // emergency-contact trio — that the applicant already gave. Same admin session
  // that can open the reservation detail; no new endpoint, no new exposure.
  const detailQuery = useQuery({
    queryKey: ["reservation", "detail", selectedReservationId],
    queryFn: () => getReservation(selectedReservationId),
    enabled: open && reservationGatedTenancyEnabled && selectedReservationId !== "",
  });
  const applicant = detailQuery.data?.applicant ?? null;

  // Uncontrolled inputs only read `defaultValue` at mount, and the detail loads
  // async — so gate the PREFILLABLE fields on the fetch resolving (mirrors the
  // Edit dialog's `!isLoading` gate) and key them on the selection so they
  // remount with the right default when it changes. Non-prefillable fields stay
  // mounted throughout so in-progress typing is never wiped.
  const detailPending =
    reservationGatedTenancyEnabled && selectedReservationId !== "" && detailQuery.isLoading;
  const prefillKey = selectedReservationId || "none";
  // NRIC is the correct INDIVIDUAL_ID_TYPES value for a Malaysian citizen; only
  // auto-pick it when the applicant is Malaysian (or nationality unknown) AND an
  // IC is on file — otherwise leave blank so the admin selects the right type.
  const prefillIdType =
    applicant?.nric && (applicant.nationality === "MY" || applicant.nationality == null)
      ? "NRIC"
      : "";

  function resetPhoneState() {
    setPhoneError(null);
    phoneValidityRef.current = "empty";
  }

  function resetReservationPicker() {
    setSelectedReservationId("");
  }

  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch<CreatedTenant>("/parties/tenants", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (tenant) => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      if (reservationGatedTenancyEnabled) {
        queryClient.invalidateQueries({ queryKey: ["reservations", "pickable"] });
      }
      toast.success("Tenant created.");
      setPhone(null);
      resetPhoneState();
      resetReservationPicker();
      setFieldErrors({});
      setOpen(false);
      onCreated?.(tenant);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to create tenant.");
      setFieldErrors(extractFieldErrors(err));
      // A picked reservation may have just been consumed by a concurrent
      // admin (raced against the pickable list) — refresh so the now-stale
      // option disappears instead of failing again on resubmit.
      if (reservationGatedTenancyEnabled && err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({ queryKey: ["reservations", "pickable"] });
      }
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    if (phoneValidityRef.current === "invalid") {
      setPhoneError("Enter a valid Malaysian mobile number");
      return;
    }
    const body = getFormData(e);
    if (reservationGatedTenancyEnabled && selectedReservationId) {
      body.reservationId = selectedReservationId;
    }
    mutation.mutate(body);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          resetPhoneState();
          resetReservationPicker();
          setFieldErrors({});
        }
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create tenant</DialogTitle>
          <DialogDescription>
            Capture the tenant's identity and profile details before move-in or screening.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-6">
          {reservationGatedTenancyEnabled && pickables.length > 0 && (
            <Field
              label="From reservation (optional)"
              hint="Prefills the fields below from a signed, not-yet-linked reservation. All fields stay editable."
            >
              <SelectInput
                aria-label="From reservation"
                value={selectedReservationId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedReservationId(id);
                  const picked = pickables.find((p) => p.id === id);
                  setPhone(picked?.applicant.contact ?? null);
                }}
              >
                <option value="">No reservation — enter details manually</option>
                {pickables.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.referenceCode} · {p.unit.label} · {p.applicant.fullName ?? "Unnamed applicant"}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
          {detailPending && (
            <p className="text-sm text-[var(--text-muted)]">Loading reservation details…</p>
          )}

          <FormSection title="Identity">
            {!detailPending && (
              <Field label="Display name" error={fieldErrors.displayName}>
                <TextInput
                  key={`displayName-${prefillKey}`}
                  name="displayName"
                  required
                  placeholder="Daniel Tan"
                  defaultValue={applicant?.fullName ?? ""}
                />
              </Field>
            )}
            <Field label="Legal name" error={fieldErrors.legalName}>
              <TextInput name="legalName" placeholder="Daniel Tan Bin Ali" />
            </Field>
            {!detailPending && (
              <Field label="ID type" error={fieldErrors.idType}>
                <SelectInput key={`idType-${prefillKey}`} name="idType" defaultValue={prefillIdType}>
                  <option value="">Select ID type…</option>
                  {INDIVIDUAL_ID_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </SelectInput>
              </Field>
            )}
            {!detailPending && (
              <Field
                label="ID number"
                error={fieldErrors.idNumber}
                hint={
                  selectedReservationId
                    ? "Prefilled from reservation — verify against the physical IC before saving."
                    : undefined
                }
              >
                <TextInput
                  key={`idNumber-${prefillKey}`}
                  name="idNumber"
                  placeholder="900101-10-1234"
                  defaultValue={applicant?.nric ?? ""}
                />
              </Field>
            )}
            {!detailPending && (
              <Field label="Nationality" error={fieldErrors.nationality}>
                <SelectInput
                  key={`nationality-${prefillKey}`}
                  name="nationality"
                  defaultValue={applicant?.nationality ?? "MY"}
                >
                  <option value="">Select nationality…</option>
                  {NATIONALITIES.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </SelectInput>
              </Field>
            )}
            <Field label="Gender" error={fieldErrors.gender}>
              <SelectInput name="gender" defaultValue="">
                <option value="">Select gender…</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </SelectInput>
            </Field>
            <Field label="Date of birth" error={fieldErrors.dateOfBirth}>
              <TextInput type="date" name="dateOfBirth" />
            </Field>
          </FormSection>

          <FormSection title="Contact">
            {!detailPending && (
              <Field label="Email" error={fieldErrors.primaryEmail}>
                <TextInput
                  key={`primaryEmail-${prefillKey}`}
                  name="primaryEmail"
                  type="email"
                  placeholder="daniel@example.com"
                  defaultValue={applicant?.email ?? ""}
                />
              </Field>
            )}
            <div className="sm:col-span-2">
              <PhoneInput
                label="Phone" value={phone} onChange={setPhone}
                error={phoneError ?? fieldErrors.primaryPhone}
                onValidityChange={(s) => {
                  phoneValidityRef.current = s;
                  setPhoneError(s === "invalid" ? "Enter a valid Malaysian mobile number" : null);
                }}
              />
              <input type="hidden" name="primaryPhone" value={phone ?? ""} />
            </div>
            <Field label="WhatsApp" error={fieldErrors.whatsappPhone}>
              <TextInput name="whatsappPhone" />
            </Field>
          </FormSection>

          <FormSection title="Employment">
            {!detailPending && (
              <Field label="Occupation" error={fieldErrors.occupation}>
                <TextInput
                  key={`occupation-${prefillKey}`}
                  name="occupation"
                  placeholder="Software engineer"
                  defaultValue={applicant?.occupation ?? ""}
                />
              </Field>
            )}
            <Field label="Employer name" error={fieldErrors.employerName}>
              <TextInput name="employerName" placeholder="Acme Studio" />
            </Field>
            {!detailPending && (
              <Field label="Monthly income" error={fieldErrors.monthlyIncome}>
                <TextInput
                  key={`monthlyIncome-${prefillKey}`}
                  name="monthlyIncome"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={applicant?.monthlyIncome ?? ""}
                />
              </Field>
            )}
            <Field label="Employer address" error={fieldErrors.employerAddress}>
              <TextInput name="employerAddress" />
            </Field>
          </FormSection>

          {!detailPending && (
            <FormSection title="Emergency contact">
              <Field label="Emergency contact name" error={fieldErrors.emergencyContactName}>
                <TextInput
                  key={`emergencyContactName-${prefillKey}`}
                  name="emergencyContactName"
                  defaultValue={applicant?.emergencyContactName ?? ""}
                />
              </Field>
              <Field label="Emergency contact phone" error={fieldErrors.emergencyContactPhone}>
                <TextInput
                  key={`emergencyContactPhone-${prefillKey}`}
                  name="emergencyContactPhone"
                  defaultValue={applicant?.emergencyContactPhone ?? ""}
                />
              </Field>
              <Field label="Emergency contact relation" error={fieldErrors.emergencyContactRelation}>
                <TextInput
                  key={`emergencyContactRelation-${prefillKey}`}
                  name="emergencyContactRelation"
                  defaultValue={applicant?.emergencyContactRelation ?? ""}
                />
              </Field>
            </FormSection>
          )}

          <DialogFooter>
            <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create tenant"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => { resetPhoneState(); setFieldErrors({}); setOpen(false); }}
              disabled={mutation.isPending}
            >
              Cancel
            </ActionButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────────
//
// Controlled-open (no internal trigger) because it's launched from the row's
// ⋯ menu. Prefill only the fields present on the row; getFormData drops empties
// so untouched blanks are a no-op on the PUT.

export function EditTenantDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phone, setPhone] = useState<string | null>(tenant.primaryPhone);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const phoneValidityRef = useRef<"empty" | "valid" | "invalid">("empty");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  // Fetch full detail on open so we can prefill gender, DOB, WhatsApp, emergency
  // contact, idType, and display the masked IC in the "Leave blank to keep" helper.
  // The query is enabled only when the dialog is open.
  const { data: detail, isLoading } = useTenantDetail(tenant.id, open);

  function handleOpenChange(v: boolean) {
    if (!v) { setPhoneError(null); phoneValidityRef.current = "empty"; setFieldErrors({}); }
    onOpenChange(v);
  }

  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch(`/parties/tenants/${tenant.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant updated.");
      setPhoneError(null);
      phoneValidityRef.current = "empty";
      setFieldErrors({});
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update tenant.");
      setFieldErrors(extractFieldErrors(err));
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    if (phoneValidityRef.current === "invalid") {
      setPhoneError("Enter a valid Malaysian mobile number");
      return;
    }
    mutation.mutate(getEditFormData(e));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit tenant</DialogTitle>
          <DialogDescription>
            Refresh {tenant.displayName}'s profile. Blank fields are left unchanged.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-6">
          {/* Detail-backed fields stay gated on !isLoading so their defaultValues
              apply after the detail fetch resolves (uncontrolled inputs only pick
              up defaultValue at mount). Always-present fields (from the row prop)
              render regardless. */}
          <FormSection title="Identity">
            <Field label="Display name" error={fieldErrors.displayName}>
              <TextInput name="displayName" required defaultValue={tenant.displayName} />
            </Field>
            <Field label="Legal name" error={fieldErrors.legalName}>
              <TextInput name="legalName" defaultValue={tenant.legalName ?? ""} />
            </Field>
            {!isLoading && (
              <Field label="ID type" error={fieldErrors.idType}>
                <SelectInput name="idType" defaultValue={detail?.idType ?? ""}>
                  <option value="">Select ID type…</option>
                  {INDIVIDUAL_ID_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </SelectInput>
              </Field>
            )}
            {!isLoading && (
              <Field
                label="ID number"
                hint={`Leave blank to keep current IC (${detail?.idNumberMasked ?? "—"}). Enter a new IC to replace it.`}
                error={fieldErrors.idNumber}
              >
                <TextInput name="idNumber" placeholder="Enter new IC to replace" />
              </Field>
            )}
            <Field label="Nationality" error={fieldErrors.nationality}>
              <SelectInput name="nationality" defaultValue={tenant.nationality ?? ""}>
                <option value="">Select nationality…</option>
                {NATIONALITIES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </SelectInput>
            </Field>
            {!isLoading && (
              <Field label="Gender" error={fieldErrors.gender}>
                <SelectInput name="gender" defaultValue={detail?.gender ?? ""}>
                  <option value="">Select gender…</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </SelectInput>
              </Field>
            )}
            {!isLoading && (
              <Field label="Date of birth" error={fieldErrors.dateOfBirth}>
                <TextInput
                  type="date"
                  name="dateOfBirth"
                  defaultValue={detail?.dateOfBirth ? detail.dateOfBirth.slice(0, 10) : ""}
                />
              </Field>
            )}
          </FormSection>

          <FormSection title="Contact">
            <Field label="Email" error={fieldErrors.primaryEmail}>
              <TextInput name="primaryEmail" type="email" defaultValue={tenant.primaryEmail ?? ""} />
            </Field>
            <div className="sm:col-span-2">
              <PhoneInput
                label="Phone" value={phone} onChange={setPhone}
                error={phoneError ?? fieldErrors.primaryPhone}
                onValidityChange={(s) => {
                  phoneValidityRef.current = s;
                  setPhoneError(s === "invalid" ? "Enter a valid Malaysian mobile number" : null);
                }}
              />
              <input type="hidden" name="primaryPhone" value={phone ?? ""} />
            </div>
            {!isLoading && (
              <Field label="WhatsApp" error={fieldErrors.whatsappPhone}>
                <TextInput name="whatsappPhone" defaultValue={detail?.whatsappPhone ?? ""} />
              </Field>
            )}
          </FormSection>

          <FormSection title="Employment">
            <Field label="Occupation" error={fieldErrors.occupation}>
              <TextInput name="occupation" defaultValue={tenant.occupation ?? ""} />
            </Field>
            <Field label="Employer name" error={fieldErrors.employerName}>
              <TextInput name="employerName" defaultValue={tenant.employerName ?? ""} />
            </Field>
            <Field label="Monthly income" error={fieldErrors.monthlyIncome}>
              <TextInput name="monthlyIncome" type="number" min={0} step="0.01" defaultValue={tenant.monthlyIncome ?? ""} />
            </Field>
            {!isLoading && (
              <Field label="Employer address" error={fieldErrors.employerAddress}>
                <TextInput name="employerAddress" defaultValue={detail?.employerAddress ?? ""} />
              </Field>
            )}
          </FormSection>

          {!isLoading && (
            <FormSection title="Emergency contact">
              <Field label="Emergency contact name" error={fieldErrors.emergencyContactName}>
                <TextInput name="emergencyContactName" defaultValue={detail?.emergencyContactName ?? ""} />
              </Field>
              <Field label="Emergency contact phone" error={fieldErrors.emergencyContactPhone}>
                <TextInput name="emergencyContactPhone" defaultValue={detail?.emergencyContactPhone ?? ""} />
              </Field>
              <Field label="Emergency contact relation" error={fieldErrors.emergencyContactRelation}>
                <TextInput name="emergencyContactRelation" defaultValue={detail?.emergencyContactRelation ?? ""} />
              </Field>
            </FormSection>
          )}

          <DialogFooter>
            <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? "Updating…" : "Update tenant"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => handleOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </ActionButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Resolve blacklist ─────────────────────────────────────────────────────

export function ResolveBlacklistTenantDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantListItem;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (status: "active" | "inactive") =>
      apiFetch(`/parties/tenants/${tenant.id}/reactivate`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Blacklist resolved.");
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to resolve blacklist."),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve blacklist — {tenant.displayName}</DialogTitle>
          <DialogDescription>
            Clear the blacklist flag and set the tenant's status.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <ActionButton
            type="button"
            variant="primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("active")}
          >
            Set Active
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("inactive")}
          >
            Set Inactive
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────

export function DeleteTenantDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantListItem;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/parties/tenants/${tenant.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant deleted.");
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete tenant."),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {tenant.displayName}?</DialogTitle>
          <DialogDescription>
            This permanently removes the tenant record and can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <ActionButton
            type="button"
            variant="danger"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Deleting…" : "Delete tenant"}
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Blacklist ─────────────────────────────────────────────────────────────

export function BlacklistTenantDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (reason: string) =>
      apiFetch(`/parties/tenants/${tenant.id}/blacklist`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast.success("Tenant blacklisted.");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to blacklist tenant.");
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    if (!reason) return;
    mutation.mutate(reason);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Blacklist {tenant.displayName}</DialogTitle>
          <DialogDescription>
            Suspend this tenant record with a tracked reason for compliance and review.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <Callout variant="danger" title="This restricts the tenant">
            Blacklisting flags {tenant.displayName} across screening and assignment.
            The reason is logged and visible to admins. This is hard to reverse.
          </Callout>
          <Field label="Reason">
            <TextInput
              name="reason"
              required
              placeholder="Fraud check / arrears / legal concern"
            />
          </Field>

          <DialogFooter>
            <ActionButton type="submit" variant="danger" disabled={mutation.isPending}>
              {mutation.isPending ? "Blacklisting…" : "Blacklist tenant"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </ActionButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
