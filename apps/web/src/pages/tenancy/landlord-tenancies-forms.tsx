import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import {
  ActionButton,
  FeedbackMessage,
  Field,
  FormCard,
  FormGrid,
  SelectInput,
  TextInput,
} from "@/components/form-ui";

type PropertyOption = { id: string; name: string; propertyCode: string };
type OwnerOption = { id: string; displayName: string };
type LinkageOption = { id: string; propertyName: string; landlordName: string };

type FeedbackState = { status: "idle" | "success" | "error"; message: string };

const idle: FeedbackState = { status: "idle", message: "" };

function getFormData(e: React.FormEvent<HTMLFormElement>): Record<string, string> {
  const fd = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of fd.entries()) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

export function LandlordTenancyForms({
  properties,
  owners,
  tenancies,
}: {
  properties: PropertyOption[];
  owners: OwnerOption[];
  tenancies: LinkageOption[];
}) {
  const queryClient = useQueryClient();

  // ── Create Landlord Tenancy ───────────────────────────────────────────────
  const [createFeedback, setCreateFeedback] = useState<FeedbackState>(idle);
  const createLandlordTenancy = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch("/tenancy/landlord-tenancies", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCreateFeedback({ status: "success", message: "Landlord tenancy created." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
    },
    onError: (err: Error) => {
      setCreateFeedback({ status: "error", message: err.message });
    },
  });

  // ── Update Landlord Tenancy Status ────────────────────────────────────────
  const [updateFeedback, setUpdateFeedback] = useState<FeedbackState>(idle);
  const updateStatus = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      apiFetch(`/tenancy/landlord-tenancies/${id}/status`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setUpdateFeedback({ status: "success", message: "Linkage status updated." });
      queryClient.invalidateQueries({ queryKey: ["tenancy"] });
    },
    onError: (err: Error) => {
      setUpdateFeedback({ status: "error", message: err.message });
    },
  });

  return (
    <FormGrid className="xl:grid-cols-2">
      {/* Create Landlord Tenancy */}
      <FormCard
        title="Create landlord tenancy"
        description="Link an owner to a property and set the commercial terms in one pass."
        onSubmit={(e) => {
          e.preventDefault();
          setCreateFeedback(idle);
          createLandlordTenancy.mutate(getFormData(e));
        }}
      >
        <Field label="Property">
          <SelectInput name="propertyId" required>
            <option value="">Select property</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.propertyCode})
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Landlord">
          <SelectInput name="landlordId" required>
            <option value="">Select owner</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.displayName}
              </option>
            ))}
          </SelectInput>
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Start date">
            <TextInput name="startDate" type="date" required />
          </Field>
          <Field label="End date">
            <TextInput name="endDate" type="date" />
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Monthly rent">
            <TextInput
              name="monthlyRent"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              required
            />
          </Field>
          <Field label="Deposit amount">
            <TextInput
              name="depositAmount"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
            />
          </Field>
        </div>
        <Field label="Status">
          <SelectInput name="status" defaultValue="active">
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="terminated">terminated</option>
          </SelectInput>
        </Field>
        <Field label="Notes" hint="Optional commercial notes or conditions for this linkage.">
          <TextInput name="notes" placeholder="Notes" />
        </Field>
        <div className="flex flex-col gap-3 pt-1">
          <ActionButton
            type="submit"
            variant="primary"
            disabled={createLandlordTenancy.isPending}
          >
            {createLandlordTenancy.isPending ? "Creating…" : "Create linkage"}
          </ActionButton>
          <FeedbackMessage status={createFeedback.status} message={createFeedback.message} />
        </div>
      </FormCard>

      {/* Update Linkage Status */}
      <FormCard
        title="Update linkage status"
        description="Keep the current landlord tenancy state aligned with operational changes."
        onSubmit={(e) => {
          e.preventDefault();
          setUpdateFeedback(idle);
          const data = getFormData(e);
          const { landlordTenancyId, ...body } = data;
          if (!landlordTenancyId) {
            setUpdateFeedback({ status: "error", message: "Select a linkage." });
            return;
          }
          updateStatus.mutate({ id: landlordTenancyId, body });
        }}
      >
        <Field label="Tenancy linkage">
          <SelectInput name="landlordTenancyId" required>
            <option value="">Select linkage</option>
            {tenancies.map((lt) => (
              <option key={lt.id} value={lt.id}>
                {lt.propertyName} · {lt.landlordName}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Status">
          <SelectInput name="status" required>
            <option value="">Select status</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="terminated">terminated</option>
          </SelectInput>
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="End date">
            <TextInput name="endDate" type="date" />
          </Field>
          <Field label="Notes">
            <TextInput name="notes" placeholder="Notes" />
          </Field>
        </div>
        <div className="flex flex-col gap-3 pt-1">
          <ActionButton type="submit" variant="secondary" disabled={updateStatus.isPending}>
            {updateStatus.isPending ? "Updating…" : "Update status"}
          </ActionButton>
          <FeedbackMessage status={updateFeedback.status} message={updateFeedback.message} />
        </div>
      </FormCard>
    </FormGrid>
  );
}
