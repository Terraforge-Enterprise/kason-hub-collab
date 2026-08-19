// Payer-first "Receive payment" flow. Unlike TransferFromInvoiceDrawer (which
// starts from ONE invoice's lines), this starts from a PAYER: pick tenant/owner,
// load ALL their open charges, enter the amount received once (the anchor), then
// spread it across charges — auto-apply oldest-first or edit per-row. A live
// running triad (Applied / Received / Unapplied) gates submit so we never record
// a payment whose allocations don't sum to the received amount, and never let a
// row exceed its own outstanding. On submit we record-and-allocate in one call
// (a receipt is issued server-side). Slip proofs are uploaded first and
// orphan-cleaned on failure, mirroring the transfer drawer.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { RecordAndAllocateInput } from "@kason/shared";
import { ApiError } from "@/lib/api-client";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Field, TextInput, SelectInput } from "@/components/form-ui";
import { Callout } from "@/components/ui/callout";
import { PartyPicker, type PartyPickerValue } from "@/components/party-picker";
import { usePartyOpenCharges, type ChargeListItem } from "@/api/charges";
import { useRecordTransfer, uploadSlipProof, deleteSlipProof } from "@/api/accounting";
import type { PartyCounterparty } from "@/api/parties-search";
import { formatRM } from "@/components/format";

type PaymentMethod = "cash" | "bank_transfer" | "cheque" | "fpx" | "card";

const METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "fpx", label: "FPX" },
  { value: "card", label: "Card" },
];

/** Editable allocation state, one row per open charge. */
type ApplyRow = { chargeId: string; description: string; due: string; outstanding: number; apply: string };

function paymentNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `RCV-${ymd}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Two-dp-tolerant "is this line over its own outstanding" test. */
function overCap(apply: string, outstanding: number): boolean {
  return Number(apply) > outstanding + 0.005;
}

function toRows(charges: ChargeListItem[]): ApplyRow[] {
  return charges.map((c) => ({
    chargeId: c.id,
    description: c.chargeType,
    due: c.dueDate.slice(0, 10),
    outstanding: c.outstandingAmount,
    apply: "",
  }));
}

export function ReceivePaymentDrawer({
  open,
  onClose,
  defaultCounterparty,
  defaultPartyId,
}: {
  open: boolean;
  onClose: () => void;
  defaultCounterparty?: PartyCounterparty;
  defaultPartyId?: string;
}) {
  const [counterparty, setCounterparty] = useState<PartyCounterparty>(defaultCounterparty ?? "tenant");
  const [party, setParty] = useState<PartyPickerValue | null>(
    defaultPartyId ? { id: defaultPartyId, name: "" } : null,
  );

  const [amountReceived, setAmountReceived] = useState("");
  const [dateReceived, setDateReceived] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [bankRef, setBankRef] = useState("");
  const [memo, setMemo] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  const [rows, setRows] = useState<ApplyRow[]>([]);

  const chargesQuery = usePartyOpenCharges(open && party ? party.id : null);
  const charges = useMemo(() => chargesQuery.data ?? [], [chargesQuery.data]);

  const [submitting, setSubmitting] = useState(false);
  const record = useRecordTransfer();

  // Reset everything when the drawer closes so a re-open starts clean — this
  // synchronizes local form state to the external `open` signal (the established
  // drawer-reset pattern in this app).
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form state to defaults when the drawer's `open` prop flips false; synchronizing to an external open/close signal
      setCounterparty(defaultCounterparty ?? "tenant");
      setParty(defaultPartyId ? { id: defaultPartyId, name: "" } : null);
      setAmountReceived("");
      setDateReceived(todayIso());
      setMethod("bank_transfer");
      setBankRef("");
      setMemo("");
      setFiles([]);
      setRows([]);
    }
  }, [open, defaultCounterparty, defaultPartyId]);

  // Seed the apply grid whenever the payer's open charges load/change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed editable apply-grid rows from the (async) open-charges query; the established data-seeding pattern used across this app's drawers
    setRows(toRows(charges));
  }, [charges]);

  function setApply(chargeId: string, v: string) {
    setRows((rs) => rs.map((r) => (r.chargeId === chargeId ? { ...r, apply: v } : r)));
  }

  // Auto-apply oldest first: walk the rows sorted by due date and pour the
  // received amount into each, capped at that charge's outstanding, until the
  // received amount is exhausted.
  function autoApply() {
    let remaining = Number(amountReceived);
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const order = [...rows].sort((a, b) => a.due.localeCompare(b.due));
    const next = new Map<string, string>();
    for (const r of order) {
      if (remaining <= 0) {
        next.set(r.chargeId, "");
        continue;
      }
      const take = Math.min(remaining, r.outstanding);
      next.set(r.chargeId, take > 0 ? take.toFixed(2) : "");
      remaining -= take;
    }
    setRows((rs) => rs.map((r) => ({ ...r, apply: next.get(r.chargeId) ?? r.apply })));
  }

  const received = Number(amountReceived);
  const receivedValid = Number.isFinite(received) && received > 0;
  const applied = rows.reduce((sum, r) => sum + (Number(r.apply) > 0 ? Number(r.apply) : 0), 0);
  const unapplied = (receivedValid ? received : 0) - applied;
  const anyOverCap = rows.some((r) => overCap(r.apply, r.outstanding));
  // "Balanced" = every ringgit received is applied, within a 1-cent tolerance,
  // and no line exceeds its own outstanding.
  const balanced = receivedValid && Math.abs(unapplied) < 0.005 && !anyOverCap && applied > 0;

  const positiveRows = rows.filter((r) => Number(r.apply) > 0);
  const canSubmit = !!party && balanced && positiveRows.length > 0 && !submitting && !record.isPending;

  let blockReason = "";
  if (!party) blockReason = "Choose a payer to begin.";
  else if (!receivedValid) blockReason = "Enter the amount received.";
  else if (anyOverCap) blockReason = "A line exceeds its outstanding — reduce it.";
  else if (positiveRows.length === 0) blockReason = "Apply the amount to at least one charge.";
  else if (unapplied > 0.005) blockReason = `Apply the remaining ${formatRM(unapplied)}.`;
  else if (unapplied < -0.005) blockReason = `Applied exceeds received by ${formatRM(Math.abs(unapplied))}.`;

  async function submit() {
    if (!party || !canSubmit) return;
    setSubmitting(true);
    const uploadedKeys: string[] = [];
    try {
      // Upload every slip first; on any failure below, orphan-clean them all.
      for (const f of files) {
        uploadedKeys.push(await uploadSlipProof(f));
      }
      const body: RecordAndAllocateInput = {
        paymentNumber: paymentNumber(),
        partyId: party.id,
        paymentType: "rental_payment",
        paymentMethod: method,
        currency: "MYR",
        receivedAt: dateReceived,
        idempotencyKey: crypto.randomUUID(),
        ...(uploadedKeys.length ? { attachmentKeys: uploadedKeys } : {}),
        ...(bankRef.trim() ? { externalReference: bankRef.trim() } : {}),
        ...(memo.trim() ? { referenceNote: memo.trim() } : {}),
        allocations: positiveRows.map((r) => ({
          chargeId: r.chargeId,
          allocatedAmount: Number(r.apply).toFixed(2),
        })),
      };
      await record.mutateAsync(body);
      toast.success("Payment recorded — receipt issued");
      onClose();
    } catch (err) {
      // Delete-on-failure: slips were uploaded but the record call failed — clean
      // up the orphans so storage never holds an object with no payment.
      for (const key of uploadedKeys) await deleteSlipProof(key).catch(() => {});
      // Best-effort duplicate detection: a 409 DUPLICATE_PAYMENT means the same
      // idempotency/payment likely already landed.
      if (err instanceof ApiError && (err.status === 409 || err.code === "DUPLICATE_PAYMENT")) {
        toast.error("You may have already recorded this — check existing payments");
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to record payment");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const pending = submitting || record.isPending;
  const openChargeCount = charges.length;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Receive payment"
      description="Record a payment from a payer and apply it across their open charges — a receipt is issued."
      onSubmit={() => void submit()}
      submit={{
        label: "Record payment",
        pendingLabel: "Recording…",
        pending,
        disabled: !canSubmit,
        confirm: party
          ? {
              title: "Record this payment?",
              body: `Record ${formatRM(received)} from ${party.name || "this payer"} across ${positiveRows.length} charge(s). A receipt will be issued.`,
              confirmLabel: "Record payment",
            }
          : undefined,
      }}
    >
      <div className="space-y-5">
        {/* ── Payer selection ─────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="inline-flex rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] p-0.5 text-sm">
            {(["tenant", "owner"] as const).map((cp) => (
              <button
                key={cp}
                type="button"
                aria-pressed={counterparty === cp}
                onClick={() => {
                  if (counterparty === cp) return;
                  setCounterparty(cp);
                  setParty(null);
                  setRows([]);
                }}
                className={
                  counterparty === cp
                    ? "rounded-md bg-[var(--primary)] px-4 py-1.5 font-medium text-white"
                    : "rounded-md px-4 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }
              >
                {cp === "tenant" ? "Tenant" : "Owner"}
              </button>
            ))}
          </div>

          <PartyPicker
            counterparty={counterparty}
            value={party}
            onChange={(v) => setParty(v)}
            label="Payer"
            placeholder={counterparty === "tenant" ? "Search tenant by name…" : "Search owner by name…"}
          />
        </div>

        {/* ── Payer context card ──────────────────────────────────────────── */}
        {party ? (
          <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {party.name || "Selected payer"}
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  {counterparty === "tenant" ? "Tenant" : "Owner"}
                </div>
              </div>
              <div className="text-xs text-[var(--text-secondary)]">
                {chargesQuery.isLoading ? "Loading charges…" : `${openChargeCount} open charge${openChargeCount === 1 ? "" : "s"}`}
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Payment fields ──────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount received" hint="The total to apply across charges.">
            <TextInput
              type="number"
              min={0}
              step="0.01"
              aria-label="Amount received"
              value={amountReceived}
              onChange={(e) => setAmountReceived(e.target.value)}
            />
          </Field>
          <Field label="Date received">
            <TextInput
              type="date"
              aria-label="Date received"
              value={dateReceived}
              onChange={(e) => setDateReceived(e.target.value)}
            />
          </Field>
          <Field label="Method">
            <SelectInput
              aria-label="Method"
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            >
              {METHOD_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="Bank reference" hint="Optional — appears on the receipt.">
            <TextInput
              aria-label="Bank reference"
              value={bankRef}
              onChange={(e) => setBankRef(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Memo" hint="Optional note stored with the payment.">
          <TextInput aria-label="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
        <Field label="Payment slip(s)" hint="Optional proof-of-payment images.">
          <input
            aria-label="Payment slip"
            type="file"
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => setFiles(e.target.files ? Array.from(e.target.files) : [])}
          />
        </Field>

        {/* ── Apply grid ──────────────────────────────────────────────────── */}
        {party ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Apply to charges</h3>
              <button
                type="button"
                onClick={autoApply}
                disabled={!receivedValid || rows.length === 0}
                className="rounded-lg border border-[var(--input-border)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition hover:bg-[var(--page-bg)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Auto-apply oldest first
              </button>
            </div>

            {chargesQuery.isLoading ? (
              <p className="text-sm text-[var(--text-secondary)]">Loading open charges…</p>
            ) : rows.length === 0 ? (
              <Callout variant="info">This payer has no open charges to apply against.</Callout>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => {
                  const over = overCap(r.apply, r.outstanding);
                  return (
                    <div
                      key={r.chargeId}
                      className="grid grid-cols-[1fr_auto] items-start gap-3 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                          {r.description}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)]">
                          Due {r.due} · Outstanding {formatRM(r.outstanding)}
                        </div>
                      </div>
                      <div className="w-32">
                        <TextInput
                          type="number"
                          min={0}
                          step="0.01"
                          aria-label={`Apply to ${r.description}`}
                          placeholder="0.00"
                          value={r.apply}
                          onChange={(e) => setApply(r.chargeId, e.target.value)}
                        />
                        {over ? (
                          <p className="mt-1 text-xs text-rose-600">Exceeds outstanding.</p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        {/* ── Running triad footer ────────────────────────────────────────── */}
        {party && rows.length > 0 ? (
          <div
            className={
              balanced
                ? "rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-100"
                : "rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3 text-sm text-[var(--text-primary)]"
            }
          >
            <div className="flex items-center justify-between gap-3">
              <span>
                {balanced ? "✓ " : ""}
                Applied <strong>{formatRM(applied)}</strong> of <strong>{formatRM(receivedValid ? received : 0)}</strong> — Unapplied{" "}
                <strong>{formatRM(unapplied)}</strong>
              </span>
            </div>
            {!balanced && blockReason ? (
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{blockReason}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </FormDrawer>
  );
}
