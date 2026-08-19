/**
 * CorrectInvoiceDrawer — R9 posted-invoice correction, rebuilt as a PROBLEM-FIRST
 * WIZARD on the Invoices / Receipts pages.
 *
 * Presentational only: the server re-derives the effect authoritatively from the
 * chosen `strategy` (POST /billing/charges/:chargeId/void). The four strategies:
 *  - CREDIT_ADJUSTMENT — re-derives the balance; a Credit Note offsets the
 *    original document. Any payment already recorded becomes tenant credit. When
 *    nothing was collected the server auto-downgrades to a plain void.
 *  - DEBIT_ADJUSTMENT — raises the receivable by an amount (Debit Note); the
 *    payment stays allocated.
 *  - CANCEL_AND_REPLACE — voids the original and issues a corrected replacement
 *    invoice, moving the allocation onto it.
 *  - REFUND — returns the money (Refund Note + Credit Note) with the transfer
 *    details, plus an optional proof-of-refund slip.
 *
 * The wizard has two steps inside one FormDrawer:
 *  STEP 1 — a plain-language "What do you need to fix?" question. Each choice is
 *           mapped to a backend strategy via a LOCAL lookup (never surfaced).
 *  STEP 2 — only the chosen branch's fields, an always-visible EFFECT PREVIEW
 *           Callout computed from COLLECTED (not total), a Back button, and a
 *           strategy-specific submit label. REFUND and CANCEL_AND_REPLACE gate
 *           the submit behind a confirm dialog.
 *
 * The Invoices list DTO (BillingDocumentListItem) carries no charge id, so the
 * drawer fetches the document detail and derives the charge id from its first
 * charge-bearing line (manual invoices are single-charge in practice). COLLECTED
 * is not on the detail DTO — it is derived as `total - outstandingAmount` (floored
 * at 0) from the party's open charges (GET /billing/charges), matched on chargeId.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { BillingDocumentListItem, CorrectionStrategy } from "@kason/shared";
import { ApiError } from "@/lib/api-client";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, SelectInput, TextAreaInput, TextInput } from "@/components/form-ui";
import { useChargeCategories } from "@/api/charge-categories";
import { useBillingDocument } from "@/api/billing-documents";
import { usePartyOpenCharges } from "@/api/charges";
import {
  useCorrectInvoice,
  uploadSlipProof,
  deleteSlipProof,
  type CorrectInvoiceInput,
  type CorrectionReplacementLine,
} from "@/api/accounting";

// Reused verbatim from void-charge-dialog.tsx — friendly copy for the backend
// void/correction error codes. The route returns a bare code as { error: CODE };
// apiFetch surfaces it as err.message with no `code`, so we key off the raw
// body/message here. Anything unmapped falls back to the raw message.
//
// R9 round-7: REVERT_PAYMENT_FIRST and STRATEGY_NOT_IMPLEMENTED are dead — the
// server no longer emits them (payment-freeze auto-derives; all four strategies
// ship). Removed so the copy map only claims codes the server can still return.
const VOID_ERROR_COPY: Record<string, string> = {
  STRATEGY_REQUIRED: "Choose how to correct this invoice before submitting.",
  ADJUSTMENT_AMOUNT_INVALID: "Enter a debit adjustment amount greater than zero.",
  REPLACEMENT_LINES_REQUIRED: "Add at least one line to the replacement invoice.",
  REPLACEMENT_TOTAL_TOO_LOW:
    "The replacement invoice total is below the amount already paid. Raise the lines to at least the collected amount.",
  CHARGE_NOT_POSTED: "This charge is no longer in a correctable state — refresh and check its current status.",
  CHARGE_NOT_FOUND: "That charge could not be found — refresh the page.",
  REFUND_DETAILS_REQUIRED: "Refund details are required when choosing a refund.",
  REFUND_AMOUNT_INVALID: "Enter a refund amount greater than zero.",
  REFUND_EXCEEDS_COLLECTED: "Refund amount exceeds the amount actually collected on this charge.",
  NO_PAYMENT_TO_REFUND: "No payment record was found to attribute this refund to.",
};

function correctionErrorMessage(err: Error): string {
  const rawCode =
    err instanceof ApiError && err.data && typeof (err.data as Record<string, unknown>).error === "string"
      ? ((err.data as Record<string, unknown>).error as string)
      : err.message;
  return VOID_ERROR_COPY[rawCode] ?? err.message;
}

// ── STEP 1: problem-first choices → backend strategy (local lookup) ────────────
// The user picks a plain-language problem; the strategy is derived here and never
// shown. "Cancel this invoice entirely" is folded into the CREDIT_ADJUSTMENT copy
// because the server auto-downgrades a fully-uncollected credit to a plain void.
type ProblemChoice = {
  strategy: CorrectionStrategy;
  /** The question-answer the user reads (also the radio aria-label). */
  question: string;
  /** One-line clarification under the question. */
  detail: string;
};

