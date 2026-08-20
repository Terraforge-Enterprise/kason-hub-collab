import { useState, useRef, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { MALAYSIAN_BANKS, NATIONALITIES, OWNER_ID_TYPES } from "@/lib/malaysia-refdata";
import { useOwnerDetail } from "@/api/parties-detail";
import type { OwnerListItem } from "./owners-table";

// Drops empty strings so a blank Edit field becomes a non-destructive no-op on
// the PUT (the API only updates keys that are present). Lifted verbatim from
// the former owners-forms.tsx.
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

type CreatedOwner = {
  id: string;
  displayName: string;
  primaryPhone?: string | null;
};

export function CreateOwnerDialog({
  trigger,
  onCreated,
}: {
  trigger: ReactNode;
  onCreated?: (owner: CreatedOwner) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const phoneValidityRef = useRef<"empty" | "valid" | "invalid">("empty");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  function resetPhoneState() {
    setPhoneError(null);
    phoneValidityRef.current = "empty";
  }

  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch<CreatedOwner>("/parties/owners", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (owner) => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      toast.success("Owner created.");
      setPhone(null);
      resetPhoneState();
      setFieldErrors({});
      setOpen(false);
      onCreated?.(owner);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to create owner.");
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
    mutation.mutate(getFormData(e));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { resetPhoneState(); setFieldErrors({}); } }}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create owner</DialogTitle>
          <DialogDescription>
            Capture the full owner profile so tenancy, remittance, and compliance workflows have a stable record.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <Field label="Display name" error={fieldErrors.displayName}>
            <TextInput name="displayName" required placeholder="Apex Holdings" />
          </Field>
          <Field label="Company / legal name" error={fieldErrors.legalName}>
            <TextInput name="legalName" placeholder="Apex Holdings Sdn. Bhd." />
          </Field>
          <Field label="Email" error={fieldErrors.primaryEmail}>
            <TextInput name="primaryEmail" type="email" placeholder="ops@apex.com" />
          </Field>
          <PhoneInput
            label="Phone" value={phone} onChange={setPhone}
            error={phoneError ?? fieldErrors.primaryPhone}
            onValidityChange={(s) => {
              phoneValidityRef.current = s;
              setPhoneError(s === "invalid" ? "Enter a valid Malaysian mobile number" : null);
            }}
          />
          <input type="hidden" name="primaryPhone" value={phone ?? ""} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="ID type" error={fieldErrors.idType}>
              <SelectInput name="idType" defaultValue="">
                <option value="">Select ID type…</option>
                {OWNER_ID_TYPES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="ID number" error={fieldErrors.idNumber}>
              <TextInput name="idNumber" placeholder="202301234567" />
            </Field>
          </div>
          <Field label="Nationality" error={fieldErrors.nationality}>
            <SelectInput name="nationality" defaultValue="MY">
              <option value="">Select nationality…</option>
              {NATIONALITIES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bank name" error={fieldErrors.bankName}>
              <SelectInput name="bankName" defaultValue="">
                <option value="">Select bank…</option>
                {MALAYSIAN_BANKS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Account holder" error={fieldErrors.bankAccountHolder}>
              <TextInput name="bankAccountHolder" />
            </Field>
          </div>
          <Field label="Bank account number" error={fieldErrors.bankAccountNumber}>
            <TextInput name="bankAccountNumber" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
          <Field label="WhatsApp" error={fieldErrors.whatsappPhone}>
            <TextInput name="whatsappPhone" />
          </Field>
          <Field label="Occupation" error={fieldErrors.occupation}>
            <TextInput name="occupation" placeholder="Property investor" />
          </Field>
          <Field label="Employer name" error={fieldErrors.employerName}>
            <TextInput name="employerName" />
          </Field>
          <Field label="Employer address" error={fieldErrors.employerAddress}>
            <TextInput name="employerAddress" />
          </Field>
          <Field label="Monthly income" error={fieldErrors.monthlyIncome}>
            <TextInput name="monthlyIncome" type="number" min={0} step="0.01" />
          </Field>
          <Field label="Emergency contact name" error={fieldErrors.emergencyContactName}>
            <TextInput name="emergencyContactName" />
          </Field>
          <Field label="Emergency contact phone" error={fieldErrors.emergencyContactPhone}>
            <TextInput name="emergencyContactPhone" />
          </Field>
          <Field label="Emergency contact relation" error={fieldErrors.emergencyContactRelation}>
            <TextInput name="emergencyContactRelation" />
          </Field>

          <DialogFooter>
            <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create owner"}
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

export function EditOwnerDialog({
  owner,
  open,
  onOpenChange,
}: {
  owner: OwnerListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phone, setPhone] = useState<string | null>(owner.primaryPhone);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const phoneValidityRef = useRef<"empty" | "valid" | "invalid">("empty");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  // Fetch full detail on open so we can prefill gender, DOB, WhatsApp, idType, and
  // display the masked IC in the "Leave blank to keep" helper text.  The query is
  // enabled only when the dialog is open, so no request fires until the user opens it.
  const { data: detail, isLoading } = useOwnerDetail(owner.id, open);

  function handleOpenChange(v: boolean) {
    if (!v) { setPhoneError(null); phoneValidityRef.current = "empty"; setFieldErrors({}); }
    onOpenChange(v);
  }

  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch(`/parties/owners/${owner.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      toast.success("Owner updated.");
      setPhoneError(null);
      phoneValidityRef.current = "empty";
      setFieldErrors({});
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update owner.");
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
          <DialogTitle>Edit owner</DialogTitle>
          <DialogDescription>
            Refresh {owner.displayName}'s profile. Blank fields are left unchanged.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <Field label="Display name" error={fieldErrors.displayName}>
            <TextInput name="displayName" required defaultValue={owner.displayName} />
          </Field>
          <Field label="Company / legal name" error={fieldErrors.legalName}>
            <TextInput name="legalName" defaultValue={owner.legalName ?? ""} />
          </Field>
          <Field label="Email" error={fieldErrors.primaryEmail}>
            <TextInput name="primaryEmail" type="email" defaultValue={owner.primaryEmail ?? ""} />
          </Field>
          <PhoneInput
            label="Phone" value={phone} onChange={setPhone}
            error={phoneError ?? fieldErrors.primaryPhone}
            onValidityChange={(s) => {
              phoneValidityRef.current = s;
              setPhoneError(s === "invalid" ? "Enter a valid Malaysian mobile number" : null);
            }}
          />
          <input type="hidden" name="primaryPhone" value={phone ?? ""} />
          <Field label="Nationality" error={fieldErrors.nationality}>
            <SelectInput name="nationality" defaultValue={owner.nationality ?? ""}>
              <option value="">Select nationality…</option>
              {NATIONALITIES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </SelectInput>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bank name" error={fieldErrors.bankName}>
              <SelectInput name="bankName" defaultValue={owner.bankName ?? ""}>
                <option value="">Select bank…</option>
                {MALAYSIAN_BANKS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Account holder" error={fieldErrors.bankAccountHolder}>
              <TextInput name="bankAccountHolder" defaultValue={owner.bankAccountHolder ?? ""} />
            </Field>
          </div>
          <Field label="Bank account number" error={fieldErrors.bankAccountNumber}>
            <TextInput name="bankAccountNumber" defaultValue={owner.bankAccountNumber ?? ""} />
          </Field>

          {/* New fields — gated on !isLoading so that defaultValues apply after the
              detail fetch resolves (uncontrolled inputs only pick up defaultValue at
              mount; rendering them once data is available avoids stale empty values). */}
          {!isLoading && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="ID type" error={fieldErrors.idType}>
                  <SelectInput name="idType" defaultValue={detail?.idType ?? owner.idType ?? ""}>
                    <option value="">Select ID type…</option>
                    {OWNER_ID_TYPES.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </SelectInput>
                </Field>
                <Field
                  label="ID number"
                  hint={`Leave blank to keep current IC (${detail?.idNumberMasked ?? "—"}). Enter a new IC to replace it.`}
                  error={fieldErrors.idNumber}
                >
                  <TextInput name="idNumber" placeholder="Enter new IC to replace" />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Gender" error={fieldErrors.gender}>
                  <SelectInput name="gender" defaultValue={detail?.gender ?? ""}>
                    <option value="">Select gender…</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </SelectInput>
                </Field>
                <Field label="Date of birth" error={fieldErrors.dateOfBirth}>
                  <TextInput
                    type="date"
                    name="dateOfBirth"
                    defaultValue={detail?.dateOfBirth ? detail.dateOfBirth.slice(0, 10) : ""}
                  />
                </Field>
              </div>
              <Field label="WhatsApp" error={fieldErrors.whatsappPhone}>
                <TextInput name="whatsappPhone" defaultValue={detail?.whatsappPhone ?? ""} />
              </Field>
              <Field label="Occupation" error={fieldErrors.occupation}>
                <TextInput name="occupation" defaultValue={detail?.occupation ?? ""} />
              </Field>
              <Field label="Employer name" error={fieldErrors.employerName}>
                <TextInput name="employerName" defaultValue={detail?.employerName ?? ""} />
              </Field>
              <Field label="Employer address" error={fieldErrors.employerAddress}>
                <TextInput name="employerAddress" defaultValue={detail?.employerAddress ?? ""} />
              </Field>
              <Field label="Monthly income" error={fieldErrors.monthlyIncome}>
                <TextInput
                  name="monthlyIncome"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={detail?.monthlyIncome ?? ""}
                />
              </Field>
              <Field label="Emergency contact name" error={fieldErrors.emergencyContactName}>
                <TextInput name="emergencyContactName" defaultValue={detail?.emergencyContactName ?? ""} />
              </Field>
              <Field label="Emergency contact phone" error={fieldErrors.emergencyContactPhone}>
                <TextInput name="emergencyContactPhone" defaultValue={detail?.emergencyContactPhone ?? ""} />
              </Field>
              <Field label="Emergency contact relation" error={fieldErrors.emergencyContactRelation}>
                <TextInput name="emergencyContactRelation" defaultValue={detail?.emergencyContactRelation ?? ""} />
              </Field>
            </>
          )}

          <DialogFooter>
            <ActionButton type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? "Updating…" : "Update owner"}
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

export function ResolveBlacklistOwnerDialog({
  owner,
  open,
  onOpenChange,
}: {
  owner: OwnerListItem;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (status: "active" | "inactive") =>
      apiFetch(`/parties/owners/${owner.id}/reactivate`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      toast.success("Blacklist resolved.");
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to resolve blacklist."),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve blacklist — {owner.displayName}</DialogTitle>
          <DialogDescription>
            Clear the blacklist flag and set the owner's status.
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

export function DeleteOwnerDialog({
  owner,
  open,
  onOpenChange,
}: {
  owner: OwnerListItem;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/parties/owners/${owner.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      toast.success("Owner deleted.");
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to delete owner."),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {owner.displayName}?</DialogTitle>
          <DialogDescription>
            This permanently removes the owner record and can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <ActionButton
            type="button"
            variant="danger"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Deleting…" : "Delete owner"}
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

export function BlacklistOwnerDialog({
  owner,
  open,
  onOpenChange,
}: {
  owner: OwnerListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (reason: string) =>
      apiFetch(`/parties/owners/${owner.id}/blacklist`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owners"] });
      toast.success("Owner blacklisted.");
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to blacklist owner.");
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
          <DialogTitle>Blacklist {owner.displayName}</DialogTitle>
          <DialogDescription>
            Suspend this owner record with a tracked reason for compliance and review.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <Callout variant="danger" title="This restricts the owner">
            Blacklisting flags {owner.displayName} across tenancy, remittance, and compliance.
            The reason is logged and visible to admins. This is hard to reverse.
          </Callout>
          <Field label="Reason">
            <TextInput
              name="reason"
              required
              placeholder="Compliance review / legal hold"
            />
          </Field>

          <DialogFooter>
            <ActionButton type="submit" variant="danger" disabled={mutation.isPending}>
              {mutation.isPending ? "Blacklisting…" : "Blacklist owner"}
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
