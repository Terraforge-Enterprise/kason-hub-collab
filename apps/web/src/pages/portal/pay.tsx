import { useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalApiFetch } from "@/lib/portal-api";
import { formatRM, formatDateMY, toTitleCase } from "@/components/format";
import { GlowCard } from "@/components/ui/glow-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LegalFooterLinks } from "@/components/legal-footer-links";

type Allocation = { chargeId: string; allocatedAmount: string };
type PaySuccess = { id: string; paymentNumber: string };
type FpxSuccess = { redirectUrl: string; providerTxnId: string; paymentId: string };
type PayingLine = { id: string; label: string; amount: number };

type PayableCharge = {
  id: string;
  chargeNumber: string;
  chargeType: string;
  description: string | null;
  dueDate: string;
  amount: number;
  outstandingAmount: number;
  currency: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  /**
   * The number on the bill the tenant was sent (IVTEN-0002, DEP-2026-0007), or
   * null when this charge is on no bill yet. Resolved server-side from the charge's
   * BillingDocument — see tenant-charge-reference.ts. Optional here only because
   * older fixtures predate the field; a missing value renders the due date alone,
   * never `chargeNumber`.
   */
  documentNumber?: string | null;
  /**
   * This charge already carries a payment the office hasn't verified yet, so it
   * must not be selectable again.
   *
   * invariant: always present from /payments/payable-charges. Optional here only
   * because older test fixtures predate the field — a missing value is treated
   * as "not pending", which fails OPEN (charge stays payable). The server-side
   * guard in validatePaymentAllocationsTx is the real protection; this flag only
   * turns a confusing 409 into a visible state.
   */
  pendingVerification?: boolean;
  /**
   * The charges this ONE row settles, and the exact amount to allocate to each.
   *
   * Usually just the row itself. It is TWO when the server folded an SST sibling
   * into the base it taxes (`foldPayableTaxSiblings`): the RM 0.54 row below is
   * RM 0.50 against the base charge and RM 0.04 against the sibling. Allocations
   * MUST be built from this and never from `{id, outstandingAmount}` on a folded
   * row — `validatePaymentAllocationsTx` locks each charge and demands the
   * allocation equal THAT charge's own outstanding to the cent, so allocating the
   * merged 0.54 against the base alone is an ALLOC_EXCEEDS_OUTSTANDING rejection.
   *
   * invariant: always present from /payments/payable-charges. Optional here only
   * because older test fixtures predate the field — same reasoning as
   * `pendingVerification` above. Absent means an older server that did no folding
   * either, so the self-allocation fallback in `chargeAllocations` is exactly
   * right for that response; it is never a silent under-payment.
   */
  components?: { chargeId: string; outstandingAmount: number }[];
};

/**
 * The allocations one selected row contributes. Falls back to a self-allocation
 * when `components` is absent — see the field's invariant note.
 */
function chargeAllocations(c: PayableCharge): Allocation[] {
  const components = c.components?.length
    ? c.components
    : [{ chargeId: c.id, outstandingAmount: c.outstandingAmount }];
  return components.map((k) => ({
    chargeId: k.chargeId,
    allocatedAmount: k.outstandingAmount.toFixed(2),
  }));
}

/** Slip upload contract — server mints the key, browser PUTs straight to storage. */
type SlipUploadTicket = {
  storageKey: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
};

const SLIP_ACCEPT = "image/jpeg,image/png,image/heic,image/webp,application/pdf";
// Bank-app screenshots are small; a 10 MB ceiling rejects an accidental video
// before it is uploaded rather than after.
const SLIP_MAX_BYTES = 10 * 1024 * 1024;