const PROBLEM_CHOICES: ProblemChoice[] = [
  {
    strategy: "CREDIT_ADJUSTMENT",
    question: "I charged too much / cancel this charge",
    detail: "Issues a Credit Note to cancel or reduce the charge. Anything already paid becomes tenant credit.",
  },
  {
    strategy: "DEBIT_ADJUSTMENT",
    question: "I charged too little — bill more",
    detail: "Issues a Debit Note that adds to the amount owed.",
  },
  {
    strategy: "CANCEL_AND_REPLACE",
    question: "The details are wrong — re-issue",
    detail: "Cancels this invoice and issues a fresh, corrected one; any payment moves onto the new invoice.",
  },
  {
    strategy: "REFUND",
    question: "The tenant wants their money back",
    detail: "Issues a Credit Note plus a Refund Note and records the money going out.",
  },
];

// Submit-button label per strategy (STEP 2).
const SUBMIT_LABEL: Record<CorrectionStrategy, string> = {
  CREDIT_ADJUSTMENT: "Issue Credit Note",
  DEBIT_ADJUSTMENT: "Issue Debit Note",
  CANCEL_AND_REPLACE: "Void & Re-issue",
  REFUND: "Issue Refund",
};

// Refund methods — friendly labels, values matching what the server expects.
const REFUND_METHODS: { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "fpx", label: "FPX / online banking" },
  { value: "card", label: "Card" },
];

type ReplacementDraft = CorrectionReplacementLine;
const emptyReplacementLine = (): ReplacementDraft => ({ categoryId: "", description: "", amount: "" });

