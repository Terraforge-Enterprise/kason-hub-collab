import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Field, TextInput, SelectInput, TextAreaInput } from "@/components/form-ui";
import { StatusPill } from "@/components/ui";
import { formatMoney } from "@/components/format";
import { useClaimActions } from "./use-claim-actions";

export type ClaimForDrawer = {
  id: string;
  claimNumber: string;
  status: string;
  agentName: string;
  totalNettPayout: number;
  claimDate: string;
};

export type ClaimDrawerMode = "reject" | "pay" | "pay-due" | null;

type Props = {
  claim: ClaimForDrawer | null;
  mode: ClaimDrawerMode;
  onClose: () => void;
  /**
   * When true, hides the "View full details" link inside the summary card.
   * Set from `claim-detail-page.tsx`, where the link would point to the same
   * URL the user is already on and React Router would no-op the click.
   */
  hideDetailLink?: boolean;
};

const TENDERS = [
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
];

const TENDER_LABELS: Record<string, string> = Object.fromEntries(
  TENDERS.map((t) => [t.value, t.label]),
);

export function ClaimDrawer({ claim, mode, onClose, hideDetailLink = false }: Props) {
  const { reject, pay, approve } = useClaimActions();

  const [dueDate, setDueDate] = useState("");
  const [reason, setReason] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentTender, setPaymentTender] = useState("bank_transfer");

  useEffect(() => {
    if (!claim || !mode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: local form state is (re)seeded from props/query data on open or upstream change
      setDueDate("");
      setReason("");
      setPaymentDate("");
      setPaymentTender("bank_transfer");
    }
  }, [claim, mode]);

  if (!claim) return null;

  const open = !!(claim && mode);

  const title =
    mode === "reject"
      ? "Reject claim"
      : mode === "pay"
        ? "Mark claim as paid"
        : "Approve with due date";

  const desc =
    mode === "reject"
      ? "Provide a reason. The agent will be notified."
      : mode === "pay"
        ? "Record a payment for this approved claim."
        : "Optionally set a payment due date before approving.";

  function handleSubmit() {
    if (!claim || !mode) return;
    if (mode === "pay-due") {
      approve.mutate({ claim, dueDate: dueDate || undefined });
      onClose();
    } else if (mode === "reject" && reason.trim().length >= 3) {
      reject.mutate({ claim, reason: reason.trim() });
      onClose();
    } else if (mode === "pay" && paymentDate) {
      pay.mutate({ claim, movementDate: paymentDate, paymentTender });
      onClose();
    }
  }

  const submitDisabled =
    (mode === "reject" && reason.trim().length < 3) ||
    (mode === "pay" && !paymentDate) ||
    approve.isPending ||
    reject.isPending ||
    pay.isPending;

  const submitLabel =
    mode === "reject"
      ? "Reject claim"
      : mode === "pay"
        ? "Record payment"
        : "Approve claim";

  const submitConfirm =
    mode === "reject"
      ? {
          title: "Reject this claim?",
          body: <RejectConfirmBody claim={claim} reason={reason} />,
          confirmLabel: "Reject claim",
          destructive: true,
        }
      : mode === "pay"
        ? {
            title: "Record payment?",
            body: (
              <PayConfirmBody
                claim={claim}
                paymentDate={paymentDate}
                paymentTender={paymentTender}
              />
            ),
            confirmLabel: "Confirm payment",
            destructive: true,
          }
        : undefined;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="md"
      title={title}
      description={desc}
      onSubmit={handleSubmit}
      submit={{
        label: submitLabel,
        variant: mode === "reject" ? "destructive" : "gold",
        disabled: submitDisabled,
        pending:
          (mode === "reject" && reject.isPending) ||
          (mode === "pay" && pay.isPending) ||
          (mode === "pay-due" && approve.isPending),
        confirm: submitConfirm,
      }}
    >
      <div className="rounded-lg border border-border/50 bg-background/40 p-4 mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground truncate">
              {claim.claimNumber}
            </p>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {claim.agentName} · {formatMoney(claim.totalNettPayout)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Claim date: {new Date(claim.claimDate).toLocaleDateString("en-MY")}
            </p>
          </div>
          <StatusPill tone={toneForStatus(claim.status)}>{claim.status}</StatusPill>
        </div>
        {!hideDetailLink && (
          <Link
            to={`/commissions/claims/${claim.id}`}
            className="mt-3 inline-block text-xs text-[var(--primary)] hover:underline"
          >
            View full details →
          </Link>
        )}
      </div>

      {mode === "pay-due" && (
        <Field label="Payment due date (optional)">
          <TextInput
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </Field>
      )}

      {mode === "reject" && (
        <Field label="Reason">
          <TextAreaInput
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={3}
            required
            placeholder="Provide a reason for rejection…"
          />
          {reason.length > 0 && reason.trim().length < 3 && (
            <p className="mt-1 text-xs text-red-500">
              Reason must be at least 3 characters.
            </p>
          )}
        </Field>
      )}

      {mode === "pay" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment date">
            <TextInput
              type="date"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </Field>
          <Field label="Payment tender">
            <SelectInput
              value={paymentTender}
              onChange={(e) => setPaymentTender(e.target.value)}
            >
              {TENDERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
      )}
    </FormDrawer>
  );
}

function RejectConfirmBody({
  claim,
  reason,
}: {
  claim: ClaimForDrawer;
  reason: string;
}) {
  return (
    <span>
      You're rejecting <strong>{claim.claimNumber}</strong> for{" "}
      <strong>{claim.agentName}</strong> ({formatMoney(claim.totalNettPayout)}).
      The agent will be notified of the rejection and your reason:{" "}
      <em>"{reason}"</em>
    </span>
  );
}

function PayConfirmBody({
  claim,
  paymentDate,
  paymentTender,
}: {
  claim: ClaimForDrawer;
  paymentDate: string;
  paymentTender: string;
}) {
  const formattedDate = paymentDate
    ? new Date(paymentDate).toLocaleDateString("en-MY")
    : "";
  return (
    <span>
      Recording <strong>{formatMoney(claim.totalNettPayout)}</strong> paid to{" "}
      <strong>{claim.agentName}</strong> on <strong>{formattedDate}</strong> via{" "}
      <strong>{TENDER_LABELS[paymentTender] ?? paymentTender}</strong>. This
      cannot be undone.
    </span>
  );
}

function toneForStatus(
  status: string,
): "amber" | "emerald" | "rose" | "sky" | "slate" {
  if (status === "submitted") return "amber";
  if (status === "approved") return "emerald";
  if (status === "rejected") return "rose";
  if (status === "paid") return "sky";
  return "slate";
}
