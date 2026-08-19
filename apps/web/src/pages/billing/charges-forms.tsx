import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import {
  ActionButton,
  FeedbackMessage,
  Field,
  FormCard,
  FormGrid,
  SelectInput,
  TextInput,
} from "@/components/form-ui";
import { ChargeForm } from "@/components/charge-form";
import { VoidChargeDialog } from "@/components/void-charge-dialog";

type ChargeOption = { id: string; chargeNumber: string; status: string };

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

function optionLabel(primary: string, secondary?: string) {
  return secondary ? `${primary} · ${secondary}` : primary;
}

export function ChargeForms({ charges }: { charges: ChargeOption[] }) {
  const queryClient = useQueryClient();

  // ── Post Charge ───────────────────────────────────────────────────────────
  const [postFeedback, setPostFeedback] = useState<FeedbackState>(idle);
  const postCharge = useMutation({
    mutationFn: (chargeId: string) =>
      apiFetch(`/billing/charges/${chargeId}/post`, { method: "POST" }),
    onSuccess: () => {
      setPostFeedback({ status: "success", message: "Charge posted." });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err: Error) => {
      setPostFeedback({ status: "error", message: err.message });
    },
  });

  // ── Void Charge ───────────────────────────────────────────────────────────
  const [voidFeedback, setVoidFeedback] = useState<FeedbackState>(idle);
  const [voidTarget, setVoidTarget] = useState<ChargeOption | null>(null);
  const billingDocsOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");
  const voidCharge = useMutation({
    mutationFn: ({ chargeId, reason }: { chargeId: string; reason: string }) =>
      apiFetch(`/billing/charges/${chargeId}/void`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      setVoidFeedback({ status: "success", message: "Charge voided." });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err: Error) => {
      setVoidFeedback({ status: "error", message: err.message });
    },
  });

  return (
    <div className="grid gap-6">
      <FormGrid className="xl:grid-cols-[1.2fr_0.8fr]">
        {/* Create Charge — shared ChargeForm (accounting-docs P1 §4.8): category
            dropdown + document preview when ENABLE_PHASE2_BILLING_DOCS is on,
            legacy free-text charge type while dark. */}
        <ChargeForm layout="card" />

        <div className="grid gap-6">
          {/* Post Charge */}
          <FormCard
            title="Post charge"
            description="Move a charge into its collection-ready state."
            onSubmit={(e) => {
              e.preventDefault();
              setPostFeedback(idle);
              const data = getFormData(e);
              if (!data.chargeId) {
                setPostFeedback({ status: "error", message: "Select a charge." });
                return;
              }
              postCharge.mutate(data.chargeId);
            }}
          >
            <Field label="Charge">
              <SelectInput name="chargeId" required>
                <option value="">Select charge</option>
                {charges.map((c) => (
                  <option key={c.id} value={c.id}>
                    {optionLabel(c.chargeNumber, c.status)}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <ActionButton type="submit" variant="secondary" disabled={postCharge.isPending}>
              {postCharge.isPending ? "Posting…" : "Post selected charge"}
            </ActionButton>
            <FeedbackMessage status={postFeedback.status} message={postFeedback.message} />
          </FormCard>

          {/* Void Charge */}
          <FormCard
            title={billingDocsOn ? "Void & issue Credit Note" : "Void charge"}
            description={
              billingDocsOn
                ? "Voiding a posted charge issues an offsetting Credit Note, permanently linked."
                : "Void an incorrect charge and record the reason."
            }
            onSubmit={(e) => {
              e.preventDefault();
              setVoidFeedback(idle);
              const data = getFormData(e);
              if (!data.chargeId) {
                setVoidFeedback({ status: "error", message: "Select a charge." });
                return;
              }
              if (billingDocsOn) {
                const target = charges.find((c) => c.id === data.chargeId) ?? null;
                setVoidTarget(target);
                return;
              }
              if (!data.reason) {
                setVoidFeedback({ status: "error", message: "Void reason is required." });
                return;
              }
              voidCharge.mutate({ chargeId: data.chargeId, reason: data.reason });
            }}
          >
            <Field label="Charge">
              <SelectInput name="chargeId" required>
                <option value="">Select charge</option>
                {charges.map((c) => (
                  <option key={c.id} value={c.id}>
                    {optionLabel(c.chargeNumber, c.status)}
                  </option>
                ))}
              </SelectInput>
            </Field>
            {!billingDocsOn && (
              <Field label="Void reason">
                <TextInput name="reason" placeholder="Void reason" required />
              </Field>
            )}
            <ActionButton type="submit" variant="danger" disabled={voidCharge.isPending}>
              {billingDocsOn ? "Void & issue Credit Note…" : voidCharge.isPending ? "Voiding…" : "Void selected charge"}
            </ActionButton>
            <FeedbackMessage status={voidFeedback.status} message={voidFeedback.message} />
          </FormCard>
        </div>
      </FormGrid>

      <VoidChargeDialog charge={voidTarget} onClose={() => setVoidTarget(null)} />
    </div>
  );
}