/** 2-dp money string for previews (input strings stay verbatim). */
function rm(value: number): string {
  return value.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CorrectInvoiceDrawer({
  doc,
  onClose,
  defaultStrategy = "CREDIT_ADJUSTMENT",
}: {
  doc: BillingDocumentListItem | null;
  onClose: () => void;
  /** Strategy to preselect when the drawer opens (reset on every doc switch).
   * R9 (Task 12): the Receipts-row "Refund" opens this drawer with "REFUND"
   * preselected — Void ≠ Refund. When a non-default strategy is passed the
   * wizard opens straight on STEP 2 for it (the caller already knows the intent).
   * Defaults to CREDIT_ADJUSTMENT, which opens on the STEP-1 question. */
  defaultStrategy?: CorrectionStrategy;
}) {
  const open = doc !== null;
  const detailQuery = useBillingDocument(open ? doc!.id : null);
  const detail = detailQuery.data?.data;
  // Derive the charge id from the first charge-bearing line of the document.
  const chargeId = useMemo(() => {
    const lines = detail?.lines ?? [];
    return lines.find((l) => l.chargeId)?.chargeId ?? null;
  }, [detail]);

  // COLLECTED is not on the detail DTO. Derive it from the party's open charges:
  // collected = total - outstandingAmount, floored at 0. Falls back to 0 when the
  // charge is fully settled/absent from the outstanding list.
  const partyOpenCharges = usePartyOpenCharges(detail?.partyId ?? null);
  const total = doc ? Number(doc.total) : 0;
  // Until the open-charges query settles we don't yet know the outstanding, so we
  // can't claim anything was collected. Hold `collected` at 0 while loading rather
  // than briefly flashing the whole total as "collected" (which would fire a false
  // "a payment is recorded" warning on an as-yet-unknown, actually-unpaid invoice).
  const chargesReady = !partyOpenCharges.isLoading;
  const collected = useMemo(() => {
    if (!chargeId || !chargesReady) return 0;
    const match = (partyOpenCharges.data ?? []).find((c) => c.id === chargeId);
    // Charge not in the outstanding list → treat as fully collected (total paid).
    const outstanding = match ? match.outstandingAmount : 0;
    return Math.max(0, total - outstanding);
  }, [chargeId, chargesReady, partyOpenCharges.data, total]);
  const balance = Math.max(0, total - collected);

  const categories = useChargeCategories({ enabled: open });
  const categoryItems = categories.data?.items ?? [];

  // Wizard state. `step` gates STEP 1 (choose problem) vs STEP 2 (branch fields).
  // A non-default `defaultStrategy` (e.g. Receipts→Refund) jumps straight to STEP 2.
  const jumpToStep2 = defaultStrategy !== "CREDIT_ADJUSTMENT";
  const [step, setStep] = useState<1 | 2>(jumpToStep2 ? 2 : 1);
  const [strategy, setStrategy] = useState<CorrectionStrategy>(defaultStrategy);
  const [reason, setReason] = useState("");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState("bank_transfer");
  const [refundBankRef, setRefundBankRef] = useState("");
  const [refundDate, setRefundDate] = useState("");
  const [refundFile, setRefundFile] = useState<File | null>(null);
  const [replacementLines, setReplacementLines] = useState<ReplacementDraft[]>([emptyReplacementLine()]);
  // One-shot seed guard: which doc id we have already pre-filled the replacement
  // grid for. Keyed on the STABLE doc id (not the detail object, whose identity
  // changes every render) so the seed fires once per doc, never on a loop.
  const seededForDocId = useRef<string | null>(null);

  const correct = useCorrectInvoice();

  // Reset every field when the target document changes (including to/from null),
  // mirroring VoidChargeDialog — the drawer is mounted once and reused per row.
  useEffect(() => {
    seededForDocId.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-doc-switch snapshot; same reopen pattern as VoidChargeDialog (no `key`).
    setStep(jumpToStep2 ? 2 : 1);
    setStrategy(defaultStrategy);
    setReason("");
    setAdjustmentAmount("");
    setRefundAmount("");
    setRefundMethod("bank_transfer");
    setRefundBankRef("");
    setRefundDate("");
    setRefundFile(null);
    setReplacementLines([emptyReplacementLine()]);
    // defaultStrategy/jumpToStep2 are stable per-mount literals; listed for exhaustive-deps.
  }, [doc?.id, defaultStrategy, jumpToStep2]);

  // Pre-fill the replacement grid from the document's charge-bearing lines the
  // first time the detail loads, so the user edits rather than retypes. Match on
  // category name → category id (the detail DTO carries categoryName, not id).
  // Guarded on the stable doc id so it seeds exactly once per document (the
  // sibling transfer-drawer uses the same one-shot data-seeding pattern).
  useEffect(() => {
    if (!detail || !doc) return;
    if (seededForDocId.current === doc.id) return;
    const seeded = detail.lines
      .filter((l) => l.chargeId)
      .map((l) => {
        const cat = categoryItems.find((c) => c.name === l.categoryName);
        return { categoryId: cat?.id ?? "", description: l.description, amount: l.amount };
      });
    if (seeded.length > 0) {
      seededForDocId.current = doc.id;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed editable replacement lines once when the async detail (and categories) load; established data-seeding pattern across this app's drawers.
      setReplacementLines(seeded);
    }
    // Keyed on the stable doc id + a category-load signal; the ref guard makes it one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, detail, categoryItems.length]);

  function setReplacementLine(i: number, patch: Partial<ReplacementDraft>) {
    setReplacementLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeReplacementLine(i: number) {
    setReplacementLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));
  }

  const decimalOk = (v: string) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0;

  const replacementTotal = replacementLines.reduce(
    (sum, l) => sum + (decimalOk(l.amount) ? Number(l.amount) : 0),
    0,
  );

  const refundExceeds = strategy === "REFUND" && decimalOk(refundAmount) && Number(refundAmount) > collected + 0.005;
  const refundIncomplete =
    strategy === "REFUND" && (!(decimalOk(refundAmount) && refundMethod && refundDate) || refundExceeds);
  const adjustmentIncomplete = strategy === "DEBIT_ADJUSTMENT" && !decimalOk(adjustmentAmount);
  const replacementIncomplete =
    strategy === "CANCEL_AND_REPLACE" &&
    !replacementLines.every((l) => l.categoryId && l.description.trim() && decimalOk(l.amount));
  const replacementTooLow = strategy === "CANCEL_AND_REPLACE" && collected > 0 && replacementTotal < collected - 0.005;

  const disabled =
    step !== 2 ||
    reason.trim().length < 3 ||
    !chargeId ||
    correct.isPending ||
    refundIncomplete ||
    adjustmentIncomplete ||
    replacementIncomplete;

  async function submit() {
    if (step !== 2) return;
    if (!chargeId) {
      toast.error("Could not resolve the charge for this invoice — refresh and try again.");
      return;
    }

    // Wire the refund proof (upload → key) with the transfer-drawer's orphan
    // cleanup: if the correction call fails after upload, delete the slip so
    // storage never holds an object with no refund attached.
    let uploadedKey: string | null = null;
    try {
      if (strategy === "REFUND" && refundFile) uploadedKey = await uploadSlipProof(refundFile);
    } catch {
      toast.error("Failed to upload the refund proof — try again.");
      return;
    }

    const body: CorrectInvoiceInput = { chargeId, strategy, reason: reason.trim() };
    if (strategy === "DEBIT_ADJUSTMENT") body.adjustmentAmount = adjustmentAmount;
    if (strategy === "REFUND") {
      body.refund = {
        amount: refundAmount,
        method: refundMethod,
        bankRef: refundBankRef || undefined,
        refundedAt: refundDate,
        ...(uploadedKey ? { proofKey: uploadedKey } : {}),
      };
    }
    if (strategy === "CANCEL_AND_REPLACE") {
      body.replacement = {
        lines: replacementLines.map((l) => ({
          categoryId: l.categoryId,
          description: l.description.trim(),
          amount: l.amount,
        })),
      };
    }
    correct.mutate(body, {
      onSuccess: (data) => {
        const issued =
          data?.creditNoteNumber ??
          data?.debitNoteNumber ??
          data?.replacementNumber ??
          data?.refundNoteNumber;
        toast.success(issued ? `Invoice corrected — ${issued} issued.` : "Invoice corrected.");
        onClose();
      },
      onError: (err: Error) => {
        // Delete-on-failure: the slip was uploaded but the correction failed —
        // clean up the orphan (mirrors transfer-from-invoice-drawer).
        if (uploadedKey) void deleteSlipProof(uploadedKey).catch(() => {});
        toast.error(correctionErrorMessage(err));
      },
    });
  }

  // ── Effect preview copy, computed from COLLECTED (not total) ─────────────────
  const previewByStrategy: Record<CorrectionStrategy, string> = {
    CREDIT_ADJUSTMENT:
      collected > 0
        ? `Issues a Credit Note; balance RM${rm(balance)} → RM0; RM${rm(collected)} paid becomes tenant credit.`
        : `Issues a Credit Note; balance RM${rm(balance)} → RM0. Nothing was collected, so this simply voids the invoice.`,
    DEBIT_ADJUSTMENT: (() => {
      const amt = decimalOk(adjustmentAmount) ? Number(adjustmentAmount) : 0;
      return `Issues a Debit Note; balance RM${rm(balance)} → RM${rm(balance + amt)} (owes more).`;
    })(),
    CANCEL_AND_REPLACE: `Cancels this invoice, issues a NEW invoice number; the RM${rm(collected)} payment moves onto it.`,
    REFUND: (() => {
      const amt = decimalOk(refundAmount) ? Number(refundAmount) : 0;
      const remaining = Math.max(0, collected - amt);
      return `Issues a Credit Note + Refund Note; refunds RM${rm(amt)}; RM${rm(remaining)} remains as credit.`;
    })(),
  };
  const activePreview = previewByStrategy[strategy];

  // Confirm gating for the two money-moving strategies.
  const confirmSpec =
    strategy === "REFUND"
      ? {
          title: "Issue this refund?",
          body: `Refund RM${rm(decimalOk(refundAmount) ? Number(refundAmount) : 0)} to ${
            doc?.partyName ?? "the tenant"
          }. RM${rm(Math.max(0, collected - (decimalOk(refundAmount) ? Number(refundAmount) : 0)))} remains as credit.`,
          confirmLabel: "Issue Refund",
          destructive: true,
        }
      : strategy === "CANCEL_AND_REPLACE"
        ? {
            title: "Void and re-issue this invoice?",
            body: `Voids ${doc?.documentNumber ?? "this invoice"} for ${
              doc?.partyName ?? "the tenant"
            } and issues a new invoice totalling RM${rm(replacementTotal)}. The RM${rm(collected)} payment moves onto it; the balance becomes RM${rm(
              Math.max(0, replacementTotal - collected),
            )}.`,
            confirmLabel: "Void & Re-issue",
            destructive: true,
          }
        : undefined;

  const submitVariant = strategy === "DEBIT_ADJUSTMENT" ? ("gold" as const) : ("destructive" as const);

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Correct invoice"
      description={
        step === 1
          ? "Tell us what's wrong — we'll pick the right correction for you."
          : "Review the effect, fill in the details, then submit."
      }
      onSubmit={() => void submit()}
      // Show the submit button only on STEP 2. On STEP 1 the user advances by
      // choosing a problem (no primary button), keeping the flow linear.
      submit={
        step === 2
          ? {
              label: SUBMIT_LABEL[strategy],
              pendingLabel: "Working…",
              pending: correct.isPending,
              disabled,
              variant: submitVariant,
              ...(confirmSpec ? { confirm: confirmSpec } : {}),
            }
          : undefined
      }
      secondaryActions={
        step === 2 && !jumpToStep2
          ? [{ label: "Back", variant: "outline", onClick: () => setStep(1) }]
          : []
      }
    >
      <div className="space-y-5">
        {/* Context header — record identity + money summary (never a re-select). */}
        {doc && (
          <div className="rounded-lg border border-border/50 bg-background/40 p-4">
            <p className="text-sm font-semibold text-foreground">{doc.documentNumber}</p>
            <p className="text-xs text-muted-foreground">{doc.partyName}</p>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Billed</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">RM{rm(total)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Collected</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">RM{rm(collected)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Balance</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">RM{rm(balance)}</p>
              </div>
            </div>
            {!chargeId && !detailQuery.isLoading && (
              <p className="mt-2 text-xs text-rose-600">
                Could not resolve a charge for this invoice — correction is unavailable.
              </p>
            )}
          </div>
        )}

        {/* Up-front payment warning — most relevant to refund/cancel. */}
        {collected > 0 && (
          <Callout variant="warning" title="A payment is recorded">
            RM{rm(collected)} has already been collected on this invoice. Cancelling or refunding it will move that
            money (to tenant credit or back to the tenant) — double-check before you proceed.
          </Callout>
        )}

        {/* ── STEP 1 — problem-first question ──────────────────────────────── */}
        {step === 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What do you need to fix on this invoice?</legend>
            {PROBLEM_CHOICES.map((c) => (
              <button
                key={c.strategy}
                type="button"
                onClick={() => {
                  setStrategy(c.strategy);
                  setStep(2);
                }}
                className="flex w-full items-start gap-3 rounded-lg border border-border/50 bg-background/40 px-4 py-3 text-left transition-all hover:border-border/80 hover:bg-background/60"
              >
                <input
                  type="radio"
                  name="correction-problem"
                  aria-label={c.question}
                  checked={strategy === c.strategy}
                  readOnly
                  className="mt-1"
                  tabIndex={-1}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{c.question}</span>
                  <span className="block text-xs text-muted-foreground">{c.detail}</span>
                </span>
              </button>
            ))}
          </fieldset>
        )}

        {/* ── STEP 2 — chosen branch's fields + effect preview ─────────────── */}
        {step === 2 && (
          <>
            {/* Always-visible effect preview, computed from COLLECTED. */}
            <Callout variant="info" title="What this does">
              {activePreview}
            </Callout>

            {/* DEBIT_ADJUSTMENT — the amount to raise the receivable by. */}
            {strategy === "DEBIT_ADJUSTMENT" && (
              <Field label="Adjustment amount" hint="How much more to bill (RM).">
                <TextInput
                  aria-label="Adjustment amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={adjustmentAmount}
                  onChange={(e) => setAdjustmentAmount(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
            )}

            {/* REFUND — amount (≤ collected), method, date, bank ref, proof. */}
            {strategy === "REFUND" && (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field
                    label="Refund amount"
                    hint={`Max RM${rm(collected)} (the amount collected).`}
                    error={refundExceeds ? "Refund exceeds the amount collected." : null}
                  >
                    <TextInput
                      aria-label="Refund amount"
                      type="number"
                      min={0}
                      max={collected}
                      step="0.01"
                      value={refundAmount}
                      onChange={(e) => setRefundAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label="Refund method">
                    <SelectInput
                      aria-label="Refund method"
                      value={refundMethod}
                      onChange={(e) => setRefundMethod(e.target.value)}
                    >
                      {REFUND_METHODS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="Refunded on">
                    <TextInput
                      aria-label="Refunded on"
                      type="date"
                      value={refundDate}
                      onChange={(e) => setRefundDate(e.target.value)}
                    />
                  </Field>
                  <Field label="Bank reference" hint="Optional — transaction / cheque number.">
                    <TextInput
                      aria-label="Bank reference"
                      value={refundBankRef}
                      onChange={(e) => setRefundBankRef(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Refund proof" hint="Optional image/PDF of the outgoing transfer.">
                  <input
                    aria-label="Refund proof"
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => setRefundFile(e.target.files?.[0] ?? null)}
                  />
                </Field>
              </div>
            )}

            {/* CANCEL_AND_REPLACE — pre-filled, editable replacement lines. */}
            {strategy === "CANCEL_AND_REPLACE" && (
              <div className="rounded-lg border border-border/50 bg-background/40 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">Replacement invoice lines</p>
                  <button
                    type="button"
                    onClick={() => setReplacementLines((ls) => [...ls, emptyReplacementLine()])}
                    className="rounded-md px-2 py-1 text-xs font-medium text-[var(--gold-dark)] transition hover:bg-amber-500/10"
                  >
                    + Add line
                  </button>
                </div>
                <div className="space-y-3">
                  {replacementLines.map((line, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_auto] md:items-start md:gap-3"
                    >
                      <SelectInput
                        aria-label="Replacement category"
                        value={line.categoryId}
                        onChange={(e) => setReplacementLine(i, { categoryId: e.target.value })}
                      >
                        <option value="">Select category…</option>
                        {categoryItems.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </SelectInput>
                      <TextInput
                        aria-label="Replacement description"
                        placeholder="Description"
                        value={line.description}
                        onChange={(e) => setReplacementLine(i, { description: e.target.value })}
                      />
                      <TextInput
                        aria-label="Replacement amount"
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="0.00"
                        value={line.amount}
                        onChange={(e) => setReplacementLine(i, { amount: e.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => removeReplacementLine(i)}
                        disabled={replacementLines.length === 1}
                        aria-label="Remove replacement line"
                        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                {/* Running replacement total vs collected. */}
                <div className="mt-3 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    Replacement total <span className="font-semibold text-foreground">RM{rm(replacementTotal)}</span>
                    {collected > 0 && <> · collected RM{rm(collected)}</>}
                  </span>
                </div>
                {replacementTooLow && (
                  <Callout variant="danger" className="mt-3">
                    The replacement total (RM{rm(replacementTotal)}) is below the RM{rm(collected)} already paid. Raise
                    the lines to at least the collected amount before submitting.
                  </Callout>
                )}
              </div>
            )}

            <Field label="Reason" hint="Recorded on the correction (required).">
              <TextAreaInput
                aria-label="Reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this invoice being corrected?"
              />
            </Field>
          </>
        )}
      </div>
    </FormDrawer>
  );
}
