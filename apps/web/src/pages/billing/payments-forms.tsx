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
import {
  ENABLE_MULTI_PAY,
  allocateBatch,
  postPayment,
} from "@/api/payments";

type TenantOption = { id: string; displayName: string };
type ChargeOption = { id: string; chargeNumber: string; outstandingAmount: number; invoiceNumber?: string | null };
type PaymentOption = { id: string; paymentNumber: string; partyName: string; status: string };

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

// ── Multi-charge allocate card (flag-gated) ─────────────────────────────────

type CheckedLine = { chargeId: string; amount: string };

function MultiChargeCard({
  charges,
  tenants,
}: {
  charges: ChargeOption[];
  tenants: TenantOption[];
}) {
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<FeedbackState>(idle);

  const selectedCharges = charges.filter((c) => checked[c.id]);
  const selectedTotal = selectedCharges.reduce((sum, c) => {
    const v = parseFloat(amounts[c.id] ?? String(c.outstandingAmount));
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);

  // Group by invoiceNumber for display (best-effort — ungrouped go under "—")
  const grouped: Record<string, ChargeOption[]> = {};
  for (const c of charges) {
    const key = c.invoiceNumber ?? "—";
    (grouped[key] ??= []).push(c);
  }

  const recordAndAllocate = useMutation({
    mutationFn: async ({
      lines,
      total,
      partyId,
      paymentNumber,
      paymentType,
      paymentMethod,
      currency,
      receivedAt,
      referenceNote,
    }: {
      lines: CheckedLine[];
      total: number;
      partyId: string;
      paymentNumber: string;
      paymentType: string;
      paymentMethod: string;
      currency: string;
      receivedAt: string;
      referenceNote?: string;
    }) => {
      // Step 1: record payment (createPaymentService sets status: "posted" directly)
      const created = await apiFetch<{ data: { id: string } }>("/payments", {
        method: "POST",
        body: JSON.stringify({
          paymentNumber,
          partyId,
          paymentType,
          paymentMethod,
          amount: String(total),
          currency,
          receivedAt,
          ...(referenceNote ? { referenceNote } : {}),
        }),
      });
      const paymentId = created.data.id;

      // Step 2: allocate-batch (payment is already posted; /post would 400)
      await allocateBatch(
        paymentId,
        crypto.randomUUID(),
        lines.map((l) => ({ chargeId: l.chargeId, allocatedAmount: l.amount })),
      );

      return { paymentId };
    },
    onSuccess: () => {
      setFeedback({ status: "success", message: "Payment recorded and allocated." });
      setChecked({});
      setAmounts({});
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err: Error) => {
      setFeedback({ status: "error", message: err.message });
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFeedback(idle);
    const fd = getFormData(e);
    if (selectedCharges.length === 0) {
      setFeedback({ status: "error", message: "Select at least one charge." });
      return;
    }
    if (!fd.partyId) {
      setFeedback({ status: "error", message: "Select a payer." });
      return;
    }
    const lines: CheckedLine[] = selectedCharges.map((c) => ({
      chargeId: c.id,
      amount: String(parseFloat(amounts[c.id] ?? String(c.outstandingAmount)).toFixed(2)),
    }));
    recordAndAllocate.mutate({
      lines,
      total: selectedTotal,
      partyId: fd.partyId,
      paymentNumber: fd.paymentNumber,
      paymentType: fd.paymentType ?? "rental_payment",
      paymentMethod: fd.paymentMethod ?? "bank_transfer",
      currency: fd.currency ?? "MYR",
      receivedAt: fd.receivedAt,
      referenceNote: fd.referenceNote,
    });
  }

  return (
    <FormCard
      title="Record & allocate (multi-charge)"
      description="Tick the charges this payment covers, adjust amounts if partial, then record and allocate in one step."
      onSubmit={handleSubmit}
    >
      {/* Charge picker grouped by invoice */}
      <div className="flex flex-col gap-3">
        {Object.entries(grouped).map(([invoiceLabel, groupCharges]) => (
          <div key={invoiceLabel}>
            <p className="mb-1 text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
              Invoice {invoiceLabel}
            </p>
            <div className="flex flex-col gap-2">
              {groupCharges.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--card-border)] bg-[var(--page-bg)] px-3 py-2 text-sm cursor-pointer hover:bg-[var(--card-bg)]"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[var(--input-border)] accent-[var(--primary)]"
                    checked={!!checked[c.id]}
                    onChange={(ev) => {
                      setChecked((prev) => ({ ...prev, [c.id]: ev.target.checked }));
                      if (!amounts[c.id]) {
                        setAmounts((prev) => ({
                          ...prev,
                          [c.id]: String(c.outstandingAmount),
                        }));
                      }
                    }}
                  />
                  <span className="flex-1 text-[var(--text-primary)]">
                    {c.chargeNumber} · outstanding {c.outstandingAmount.toFixed(2)}
                  </span>
                  {checked[c.id] && (
                    <TextInput
                      type="number"
                      min={0.01}
                      max={c.outstandingAmount}
                      step="0.01"
                      className="w-28"
                      value={amounts[c.id] ?? String(c.outstandingAmount)}
                      onChange={(ev) =>
                        setAmounts((prev) => ({ ...prev, [c.id]: ev.target.value }))
                      }
                      aria-label={`Amount for ${c.chargeNumber}`}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
        {charges.length === 0 && (
          <p className="text-sm text-[var(--text-muted)]">No charges available.</p>
        )}
      </div>

      {/* Live selected total */}
      <div className="flex items-center justify-between rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-2 text-sm">
        <span className="text-[var(--text-secondary)]">Selected total</span>
        <span className="font-semibold text-[var(--text-primary)]">
          MYR {selectedTotal.toFixed(2)}
        </span>
      </div>

      {/* Payment metadata */}
      <Field label="Payment number">
        <TextInput name="paymentNumber" placeholder="Payment number" required />
      </Field>
      <Field label="Payer">
        <SelectInput name="partyId" required>
          <option value="">Select payer</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.displayName}
            </option>
          ))}
        </SelectInput>
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Payment type">
          <TextInput
            name="paymentType"
            placeholder="rental_payment"
            required
            defaultValue="rental_payment"
          />
        </Field>
        <Field label="Method">
          <TextInput
            name="paymentMethod"
            placeholder="bank_transfer"
            required
            defaultValue="bank_transfer"
          />
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Currency">
          <TextInput name="currency" placeholder="MYR" required defaultValue="MYR" />
        </Field>
        <Field label="Received at">
          <TextInput name="receivedAt" type="datetime-local" required />
        </Field>
      </div>
      <Field label="Reference note">
        <TextInput name="referenceNote" placeholder="Reference note (optional)" />
      </Field>
      <ActionButton
        type="submit"
        variant="primary"
        disabled={recordAndAllocate.isPending || selectedCharges.length === 0}
      >
        {recordAndAllocate.isPending ? "Recording…" : "Record & allocate"}
      </ActionButton>
      <FeedbackMessage status={feedback.status} message={feedback.message} />
    </FormCard>
  );
}

// ── Post-payment card (flag-gated) ──────────────────────────────────────────

function PostPaymentCard({ payments }: { payments: PaymentOption[] }) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<FeedbackState>(idle);

  const pendingPayments = payments.filter((p) => p.status === "pending_approval");

  const postMutation = useMutation({
    mutationFn: (paymentId: string) => postPayment(paymentId),
    onSuccess: () => {
      setFeedback({ status: "success", message: "Payment posted." });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (err: Error) => {
      setFeedback({ status: "error", message: err.message });
    },
  });

  return (
    <FormCard
      title="Post (approve) payment"
      description="Approve a pending payment and apply it to charges."
      onSubmit={(e) => {
        e.preventDefault();
        setFeedback(idle);
        const data = getFormData(e);
        if (!data.paymentId) {
          setFeedback({ status: "error", message: "Select a payment." });
          return;
        }
        postMutation.mutate(data.paymentId);
      }}
    >
      <Field label="Pending payment">
        <SelectInput name="paymentId" required>
          <option value="">Select payment</option>
          {pendingPayments.map((p) => (
            <option key={p.id} value={p.id}>
              {optionLabel(p.paymentNumber, p.partyName)}
            </option>
          ))}
        </SelectInput>
      </Field>
      {pendingPayments.length === 0 && (
        <p className="text-sm text-[var(--text-muted)]">No pending payments to approve.</p>
      )}
      <ActionButton type="submit" variant="secondary" disabled={postMutation.isPending}>
        {postMutation.isPending ? "Posting…" : "Post payment"}
      </ActionButton>
      <FeedbackMessage status={feedback.status} message={feedback.message} />
    </FormCard>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function PaymentForms({
  tenants,
  charges,
  payments,
}: {
  tenants: TenantOption[];
  charges: ChargeOption[];
  payments: PaymentOption[];
}) {
  const queryClient = useQueryClient();

  // ── Create Payment ────────────────────────────────────────────────────────
  const [createFeedback, setCreateFeedback] = useState<FeedbackState>(idle);
  const createPayment = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch("/payments", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      setCreateFeedback({ status: "success", message: "Payment recorded." });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (err: Error) => {
      setCreateFeedback({ status: "error", message: err.message });
    },
  });

  // ── Allocate Payment ──────────────────────────────────────────────────────
  const [allocateFeedback, setAllocateFeedback] = useState<FeedbackState>(idle);
  const allocatePayment = useMutation({
    mutationFn: ({
      paymentId,
      chargeId,
      allocatedAmount,
    }: {
      paymentId: string;
      chargeId: string;
      allocatedAmount: string;
    }) =>
      apiFetch(`/payments/${paymentId}/allocate`, {
        method: "POST",
        body: JSON.stringify({ chargeId, allocatedAmount }),
      }),
    onSuccess: () => {
      setAllocateFeedback({ status: "success", message: "Payment allocated." });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
    onError: (err: Error) => {
      setAllocateFeedback({ status: "error", message: err.message });
    },
  });

  // ── Update Payment Status ─────────────────────────────────────────────────
  const [statusFeedback, setStatusFeedback] = useState<FeedbackState>(idle);
  const updateStatus = useMutation({
    mutationFn: ({
      paymentId,
      status,
      note,
    }: {
      paymentId: string;
      status: string;
      note?: string;
    }) =>
      apiFetch(`/payments/${paymentId}/status`, {
        method: "PUT",
        body: JSON.stringify({ status, note }),
      }),
    onSuccess: () => {
      setStatusFeedback({ status: "success", message: "Payment status updated." });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (err: Error) => {
      setStatusFeedback({ status: "error", message: err.message });
    },
  });

  return (
    <div className="grid gap-6">
      <FormGrid className="xl:grid-cols-2">
        {/* Record Payment */}
        <FormCard
          title="Record payment"
          description="Capture a receipt with method, amount, and reference context."
          onSubmit={(e) => {
            e.preventDefault();
            setCreateFeedback(idle);
            createPayment.mutate(getFormData(e));
          }}
        >
          <Field label="Payment number">
            <TextInput name="paymentNumber" placeholder="Payment number" required />
          </Field>
          <Field label="Payer">
            <SelectInput name="partyId" required>
              <option value="">Select payer</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </SelectInput>
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Payment type">
              <TextInput
                name="paymentType"
                placeholder="rental_payment"
                required
                defaultValue="rental_payment"
              />
            </Field>
            <Field label="Method">
              <TextInput
                name="paymentMethod"
                placeholder="bank_transfer"
                required
                defaultValue="bank_transfer"
              />
            </Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Amount">
              <TextInput
                name="amount"
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
                required
              />
            </Field>
            <Field label="Currency">
              <TextInput name="currency" placeholder="MYR" required defaultValue="MYR" />
            </Field>
          </div>
          <Field label="Received at">
            <TextInput name="receivedAt" type="datetime-local" required />
          </Field>
          <Field label="Reference note">
            <TextInput name="referenceNote" placeholder="Reference note" />
          </Field>
          <Field label="External reference">
            <TextInput name="externalReference" placeholder="External reference" />
          </Field>
          <ActionButton type="submit" variant="primary" disabled={createPayment.isPending}>
            {createPayment.isPending ? "Recording…" : "Record payment"}
          </ActionButton>
          <FeedbackMessage status={createFeedback.status} message={createFeedback.message} />
        </FormCard>

        {/* Allocate Payment */}
        <FormCard
          title="Allocate payment"
          description="Map a payment to a charge and record the applied amount."
          onSubmit={(e) => {
            e.preventDefault();
            setAllocateFeedback(idle);
            const data = getFormData(e);
            if (!data.paymentId) {
              setAllocateFeedback({ status: "error", message: "Select a payment." });
              return;
            }
            if (!data.chargeId) {
              setAllocateFeedback({ status: "error", message: "Select a charge." });
              return;
            }
            if (!data.allocatedAmount) {
              setAllocateFeedback({ status: "error", message: "Enter an allocated amount." });
              return;
            }
            allocatePayment.mutate({
              paymentId: data.paymentId,
              chargeId: data.chargeId,
              allocatedAmount: data.allocatedAmount,
            });
          }}
        >
          <Field label="Payment">
            <SelectInput name="paymentId" required>
              <option value="">Select payment</option>
              {payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {optionLabel(p.paymentNumber, p.partyName)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Charge">
            <SelectInput name="chargeId" required>
              <option value="">Select charge</option>
              {charges.map((c) => (
                <option key={c.id} value={c.id}>
                  {optionLabel(c.chargeNumber, `outstanding ${c.outstandingAmount}`)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Allocated amount">
            <TextInput
              name="allocatedAmount"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              required
            />
          </Field>
          <ActionButton type="submit" variant="secondary" disabled={allocatePayment.isPending}>
            {allocatePayment.isPending ? "Allocating…" : "Allocate"}
          </ActionButton>
          <FeedbackMessage status={allocateFeedback.status} message={allocateFeedback.message} />
        </FormCard>
      </FormGrid>

      {/* Update Payment Status */}
      <div className="max-w-2xl">
        <FormCard
          title="Update payment status"
          description="Void or refund a payment without leaving the register."
          onSubmit={(e) => {
            e.preventDefault();
            setStatusFeedback(idle);
            const data = getFormData(e);
            if (!data.paymentId) {
              setStatusFeedback({ status: "error", message: "Select a payment." });
              return;
            }
            updateStatus.mutate({
              paymentId: data.paymentId,
              status: data.status ?? "void",
              note: data.note,
            });
          }}
        >
          <Field label="Payment">
            <SelectInput name="paymentId" required>
              <option value="">Select payment</option>
              {payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {optionLabel(p.paymentNumber, p.status)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Status">
              <SelectInput name="status" defaultValue="void">
                <option value="void">void</option>
                <option value="refunded">refunded</option>
              </SelectInput>
            </Field>
            <Field label="Note">
              <TextInput name="note" placeholder="Status note (optional)" />
            </Field>
          </div>
          <ActionButton type="submit" variant="danger" disabled={updateStatus.isPending}>
            {updateStatus.isPending ? "Updating…" : "Update status"}
          </ActionButton>
          <FeedbackMessage status={statusFeedback.status} message={statusFeedback.message} />
        </FormCard>
      </div>

      {/* Flag-gated: multi-charge record+allocate + post */}
      {ENABLE_MULTI_PAY && (
        <>
          <FormGrid className="xl:grid-cols-2">
            <MultiChargeCard charges={charges} tenants={tenants} />
            <PostPaymentCard payments={payments} />
          </FormGrid>
        </>
      )}
    </div>
  );
}