type PayableChargesResponse = {
  data: PayableCharge[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

type Group = "overdue" | "due" | "upcoming";
const GROUP_ORDER: Group[] = ["overdue", "due", "upcoming"];
const GROUP_LABEL: Record<Group, string> = { overdue: "Overdue", due: "Due now", upcoming: "Upcoming" };
const STATUS_LABEL: Record<Group, string> = { overdue: "OVERDUE", due: "UNPAID", upcoming: "UPCOMING" };
const STATUS_BADGE_VARIANT: Record<Group, "rose" | "amber" | "sky"> = {
  overdue: "rose",
  due: "amber",
  upcoming: "sky",
};

// Date-only classification, anchored to Asia/Kuala_Lumpur — must agree with
// formatDateMY's timezone convention. A UTC- or host-local-anchored "today"
// can disagree with MY's actual calendar day near a midnight boundary (the
// host running this code has no guarantee of being in MY time), which could
// silently flip an already-due charge to "upcoming" (excluded from
// auto-select) or vice versa. Returns "" for an unparseable date so callers
// can fail safe rather than crash.
const MY_DATE_ONLY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
function dateOnly(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : MY_DATE_ONLY.format(d);
}

function classify(c: PayableCharge, todayStr: string): Group {
  const due = dateOnly(c.dueDate);
  // Malformed/unparseable due date -> the one bucket never auto-selected in
  // pay-all mode, so a bad date can never accidentally auto-charge a tenant.
  if (!due) return "upcoming";
  if (due < todayStr) return "overdue";
  if (due > todayStr) return "upcoming";
  return "due";
}

function sumCents(values: number[]): number {
  return values.reduce((sum, v) => sum + Math.round(v * 100), 0) / 100;
}

function chargeLabel(c: PayableCharge): string {
  if (c.description) return c.description;
  if (c.chargeType === "rent") return "Rent";
  if (c.chargeType === "utility") return "Utilities";
  return toTitleCase(c.chargeType);
}

/**
 * The sub-label under a charge: which bill it came from, and when it is due.
 *
 * ⚠️ Deliberately does NOT fall back to `chargeNumber`. That is an internal key
 * which for grid-minted charges embeds raw UUIDs — a tenant was shown
 * `GRIDEXP-202608-360f0307-7426-412f-b362-3e500534b44d-SST`, which matches nothing
 * they hold. `documentNumber` is the number printed on the bill they were sent;
 * when a charge is on no bill yet, the due date alone is honest and readable.
 */
function chargeReferenceLine(c: PayableCharge): string {
  const due = `Due ${formatDateMY(c.dueDate)}`;
  const ref = c.documentNumber ?? c.invoiceNumber;
  return ref ? `${ref} · ${due}` : due;
}

export default function PortalPayPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error: fetchError } = useQuery({
    queryKey: ["portal-payable-charges"],
    queryFn: () => portalApiFetch<PayableChargesResponse>("/payments/payable-charges?limit=50"),
  });

  const charges = useMemo(() => data?.data ?? [], [data]);
  const todayStr = dateOnly(new Date().toISOString());

  const grouped = useMemo(() => {
    const g: Record<Group, PayableCharge[]> = { overdue: [], due: [], upcoming: [] };
    for (const c of charges) g[classify(c, todayStr)].push(c);
    return g;
  }, [charges, todayStr]);

  // A charge awaiting verification is NOT eligible: its outstanding still reads
  // full (an unverified payment settles nothing), so leaving it selectable would
  // invite the tenant to pay the same money twice — and the server would reject
  // the whole basket with a 409 anyway.
  const eligibleIds = useMemo(
    () =>
      new Set(
        [...grouped.overdue, ...grouped.due].filter((c) => !c.pendingVerification).map((c) => c.id),
      ),
    [grouped],
  );

  const awaitingVerificationCount = useMemo(
    () => charges.filter((c) => c.pendingVerification).length,
    [charges],
  );

  const [mode, setMode] = useState<"all" | "select">("all");
  // Manual selection for "Select charges" mode. Lazily seeded from eligibleIds
  // the first time the user switches into this mode (so it starts matching
  // "pay all" defaults), then fully user-controlled thereafter. Switching
  // back to "all" never reads this — "all" mode always reflects eligibleIds
  // live, since it is non-editable by definition.
  const [manualChecked, setManualChecked] = useState<Set<string> | null>(null);

  function handleModeChange(next: "all" | "select") {
    setMode(next);
    if (next === "select") {
      setManualChecked((prev) => prev ?? new Set(eligibleIds));
    }
  }

  function toggleCharge(id: string) {
    setManualChecked((prev) => {
      const base = prev ?? new Set(eligibleIds);
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Bulk toggle scoped to ELIGIBLE (overdue+due-now) charges only — mirrors
  // the anti-prepay invariant: a bulk "select all" action is still an
  // auto-select mechanism, so it must never sweep in Upcoming charges. Any
  // Upcoming charge the tenant deliberately checked by hand is preserved.
  function toggleSelectAll() {
    setManualChecked((prev) => {
      const base = prev ?? new Set(eligibleIds);
      const allEligibleSelected = eligibleIds.size > 0 && [...eligibleIds].every((id) => base.has(id));
      const next = new Set(base);
      for (const id of eligibleIds) {
        if (allEligibleSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  const effectiveChecked = mode === "all" ? eligibleIds : (manualChecked ?? eligibleIds);
  const allEligibleChecked =
    eligibleIds.size > 0 && [...eligibleIds].every((id) => effectiveChecked.has(id));

  const totalOutstandingEligible = sumCents(
    [...grouped.overdue, ...grouped.due].map((c) => c.outstandingAmount),
  );
  // Re-filter against pendingVerification, not just the checkbox set.
  // `manualChecked` is seeded ONCE and never reconciled against a refetch, so a
  // charge that becomes pending after seeding would stay ticked and submit
  // straight into a 409. The server rejects it either way; this stops the UI
  // presenting it as payable in the first place.
  const selectedCharges = charges.filter((c) => effectiveChecked.has(c.id) && !c.pendingVerification);
  const paymentAmount = sumCents(selectedCharges.map((c) => c.outstandingAmount));
  const selectedCount = selectedCharges.length;

  const [step, setStep] = useState<"select" | "review" | "result">("select");
  const [paymentMethod, setPaymentMethod] = useState<"fpx" | "bank_transfer">("fpx");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  // Explicit consent to the T&Cs + refund policy. Deliberately NOT reset by
  // Back/edit or a method toggle: the tick agrees to the two policies, which
  // don't change with the basket — same reasoning that keeps referenceNumber,
  // notes and the slip alive across those transitions.
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  // The transfer slip. Held as a File and uploaded at submit time (not on pick)
  // so a tenant who changes their mind at the review step never leaves an orphan
  // object in storage that no payment references.
  const [slipFile, setSlipFile] = useState<File | null>(null);
  const [slipError, setSlipError] = useState<string | null>(null);
  const [uploadingSlip, setUploadingSlip] = useState(false);
  // Snapshot of what was actually submitted, captured at submit time — the
  // /payments/pay response only returns {id, paymentNumber}, no allocations,
  // so the result screen's "applied to" list must come from client state
  // rather than the mutation response.
  const [payingSnapshot, setPayingSnapshot] = useState<PayingLine[]>([]);
  const [resultInfo, setResultInfo] = useState<PaySuccess | null>(null);

  const payMutation = useMutation({
    mutationFn: (payload: {
      idempotencyKey: string;
      paymentMethod: string;
      referenceNumber: string;
      notes?: string;
      attachmentKeys?: string[];
      allocations: Allocation[];
    }) => portalApiFetch<PaySuccess>("/payments/pay", { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["portal-charges"] });
      queryClient.invalidateQueries({ queryKey: ["portal-payments"] });
      setResultInfo(result);
      setStep("result");
    },
  });

  // FPX path: initiates at the gateway and leaves the SPA entirely — the
  // signed callback (not this page) settles the charges, so there is no
  // in-page result step for this branch.
  const fpxMutation = useMutation({
    mutationFn: (payload: { allocations: Allocation[]; idempotencyKey: string }) =>
      portalApiFetch<FpxSuccess>("/payments/fpx/initiate", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (result) => {
      window.location.assign(result.redirectUrl);
    },
  });

  /**
   * Upload the slip and return its storage key. Two steps: ask the API for a
   * signed URL (it mints the org+party-scoped key server-side), then PUT the
   * bytes straight to storage. Throws with tenant-readable copy — the caller
   * surfaces it and does NOT submit the payment.
   */
  async function uploadSlip(file: File): Promise<string> {
    const ticket = await portalApiFetch<{ data: SlipUploadTicket }>("/payments/slip-upload-url", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, contentType: file.type }),
    });
    const { uploadUrl, method, headers, storageKey } = ticket.data;
    const res = await fetch(uploadUrl, { method, headers, body: file });
    if (!res.ok) throw new Error("We couldn't upload your slip. Check your connection and try again.");
    return storageKey;
  }

  async function handleSubmit() {
    if (selectedCharges.length === 0) return;
    // Belt-and-braces with the disabled button: a disabled <button> can't
    // dispatch a click, but this is the last gate before money moves, so it
    // does not rely on the DOM alone.
    if (!agreedToTerms) return;
    // FULL-OUTSTANDING LOCK: every allocation is exactly the charge's own
    // outstandingAmount — there is no editable-amount input anywhere in this
    // UI, so there is no other value this could ever be. A folded row expands to
    // one allocation per component (base + its SST sibling), which is why this is
    // a flatMap and not a map — Σ(allocations) still equals `paymentAmount`.
    const allocations: Allocation[] = selectedCharges.flatMap(chargeAllocations);
    setPayingSnapshot(selectedCharges.map((c) => ({ id: c.id, label: chargeLabel(c), amount: c.outstandingAmount })));

    if (paymentMethod === "fpx") {
      fpxMutation.mutate({ allocations, idempotencyKey: crypto.randomUUID() });
      return;
    }
    if (!referenceNumber.trim()) return;
    if (!slipFile) {
      setSlipError("Attach your transfer slip so we can verify the payment.");
      return;
    }

    // Upload FIRST, submit second. If the upload fails the payment is never
    // created, so the tenant retries a whole submission rather than ending up
    // with a slipless payment nobody can verify.
    setSlipError(null);
    setUploadingSlip(true);
    let storageKey: string;
    try {
      storageKey = await uploadSlip(slipFile);
    } catch (err) {
      setSlipError(err instanceof Error ? err.message : "We couldn't upload your slip. Please try again.");
      return;
    } finally {
      setUploadingSlip(false);
    }

    payMutation.mutate({
      idempotencyKey: crypto.randomUUID(),
      paymentMethod,
      referenceNumber: referenceNumber.trim(),
      notes: notes.trim() || undefined,
      attachmentKeys: [storageKey],
      allocations,
    });
  }

  function handleSlipPick(file: File | null) {
    setSlipError(null);
    if (!file) {
      setSlipFile(null);
      return;
    }
    if (file.size > SLIP_MAX_BYTES) {
      setSlipFile(null);
      setSlipError("That file is over 10 MB. A photo or PDF of the slip is enough.");
      return;
    }
    setSlipFile(file);
  }

  const submitPending = payMutation.isPending || fpxMutation.isPending || uploadingSlip;
  const submitError = payMutation.error || fpxMutation.error;
  const referenceMissing = paymentMethod !== "fpx" && !referenceNumber.trim();
  const slipMissing = paymentMethod !== "fpx" && !slipFile;

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-24 bg-muted rounded-xl" />
        <div className="h-40 bg-muted rounded-xl" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Pay Charges</h1>
        <Callout variant="danger" title="Couldn't load your charges">
          No payable charges available at this time. Please try again shortly.
        </Callout>
      </div>
    );
  }

  if (charges.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Pay Charges</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          You have no outstanding charges to pay.
        </p>
      </div>
    );
  }

  if (step === "review") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Review Payment</h1>

        <div className="rounded-lg bg-background/60 backdrop-blur-xl border border-border/50 shadow-xl p-6 space-y-3">
          {selectedCharges.map((c) => (
            <div key={c.id} className="flex items-center justify-between text-sm text-[var(--text-primary)]">
              <span>{chargeLabel(c)}</span>
              <span className="tabular-nums">{formatRM(c.outstandingAmount)}</span>
            </div>
          ))}
          <div className="pt-3 border-t border-border/50 text-sm text-muted-foreground">
            Subtotal {formatRM(paymentAmount)}
          </div>
          <div className="text-lg font-bold text-foreground">TOTAL {formatRM(paymentAmount)}</div>
        </div>

        <div className="rounded-lg bg-background/60 backdrop-blur-xl border border-border/50 shadow-xl p-6 space-y-4">
          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="radio"
              name="payment-method"
              checked={paymentMethod === "fpx"}
              onChange={() => setPaymentMethod("fpx")}
              className="h-4 w-4 accent-[var(--gold)]"
            />
            FPX Online Banking
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="radio"
              name="payment-method"
              checked={paymentMethod === "bank_transfer"}
              onChange={() => setPaymentMethod("bank_transfer")}
              className="h-4 w-4 accent-[var(--gold)]"
            />
            Bank transfer
          </label>

          {paymentMethod !== "fpx" && (
            <>
              <Callout variant="info" title="Already transferred?">
                Enter the reference from your bank and attach the slip. We'll check it against our
                account and confirm — the charges stay open until we do.
              </Callout>

              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1">
                  Reference Number *
                </label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="e.g. TXN-20260618-001"
                  className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
                />
              </div>

              <div>
                <label htmlFor="pay-slip" className="block text-sm text-[var(--text-secondary)] mb-1">
                  Transfer slip *
                </label>
                <input
                  id="pay-slip"
                  type="file"
                  required
                  aria-label="Transfer slip"
                  accept={SLIP_ACCEPT}
                  onChange={(e) => handleSlipPick(e.target.files?.[0] ?? null)}
                  className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition file:mr-3 file:rounded file:border-0 file:bg-[var(--gold)] file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {slipFile
                    ? `Attached: ${slipFile.name}`
                    : "A photo or PDF of your bank receipt (max 10 MB)."}
                </p>
              </div>

              {slipError && <Callout variant="danger">{slipError}</Callout>}
            </>
          )}

          <div>
            <label htmlFor="pay-notes" className="block text-sm text-[var(--text-secondary)] mb-1">
              Notes (optional)
            </label>
            <textarea
              id="pay-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
        </div>

        {/*
          Explicit consent, not implied. This replaced a passive "By paying you
          agree to our Terms…" line sitting BELOW the buttons — which asked the
          tenant to agree by doing nothing, on the one screen in the product
          that moves money. The agreement is now an act: the submit button stays
          disabled until the box is ticked, and the box sits above the buttons
          because you cannot consent to something you haven't been shown yet.

          It still carries the disclosure it replaced — Fiuu ToS cl. 3.9 requires
          the refund policy and trading details to be discoverable at the point
          of purchase, not merely somewhere on the site (LegalFooterLinks below
          covers the trading details).

          Both links open in a NEW TAB on purpose. In-place navigation would
          unmount this page and silently discard the selected charges, the
          reference number and the picked slip — so the act of reading what you
          are agreeing to would destroy the payment you were making.
        */}
        <div className="rounded-lg border border-border/50 bg-background/40 p-4 backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <input
              id="pay-terms-agree"
              type="checkbox"
              checked={agreedToTerms}
              aria-labelledby="pay-terms-agree-label"
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--gold)]"
            />
            <div className="min-w-0">
              <p id="pay-terms-agree-label" className="text-sm text-[var(--text-primary)]">
                I agree to the{" "}
                <Link
                  to="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-[#B8963E]"
                >
                  Terms &amp; Conditions
                </Link>{" "}
                and the{" "}
                <Link
                  to="/refund-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-[#B8963E]"
                >
                  Return &amp; Refund Policy
                </Link>
                .
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Required before you can continue. Both open in a new tab, so nothing you've
                entered here is lost.
              </p>
            </div>
          </div>
        </div>

        {submitError && (
          <Callout variant="danger" title="Payment not submitted">
            {(submitError as Error).message}
          </Callout>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" onClick={() => setStep("select")} disabled={submitPending}>
            Back
          </Button>
          <Button
            variant="gold"
            onClick={() => void handleSubmit()}
            disabled={
              submitPending ||
              !agreedToTerms ||
              referenceMissing ||
              slipMissing ||
              selectedCharges.length === 0
            }
          >
            {submitPending
              ? paymentMethod === "fpx"
                ? "Redirecting to FPX..."
                : uploadingSlip
                  ? "Uploading slip..."
                  : "Submitting..."
              : paymentMethod === "fpx"
                ? `Pay ${formatRM(paymentAmount)}`
                : `Submit ${formatRM(paymentAmount)} for verification`}
          </Button>
        </div>

        <LegalFooterLinks showEntity />
      </div>
    );
  }

  if (step === "result" && resultInfo) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Pay Charges</h1>
        {/*
          Amber, not green, and "Submitted" rather than "Successful". This screen
          is only ever reached by the manual-transfer path, where NOTHING has
          been confirmed: the charges are still open and the office has yet to
          look at the slip. A green "Payment Successful" here would tell the
          tenant their balance is settled when it isn't — and the likeliest next
          move for someone who believes that is to ignore the reminder that
          follows, or to pay again when they see the charge still outstanding.
        */}
        <GlowCard glowColor="orange" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50 space-y-3">
          <div className="flex items-center gap-2">
            <Check className="h-6 w-6 text-amber-600" />
            <h2 className="text-xl font-bold text-foreground">Payment submitted for verification</h2>
          </div>
          <p className="text-sm text-muted-foreground">Payment number {resultInfo.paymentNumber}</p>
          <div className="text-sm text-[var(--text-primary)]">
            <p className="text-xs text-muted-foreground mb-1">You've told us this covers</p>
            {payingSnapshot.map((line) => (
              <div key={line.id} className="flex items-center justify-between">
                <span>{line.label}</span>
                <span className="tabular-nums">{formatRM(line.amount)}</span>
              </div>
            ))}
          </div>
          <Callout variant="warning" title="Not confirmed yet">
            We'll check your slip against our bank account. These charges stay open until we
            confirm, so please don't pay them again — you can follow the status under Payments.
          </Callout>
          <div className="pt-2">
            <Button variant="gold" onClick={() => navigate("/portal/billing")}>
              Return to Billing
            </Button>
          </div>
        </GlowCard>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Pay Charges</h1>

      {awaitingVerificationCount > 0 && (
        <Callout variant="warning" title="Waiting on us">
          {awaitingVerificationCount === 1
            ? "One charge below already has a payment you've submitted. We're checking it now — you don't need to pay it again."
            : `${awaitingVerificationCount} charges below already have payments you've submitted. We're checking them now — you don't need to pay them again.`}
        </Callout>
      )}

      <div className="rounded-lg bg-background/60 backdrop-blur-xl border border-border/50 shadow-xl p-4 space-y-2">
        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="radio"
            name="pay-mode"
            checked={mode === "all"}
            onChange={() => handleModeChange("all")}
            className="h-4 w-4 accent-[var(--gold)]"
          />
          Pay all outstanding
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="radio"
            name="pay-mode"
            checked={mode === "select"}
            onChange={() => handleModeChange("select")}
            className="h-4 w-4 accent-[var(--gold)]"
          />
          Select charges
        </label>
        {mode === "select" && (
          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] pl-6">
            <input
              type="checkbox"
              checked={allEligibleChecked}
              onChange={toggleSelectAll}
              className="h-4 w-4 accent-[var(--gold)] cursor-pointer"
            />
            Select all outstanding
          </label>
        )}
      </div>

      <div className="rounded-lg bg-background/60 backdrop-blur-xl border border-border/50 shadow-xl overflow-hidden">
        {GROUP_ORDER.filter((g) => grouped[g].length > 0).map((g) => (
          <div key={g}>
            <div className="px-4 py-2 border-b border-border/50 bg-background/40">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {GROUP_LABEL[g].toUpperCase()}
              </h2>
            </div>
            {grouped[g].map((c) => {
              const awaiting = c.pendingVerification === true;
              const checked = !awaiting && effectiveChecked.has(c.id);
              const inputId = `chk-${c.id}`;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0",
                    // Dimmed AND non-interactive: this charge already has money
                    // claimed against it that we haven't confirmed. Leaving it
                    // selectable would let the tenant pay the same thing twice.
                    awaiting && "opacity-60",
                  )}
                >
                  <div className="w-4 shrink-0 flex items-center justify-center">
                    {awaiting ? (
                      <Clock className="h-4 w-4 text-amber-600" />
                    ) : mode === "select" ? (
                      <input
                        type="checkbox"
                        id={inputId}
                        checked={checked}
                        onChange={() => toggleCharge(c.id)}
                        className="h-4 w-4 accent-[var(--gold)] cursor-pointer"
                      />
                    ) : checked ? (
                      <Check className="h-4 w-4 text-emerald-600" />
                    ) : null}
                  </div>
                  <label
                    htmlFor={!awaiting && mode === "select" ? inputId : undefined}
                    className={cn("flex-1 min-w-0", awaiting ? "cursor-default" : "cursor-pointer")}
                  >
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      {chargeLabel(c)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {awaiting
                        ? "You've submitted a payment for this — we're verifying it"
                        : chargeReferenceLine(c)}
                    </div>
                  </label>
                  <Badge variant={awaiting ? "amber" : STATUS_BADGE_VARIANT[g]}>
                    {awaiting ? "AWAITING VERIFICATION" : STATUS_LABEL[g]}
                  </Badge>
                  <span className="text-sm font-medium tabular-nums text-[var(--text-primary)] shrink-0">
                    {formatRM(c.outstandingAmount)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <GlowCard glowColor="gold" className="p-6 bg-background/40 backdrop-blur-xl border border-border/50 space-y-1">
        <p className="text-sm text-muted-foreground">
          {selectedCount} charge{selectedCount === 1 ? "" : "s"} selected
        </p>
        <p className="text-sm text-muted-foreground">
          Total outstanding {formatRM(totalOutstandingEligible)}
        </p>
        {/* These two legitimately differ when something is mid-verification —
            "outstanding" counts the debt, "payment amount" counts what this
            submission can settle. Unexplained, the gap reads as a maths error. */}
        {awaitingVerificationCount > 0 && totalOutstandingEligible - paymentAmount > 0.005 && (
          <p className="text-xs text-amber-600">
            {formatRM(totalOutstandingEligible - paymentAmount)} of that is already with us for
            verification and isn't included below.
          </p>
        )}
        <p className="text-2xl font-bold text-foreground">Payment amount {formatRM(paymentAmount)}</p>
      </GlowCard>

      <div className="flex justify-end">
        <Button
          variant="gold"
          disabled={selectedCount === 0}
          onClick={() => setStep("review")}
        >
          Continue to payment
        </Button>
      </div>
    </div>
  );
}
